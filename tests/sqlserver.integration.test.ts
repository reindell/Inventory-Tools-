import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDatabase, migrate, type Database } from '../server/db';

const url = process.env.TEST_DATABASE_URL || '';
describe.skipIf(!/^(mssql|sqlserver|mssql\+windows):/.test(url))(
  'native SQL Server permissions',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = await createDatabase(url);
      await migrate(db);
    });
    afterAll(async () => {
      await db?.close();
    });
    it('denies runtime history and schema writes while permitting ordinary inventory work', async () => {
      const user = `sdp_probe_${randomBytes(6).toString('hex')}`;
      await db.exec(
        `CREATE USER [${user}] WITHOUT LOGIN; ALTER ROLE sdp_runtime ADD MEMBER [${user}];`,
      );
      try {
        const [permissions] =
          await db.query(`DECLARE @checks TABLE (history_update int,history_delete int,request_history_update int,schema_write int,inventory_update int);
EXECUTE AS USER='${user}';
BEGIN TRY
INSERT INTO @checks SELECT HAS_PERMS_BY_NAME('dbo.stock_movements','OBJECT','UPDATE'),HAS_PERMS_BY_NAME('dbo.audit_events','OBJECT','DELETE'),HAS_PERMS_BY_NAME('dbo.request_events','OBJECT','UPDATE'),HAS_PERMS_BY_NAME('dbo.schema_migrations','OBJECT','INSERT'),HAS_PERMS_BY_NAME('dbo.items','OBJECT','UPDATE');
REVERT;
END TRY BEGIN CATCH REVERT; THROW; END CATCH;
SELECT * FROM @checks;`);
        expect(permissions).toEqual({
          history_update: 0,
          history_delete: 0,
          request_history_update: 0,
          schema_write: 0,
          inventory_update: 1,
        });
      } finally {
        await db.exec(`DROP USER [${user}];`);
      }
    });
  },
);
