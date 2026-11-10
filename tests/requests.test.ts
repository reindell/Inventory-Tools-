import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createDatabase, migrate, type Database } from '../server/db';
import { createApp } from '../server/app';
import { reconcile } from '../server/inventory';
import type { Item, Role, User } from '../shared/contracts';
import type { ToolRequest } from '../shared/requests';

type Session = {
  agent: ReturnType<typeof request.agent>;
  headers: Record<string, string>;
  user: User;
};
let db: Database;
let app: ReturnType<typeof createApp>;
let admin: Session;
let requester: Session;
let other: Session;
let manager: Session;
let viewer: Session;
const run = randomUUID().slice(0, 8);
const password = 'Request-testing-password-123';

async function session(role: Role, suffix: string = role): Promise<Session> {
  const email = `requests-${run}-${suffix.toLowerCase().replace(/\W+/g, '-')}@test.local`;
  await db.query('INSERT INTO users(email,name,password_hash,role) VALUES ($1,$2,$3,$4)', [
    email,
    `Request ${suffix} ${run}`,
    await bcrypt.hash(password, 4),
    role,
  ]);
  const agent = request.agent(app);
  const csrf = await agent.get('/api/v1/auth/csrf');
  const headers = { Origin: 'http://localhost:5173', 'X-CSRF-Token': csrf.body.token };
  const login = await agent.post('/api/v1/auth/login').set(headers).send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return {
    agent,
    headers: { ...headers, Authorization: `Bearer ${login.body.token}` },
    user: login.body.user,
  };
}

async function item(quantity = 8, serials: string[] = []): Promise<Item> {
  const suffix = randomUUID().slice(0, 8);
  const created = await admin.agent
    .post('/api/v1/items')
    .set(admin.headers)
    .send({
      name: `Assembly jig ${suffix}`,
      sku: `JIG-${run}-${suffix}`,
      category: 'Tools and jigs',
      reorderLevel: 0,
      serialized: serials.length > 0,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (!quantity) return created.body;
  const received = await admin.agent
    .post('/api/v1/stock')
    .set(admin.headers)
    .set('Idempotency-Key', randomUUID())
    .send({
      itemId: created.body.id,
      type: 'in',
      quantity,
      reason: 'Request workflow test receipt',
      expectedVersion: created.body.stock_version,
      serials,
    });
  expect(received.status, JSON.stringify(received.body)).toBe(201);
  return received.body.item;
}

async function submit(
  tool: Item,
  quantity = 2,
  actor = requester,
  key = randomUUID(),
): Promise<ToolRequest> {
  const response = await actor.agent
    .post('/api/v1/requests')
    .set(actor.headers)
    .set('Idempotency-Key', key)
    .send({ itemId: tool.id, quantity, purpose: 'Production assembly setup' });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

async function approve(value: ToolRequest): Promise<ToolRequest> {
  const response = await admin.agent
    .post(`/api/v1/requests/${value.id}/approve`)
    .set(admin.headers)
    .send({ version: value.version, note: 'Approved for production' });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

function stockAction(
  value: ToolRequest,
  action: 'issue' | 'return',
  quantity: number,
  key = randomUUID(),
  serials: string[] = [],
) {
  return admin.agent
    .post(`/api/v1/requests/${value.id}/${action}`)
    .set(admin.headers)
    .set('Idempotency-Key', key)
    .send({ version: value.version, quantity, serials, note: 'Handled at the tool desk' });
}

async function quantity(tool: Item) {
  const detail = await admin.agent.get(`/api/v1/items/${tool.id}`).set(admin.headers);
  expect(detail.status).toBe(200);
  return detail.body.item.quantity as number;
}

beforeAll(async () => {
  // A configured SQL URL must identify an isolated, disposable test database.
  db = await createDatabase(process.env.TEST_DATABASE_URL || '', true);
  await migrate(db);
  app = createApp(db);
  admin = await session('Admin');
  requester = await session('Staff', 'Requester');
  other = await session('Staff', 'Other requester');
  manager = await session('Manager');
  viewer = await session('Viewer');
});

afterAll(async () => {
  await db?.close();
});

describe('tool request access and notifications', () => {
  it('makes Staff request-only even when forbidden operations are forged through the API', async () => {
    const tool = await item();
    for (const type of ['in', 'out', 'adjustment']) {
      const response = await requester.agent
        .post('/api/v1/stock')
        .set(requester.headers)
        .set('Idempotency-Key', randomUUID())
        .send({
          itemId: tool.id,
          type,
          quantity: 1,
          reason: 'Forged direct stock operation',
          expectedVersion: tool.stock_version,
        });
      expect(response.status, type).toBe(403);
    }
    expect(
      (await requester.agent.post('/api/v1/items').set(requester.headers).send({})).status,
    ).toBe(403);
    expect(
      (await requester.agent.patch(`/api/v1/items/${tool.id}`).set(requester.headers).send({}))
        .status,
    ).toBe(403);
    expect(
      (
        await requester.agent
          .post(`/api/v1/items/${tool.id}/archive`)
          .set(requester.headers)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (await requester.agent.post(`/api/v1/items/${tool.id}/images`).set(requester.headers)).status,
    ).toBe(403);
    for (const path of [
      '/dashboard',
      '/movements',
      '/alerts/low-stock',
      '/users',
      '/audit-events',
      '/exports/items.csv',
    ]) {
      expect(
        (await requester.agent.get(`/api/v1${path}`).set(requester.headers)).status,
        path,
      ).toBe(403);
    }
    expect(
      (await requester.agent.post('/api/v1/reports/stock').set(requester.headers).send({})).status,
    ).toBe(403);
    expect(await quantity(tool)).toBe(8);
  });

  it('uses the same catalog photo, hides operational history, and scopes requests to their owner', async () => {
    const tool = await item();
    const picture = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#003e6f' },
    })
      .png()
      .toBuffer();
    const upload = await admin.agent
      .post(`/api/v1/items/${tool.id}/images`)
      .set(admin.headers)
      .attach('file', picture, 'jig.png');
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const detail = await requester.agent.get(`/api/v1/items/${tool.id}`).set(requester.headers);
    expect(detail.status).toBe(200);
    expect(detail.body.images).toHaveLength(1);
    expect(detail.body.movements).toEqual([]);
    expect(detail.body.serials).toEqual([]);
    const value = await submit(tool, 3);
    expect(value.image_url).toMatch(/\/api\/v1\/files\//);
    expect(value.name).toBe(tool.name);
    expect(value.quantity).toBe(3);
    expect(value.issued_quantity).toBe(0);
    expect(value.available_quantity).toBe(8);
    for (const actor of [other, manager]) {
      const list = await actor.agent
        .get(`/api/v1/requests?requestId=${value.id}`)
        .set(actor.headers);
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(0);
      expect(list.body.data).toEqual([]);
    }
    const mine = await requester.agent
      .get(`/api/v1/requests?requestId=${value.id}`)
      .set(requester.headers);
    expect(mine.body.data.map((row: ToolRequest) => row.id)).toEqual([value.id]);
    const monitored = await admin.agent
      .get(`/api/v1/requests?requestId=${value.id}`)
      .set(admin.headers);
    expect(monitored.body.data[0].requester_id).toBe(requester.user.id);
    expect(monitored.body.data[0].requester).toBe(requester.user.name);
    const notice = await admin.agent.get('/api/v1/notifications').set(admin.headers);
    expect(notice.status).toBe(200);
    expect(notice.body.unread).toBeGreaterThan(0);
    const notification = notice.body.data.find(
      (row: { request_id: string }) => row.request_id === value.id,
    );
    expect(notification).toBeDefined();
    expect(`${notification.title} ${notification.message}`).toContain(tool.name);
    expect(`${notification.title} ${notification.message}`).toContain('3');
    const forbiddenRead = await other.agent
      .patch(`/api/v1/notifications/${notification.id}/read`)
      .set(other.headers)
      .send({});
    expect([403, 404]).toContain(forbiddenRead.status);
    expect(
      (
        await admin.agent
          .patch(`/api/v1/notifications/${notification.id}/read`)
          .set(admin.headers)
          .send({})
      ).status,
    ).toBe(204);
  });

  it('validates quantity, stock availability, read-only roles and CSRF on submission', async () => {
    const tool = await item(2);
    expect((await request(app).get('/api/v1/requests')).status).toBe(401);
    const body = { itemId: tool.id, quantity: 1, purpose: 'Production setup' };
    expect(
      (
        await viewer.agent
          .post('/api/v1/requests')
          .set(viewer.headers)
          .set('Idempotency-Key', randomUUID())
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await requester.agent
          .post('/api/v1/requests')
          .set('Authorization', requester.headers.Authorization)
          .set('Idempotency-Key', randomUUID())
          .send(body)
      ).status,
    ).toBe(403);
    for (const invalid of [0, -1, 1.5]) {
      const response = await requester.agent
        .post('/api/v1/requests')
        .set(requester.headers)
        .set('Idempotency-Key', randomUUID())
        .send({ ...body, quantity: invalid });
      expect(response.status, String(invalid)).toBe(422);
    }
    const excess = await requester.agent
      .post('/api/v1/requests')
      .set(requester.headers)
      .set('Idempotency-Key', randomUUID())
      .send({ ...body, quantity: 3 });
    expect(excess.status).toBe(409);
    expect(excess.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await quantity(tool)).toBe(2);
  });

  it('replays submissions once and rejects reuse of a key with a different quantity', async () => {
    const tool = await item();
    const key = randomUUID();
    const first = await submit(tool, 2, requester, key);
    const second = await submit(tool, 2, requester, key);
    expect(second.id).toBe(first.id);
    const conflict = await requester.agent
      .post('/api/v1/requests')
      .set(requester.headers)
      .set('Idempotency-Key', key)
      .send({ itemId: tool.id, quantity: 3, purpose: 'Production assembly setup' });
    expect(conflict.status).toBe(409);
    const list = await admin.agent.get(`/api/v1/requests?q=${tool.sku}`).set(admin.headers);
    expect(list.body.total).toBe(1);
    expect(await quantity(tool)).toBe(8);
  });

  it('allows only Admin review and only the owner or Admin to cancel an unissued request', async () => {
    const tool = await item();
    const value = await submit(tool);
    for (const actor of [requester, other, manager, viewer]) {
      for (const action of ['approve', 'reject', 'issue', 'return']) {
        const response = await actor.agent
          .post(`/api/v1/requests/${value.id}/${action}`)
          .set(actor.headers)
          .set('Idempotency-Key', randomUUID())
          .send({ version: value.version, note: 'Not an administrator', quantity: 1 });
        expect(response.status, `${actor.user.role}: ${action}`).toBe(403);
      }
    }
    const crossOwner = await other.agent
      .post(`/api/v1/requests/${value.id}/cancel`)
      .set(other.headers)
      .send({ version: value.version });
    expect([403, 404]).toContain(crossOwner.status);
    const accepted = await approve(value);
    expect(await quantity(tool)).toBe(8);
    const cancelled = await requester.agent
      .post(`/api/v1/requests/${value.id}/cancel`)
      .set(requester.headers)
      .send({ version: accepted.version, note: 'Setup was cancelled' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(await quantity(tool)).toBe(8);
    const issue = await stockAction(cancelled.body, 'issue', 2);
    expect(issue.status).toBe(409);
  });
});

describe('admin issuing and returns', () => {
  it('keeps requested and issued quantities distinct and records stock only on issue and return', async () => {
    const tool = await item(8);
    const pending = await submit(tool, 5);
    expect(await quantity(tool)).toBe(8);
    const beforeApproval = await stockAction(pending, 'issue', 3);
    expect(beforeApproval.status).toBe(409);
    const accepted = await approve(pending);
    expect(accepted.status).toBe('approved');
    expect(await quantity(tool)).toBe(8);
    const key = randomUUID();
    const issued = await stockAction(accepted, 'issue', 3, key);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.status).toBe('issued');
    expect(issued.body.quantity).toBe(5);
    expect(issued.body.issued_quantity).toBe(3);
    expect(issued.body.returned_quantity).toBe(0);
    expect(await quantity(tool)).toBe(5);
    const replay = await stockAction(accepted, 'issue', 3, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toEqual(issued.body);
    expect(await quantity(tool)).toBe(5);
    expect(
      (
        await requester.agent
          .post(`/api/v1/requests/${pending.id}/cancel`)
          .set(requester.headers)
          .send({ version: issued.body.version })
      ).status,
    ).toBe(409);
    expect((await stockAction(issued.body, 'issue', 1)).status).toBe(409);
    const partial = await stockAction(issued.body, 'return', 1);
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body.status).toBe('issued');
    expect(partial.body.returned_quantity).toBe(1);
    expect(await quantity(tool)).toBe(6);
    expect((await stockAction(partial.body, 'return', 3)).status).toBe(422);
    const returned = await stockAction(partial.body, 'return', 2);
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body.status).toBe('returned');
    expect(returned.body.returned_quantity).toBe(3);
    expect(await quantity(tool)).toBe(8);
    const movements = await db.query(
      'SELECT type,delta FROM stock_movements WHERE item_id=$1 ORDER BY created_at,id',
      [tool.id],
    );
    expect(movements.map((row) => row.delta).sort((a, b) => a - b)).toEqual([-3, 1, 2, 8]);
    expect(await reconcile(db)).toEqual([]);
  });

  it('replays returns once and rejects a stale administrator action', async () => {
    const tool = await item();
    const accepted = await approve(await submit(tool, 2));
    const issued = await stockAction(accepted, 'issue', 2);
    expect(issued.status).toBe(200);
    const key = randomUUID();
    const returned = await stockAction(issued.body, 'return', 1, key);
    expect(returned.status).toBe(200);
    const replay = await stockAction(issued.body, 'return', 1, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(returned.body);
    expect(await quantity(tool)).toBe(7);
    expect((await stockAction(issued.body, 'return', 1)).status).toBe(409);
  });

  it('rejects an unapproved request with a reason and notifies its owner', async () => {
    const tool = await item();
    const value = await submit(tool);
    const rejected = await admin.agent
      .post(`/api/v1/requests/${value.id}/reject`)
      .set(admin.headers)
      .send({ version: value.version, note: 'Tool reserved for maintenance inspection' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.decision_note).toContain('maintenance');
    expect(await quantity(tool)).toBe(8);
    const notices = await requester.agent.get('/api/v1/notifications').set(requester.headers);
    expect(
      notices.body.data.some((notice: { request_id: string }) => notice.request_id === value.id),
    ).toBe(true);
    expect((await stockAction(rejected.body, 'issue', 1)).status).toBe(409);
    const approved = await approve(await submit(tool));
    const revoked = await admin.agent
      .post(`/api/v1/requests/${approved.id}/reject`)
      .set(admin.headers)
      .send({ version: approved.version, note: 'Approval withdrawn before handover' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.status).toBe('rejected');
    expect(revoked.body.issued_quantity).toBe(0);
    expect(await quantity(tool)).toBe(8);
    expect((await stockAction(revoked.body, 'issue', 1)).status).toBe(409);
  });

  it('rechecks physical stock when competing approved requests are issued concurrently', async () => {
    const tool = await item(3);
    const first = await approve(await submit(tool, 2));
    const second = await approve(await submit(tool, 2, other));
    expect(await quantity(tool)).toBe(3);
    const results = await Promise.all([
      stockAction(first, 'issue', 2),
      stockAction(second, 'issue', 2),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await quantity(tool)).toBe(1);
    const [ledger] = await db.query(
      'SELECT sum(delta) AS quantity FROM stock_movements WHERE item_id=$1',
      [tool.id],
    );
    expect(Number(ledger.quantity)).toBe(1);
    expect(await reconcile(db)).toEqual([]);
  });

  it('commits either cancellation or issuing in a race, never both', async () => {
    const tool = await item(3);
    const value = await approve(await submit(tool, 2));
    const results = await Promise.all([
      requester.agent
        .post(`/api/v1/requests/${value.id}/cancel`)
        .set(requester.headers)
        .send({ version: value.version }),
      stockAction(value, 'issue', 2),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const listed = await admin.agent
      .get(`/api/v1/requests?requestId=${value.id}`)
      .set(admin.headers);
    const current = listed.body.data[0] as ToolRequest;
    expect(['cancelled', 'issued']).toContain(current.status);
    expect(await quantity(tool)).toBe(current.status === 'issued' ? 1 : 3);
    expect(await reconcile(db)).toEqual([]);
  });

  it('returns only serial units issued on that particular request', async () => {
    const serialA = `REQ-${run}-A`;
    const serialB = `REQ-${run}-B`;
    const tool = await item(2, [serialA, serialB]);
    const first = await approve(await submit(tool, 1));
    const second = await approve(await submit(tool, 1, other));
    const firstIssue = await stockAction(first, 'issue', 1, randomUUID(), [serialA]);
    const secondIssue = await stockAction(second, 'issue', 1, randomUUID(), [serialB]);
    expect(firstIssue.status, JSON.stringify(firstIssue.body)).toBe(200);
    expect(secondIssue.status, JSON.stringify(secondIssue.body)).toBe(200);
    const archive = await admin.agent
      .post(`/api/v1/items/${tool.id}/archive`)
      .set(admin.headers)
      .send({});
    expect(archive.status).toBe(409);
    const current = await admin.agent.get(`/api/v1/items/${tool.id}`).set(admin.headers);
    const bypassReturn = await admin.agent
      .post('/api/v1/stock')
      .set(admin.headers)
      .set('Idempotency-Key', randomUUID())
      .send({
        itemId: tool.id,
        type: 'in',
        quantity: 1,
        reason: 'Attempt to bypass the request return record',
        expectedVersion: current.body.item.stock_version,
        serials: [serialA],
      });
    expect(bypassReturn.status, JSON.stringify(bypassReturn.body)).toBe(409);
    expect(bypassReturn.body.error.code).toBe('BORROWED_SERIAL');
    const wrongSerial = await stockAction(firstIssue.body, 'return', 1, randomUUID(), [serialB]);
    expect([409, 422]).toContain(wrongSerial.status);
    expect(await quantity(tool)).toBe(0);
    const returned = await stockAction(firstIssue.body, 'return', 1, randomUUID(), [serialA]);
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body.status).toBe('returned');
    expect(await quantity(tool)).toBe(1);
    expect(await reconcile(db)).toEqual([]);
  });
});
