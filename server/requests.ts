import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from './db.js';
import { audit } from './db.js';
import { AppError } from './errors.js';
import { changeStock, getItem, pageSchema } from './inventory.js';
import { fileUrl } from './storage.js';
import { requireRole } from './security.js';
import { identity, type User } from '../shared/contracts.js';
import {
  requestActionSchema,
  requestStatuses,
  requestStockSchema,
  toolRequestSchema,
  type ToolRequest,
} from '../shared/requests.js';

const admin = requireRole('Admin');
const requester = requireRole('Admin', 'Manager', 'Staff');
const uuid = (value: unknown) => z.string().uuid().parse(value);
const selection = `SELECT r.id,r.item_id,r.requester_id,r.quantity,r.issued_quantity,r.returned_quantity,
 r.status,r.purpose,r.decision_note,r.version,r.created_at,r.updated_at,r.issued_at,
 i.name,i.sku,i.serialized,u.name AS requester,b.quantity AS available_quantity,
 (SELECT thumbnail_key FROM item_images WHERE item_id=i.id ORDER BY is_primary DESC,sort_order,id LIMIT 1) AS thumbnail_key
 FROM tool_requests r JOIN items i ON i.id=r.item_id JOIN users u ON u.id=r.requester_id
 JOIN stock_balances b ON b.item_id=r.item_id`;
const scope = (user: User, params: unknown[]) => {
  if (user.role === 'Admin') return '';
  params.push(user.id);
  return `r.requester_id=$${params.length}`;
};
async function decorate(row: any): Promise<ToolRequest> {
  const { thumbnail_key, ...rest } = row;
  return { ...rest, image_url: thumbnail_key ? await fileUrl(thumbnail_key) : null };
}
async function detail(tx: Sql, id: string): Promise<ToolRequest> {
  const [row] = await tx.query(`${selection} WHERE r.id=$1`, [id]);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'This tool request could not be found.');
  return decorate(row);
}
async function locked(tx: Sql, id: string, user: User, version: number) {
  const [row] = await tx.query('SELECT * FROM tool_requests WHERE id=$1 FOR UPDATE', [id]);
  if (!row || (user.role !== 'Admin' && row.requester_id !== user.id))
    throw new AppError(404, 'NOT_FOUND', 'This tool request could not be found.');
  if (row.version !== version)
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This request changed. Refresh the request list before trying again.',
    );
  return row;
}
async function event(
  tx: Sql,
  id: string,
  actor: string,
  action: string,
  quantity: number,
  note: string,
  movementId: string | null,
  requestId: string,
) {
  await tx.query(
    'INSERT INTO request_events(request_id,actor_id,action,quantity,note,movement_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, actor, action, quantity, note, movementId],
  );
  await audit(
    tx,
    actor,
    `request.${action}`,
    'tool_request',
    id,
    null,
    { quantity, note, movementId },
    requestId,
  );
}
async function notify(tx: Sql, row: ToolRequest, action: string) {
  const title = action === 'created' ? 'New tool request' : `Tool request ${action}`;
  const message = `${row.requester}: ${row.name} (${row.sku}). Requested ${row.quantity}; issued ${row.issued_quantity}; returned ${row.returned_quantity}; available ${row.available_quantity}.`;
  const includeRequester = !['created', 'cancelled'].includes(action);
  await tx.query(
    `INSERT INTO user_notifications(user_id,request_id,title,message) SELECT id,$1,$2,$3 FROM users WHERE enabled=true AND (role='Admin'${includeRequester ? ' OR id=$4' : ''})`,
    includeRequester ? [row.id, title, message, row.requester_id] : [row.id, title, message],
  );
  await tx.query(
    "INSERT INTO outbox(type,payload,dedup_key) VALUES ('tool-request',$1::jsonb,$2)",
    [
      JSON.stringify({
        requestId: row.id,
        requesterId: row.requester_id,
        includeRequester,
        title,
        message,
      }),
      `tool-request:${row.id}:${row.version}`,
    ],
  );
}
async function idempotent<T>(
  tx: Sql,
  user: User,
  route: string,
  key: string,
  input: unknown,
  work: () => Promise<T>,
): Promise<T> {
  uuid(key);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const [inserted] = await tx.query(
    'INSERT INTO idempotency_records(actor_id,route,key,request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
    [user.id, route, key, hash],
  );
  if (!inserted) {
    const [old] = await tx.query(
      'SELECT * FROM idempotency_records WHERE actor_id=$1 AND route=$2 AND key=$3 FOR UPDATE',
      [user.id, route, key],
    );
    if (!old || old.request_hash !== hash)
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This request key was used for a different operation.',
      );
    if (!old.response_json)
      throw new AppError(
        409,
        'REQUEST_IN_PROGRESS',
        'This operation is still being processed. Retry shortly.',
      );
    // Signed photo URLs expire independently of the durable operation response.
    const result = old.response_json as T & { id: string };
    const current = await detail(tx, result.id);
    return { ...result, image_url: current.image_url };
  }
  const result = await work();
  await tx.query('UPDATE idempotency_records SET response_json=$1::jsonb WHERE id=$2', [
    JSON.stringify(result),
    inserted.id,
  ]);
  return result;
}

export function requestRoutes(db: Database) {
  const routes = Router();
  routes.get('/requests/summary', async (req, res) => {
    const params: unknown[] = [];
    const own = scope(req.user!, params);
    const [row] = await db.query(
      `SELECT
     coalesce(sum(CASE WHEN r.status='pending' THEN 1 ELSE 0 END),0)::int AS pending,
     coalesce(sum(CASE WHEN r.status='approved' THEN 1 ELSE 0 END),0)::int AS approved,
     coalesce(sum(CASE WHEN r.status='issued' THEN 1 ELSE 0 END),0)::int AS outstanding,
     coalesce(sum(CAST(r.issued_quantity AS BIGINT)-r.returned_quantity),0) AS outstanding_quantity
     FROM tool_requests r${own ? ` WHERE ${own}` : ''}`,
      params,
    );
    res.json({ ...row, outstanding_quantity: Number(row.outstanding_quantity) });
  });
  routes.get('/requests', async (req, res) => {
    const query = pageSchema
      .extend({
        q: z.string().trim().max(150).default(''),
        status: z.enum(['all', ...requestStatuses]).default('all'),
        requestId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.query);
    const params: unknown[] = [];
    const own = scope(req.user!, params);
    const parts = own ? [own] : [];
    if (query.q) {
      params.push(`%${query.q}%`);
      parts.push(
        `(i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length} OR u.name ILIKE $${params.length})`,
      );
    }
    if (query.status !== 'all') {
      params.push(query.status);
      parts.push(`r.status=$${params.length}`);
    }
    if (query.requestId) {
      params.push(query.requestId);
      parts.push(`r.id=$${params.length}`);
    }
    const where = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
    const [count] = await db.query(
      `SELECT count(*)::int AS total FROM tool_requests r JOIN items i ON i.id=r.item_id JOIN users u ON u.id=r.requester_id${where}`,
      params,
    );
    const rows = await db.query(
      `${selection}${where} ORDER BY r.created_at DESC,r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );
    res.json({
      data: await Promise.all(rows.map(decorate)),
      total: count.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });
  routes.post('/requests', requester, async (req, res) => {
    const data = toolRequestSchema.parse(req.body);
    const row = await db.transaction((tx) =>
      idempotent(
        tx,
        req.user!,
        'requests:create',
        req.get('idempotency-key') || '',
        data,
        async () => {
          await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [data.itemId]);
          await tx.query('SELECT item_id FROM stock_balances WHERE item_id=$1 FOR UPDATE', [
            data.itemId,
          ]);
          const item = await getItem(tx, data.itemId);
          if (item.status !== 'active')
            throw new AppError(409, 'ARCHIVED', 'This item is no longer available for requests.');
          if (data.quantity > item.quantity)
            throw new AppError(
              409,
              'INSUFFICIENT_STOCK',
              `Only ${item.quantity} units are currently available.`,
            );
          const [created] = await tx.query(
            'INSERT INTO tool_requests(item_id,requester_id,quantity,purpose) VALUES ($1,$2,$3,$4) RETURNING id',
            [data.itemId, req.user!.id, data.quantity, data.purpose],
          );
          await event(
            tx,
            created.id,
            req.user!.id,
            'created',
            data.quantity,
            data.purpose,
            null,
            req.requestId,
          );
          const result = await detail(tx, created.id);
          await notify(tx, result, 'created');
          return result;
        },
      ),
    );
    res.status(201).json(row);
  });
  for (const action of ['approve', 'reject', 'cancel'] as const) {
    routes.post(
      `/requests/:id/${action}`,
      action === 'cancel' ? requester : admin,
      async (req, res) => {
        const id = uuid(req.params.id);
        const data = requestActionSchema.parse(req.body);
        if (action === 'reject' && data.note.length < 3)
          throw new AppError(422, 'REASON_REQUIRED', 'Give a reason for rejecting this request.');
        const result = await db.transaction(async (tx) => {
          const old = await locked(tx, id, req.user!, data.version);
          if (
            action === 'approve'
              ? old.status !== 'pending'
              : !['pending', 'approved'].includes(old.status)
          )
            throw new AppError(
              409,
              'REQUEST_STATE',
              'This request can no longer be changed by this action.',
            );
          if (action === 'approve') {
            const item = await getItem(tx, old.item_id);
            if (item.status !== 'active')
              throw new AppError(
                409,
                'ARCHIVED',
                'Restore this item before approving its request.',
              );
          }
          await tx.query(
            'UPDATE tool_requests SET status=$1,decision_note=$2,decided_by=$3,decided_at=now(),version=version+1,updated_at=now() WHERE id=$4',
            [
              action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled',
              data.note,
              req.user!.id,
              id,
            ],
          );
          await event(
            tx,
            id,
            req.user!.id,
            action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled',
            0,
            data.note,
            null,
            req.requestId,
          );
          const row = await detail(tx, id);
          await notify(
            tx,
            row,
            action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled',
          );
          return row;
        });
        res.json(result);
      },
    );
  }
  for (const action of ['issue', 'return'] as const) {
    routes.post(`/requests/:id/${action}`, admin, async (req, res) => {
      const id = uuid(req.params.id);
      const data = requestStockSchema.parse(req.body);
      const key = req.get('idempotency-key') || '';
      const row = await db.transaction((tx) =>
        idempotent(tx, req.user!, `requests:${id}:${action}`, key, data, async () => {
          const old = await locked(tx, id, req.user!, data.version);
          if (old.status !== (action === 'issue' ? 'approved' : 'issued'))
            throw new AppError(
              409,
              'REQUEST_STATE',
              action === 'issue'
                ? 'Approve this request before issuing tools.'
                : 'Only issued tools can be returned.',
            );
          const maximum =
            action === 'issue' ? old.quantity : old.issued_quantity - old.returned_quantity;
          if (data.quantity > maximum)
            throw new AppError(422, 'REQUEST_QUANTITY', `Enter a quantity from 1 to ${maximum}.`);
          await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [old.item_id]);
          await tx.query('SELECT item_id FROM stock_balances WHERE item_id=$1 FOR UPDATE', [
            old.item_id,
          ]);
          const item = await getItem(tx, old.item_id);
          if (action === 'return' && item.serialized) {
            for (const serial of data.serials.map(identity)) {
              const [loan] = await tx.query(
                'SELECT rs.serial_id FROM request_serials rs JOIN serial_units s ON s.id=rs.serial_id WHERE rs.request_id=$1 AND s.serial_normalized=$2 AND rs.returned_at IS NULL',
                [id, serial],
              );
              if (!loan)
                throw new AppError(
                  409,
                  'SERIAL_OWNERSHIP',
                  `Serial ${serial} is not outstanding on this request.`,
                );
            }
          }
          const changed = await changeStock(
            db,
            {
              itemId: old.item_id,
              type: action === 'issue' ? 'out' : 'in',
              quantity: data.quantity,
              direction: 'add',
              reason: `Tool request ${action}: ${id}`,
              note: data.note,
              expectedVersion: item.stock_version,
              serials: data.serials,
              outStatus: 'sold',
            },
            req.user!.id,
            req.user!.role,
            key,
            req.requestId,
            { tx, returnRequestId: action === 'return' ? id : undefined },
          );
          if (item.serialized) {
            for (const serial of data.serials.map(identity)) {
              const [unit] = await tx.query(
                'SELECT id FROM serial_units WHERE item_id=$1 AND serial_normalized=$2',
                [old.item_id, serial],
              );
              if (action === 'issue')
                await tx.query('INSERT INTO request_serials(request_id,serial_id) VALUES ($1,$2)', [
                  id,
                  unit.id,
                ]);
              else
                await tx.query(
                  'UPDATE request_serials SET returned_at=now() WHERE request_id=$1 AND serial_id=$2 AND returned_at IS NULL',
                  [id, unit.id],
                );
            }
          }
          if (action === 'issue') {
            await tx.query(
              "UPDATE tool_requests SET issued_quantity=$1,status='issued',issued_at=now(),issue_movement_id=$2,version=version+1,updated_at=now() WHERE id=$3",
              [data.quantity, changed.movement.id, id],
            );
          } else {
            const returned = old.returned_quantity + data.quantity;
            await tx.query(
              'UPDATE tool_requests SET returned_quantity=$1,status=$2,version=version+1,updated_at=now() WHERE id=$3',
              [returned, returned === old.issued_quantity ? 'returned' : 'issued', id],
            );
          }
          await event(
            tx,
            id,
            req.user!.id,
            action === 'issue' ? 'issued' : 'returned',
            data.quantity,
            data.note,
            changed.movement.id,
            req.requestId,
          );
          const result = await detail(tx, id);
          await notify(tx, result, action === 'issue' ? 'issued' : 'returned');
          return result;
        }),
      );
      res.json(row);
    });
  }
  routes.get('/notifications', async (req, res) => {
    const [count] = await db.query(
      'SELECT count(*)::int AS unread FROM user_notifications WHERE user_id=$1 AND read_at IS NULL',
      [req.user!.id],
    );
    const rows = await db.query(
      'SELECT id,request_id,title,message,read_at,created_at FROM user_notifications WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',
      [req.user!.id],
    );
    res.json({ data: rows, unread: count.unread });
  });
  routes.patch('/notifications/:id/read', async (req, res) => {
    const rows = await db.query(
      'UPDATE user_notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id',
      [uuid(req.params.id), req.user!.id],
    );
    if (!rows.length) throw new AppError(404, 'NOT_FOUND', 'This notification could not be found.');
    res.sendStatus(204);
  });
  routes.post('/notifications/read-all', async (req, res) => {
    await db.query(
      'UPDATE user_notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',
      [req.user!.id],
    );
    res.sendStatus(204);
  });
  return routes;
}
