import { describe, expect, it } from 'vitest';
import { sqlServerStatement, normalizeSqlServerRow } from '../server/sqlserver-dialect';
import { sqlServerConfig } from '../server/sqlserver';

describe('SQL Server parameter and query semantics', () => {
  it('binds hostile input without rewriting SQL-looking content inside literals', () => {
    const value = "x'); DROP TABLE users;--";
    const statement = sqlServerStatement(
      "SELECT 'true key LIMIT 1 now()' AS note FROM items WHERE name=$1",
      [value],
    );
    expect(statement.sql).toBe(
      "SELECT 'true key LIMIT 1 now()' AS note FROM items WHERE name=@sdp_p1",
    );
    expect(statement.parameters).toEqual({ sdp_p1: value });
  });
  it('preserves separate thumbnail and outer page boundaries', () => {
    const statement = sqlServerStatement(
      'SELECT i.id,(SELECT thumbnail_key FROM item_images WHERE item_id=i.id ORDER BY is_primary DESC,sort_order,id LIMIT 1) AS image FROM items i ORDER BY i.name,i.id LIMIT $1 OFFSET $2',
      [12, 24],
    );
    expect(statement.sql).toContain('SELECT TOP (1) thumbnail_key');
    expect(statement.sql).toContain(
      'ORDER BY i.name,i.id OFFSET @sdp_p2 ROWS FETCH NEXT @sdp_p1 ROWS ONLY',
    );
    expect(statement.sql).not.toContain('[ROWS]');
  });
  it('guards conflict-safe idempotency inserts with a key-range lock', () => {
    const statement = sqlServerStatement(
      "INSERT INTO idempotency_records(actor_id,route,key,request_hash) VALUES ($1,'stock',$2,$3) ON CONFLICT DO NOTHING RETURNING id",
      ['actor', 'key', 'hash'],
    );
    expect(statement.sql).toContain('OUTPUT INSERTED.id SELECT');
    expect(statement.sql).toContain('WITH (UPDLOCK,HOLDLOCK)');
    expect(statement.sql).toContain("actor_id=@sdp_p1 AND route='stock' AND [key]=@sdp_p2");
    expect(() =>
      sqlServerStatement('INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING', ['x']),
    ).toThrow('Unsupported conflict-safe insert');
  });
  it('uses update locks and skips claimed worker rows', () => {
    expect(sqlServerStatement('SELECT id FROM items WHERE id=$1 FOR UPDATE', ['id']).sql).toContain(
      'FROM items WITH (UPDLOCK,HOLDLOCK,ROWLOCK)',
    );
    expect(
      sqlServerStatement('SELECT * FROM outbox ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED')
        .sql,
    ).toContain('SELECT TOP (1) * FROM outbox WITH (UPDLOCK,READPAST,ROWLOCK)');
  });
  it('uses transaction-owned application locks and native savepoints', () => {
    expect(sqlServerStatement('SELECT pg_advisory_xact_lock(781019)').sql).toContain(
      "@LockOwner='Transaction'",
    );
    expect(sqlServerStatement('SAVEPOINT import_row').sql).toBe('SAVE TRANSACTION import_row');
    expect(sqlServerStatement('ROLLBACK TO SAVEPOINT import_row').sql).toBe(
      'ROLLBACK TRANSACTION import_row',
    );
  });
  it('keeps UUID arrays as separately bound parameters and handles empty sets', () => {
    expect(
      sqlServerStatement('SELECT id FROM items WHERE id=ANY($1::uuid[])', [['a', 'b']]),
    ).toEqual({
      sql: 'SELECT id FROM items WHERE id IN (@sdp_p1_0,@sdp_p1_1)',
      parameters: { sdp_p1_0: 'a', sdp_p1_1: 'b' },
    });
    expect(sqlServerStatement('SELECT id FROM items WHERE id=ANY($1::uuid[])', [[]]).sql).toContain(
      'WHERE 1=0',
    );
  });
  it('preserves LIKE literal brackets and uses explicit case-insensitive matching', () => {
    const statement = sqlServerStatement('SELECT id FROM items WHERE name ILIKE $1', ['%Jig[1]%']);
    expect(statement.sql).toContain('COLLATE Latin1_General_100_CI_AS_SC LIKE @sdp_p1');
    expect(statement.parameters.sdp_p1).toBe('%Jig[[]1]%');
  });
  it('widens sums and handles empty conditional counts and date arithmetic', () => {
    const statement = sqlServerStatement(
      "SELECT count(*) FILTER(WHERE quantity=0)::int AS out,sum(quantity)::bigint::text AS units FROM stock_balances WHERE created_at<$1::date+interval '1 day'",
      ['2026-10-30'],
    );
    expect(statement.sql).toContain('COALESCE(SUM(CASE WHEN quantity=0 THEN 1 ELSE 0 END),0)');
    expect(statement.sql).toContain('SUM(CAST(quantity AS bigint))');
    expect(statement.sql).toContain('DATEADD(day,1,CAST(@sdp_p1 AS date))');
  });
  it('normalizes GUIDs, timestamps and JSON while keeping ordinary text unchanged', () => {
    expect(
      normalizeSqlServerRow({
        id: 'ABCDABCD-1234-1234-1234-ABCDABCDABCD',
        created_at: new Date('2026-10-30T00:00:00Z'),
        payload: '{"quantity":2}',
        note: 'true',
        sku: 'ABCDABCD-1234-1234-1234-ABCDABCDABCD',
      }),
    ).toEqual({
      id: 'abcdabcd-1234-1234-1234-abcdabcdabcd',
      created_at: '2026-10-30T00:00:00.000Z',
      payload: { quantity: 2 },
      note: 'true',
      sku: 'ABCDABCD-1234-1234-1234-ABCDABCDABCD',
    });
  });
  it('encrypts SQL Server connections by default and rejects missing database or credentials', () => {
    const config = sqlServerConfig('mssql://sdp_app:Example%21Password@localhost:1433/sdp');
    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(false);
    expect(config.password).toBe('Example!Password');
    expect(sqlServerConfig('mssql://u:p@localhost/sdp?instance=SQLEXPRESS').port).toBeUndefined();
    expect(() => sqlServerConfig('mssql://u:p@localhost:1433/sdp?instance=SQLEXPRESS')).toThrow(
      'not both',
    );
    expect(() => sqlServerConfig('mssql://localhost/sdp')).toThrow('credentials');
    expect(() => sqlServerConfig('mssql://u:p@localhost/')).toThrow('database');
  });
});
