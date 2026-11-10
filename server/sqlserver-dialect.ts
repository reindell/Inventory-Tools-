/** The application's small, parameterized SQL vocabulary, normalized to native T-SQL.
 * SQL literals are shielded before rewriting; user values are always bound separately.
 * Unsupported constructs fail explicitly rather than being sent with changed semantics.
 */
export interface SqlServerStatement {
  sql: string;
  parameters: Record<string, unknown>;
}

const conflicts: Record<string, string[]> = {
  categories: ['name'],
  suppliers: ['name'],
  idempotency_records: ['actor_id', 'route', 'key'],
};

const splitList = (value: string) => {
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '(') depth++;
    if (value[index] === ')') depth--;
    if (value[index] === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
};

function expressionStart(sql: string, end: number) {
  let cursor = end - 1;
  while (/\s/.test(sql[cursor] || '') && cursor >= 0) cursor--;
  if (sql[cursor] === ')') {
    let depth = 1;
    cursor--;
    while (cursor >= 0 && depth) {
      if (sql[cursor] === ')') depth++;
      if (sql[cursor] === '(') depth--;
      cursor--;
    }
    while (cursor >= 0 && /[\w.]/.test(sql[cursor])) cursor--;
    return cursor + 1;
  }
  while (cursor >= 0 && /[\w.$@]/.test(sql[cursor])) cursor--;
  return cursor + 1;
}

function limits(sql: string): string {
  // Work innermost-first so thumbnail subqueries and the surrounding page retain separate limits.
  const stack: number[] = [];
  for (let index = 0; index < sql.length; index++) {
    if (sql[index] === '(') stack.push(index);
    if (sql[index] === ')') {
      const start = stack.pop()!;
      const inner = sql.slice(start + 1, index);
      if (/^\s*SELECT\b/i.test(inner) && /\bLIMIT\b/i.test(inner)) {
        const normalized = limits(inner);
        sql = sql.slice(0, start + 1) + normalized + sql.slice(index);
        index = start + normalized.length + 1;
      }
    }
  }
  const page = /\s+LIMIT\s+(\$\d+|\d+)(?:\s+OFFSET\s+(\$\d+|\d+))?\s*;?$/i.exec(sql);
  if (!page) return sql;
  const head = sql.slice(0, page.index);
  if (page[2]) {
    if (!/\bORDER\s+BY\b/i.test(head)) throw new Error('SQL Server pages require explicit order.');
    return `${head} OFFSET ${page[2]} ROWS FETCH NEXT ${page[1]} ROWS ONLY`;
  }
  return head.replace(/^(\s*SELECT)\s+/i, `$1 TOP (${page[1]}) `);
}

export function sqlServerStatement(source: string, values: unknown[] = []): SqlServerStatement {
  const literals: string[] = [];
  let sql = source
    .replace(/'(?:''|[^'])*'/g, (literal) => {
      literals.push(literal);
      return `__literal${literals.length - 1}__`;
    })
    .trim();
  const parameters: Record<string, unknown> = {};

  const advisory = /^SELECT\s+pg_advisory_xact_lock\((\d+)\)\s*;?$/i.exec(sql);
  if (advisory)
    return {
      sql: "DECLARE @lock_result int; EXEC @lock_result=sys.sp_getapplock @Resource=@lock_resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000; IF @lock_result<0 THROW 51001,'Could not acquire the application lock.',1;",
      parameters: { lock_resource: `sdp:${advisory[1]}` },
    };
  if (/^RELEASE SAVEPOINT [a-z_]+$/i.test(sql)) return { sql: 'SELECT 1 AS released', parameters };
  sql = sql.replace(/^SAVEPOINT ([a-z_]+)$/i, 'SAVE TRANSACTION $1');
  sql = sql.replace(/^ROLLBACK TO SAVEPOINT ([a-z_]+)$/i, 'ROLLBACK TRANSACTION $1');

  sql = sql.replace(/([\w.]+)\s*=\s*ANY\(\$(\d+)::uuid\[\]\)/gi, (_match, field, number) => {
    const array = values[Number(number) - 1];
    if (!Array.isArray(array)) throw new Error('Expected a UUID array parameter.');
    if (!array.length) return '1=0';
    return `${field} IN (${array
      .map((value, index) => {
        const key = `sdp_p${number}_${index}`;
        parameters[key] = value;
        return `@${key}`;
      })
      .join(',')})`;
  });

  const interval = (token: string) => {
    const literal = literals[Number(/\d+/.exec(token)![0])];
    const parts = /^'(\d+) (minute|hour|day)s?'$/i.exec(literal);
    if (!parts) throw new Error('Unsupported SQL interval.');
    return { amount: parts[1], unit: parts[2] };
  };
  sql = sql.replace(
    /now\(\)\s*\+\s*interval\s+(__literal\d+__)\s*\*\s*power\((\d+),([\w.]+)\)/gi,
    (_match, token, base, exponent) => {
      const time = interval(token);
      return `DATEADD(${time.unit},${time.amount}*POWER(${base},${exponent}),SYSUTCDATETIME())`;
    },
  );
  sql = sql.replace(
    /(now\(\)|\$\d+::date)\s*([+-])\s*interval\s+(__literal\d+__)/gi,
    (_match, origin, sign, token) => {
      const time = interval(token);
      return `DATEADD(${time.unit},${sign === '-' ? '-' : ''}${time.amount},${origin === 'now()' ? 'SYSUTCDATETIME()' : origin})`;
    },
  );
  sql = sql.replace(/\bnow\(\)/gi, 'SYSUTCDATETIME()');
  sql = sql.replace(
    /\bcount\(\*\)\s+FILTER\s*\(WHERE\s+([^)]*)\)/gi,
    'COALESCE(SUM(CASE WHEN $1 THEN 1 ELSE 0 END),0)',
  );
  // PostgreSQL SUM(int) widens to bigint; T-SQL requires that widening explicitly.
  sql = sql.replace(/\bsum\((abs\([^()]*\)|[\w.]+)\)/gi, 'SUM(CAST($1 AS bigint))');
  sql = sql.replace(/::(?:jsonb|uuid)\b/gi, '');
  let cast: RegExpExecArray | null;
  while ((cast = /::(int|integer|bigint|text|date)\b/i.exec(sql))) {
    const start = expressionStart(sql, cast.index);
    const type = /^(int|integer)$/i.test(cast[1])
      ? 'int'
      : cast[1].toLowerCase() === 'text'
        ? 'nvarchar(max)'
        : cast[1];
    sql = `${sql.slice(0, start)}CAST(${sql.slice(start, cast.index)} AS ${type})${sql.slice(cast.index + cast[0].length)}`;
  }
  sql = sql.replace(/([\w.]+)\s+ILIKE\s+\$(\d+)/gi, (_match, field, number) => {
    const value = values[Number(number) - 1];
    if (typeof value === 'string') parameters[`sdp_p${number}`] = value.replaceAll('[', '[[]');
    return `${field} COLLATE Latin1_General_100_CI_AS_SC LIKE $${number}`;
  });
  sql = sql.replace(/\btrue\b/gi, '1').replace(/\bfalse\b/gi, '0');
  sql = sql.replace(/\bWHERE\s+is_primary\s*$/i, 'WHERE is_primary=1');
  sql = sql.replace(/\bi\.serialized\s+AND\b/gi, 'i.serialized=1 AND');
  const lock = /\s+FOR UPDATE(?:\s+SKIP LOCKED)?\s*$/i.exec(sql);
  if (lock) {
    const skip = /SKIP LOCKED/i.test(lock[0]);
    sql = sql.slice(0, lock.index);
    sql = sql.replace(
      /\bFROM\s+([a-z_]+)(\s+(?:[a-z]\w*)\b)?(?=\s+(?:WHERE|ORDER|JOIN|LEFT|CROSS)|\s*$)/i,
      (match) => `${match} WITH (UPDLOCK,${skip ? 'READPAST' : 'HOLDLOCK'},ROWLOCK)`,
    );
  }
  sql = limits(sql);

  const conflict = /\s+ON CONFLICT DO NOTHING(?:\s+RETURNING\s+([\w*,. ]+))?\s*$/i.exec(sql);
  if (conflict) {
    const insertion = /^INSERT INTO ([a-z_]+)\(([^)]+)\) VALUES\s*\(([\s\S]*)\)$/i.exec(
      sql.slice(0, conflict.index),
    );
    if (!insertion || !conflicts[insertion[1]])
      throw new Error('Unsupported conflict-safe insert.');
    const columns = splitList(insertion[2]);
    const inputs = splitList(insertion[3]);
    const predicate = conflicts[insertion[1]]
      .map((field) => `${field}=${inputs[columns.indexOf(field)]}`)
      .join(' AND ');
    const output = conflict[1]
      ? ` OUTPUT ${splitList(conflict[1])
          .map((field) => `INSERTED.${field}`)
          .join(',')}`
      : '';
    sql = `INSERT INTO ${insertion[1]}(${insertion[2]})${output} SELECT ${insertion[3]} WHERE NOT EXISTS (SELECT 1 FROM ${insertion[1]} WITH (UPDLOCK,HOLDLOCK) WHERE ${predicate})`;
  } else {
    const returning = /\s+RETURNING\s+([\w*,. ]+)\s*$/i.exec(sql);
    if (returning) {
      sql = sql.slice(0, returning.index);
      const prefix = /^DELETE\b/i.test(sql) ? 'DELETED' : 'INSERTED';
      const output = ` OUTPUT ${splitList(returning[1])
        .map((field) => `${prefix}.${field}`)
        .join(',')}`;
      if (/^INSERT\b/i.test(sql)) sql = sql.replace(/\s+VALUES\s*\(/i, `${output} VALUES (`);
      else if (/\sWHERE\s/i.test(sql)) sql = sql.replace(/\sWHERE\s/i, `${output} WHERE `);
      else sql += output;
    }
  }
  // Reserved identifiers are quoted only outside shielded literals.
  sql = sql.replace(/\b(key|rows|errors)\b/g, '[$1]');
  sql = sql.replace(/\$(\d+)/g, (_match, number) => {
    const key = `sdp_p${number}`;
    if (!(key in parameters)) parameters[key] = values[Number(number) - 1];
    return `@${key}`;
  });
  if (/::|\bILIKE\b|\bFOR UPDATE\b|\bLIMIT\b|\binterval\b|\bON CONFLICT\b/i.test(sql))
    throw new Error('This SQL construct has no supported SQL Server mapping.');
  sql = sql.replace(/__literal(\d+)__/g, (_match, index) => literals[Number(index)]);
  return { sql, parameters };
}

const jsonColumns = new Set([
  'response_json',
  'payload',
  'rows',
  'errors',
  'result',
  'before_data',
  'after_data',
]);
export function normalizeSqlServerRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'string' && jsonColumns.has(key)
          ? JSON.parse(value)
          : typeof value === 'string' &&
              (key === 'id' || key.endsWith('_id')) &&
              /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
            ? value.toLowerCase()
            : value,
    ]),
  );
}
