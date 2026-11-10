import sql from 'mssql';
import type { config as ConnectionConfig } from 'mssql';
import type { Database, Sql } from './db.js';
import { normalizeSqlServerRow, sqlServerStatement } from './sqlserver-dialect.js';

export function sqlServerConfig(
  connection: string,
): ConnectionConfig & { connectionString?: string } {
  const url = new URL(connection);
  if (!['mssql:', 'sqlserver:', 'mssql+windows:'].includes(url.protocol))
    throw new Error('Use an mssql:// or mssql+windows:// SQL Server URL.');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || !/^[\w-]{1,128}$/.test(database))
    throw new Error('Specify a valid SQL Server database name.');
  const instance = url.searchParams.get('instance') || undefined;
  if (instance && url.port)
    throw new Error('Specify a SQL Server instance name or port, not both.');
  const encrypt = url.searchParams.get('encrypt') !== 'false';
  const trustServerCertificate = url.searchParams.get('trustServerCertificate') === 'true';
  if (url.protocol === 'mssql+windows:') {
    if (process.platform !== 'win32')
      throw new Error(
        'Windows integrated authentication requires Windows; use a SQL Server login in Docker.',
      );
    if (url.username || url.password)
      throw new Error('Do not include credentials in a Windows-authentication URL.');
    if (!/^[\w.-]+$/.test(url.hostname) || (instance && !/^[\w-]+$/.test(instance)))
      throw new Error('Invalid Windows SQL Server address.');
    const server = instance
      ? `${url.hostname}\\${instance}`
      : `${url.hostname},${url.port || '1433'}`;
    return {
      server: url.hostname,
      connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${server};Database=${database};Trusted_Connection=yes;Encrypt=${encrypt ? 'yes' : 'no'};TrustServerCertificate=${trustServerCertificate ? 'yes' : 'no'};`,
      connectionTimeout: 10000,
      requestTimeout: 15000,
      options: { useUTC: true, enableArithAbort: true },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    };
  }
  if (!url.username || !url.password) throw new Error('SQL Server login credentials are required.');
  return {
    server: url.hostname,
    ...(instance ? {} : { port: url.port ? Number(url.port) : 1433 }),
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectionTimeout: 10000,
    requestTimeout: 15000,
    options: {
      encrypt,
      trustServerCertificate,
      useUTC: true,
      enableArithAbort: true,
      ...(instance ? { instanceName: instance } : {}),
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
}

export async function createSqlServerDatabase(connection: string): Promise<Database> {
  // The native driver is optional and loaded only for an explicitly selected Windows URL.
  // Linux/Docker always uses the portable, pure-JS Tedious driver shipped with node-mssql.
  const driver: typeof sql = connection.startsWith('mssql+windows:')
    ? (await import('mssql/msnodesqlv8.js')).default
    : sql;
  const pool = await new driver.ConnectionPool(sqlServerConfig(connection)).connect();
  const wrap = (owner: sql.ConnectionPool | sql.Transaction): Sql => ({
    query: async <T>(source: string, params: unknown[] = []) => {
      const statement = sqlServerStatement(source, params);
      const request = owner.request();
      for (const [key, value] of Object.entries(statement.parameters)) {
        if (value === undefined || value === null) request.input(key, driver.NVarChar, null);
        else if (typeof value === 'boolean') request.input(key, driver.Bit, value);
        else if (typeof value === 'number')
          request.input(key, Number.isInteger(value) ? driver.BigInt : driver.Float, value);
        else if (value instanceof Date) request.input(key, driver.DateTime2, value);
        else
          request.input(
            key,
            driver.NVarChar(driver.MAX),
            typeof value === 'string' ? value : JSON.stringify(value),
          );
      }
      const result = await request.query(statement.sql);
      return (result.recordset || []).map(normalizeSqlServerRow) as T[];
    },
    exec: async (source) => {
      // Migration batches are already authored in native T-SQL. SAVEPOINT operations are
      // the only portable exec statements emitted by normal application code.
      if (/^(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/i.test(source.trim())) {
        await owner.request().query(sqlServerStatement(source).sql);
      } else {
        for (const batch of source.split(/^\s*GO\s*$/gim).filter((part) => part.trim()))
          await owner.request().batch(batch);
      }
    },
  });
  return {
    ...wrap(pool),
    kind: 'mssql',
    transaction: async (work) => {
      const transaction = new driver.Transaction(pool);
      let aborted = false;
      transaction.on('rollback', () => {
        aborted = true;
      });
      await transaction.begin(driver.ISOLATION_LEVEL.READ_COMMITTED);
      try {
        const result = await work(wrap(transaction));
        await transaction.commit();
        return result;
      } catch (error) {
        if (!aborted) await transaction.rollback().catch(() => {});
        throw error;
      }
    },
    close: () => pool.close(),
  };
}
