import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createDatabase, migrate, type Database } from '../server/db';
import { importSampleCatalog, loadSampleCatalog, sampleAvailable } from '../server/sample-catalog';
import { changeStock, getItem, reconcile } from '../server/inventory';
import { readStoredFile } from '../server/storage';
import sharp from 'sharp';

let db: Database;
let actor: string;
beforeAll(async () => {
  db = await createDatabase(process.env.TEST_DATABASE_URL || '', true);
  await migrate(db);
  const [user] = await db.query(
    "INSERT INTO users(email,name,password_hash,role) VALUES ($1,'Sample import test','not-a-login','Admin') RETURNING id",
    [`samples-${randomUUID()}@test.local`],
  );
  actor = user.id;
});
afterAll(async () => {
  await db?.close();
});

describe('SIP workbook sample catalog', () => {
  it('retains sheet/merged-row counts and maps all original embedded photos without treating totals as available stock', async () => {
    const catalog = await loadSampleCatalog();
    expect(catalog.items).toHaveLength(135);
    expect(catalog.items.filter((item) => item.photos.length)).toHaveLength(130);
    expect(new Set(catalog.items.map((item) => item.sheet)).size).toBe(12);
    expect(catalog.items.reduce((sum, item) => sum + sampleAvailable(item), 0)).toBe(276);
    const combined = catalog.items.find((item) => item.sku === 'SIP-DEBURRING-BLADE-003')!;
    expect(combined.rows).toEqual([3, 4]);
    expect(combined.name).toContain('MDPR.14 / MDPR.17');
    expect(sampleAvailable(combined)).toBe(16);
    expect(catalog.items.find((item) => item.sku === 'SIP-DEBURRING-BLADE-004')).toBeUndefined();
    const separate = catalog.items.find((item) => item.sku === 'SIP-DEBURRING-BLADE-008')!;
    expect(separate.inUse).toBeNull();
    expect(sampleAvailable(separate)).toBe(0);
    expect(catalog.warnings).toHaveLength(4);
    const inconsistent = catalog.items.find((item) => item.sku === 'SIP-SQUEEGEE-009')!;
    expect(inconsistent.total).toBe(0);
    expect(sampleAvailable(inconsistent)).toBe(20);
    const pictures = new Set(catalog.items.flatMap((item) => item.photos));
    expect(pictures.size).toBe(126);
    for (const photo of pictures) {
      const bytes = await readFile(path.resolve('samples/sip-assembly-jigs', photo));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        path.basename(photo).split('.')[0],
      );
    }
  });
  it('adds private photos and ledger-backed sample availability once, preserving later stock changes on rerun', async () => {
    const skus = ['SIP-3S-SBD-003', 'SIP-3S-SBD-004'];
    const imported = await importSampleCatalog(db, actor, { skus, withStock: true });
    expect(imported).toMatchObject({ created: 2, skipped: 0, photos: 2, availableUnitsAdded: 11 });
    const [row] = await db.query('SELECT id FROM items WHERE sku=$1', [skus[0]]);
    const item = await getItem(db, row.id);
    expect(item.quantity).toBe(8);
    expect(item.description).toContain('in use: 2; spare: 8');
    const [photo] = await db.query(
      'SELECT object_key,thumbnail_key FROM item_images WHERE item_id=$1',
      [item.id],
    );
    expect((await sharp(await readStoredFile(photo.object_key)).metadata()).format).toBe('webp');
    expect((await sharp(await readStoredFile(photo.thumbnail_key)).metadata()).width).toBe(160);
    await changeStock(
      db,
      {
        itemId: item.id,
        type: 'out',
        quantity: 1,
        expectedVersion: item.stock_version,
        reason: 'Sample import repeat test',
        note: '',
        direction: 'add',
        serials: [],
        outStatus: 'sold',
      },
      actor,
      'Admin',
      randomUUID(),
    );
    const repeated = await importSampleCatalog(db, actor, { skus, withStock: true });
    expect(repeated).toMatchObject({ created: 0, skipped: 2, photos: 0, availableUnitsAdded: 0 });
    expect((await getItem(db, item.id)).quantity).toBe(7);
    expect((await db.query('SELECT id FROM item_images WHERE item_id=$1', [item.id])).length).toBe(
      1,
    );
    expect(await reconcile(db)).toEqual([]);
  });
  it('supports catalog-only imports without assigning old in-use counts or granting import rights to Staff', async () => {
    const skus = ['SIP-DEBURRING-BLADE-003'];
    expect(await importSampleCatalog(db, actor, { skus, withStock: false })).toMatchObject({
      created: 1,
      availableUnitsAdded: 0,
    });
    const [row] = await db.query('SELECT id FROM items WHERE sku=$1', [skus[0]]);
    const item = await getItem(db, row.id);
    expect(item.quantity).toBe(0);
    expect(item.description).toContain('borrowers were not provided');
    expect(
      (await db.query('SELECT id FROM tool_requests WHERE item_id=$1', [item.id])).length,
    ).toBe(0);
    expect(await importSampleCatalog(db, actor, { skus, withStock: true })).toMatchObject({
      created: 0,
      skipped: 1,
    });
    expect((await getItem(db, item.id)).quantity).toBe(0);
    const [staff] = await db.query(
      "INSERT INTO users(email,name,password_hash,role) VALUES ($1,'Sample Staff','not-a-login','Staff') RETURNING id",
      [`samples-staff-${randomUUID()}@test.local`],
    );
    await expect(importSampleCatalog(db, staff.id, { skus })).rejects.toThrow('enabled Admin');
  });
});
