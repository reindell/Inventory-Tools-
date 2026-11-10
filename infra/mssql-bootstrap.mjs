import sql from 'mssql';
import { spawn } from 'node:child_process';
import process from 'node:process';

// Only the one-shot migration container receives SA/owner secrets. The web container
// connects with sdp_app and its restricted database role.
const server = process.env.SQLSERVER_SERVER || 'sqlserver';
const saPassword = process.env.SQLSERVER_SA_PASSWORD;
const ownerPassword = process.env.DB_PASSWORD;
const appPassword = process.env.APP_DB_PASSWORD;
const databasePasswords = [saPassword, ownerPassword, appPassword];
if (
  new Set(databasePasswords).size !== 3 ||
  databasePasswords.some((value) => !value || value.length < 12 || value.length > 128)
)
  throw new Error(
    'Set distinct SQLSERVER_SA_PASSWORD, DB_PASSWORD and APP_DB_PASSWORD values of 12–128 characters.',
  );
const trust = process.env.SQLSERVER_TRUST_SERVER_CERTIFICATE === 'true';
const options = { encrypt: true, trustServerCertificate: trust };
const master = await new sql.ConnectionPool({
  server,
  user: 'sa',
  password: saPassword,
  database: 'master',
  options,
}).connect();
try {
  await master
    .request()
    .batch("IF DB_ID(N'sdp') IS NULL CREATE DATABASE [sdp] COLLATE Latin1_General_100_BIN2;");
  for (const [login, password] of [
    ['sdp_owner', ownerPassword],
    ['sdp_app', appPassword],
  ]) {
    const request = master.request();
    request.input('login_name', sql.NVarChar(128), login);
    request.input('login_password', sql.NVarChar(128), password);
    await request.query(
      "IF SUSER_ID(@login_name) IS NULL BEGIN DECLARE @statement nvarchar(max)=N'CREATE LOGIN '+QUOTENAME(@login_name)+N' WITH PASSWORD='+QUOTENAME(@login_password,'''')+N',CHECK_POLICY=ON,CHECK_EXPIRATION=OFF'; EXEC sys.sp_executesql @statement; END;",
    );
  }
} finally {
  await master.close();
}
const owner = await new sql.ConnectionPool({
  server,
  user: 'sa',
  password: saPassword,
  database: 'sdp',
  options,
}).connect();
try {
  await owner
    .request()
    .batch(
      "IF DATABASE_PRINCIPAL_ID(N'sdp_owner') IS NULL CREATE USER sdp_owner FOR LOGIN sdp_owner; ALTER ROLE db_owner ADD MEMBER sdp_owner; IF DATABASE_PRINCIPAL_ID(N'sdp_app') IS NULL CREATE USER sdp_app FOR LOGIN sdp_app; IF DATABASE_PRINCIPAL_ID(N'sdp_runtime') IS NULL CREATE ROLE sdp_runtime AUTHORIZATION dbo; ALTER ROLE sdp_runtime ADD MEMBER sdp_app;",
    );
} finally {
  await owner.close();
}
const databaseUrl = `mssql://sdp_owner:${encodeURIComponent(ownerPassword)}@${server}:1433/sdp?encrypt=true&trustServerCertificate=${trust}`;
const child = spawn(process.execPath, ['dist-server/cli.js', 'setup'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
});
child.once('error', () => {
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
