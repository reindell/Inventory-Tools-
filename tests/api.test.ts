import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createDatabase, migrate, type Database } from '../server/db';
import { createApp } from '../server/app';
import { changeStock, reconcile, saveItem } from '../server/inventory';
import { identity, type ItemInput } from '../shared/contracts';
import { validateSvg } from '../server/images';
import { safeCell } from '../server/reports';
import { startWorker } from '../server/worker';
import { hashToken } from '../server/security';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config';

let db: Database;
let app: ReturnType<typeof createApp>;
let admin: any;
let viewer: any;
let staff: any;
let adminId: string;
const fixture: ItemInput = {
  name: 'Test rectifier',
  sku: 'TEST-001',
  barcode: '123456789',
  category: 'Semiconductors',
  supplier: 'Test supplier',
  description: '',
  reorderLevel: 5,
  serialized: false,
};
async function session(email: string) {
  const agent = request.agent(app);
  const csrf = await agent.get('/api/v1/auth/csrf');
  const headers = { Origin: 'http://localhost:5173', 'X-CSRF-Token': csrf.body.token };
  const login = await agent
    .post('/api/v1/auth/login')
    .set(headers)
    .send({ email, password: 'Testing-password-123' });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return {
    agent,
    headers: { ...headers, Authorization: `Bearer ${login.body.token}` },
    user: login.body.user,
  };
}
beforeAll(async () => {
  // TEST_DATABASE_URL must refer to an isolated disposable test database.
  db = await createDatabase(process.env.TEST_DATABASE_URL || '', true);
  await migrate(db);
  app = createApp(db);
  const hash = await bcrypt.hash('Testing-password-123', 4);
  for (const [email, role] of [
    ['admin@test.local', 'Admin'],
    ['viewer@test.local', 'Viewer'],
    ['staff@test.local', 'Staff'],
  ])
    await db.query('INSERT INTO users(email,name,password_hash,role) VALUES ($1,$2,$3,$4)', [
      email,
      role,
      hash,
      role,
    ]);
  admin = await session('admin@test.local');
  viewer = await session('viewer@test.local');
  staff = await session('staff@test.local');
  adminId = admin.user.id;
});
afterAll(async () => {
  await db.close();
});
describe('security boundaries', () => {
  it('rejects unauthorized reads and missing CSRF', async () => {
    expect((await request(app).get('/api/v1/items')).status).toBe(401);
    expect(
      (
        await admin.agent
          .post('/api/v1/items')
          .set('Authorization', admin.headers.Authorization)
          .send(fixture)
      ).status,
    ).toBe(403);
  });
  it('enforces Viewer and Staff roles on server', async () => {
    expect(
      (await viewer.agent.post('/api/v1/items').set(viewer.headers).send(fixture)).status,
    ).toBe(403);
    expect((await staff.agent.patch('/api/v1/settings').set(staff.headers).send({})).status).toBe(
      403,
    );
    expect((await viewer.agent.get('/api/v1/users').set(viewer.headers)).status).toBe(403);
    expect(
      (
        await viewer.agent
          .post('/api/v1/settings/logo')
          .set(viewer.headers)
          .attach('file', Buffer.from('bad'), 'bad.svg')
      ).status,
    ).toBe(403);
  });
  it('prevents demoting the final Admin', async () => {
    const res = await admin.agent
      .patch(`/api/v1/users/${adminId}`)
      .set(admin.headers)
      .send({ role: 'Viewer', enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
  });
  it('rejects malicious SVG constructs and accepts simple paths', () => {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<svg><image href="https://example.com/a"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
      '<svg><path style="fill:red"/></svg>',
    ])
      expect(() => validateSvg(Buffer.from(svg))).toThrow();
    expect(() =>
      validateSvg(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><path d="M0 0L20 20" fill="#000"/></svg>',
        ),
      ),
    ).not.toThrow();
  });
  it('escapes spreadsheet formula cells', () => {
    expect(safeCell(' =SUM(1,2)')).toBe("' =SUM(1,2)");
    expect(safeCell('@cmd')).toBe("'@cmd");
    expect(safeCell('Part 123')).toBe('Part 123');
  });
  it('normalizes identities consistently', () => {
    expect(identity('  ａｂｃ-01 ')).toBe('ABC-01');
  });
});
describe('inventory and ledger', () => {
  let item: any;
  it('creates, finds and edits a real item with version checking', async () => {
    const response = await admin.agent.post('/api/v1/items').set(admin.headers).send(fixture);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    item = response.body;
    expect(item.quantity).toBe(0);
    expect(item).not.toHaveProperty('unit_price');
    expect(item).not.toHaveProperty('unit_cost');
    const [createdAmounts] = await db.query('SELECT unit_price,unit_cost FROM items WHERE id=$1', [
      item.id,
    ]);
    expect(Number(createdAmounts.unit_price)).toBe(0);
    expect(Number(createdAmounts.unit_cost)).toBe(0);
    const duplicate = await admin.agent
      .post('/api/v1/items')
      .set(admin.headers)
      .send({ ...fixture, sku: 'test-001' });
    expect(duplicate.status).toBe(409);
    const check = await admin.agent
      .get('/api/v1/items/check-identity?sku=TEST-001')
      .set(admin.headers);
    expect(check.body.skuExists).toBe(true);
    const list = await admin.agent.get('/api/v1/items?q=rectifier&pageSize=1').set(admin.headers);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).not.toHaveProperty('unit_price');
    expect(list.body.data[0]).not.toHaveProperty('unit_cost');
    // Existing installations retain their stored amounts when editing the new quantity-only form.
    await db.query('UPDATE items SET unit_price=5.50,unit_cost=2.25 WHERE id=$1', [item.id]);
    const edited = await admin.agent
      .patch(`/api/v1/items/${item.id}`)
      .set(admin.headers)
      .send({ ...fixture, name: 'Updated rectifier', version: item.version });
    expect(edited.status).toBe(200);
    item = edited.body;
    expect(item).not.toHaveProperty('unit_price');
    expect(item).not.toHaveProperty('unit_cost');
    const [preservedAmounts] = await db.query(
      'SELECT unit_price,unit_cost FROM items WHERE id=$1',
      [item.id],
    );
    expect(Number(preservedAmounts.unit_price)).toBe(5.5);
    expect(Number(preservedAmounts.unit_cost)).toBe(2.25);
    const detail = await admin.agent.get(`/api/v1/items/${item.id}`).set(admin.headers);
    expect(detail.status).toBe(200);
    expect(detail.body.item).not.toHaveProperty('unit_price');
    expect(detail.body.item).not.toHaveProperty('unit_cost');
    expect(
      (
        await admin.agent
          .patch(`/api/v1/items/${item.id}`)
          .set(admin.headers)
          .send({ ...fixture, version: 1 })
      ).status,
    ).toBe(409);
  });
  it('commits stock and returns the same response on key replay', async () => {
    const key = randomUUID();
    const body = {
      itemId: item.id,
      type: 'in',
      quantity: 10,
      reason: 'Test receipt',
      expectedVersion: item.stock_version,
    };
    const first = await admin.agent
      .post('/api/v1/stock')
      .set(admin.headers)
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    item = first.body.item;
    expect(item).not.toHaveProperty('unit_price');
    expect(item).not.toHaveProperty('unit_cost');
    expect(first.body.movement).not.toHaveProperty('unit_cost_snapshot');
    const second = await admin.agent
      .post('/api/v1/stock')
      .set(admin.headers)
      .set('Idempotency-Key', key)
      .send(body);
    expect(second.body.movement.id).toBe(first.body.movement.id);
    const conflict = await admin.agent
      .post('/api/v1/stock')
      .set(admin.headers)
      .set('Idempotency-Key', key)
      .send({ ...body, quantity: 11 });
    expect(conflict.status).toBe(409);
    expect(
      (await db.query('SELECT quantity FROM stock_balances WHERE item_id=$1', [item.id]))[0]
        .quantity,
    ).toBe(10);
  });
  it('rejects negative stock, unknown locations, and Staff adjustments', async () => {
    const body = {
      itemId: item.id,
      type: 'out',
      quantity: 11,
      reason: 'Test issue',
      expectedVersion: item.stock_version,
    };
    const response = await admin.agent
      .post('/api/v1/stock')
      .set(admin.headers)
      .set('Idempotency-Key', randomUUID())
      .send(body);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(
      (
        await admin.agent
          .post('/api/v1/stock')
          .set(admin.headers)
          .set('Idempotency-Key', randomUUID())
          .send({ ...body, quantity: 1, locationId: 2 })
      ).status,
    ).toBe(422);
    expect(
      (
        await staff.agent
          .post('/api/v1/stock')
          .set(staff.headers)
          .set('Idempotency-Key', randomUUID())
          .send({ ...body, type: 'adjustment', quantity: 1 })
      ).status,
    ).toBe(403);
    await expect(db.query("INSERT INTO locations(id,name) VALUES (2,'Other')")).rejects.toThrow();
  });
  it('prevents concurrent withdrawals from overselling and reconciles', async () => {
    const data = {
      itemId: item.id,
      type: 'out' as const,
      quantity: 7,
      reason: 'Concurrent stock issue',
      expectedVersion: item.stock_version,
      direction: 'add' as const,
      serials: [],
      note: '',
      outStatus: 'sold' as const,
    };
    const results = await Promise.allSettled([
      changeStock(db, data, adminId, 'Admin', randomUUID()),
      changeStock(db, data, adminId, 'Admin', randomUUID()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await db.query('SELECT quantity FROM stock_balances WHERE item_id=$1', [item.id]))[0]
        .quantity,
    ).toBe(3);
    expect(await reconcile(db)).toEqual([]);
  });
  it('keeps ledger and audit history immutable', async () => {
    await expect(
      db.query("UPDATE stock_movements SET reason='changed' WHERE item_id=$1", [item.id]),
    ).rejects.toThrow();
    await expect(
      db.query('DELETE FROM audit_events WHERE entity_id=$1', [item.id]),
    ).rejects.toThrow();
  });
  it('blocks archive with stock and can archive/restore a zero-stock item', async () => {
    expect(
      (await admin.agent.post(`/api/v1/items/${item.id}/archive`).set(admin.headers).send({}))
        .status,
    ).toBe(409);
    const fresh = (await admin.agent.get(`/api/v1/items/${item.id}`).set(admin.headers)).body.item;
    expect(
      (
        await admin.agent
          .post('/api/v1/stock')
          .set(admin.headers)
          .set('Idempotency-Key', randomUUID())
          .send({
            itemId: item.id,
            type: 'out',
            quantity: 3,
            reason: 'Final issue',
            expectedVersion: fresh.stock_version,
          })
      ).status,
    ).toBe(201);
    expect(
      (await admin.agent.post(`/api/v1/items/${item.id}/archive`).set(admin.headers).send({}))
        .status,
    ).toBe(204);
    expect(
      (await admin.agent.post(`/api/v1/items/${item.id}/restore`).set(admin.headers).send({}))
        .status,
    ).toBe(204);
  });
  it('validates serial counts, uniqueness and state transitions atomically', async () => {
    const serialized = await db.transaction((tx) =>
      saveItem(tx, { ...fixture, sku: 'SERIAL-01', barcode: '', serialized: true }, adminId),
    );
    const body = {
      itemId: serialized.id,
      type: 'in' as const,
      quantity: 2,
      expectedVersion: serialized.stock_version,
      reason: 'Serialized receipt',
      note: '',
      direction: 'add' as const,
      serials: ['SER-1', 'SER-1'],
      outStatus: 'sold' as const,
    };
    await expect(changeStock(db, body, adminId, 'Admin', randomUUID())).rejects.toThrow(
      'different serial',
    );
    const result = await changeStock(
      db,
      { ...body, serials: ['SER-1', 'SER-2'] },
      adminId,
      'Admin',
      randomUUID(),
    );
    await expect(
      changeStock(
        db,
        {
          ...body,
          type: 'out',
          serials: ['SER-1', 'MISSING'],
          expectedVersion: result.item.stock_version,
        },
        adminId,
        'Admin',
        randomUUID(),
      ),
    ).rejects.toThrow('not available');
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM serial_units WHERE item_id=$1 AND status='in_stock'",
          [serialized.id],
        )
      )[0].count,
    ).toBe(2);
    expect(await reconcile(db)).toEqual([]);
  });
});
describe('brand, uploads and reports', () => {
  it('serves bundled Shindengen artwork and audits a valid rasterized logo replacement', async () => {
    const before = await request(app).get('/api/v1/settings/branding');
    expect(before.status).toBe(200);
    expect(before.body.companyName).toBe('SHINDENGEN ELECTRIC MFG.CO.,LTD');
    expect(before.body).not.toHaveProperty('currency');
    expect(before.body.logoUrl).toBeNull();
    expect(before.body.fullLogoUrl).toBe('/brand/sdp-logo.svg');
    expect(before.body.markUrl).toBe('/brand/sdp-mark.png');
    const bundledLogo = await request(app).get('/api/v1/settings/brand-logo');
    expect(bundledLogo.status).toBe(200);
    expect(bundledLogo.type).toBe('image/png');
    const bundledMetadata = await sharp(bundledLogo.body).metadata();
    expect(bundledMetadata.width).toBeGreaterThan(0);
    expect(bundledMetadata.height).toBeGreaterThan(0);
    const bundledStats = await sharp(bundledLogo.body).stats();
    expect(bundledStats.channels.some((channel) => channel.max > channel.min)).toBe(true);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#1D4ED8"/></svg>',
    );
    const response = await admin.agent
      .post('/api/v1/settings/logo')
      .set(admin.headers)
      .attach('file', svg, 'company.svg');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.logoUrl).toContain('/brand-logo');
    const logo = await request(app).get(response.body.logoUrl);
    expect(logo.type).toBe('image/png');
    const metadata = await sharp(logo.body).metadata();
    expect(metadata.format).toBe('png');
    expect(
      (await db.query("SELECT id FROM audit_events WHERE action='branding.logo_replaced'")).length,
    ).toBe(1);
    const bad = await admin.agent
      .post('/api/v1/settings/logo')
      .set(admin.headers)
      .attach('file', Buffer.from('<svg onload="alert(1)"></svg>'), 'logo.svg');
    expect(bad.status).toBe(422);
    const spoof = await admin.agent
      .post('/api/v1/settings/logo')
      .set(admin.headers)
      .attach('file', Buffer.from('not an image'), {
        filename: 'logo.png',
        contentType: 'image/png',
      });
    expect(spoof.status).toBe(422);
  });
  it('uploads at most five item images, selects primary, and removes safely', async () => {
    const item = await db.transaction((tx) =>
      saveItem(tx, { ...fixture, sku: 'IMAGE-TEST', barcode: '' }, adminId),
    );
    const bytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#1D4ED8' },
    })
      .png()
      .toBuffer();
    let images: any[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await admin.agent
        .post(`/api/v1/items/${item.id}/images`)
        .set(admin.headers)
        .attach('file', bytes, 'part.png');
      expect(response.status).toBe(201);
      images = response.body;
    }
    expect(
      (
        await admin.agent
          .post(`/api/v1/items/${item.id}/images`)
          .set(admin.headers)
          .attach('file', bytes, 'part.png')
      ).status,
    ).toBe(422);
    expect(
      (
        await admin.agent
          .patch(`/api/v1/items/${item.id}/images`)
          .set(admin.headers)
          .send({ ids: images.map((image) => image.id).reverse(), primaryId: images[4].id })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.agent
          .delete(`/api/v1/items/${item.id}/images/${images[4].id}`)
          .set(admin.headers)
      ).status,
    ).toBe(204);
    expect(
      (await db.query('SELECT id FROM item_images WHERE item_id=$1 AND is_primary=true', [item.id]))
        .length,
    ).toBe(1);
  });
  it('keeps company details fixed when an Admin attempts to change them', async () => {
    const settingsQuery =
      'SELECT c.company_name,c.timezone,c.brand_version,l.name AS location_name FROM company_settings c CROSS JOIN locations l WHERE c.id=1 AND l.id=1';
    const before = await db.query(settingsQuery);
    const response = await admin.agent.patch('/api/v1/settings').set(admin.headers).send({
      companyName: 'Another Company',
      locationName: 'Another Production',
      timezone: 'UTC',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(405);
    expect(response.body.error.code).toBe('COMPANY_DETAILS_FIXED');
    expect(await db.query(settingsQuery)).toEqual(before);
  });
  it('keeps Shindengen branding when legacy settings contain another company name', async () => {
    const [before] = await db.query('SELECT company_name FROM company_settings WHERE id=1');
    try {
      await db.query('UPDATE company_settings SET company_name=$1 WHERE id=1', ['Legacy Company']);
      const publicBrand = await request(app).get('/api/v1/settings/branding');
      expect(publicBrand.status).toBe(200);
      expect(publicBrand.body.companyName).toBe('SHINDENGEN ELECTRIC MFG.CO.,LTD');
      const settings = await admin.agent.get('/api/v1/settings').set(admin.headers);
      expect(settings.status).toBe(200);
      expect(settings.body.companyName).toBe('SHINDENGEN ELECTRIC MFG.CO.,LTD');
    } finally {
      await db.query('UPDATE company_settings SET company_name=$1 WHERE id=1', [
        before.company_name,
      ]);
    }
  });
  it('generates a real branded PDF and CSV', async () => {
    const pdf = await admin.agent.post('/api/v1/reports/stock').set(admin.headers).send({});
    expect(pdf.status, JSON.stringify(pdf.body)).toBe(200);
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    const csv = await admin.agent.get('/api/v1/exports/items.csv').set(admin.headers);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('sku,name,barcode');
    expect(csv.text).not.toContain('unit_price');
    expect(csv.text).not.toContain('unit_cost');
    const dashboard = await admin.agent.get('/api/v1/dashboard').set(admin.headers);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.totals).not.toHaveProperty('value');
    expect(dashboard.body.totals.items).toBeGreaterThan(0);
  });
  it('previews and commits CSV once with row errors', async () => {
    const csv =
      'name,sku,category,reorder_level\nImported diode,IMPORT-001,Semiconductors,5\nDuplicate diode,IMPORT-001,Semiconductors,5\n';
    const preview = await admin.agent
      .post('/api/v1/imports/items')
      .set(admin.headers)
      .attach('file', Buffer.from(csv), 'items.csv');
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    expect(preview.body.validRows).toBe(1);
    expect(preview.body.errors).toHaveLength(1);
    const commit = await admin.agent
      .post(`/api/v1/imports/${preview.body.id}/commit`)
      .set(admin.headers)
      .send({});
    expect(commit.status).toBe(200);
    expect(commit.body.accepted).toBe(1);
    const repeat = await admin.agent
      .post(`/api/v1/imports/${preview.body.id}/commit`)
      .set(admin.headers)
      .send({});
    expect(repeat.body).toEqual(commit.body);
  });
  it('imports a legacy price CSV without applying its monetary values', async () => {
    const csv =
      'name,sku,category,unit_price,unit_cost,reorder_level\nLegacy diode,IMPORT-LEGACY,Semiconductors,99.50,45.25,5\n';
    const preview = await admin.agent
      .post('/api/v1/imports/items')
      .set(admin.headers)
      .attach('file', Buffer.from(csv), 'legacy-items.csv');
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    expect(preview.body.validRows).toBe(1);
    expect(preview.body.errors).toEqual([]);
    const commit = await admin.agent
      .post(`/api/v1/imports/${preview.body.id}/commit`)
      .set(admin.headers)
      .send({});
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    expect(commit.body.accepted).toBe(1);
    const [imported] = await db.query('SELECT unit_price,unit_cost FROM items WHERE sku=$1', [
      'IMPORT-LEGACY',
    ]);
    expect(Number(imported.unit_price)).toBe(0);
    expect(Number(imported.unit_cost)).toBe(0);
  });
});
describe('session lifecycle', () => {
  it('issues branded reset email, consumes the token once and revokes sessions', async () => {
    const active = await session('viewer@test.local');
    const known = await active.agent
      .post('/api/v1/auth/forgot-password')
      .set(active.headers)
      .send({ email: 'viewer@test.local' });
    const unknown = await active.agent
      .post('/api/v1/auth/forgot-password')
      .set(active.headers)
      .send({ email: 'missing@test.local' });
    expect(known.body).toEqual(unknown.body);
    const [job] = await db.query(
      "SELECT * FROM outbox WHERE type='password-reset' ORDER BY created_at DESC LIMIT 1",
    );
    const reset = job.payload.token;
    const [stored] = await db.query('SELECT * FROM reset_tokens WHERE token_hash=$1', [
      hashToken(reset),
    ]);
    expect(stored.token_hash).not.toBe(reset);
    const worker = startWorker(db);
    try {
      for (let count = 0; count < 10; count++) {
        await worker.tick();
        const [state] = await db.query('SELECT state FROM outbox WHERE id=$1', [job.id]);
        if (state.state === 'sent') break;
      }
    } finally {
      await worker.stop();
    }
    const [sent] = await db.query('SELECT state,payload FROM outbox WHERE id=$1', [job.id]);
    expect(sent.state).toBe('sent');
    expect(sent.payload).toEqual({});
    const email = await readFile(path.join(config.dataDir, 'mail', `${job.id}-0.eml`), 'utf8');
    expect(email).toContain('SDP Inventory');
    expect(email).toMatch(/Content-ID:\s*<sdp-logo>/i);
    const res = await active.agent
      .post('/api/v1/auth/reset-password')
      .set(active.headers)
      .send({ token: reset, password: 'Replacement-password-456' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await active.agent.get('/api/v1/items').set(active.headers)).status).toBe(401);
    expect(
      (
        await active.agent
          .post('/api/v1/auth/reset-password')
          .set(active.headers)
          .send({ token: reset, password: 'Replacement-password-456' })
      ).status,
    ).toBe(422);
    // Restore the fixture password so the following independent lifecycle check can sign in.
    await db.query('UPDATE users SET password_hash=$1 WHERE email=$2', [
      await bcrypt.hash('Testing-password-123', 4),
      'viewer@test.local',
    ]);
  });
  it('accepts invitations once and revokes access after an Admin role change', async () => {
    const invite = await admin.agent
      .post('/api/v1/users/invitations')
      .set(admin.headers)
      .send({ email: 'invited@test.local', role: 'Staff' });
    expect(invite.status).toBe(201);
    const [job] = await db.query(
      "SELECT payload FROM outbox WHERE type='invitation' ORDER BY created_at DESC LIMIT 1",
    );
    const body = {
      token: job.payload.token,
      name: 'Invited person',
      password: 'Testing-password-123',
    };
    expect(
      (await admin.agent.post('/api/v1/auth/accept-invitation').set(admin.headers).send(body))
        .status,
    ).toBe(201);
    expect(
      (await admin.agent.post('/api/v1/auth/accept-invitation').set(admin.headers).send(body))
        .status,
    ).toBe(422);
    const active = await session('invited@test.local');
    expect(
      (
        await admin.agent
          .patch(`/api/v1/users/${active.user.id}`)
          .set(admin.headers)
          .send({ role: 'Viewer', enabled: true })
      ).status,
    ).toBe(204);
    expect((await active.agent.get('/api/v1/items').set(active.headers)).status).toBe(401);
  });
  it('rotates refresh cookies and revokes a family on token reuse', async () => {
    const active = await session('viewer@test.local');
    const original = await active.agent.post('/api/v1/auth/refresh').set(active.headers).send({});
    expect(original.status).toBe(200);
    const rotatedCookie = original.headers['set-cookie'][0].split(';')[0];
    const second = await active.agent.post('/api/v1/auth/refresh').set(active.headers).send({});
    expect(second.status).toBe(200);
    const csrfResponse = await request(app).get('/api/v1/auth/csrf');
    const csrfCookie = csrfResponse.headers['set-cookie'][0].split(';')[0];
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfResponse.body.token)
      .set('Cookie', [rotatedCookie, csrfCookie])
      .send({});
    expect(reuse.status).toBe(401);
    expect(
      (await active.agent.get('/api/v1/items').set('Authorization', `Bearer ${second.body.token}`))
        .status,
    ).toBe(401);
  });
});
