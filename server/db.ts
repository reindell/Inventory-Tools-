import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export interface Sql {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}
export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'mssql' | 'postgres' | 'embedded';
}
export async function createDatabase(url = config.databaseUrl, memory = false): Promise<Database> {
  if (url && /^(mssql|sqlserver|mssql\+windows):/.test(url)) {
    const { createSqlServerDatabase } = await import('./sqlserver.js');
    return createSqlServerDatabase(url);
  }
  if (url) {
    if (!/^postgres(?:ql)?:/.test(url))
      throw new Error('Unsupported DATABASE_URL scheme. Use mssql:// for Microsoft SQL Server.');
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
    });
    const wrap = (client: Pick<pg.PoolClient, 'query'>): Sql => ({
      query: async <T>(sql: string, params: unknown[] = []) =>
        (await client.query(sql, params)).rows as T[],
      exec: async (sql) => {
        await client.query(sql);
      },
    });
    return {
      ...wrap(pool),
      kind: 'postgres',
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(wrap(client));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (config.production) throw new Error('Embedded database is forbidden in production.');
  const embedded = new PGlite(memory ? undefined : path.join(config.dataDir, 'postgres'));
  await embedded.waitReady;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const direct: Sql = {
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await embedded.query<T>(sql, params)).rows,
    exec: async (sql) => {
      await embedded.exec(sql);
    },
  };
  return {
    kind: 'embedded',
    query: (sql, params) => serialize(() => direct.query(sql, params)),
    exec: (sql) => serialize(() => direct.exec(sql)),
    transaction: (fn) =>
      serialize(async () => {
        await direct.exec('BEGIN');
        try {
          const result = await fn(direct);
          await direct.exec('COMMIT');
          return result;
        } catch (error) {
          await direct.exec('ROLLBACK');
          throw error;
        }
      }),
    close: () => serialize(() => embedded.close()),
  };
}
export async function migrate(db: Database) {
  if (db.kind === 'mssql') {
    await db.exec(
      "IF OBJECT_ID(N'dbo.schema_migrations',N'U') IS NULL CREATE TABLE dbo.schema_migrations(name nvarchar(255) NOT NULL PRIMARY KEY, applied_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());",
    );
    const directory = path.resolve('migrations/mssql');
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(781019)');
        if ((await tx.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).length)
          return;
        await tx.exec(await readFile(path.join(directory, name), 'utf8'));
        await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      });
    }
    return;
  }
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = path.resolve('migrations');
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(781019)');
      if ((await tx.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).length)
        return;
      await tx.exec(await readFile(path.join(directory, name), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    });
  }
}
export async function audit(
  tx: Sql,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown = null,
  after: unknown = null,
  requestId?: string,
) {
  await tx.query(
    'INSERT INTO audit_events(actor_id,action,entity_type,entity_id,before_data,after_data,request_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',
    [
      actorId,
      action,
      entity,
      entityId,
      JSON.stringify(before),
      JSON.stringify(after),
      requestId || null,
    ],
  );
}
