import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Database, Sql } from './db.js';
import { audit } from './db.js';
import { AppError } from './errors.js';
import {
  identity,
  itemSchema,
  stockSchema,
  type Item,
  type ItemInput,
  type StockInput,
} from '../shared/contracts.js';
import { fileUrl } from './storage.js';

export const itemSelect = `SELECT i.*, coalesce(i.supplier,'') AS supplier,b.quantity,b.reorder_level,b.version AS stock_version,
 (SELECT thumbnail_key FROM item_images WHERE item_id=i.id ORDER BY is_primary DESC,sort_order,id LIMIT 1) AS thumbnail_key
 FROM items i JOIN stock_balances b ON b.item_id=i.id`;
export const movementSelect =
  'SELECT m.id,m.item_id,m.location_id,m.type,m.delta,m.balance_after,m.reason,m.note,m.actor_id,m.idempotency_id,m.created_at,i.name,i.sku,u.name AS actor FROM stock_movements m JOIN items i ON i.id=m.item_id JOIN users u ON u.id=m.actor_id';
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(12),
});
export const itemQuerySchema = pageSchema
  .extend({
    q: z.string().max(150).default(''),
    category: z.string().max(80).default(''),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    stock: z.enum(['all', 'in', 'low', 'out']).default('all'),
    sort: z.enum(['name', 'sku', 'quantity', 'created_at']).default('name'),
    direction: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();
export async function decorateItem(row: any): Promise<Item> {
  const {
    thumbnail_key,
    sku_normalized: _sku,
    barcode_normalized: _barcode,
    unit_price: _price,
    unit_cost: _cost,
    ...rest
  } = row;
  return {
    ...rest,
    image_url: thumbnail_key ? await fileUrl(thumbnail_key) : null,
  };
}
export function itemFilters(data: z.infer<typeof itemQuerySchema>) {
  const params: unknown[] = [];
  const parts: string[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    parts.push(clause.replaceAll('?', `$${params.length}`));
  };
  if (data.q) add('(i.name ILIKE ? OR i.sku ILIKE ? OR i.barcode ILIKE ?)', `%${data.q}%`);
  if (data.category) add('i.category=?', data.category);
  if (data.status !== 'all') add('i.status=?', data.status);
  if (data.stock === 'in') parts.push('b.quantity>b.reorder_level');
  if (data.stock === 'low') parts.push('b.quantity>0 AND b.quantity<=b.reorder_level');
  if (data.stock === 'out') parts.push('b.quantity=0');
  return { where: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}
export async function listItems(db: Database, input: unknown) {
  const data = itemQuerySchema.parse(input);
  const { where, params } = itemFilters(data);
  const [count] = await db.query(
    `SELECT count(*)::int AS total FROM items i JOIN stock_balances b ON b.item_id=i.id${where}`,
    params,
  );
  const sort = data.sort === 'quantity' ? 'b.quantity' : `i.${data.sort}`;
  const rows = await db.query(
    `${itemSelect}${where} ORDER BY ${sort} ${data.direction},i.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, data.pageSize, (data.page - 1) * data.pageSize],
  );
  return {
    data: await Promise.all(rows.map(decorateItem)),
    total: count.total,
    page: data.page,
    pageSize: data.pageSize,
  };
}
export async function getItem(tx: Sql, id: string) {
  z.string().uuid().parse(id);
  const [item] = await tx.query(`${itemSelect} WHERE i.id=$1`, [id]);
  if (!item) throw new AppError(404, 'NOT_FOUND', 'This item could not be found.');
  return item;
}
export async function saveItem(
  tx: Sql,
  input: ItemInput,
  actorId: string,
  requestId?: string,
  id?: string,
) {
  const data = itemSchema.parse(input);
  let old: any;
  if (id) {
    const [locked] = await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [id]);
    if (!locked) throw new AppError(404, 'NOT_FOUND', 'This item could not be found.');
    old = await getItem(tx, id);
    if (!data.version || old.version !== data.version)
      throw new AppError(409, 'VERSION_CONFLICT', 'This item changed. Reload it before saving.');
    if (old.status !== 'active')
      throw new AppError(409, 'ARCHIVED', 'Restore this item before editing.');
    if (
      old.serialized !== data.serialized &&
      (await tx.query('SELECT id FROM stock_movements WHERE item_id=$1 LIMIT 1', [id])).length
    )
      throw new AppError(
        409,
        'SERIALIZATION_LOCKED',
        'Serial tracking cannot change after stock history exists.',
      );
  }
  await tx.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT DO NOTHING', [
    data.category,
  ]);
  if (data.supplier)
    await tx.query('INSERT INTO suppliers(name) VALUES ($1) ON CONFLICT DO NOTHING', [
      data.supplier,
    ]);
  const values = [
    data.name,
    data.sku,
    identity(data.sku),
    data.barcode || null,
    data.barcode ? identity(data.barcode) : null,
    data.category,
    data.description,
    data.supplier || null,
    data.serialized,
  ];
  let itemId = id;
  if (id)
    await tx.query(
      'UPDATE items SET name=$1,sku=$2,sku_normalized=$3,barcode=$4,barcode_normalized=$5,category=$6,description=$7,supplier=$8,serialized=$9,version=version+1,updated_at=now() WHERE id=$10',
      [...values, id],
    );
  else {
    const [row] = await tx.query(
      'INSERT INTO items(name,sku,sku_normalized,barcode,barcode_normalized,category,description,supplier,serialized) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      values,
    );
    itemId = row.id;
    await tx.query('INSERT INTO stock_balances(item_id,reorder_level) VALUES ($1,$2)', [
      itemId,
      data.reorderLevel,
    ]);
  }
  if (id)
    await tx.query(
      'UPDATE stock_balances SET reorder_level=$1,version=version+1 WHERE item_id=$2',
      [data.reorderLevel, id],
    );
  await audit(
    tx,
    actorId,
    id ? 'item.updated' : 'item.created',
    'item',
    itemId!,
    old
      ? { name: old.name, sku: old.sku, version: old.version, reorderLevel: old.reorder_level }
      : null,
    data,
    requestId,
  );
  return decorateItem(await getItem(tx, itemId!));
}
export async function changeStock(
  db: Database,
  input: StockInput,
  actorId: string,
  role: string,
  key: string,
  requestId?: string,
  context?: { tx: Sql; returnRequestId?: string },
) {
  const data = stockSchema.parse(input);
  if (!['Admin', 'Manager'].includes(role))
    throw new AppError(
      403,
      'FORBIDDEN',
      'Only an Admin or Manager can change stock. Submit a tool request instead.',
    );
  z.string().uuid().parse(key);
  const requestHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const perform = async (tx: Sql) => {
    const inserted = await tx.query(
      "INSERT INTO idempotency_records(actor_id,route,key,request_hash) VALUES ($1,'stock',$2,$3) ON CONFLICT DO NOTHING RETURNING id",
      [actorId, key, requestHash],
    );
    if (!inserted.length) {
      const [previous] = await tx.query(
        "SELECT * FROM idempotency_records WHERE actor_id=$1 AND route='stock' AND key=$2",
        [actorId, key],
      );
      if (previous.request_hash !== requestHash)
        throw new AppError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This request key was used for a different operation.',
        );
      return stockResponse(previous.response_json);
    }
    // Lock item first, then its balance. Every item/stock/archive/image write uses this order.
    await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [data.itemId]);
    await tx.query('SELECT item_id FROM stock_balances WHERE item_id=$1 FOR UPDATE', [data.itemId]);
    const item = await getItem(tx, data.itemId);
    if (item.status !== 'active')
      throw new AppError(409, 'ARCHIVED', 'Restore this item before changing stock.');
    if (item.stock_version !== data.expectedVersion)
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'Stock changed since you opened this form. Review the refreshed balance and try again.',
      );
    const delta =
      (data.type === 'out' || (data.type === 'adjustment' && data.direction === 'remove')
        ? -1
        : 1) * data.quantity;
    const balance = item.quantity + delta;
    if (balance < 0)
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        `Only ${item.quantity} units are available. Stock cannot be negative.`,
      );
    if (balance > 1000000000)
      throw new AppError(422, 'STOCK_LIMIT', 'The resulting stock exceeds the supported limit.');
    const serials = data.serials.map(identity);
    if (
      item.serialized &&
      (serials.length !== data.quantity || new Set(serials).size !== serials.length)
    )
      throw new AppError(
        422,
        'SERIAL_COUNT',
        'Supply exactly one different serial number per unit.',
      );
    if (!item.serialized && serials.length)
      throw new AppError(422, 'NOT_SERIALIZED', 'This item does not use serial numbers.');
    const [movement] = await tx.query(
      'INSERT INTO stock_movements(item_id,type,delta,balance_after,reason,note,unit_cost_snapshot,actor_id,idempotency_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [
        data.itemId,
        data.type,
        delta,
        balance,
        data.reason,
        data.note,
        item.unit_cost,
        actorId,
        inserted[0].id,
      ],
    );
    for (const normalized of [...serials].sort()) {
      let [unit] = await tx.query(
        'SELECT * FROM serial_units WHERE serial_normalized=$1 FOR UPDATE',
        [normalized],
      );
      const previous = unit?.status || null;
      if (delta > 0) {
        if (unit) {
          const [loan] = await tx.query(
            'SELECT request_id FROM request_serials WHERE serial_id=$1 AND returned_at IS NULL',
            [unit.id],
          );
          if (loan && loan.request_id !== context?.returnRequestId)
            throw new AppError(
              409,
              'BORROWED_SERIAL',
              'Record this serial as a return against its original tool request.',
            );
        }
        if (unit && (unit.item_id !== data.itemId || unit.status === 'in_stock'))
          throw new AppError(
            409,
            'SERIAL_EXISTS',
            `Serial ${normalized} already belongs to available stock or another item.`,
          );
        if (unit) {
          await tx.query("UPDATE serial_units SET status='in_stock' WHERE id=$1", [unit.id]);
        } else {
          [unit] = await tx.query(
            "INSERT INTO serial_units(item_id,serial,serial_normalized,status) VALUES ($1,$2,$2,'in_stock') RETURNING id",
            [data.itemId, normalized],
          );
        }
      } else {
        if (!unit || unit.item_id !== data.itemId || unit.status !== 'in_stock')
          throw new AppError(
            409,
            'SERIAL_UNAVAILABLE',
            `Serial ${normalized} is not available for this item.`,
          );
        await tx.query('UPDATE serial_units SET status=$1 WHERE id=$2', [data.outStatus, unit.id]);
      }
      await tx.query(
        'INSERT INTO serial_events(serial_id,movement_id,from_status,to_status) VALUES ($1,$2,$3,$4)',
        [unit.id, movement.id, previous, delta > 0 ? 'in_stock' : data.outStatus],
      );
    }
    await tx.query('UPDATE stock_balances SET quantity=$1,version=version+1 WHERE item_id=$2', [
      balance,
      data.itemId,
    ]);
    await audit(
      tx,
      actorId,
      `stock.${data.type}`,
      'item',
      data.itemId,
      { quantity: item.quantity },
      { quantity: balance, movementId: movement.id, reason: data.reason },
      requestId,
    );
    if (
      (item.quantity > item.reorder_level && balance <= item.reorder_level) ||
      (item.quantity > 0 && balance === 0)
    )
      await tx.query(
        "INSERT INTO outbox(type,payload,dedup_key) VALUES ('low-stock',$1::jsonb,$2)",
        [
          JSON.stringify({
            itemId: data.itemId,
            sku: item.sku,
            name: item.name,
            quantity: balance,
            reorderLevel: item.reorder_level,
          }),
          `low-stock:${movement.id}`,
        ],
      );
    const result = stockResponse({
      movement,
      item: await decorateItem(await getItem(tx, data.itemId)),
    });
    await tx.query('UPDATE idempotency_records SET response_json=$1::jsonb WHERE id=$2', [
      JSON.stringify(result),
      inserted[0].id,
    ]);
    return result;
  };
  return context ? perform(context.tx) : db.transaction(perform);
}
function stockResponse(result: any) {
  const { unit_price: _price, unit_cost: _cost, ...item } = result.item;
  const { unit_cost_snapshot: _snapshot, ...movement } = result.movement;
  return { ...result, item, movement };
}
export async function reconcile(db: Database) {
  return db.query(`SELECT i.id,i.sku,b.quantity,coalesce(sum(m.delta),0)::int AS ledger_quantity,
  (SELECT count(*)::int FROM serial_units s WHERE s.item_id=i.id AND s.status='in_stock') AS serial_quantity
  FROM items i JOIN stock_balances b ON b.item_id=i.id LEFT JOIN stock_movements m ON m.item_id=i.id
  GROUP BY i.id,i.sku,i.serialized,b.quantity HAVING b.quantity<>coalesce(sum(m.delta),0)
  OR (i.serialized AND b.quantity<>(SELECT count(*) FROM serial_units s WHERE s.item_id=i.id AND s.status='in_stock'))`);
}
