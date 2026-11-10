import express from 'express';
import helmet from 'helmet';
import type { RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import swaggerUi from 'swagger-ui-express';
import type { Database } from './db.js';
import { audit } from './db.js';
import { config } from './config.js';
import { AppError, errorHandler, requestLog } from './errors.js';
import { authenticate, csrf, hashToken, requireRole, secretToken } from './security.js';
import { authRoutes } from './auth.js';
import {
  changeStock,
  decorateItem,
  getItem,
  itemFilters,
  itemQuerySchema,
  itemSelect,
  listItems,
  movementSelect,
  pageSchema,
  reconcile,
  saveItem,
} from './inventory.js';
import { identity, itemSchema, passwordSchema, roles } from '../shared/contracts.js';
import { getBrand, imageMetadata, logoBytes, replaceLogo } from './branding.js';
import {
  putFile,
  readStoredFile,
  removeFile,
  storageReady,
  validFileSignature,
} from './storage.js';
import { processImage } from './images.js';
import { csvRows, pdfReport, reportItems } from './reports.js';
import { openapi } from './openapi.js';
import { requestRoutes } from './requests.js';

const uuid = (value: unknown) => z.string().uuid().parse(value);
const editors = requireRole('Admin', 'Manager');
const operators = requireRole('Admin', 'Manager');
const admin = requireRole('Admin');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
});
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 },
});
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1, fields: 0 },
});
let activeUploads = 0;
const uploadGate: RequestHandler = (_req, res, next) => {
  if (activeUploads >= 2)
    return next(new AppError(429, 'UPLOAD_BUSY', 'Uploads are busy. Try again shortly.'));
  activeUploads++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeUploads--;
    }
  };
  res.once('finish', release);
  res.once('close', release);
  next();
};

export function createApp(db: Database) {
  const app = express();
  app.disable('x-powered-by');
  // Exactly one trusted reverse proxy in the supplied Compose topology.
  if (config.production) app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: [
            "'self'",
            'data:',
            'blob:',
            ...(process.env.S3_PUBLIC_ORIGIN ? [process.env.S3_PUBLIC_ORIGIN] : []),
          ],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
      strictTransportSecurity: config.production ? undefined : false,
    }),
  );
  app.use(requestLog);
  app.get('/api/v1/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/v1/health/ready', async (_req, res) => {
    await db.query('SELECT 1');
    await storageReady();
    res.json({ status: 'ready' });
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: process.env.NODE_ENV === 'test' ? 10000 : 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: {
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      },
    }),
  );
  app.use(express.json({ limit: '128kb' }), cookieParser(config.cookieSecret));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/v1', csrf);
  app.use('/api/v1/auth', authRoutes(db));
  app.get('/api/v1/settings/branding', async (_req, res) => res.json(await getBrand(db)));
  app.get('/api/v1/settings/brand-logo', async (_req, res) => {
    const bytes = await logoBytes(db);
    if (!bytes) throw new AppError(404, 'NOT_FOUND', 'No company logo is configured.');
    res.type('png').send(bytes);
  });
  app.get('/api/v1/settings/favicon/:size', async (req, res) => {
    const size = z
      .enum(['16.png', '32.png', '180.png', '192.png', '512.png'])
      .parse(req.params.size);
    const pixels = parseInt(size);
    const sharp = (await import('sharp')).default;
    let bytes = await logoBytes(db);
    const brand = await getBrand(db);
    const markPath = path.resolve(
      existsSync(path.resolve('public/brand/sdp-mark.svg'))
        ? 'public/brand/sdp-mark.svg'
        : 'public/brand/sdp-mark.png',
    );
    if (!brand.logoUrl && existsSync(markPath)) bytes = readFileSync(markPath);
    if (bytes)
      return res
        .type('png')
        .send(
          await sharp(bytes)
            .resize(pixels, pixels, { fit: 'contain', background: '#ffffff' })
            .png()
            .toBuffer(),
        );
    res.sendFile(
      path.resolve(
        `public/brand/${pixels === 180 ? 'apple-touch-icon' : pixels < 100 ? `favicon-${pixels}` : `icon-${pixels}`}.png`,
      ),
    );
  });
  app.get('/api/v1/settings/manifest', async (_req, res) => {
    const brand = await getBrand(db);
    res.type('application/manifest+json').json({
      name: `${brand.appName} — ${brand.companyName}`,
      short_name: 'SDP',
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#1D4ED8',
      icons: [192, 512].map((size) => ({
        src: `/api/v1/settings/favicon/${size}.png?v=${brand.version}`,
        sizes: `${size}x${size}`,
        type: 'image/png',
        purpose: 'any',
      })),
    });
  });
  app.get('/api/v1/files/:key', async (req, res) => {
    const key = String(req.params.key);
    if (!validFileSignature(key, req.query.expires, req.query.signature))
      throw new AppError(403, 'FILE_EXPIRED', 'This file link expired. Refresh the page.');
    res
      .type(
        key.endsWith('.png') ? 'png' : key.endsWith('.webp') ? 'webp' : 'application/octet-stream',
      )
      .send(await readStoredFile(key));
  });
  app.use('/api/v1', authenticate(db));
  app.use('/api/v1', (req, _res, next) => {
    if (req.user!.role !== 'Staff') return next();
    const catalogRead =
      req.method === 'GET' &&
      (/^\/items(?:\/[0-9a-f-]+)?$/i.test(req.path) ||
        ['/categories', '/suppliers'].includes(req.path));
    const ownWorkflow = /^\/(requests|notifications)(\/|$)/.test(req.path);
    if (!catalogRead && !ownWorkflow)
      throw new AppError(
        403,
        'FORBIDDEN',
        'Your account can browse tools and manage its own requests.',
      );
    next();
  });
  app.use('/api/v1', requestRoutes(db));
  app.get('/api/v1/openapi.json', (_req, res) => res.json(openapi));
  app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(openapi));
  app.get('/api/v1/dashboard', async (_req, res) => {
    const [totals] = await db.query(
      "SELECT count(*)::int AS items,coalesce(sum(b.quantity),0)::bigint::text AS units,count(*) FILTER(WHERE b.quantity>0 AND b.quantity<=b.reorder_level)::int AS low,count(*) FILTER(WHERE b.quantity=0)::int AS out FROM items i JOIN stock_balances b ON b.item_id=i.id WHERE i.status='active'",
    );
    const recent = await db.query(`${movementSelect} ORDER BY m.created_at DESC,m.id DESC LIMIT 6`);
    const low = await db.query(
      `${itemSelect} WHERE i.status='active' AND b.quantity<=b.reorder_level ORDER BY b.quantity,i.name LIMIT 5`,
    );
    const top = await db.query(
      "SELECT i.name,i.sku,sum(abs(m.delta))::int AS units FROM stock_movements m JOIN items i ON i.id=m.item_id WHERE m.type='out' AND m.created_at>now()-interval '30 days' GROUP BY i.id,i.name,i.sku ORDER BY units DESC LIMIT 5",
    );
    res.json({ totals, recent, low: await Promise.all(low.map(decorateItem)), top });
  });
  app.get('/api/v1/items/check-identity', async (req, res) => {
    const data = z
      .object({
        sku: z.string().max(64).optional(),
        barcode: z.string().max(100).optional(),
        excludeId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.query);
    const rows = await db.query(
      'SELECT sku_normalized,barcode_normalized FROM items WHERE (sku_normalized=$1 OR barcode_normalized=$2) AND ($3::uuid IS NULL OR id<>$3)',
      [
        identity(data.sku || ''),
        data.barcode ? identity(data.barcode) : null,
        data.excludeId || null,
      ],
    );
    res.json({
      skuExists: rows.some((row) => row.sku_normalized === identity(data.sku || '')),
      barcodeExists:
        !!data.barcode && rows.some((row) => row.barcode_normalized === identity(data.barcode!)),
    });
  });
  app.get('/api/v1/items', async (req, res) =>
    res.json(
      await listItems(
        db,
        req.user!.role === 'Staff' ? { ...req.query, status: 'active' } : req.query,
      ),
    ),
  );
  app.post('/api/v1/items', editors, async (req, res) => {
    const item = await db.transaction((tx) => saveItem(tx, req.body, req.user!.id, req.requestId));
    res.status(201).json(item);
  });
  app.get('/api/v1/items/:id', async (req, res) => {
    const id = uuid(req.params.id);
    const item = await decorateItem(await getItem(db, id));
    res.json({
      item,
      images: await imageMetadata(db, id),
      serials:
        req.user!.role === 'Staff'
          ? []
          : await db.query(
              'SELECT id,serial,status FROM serial_units WHERE item_id=$1 ORDER BY serial LIMIT 1000',
              [id],
            ),
      movements:
        req.user!.role === 'Staff'
          ? []
          : await db.query(
              `${movementSelect} WHERE m.item_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 20`,
              [id],
            ),
    });
  });
  app.patch('/api/v1/items/:id', editors, async (req, res) => {
    const id = uuid(req.params.id);
    res.json(await db.transaction((tx) => saveItem(tx, req.body, req.user!.id, req.requestId, id)));
  });
  for (const action of ['archive', 'restore'] as const)
    app.post(`/api/v1/items/:id/${action}`, editors, async (req, res) => {
      const id = uuid(req.params.id);
      z.object({})
        .strict()
        .parse(req.body || {});
      await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [id]);
        const item = await getItem(tx, id);
        if (action === 'archive' && item.quantity !== 0)
          throw new AppError(
            409,
            'STOCK_REMAINS',
            'Remove or reconcile remaining stock before archiving this item.',
          );
        if (
          action === 'archive' &&
          (
            await tx.query(
              "SELECT id FROM tool_requests WHERE item_id=$1 AND status='issued' LIMIT 1",
              [id],
            )
          ).length
        )
          throw new AppError(
            409,
            'TOOLS_BORROWED',
            'Record all borrowed tools as returned before archiving this item.',
          );
        const status = action === 'archive' ? 'archived' : 'active';
        await tx.query(
          'UPDATE items SET status=$1,version=version+1,updated_at=now() WHERE id=$2',
          [status, id],
        );
        await audit(
          tx,
          req.user!.id,
          `item.${action}`,
          'item',
          id,
          { status: item.status },
          { status },
          req.requestId,
        );
      });
      res.status(204).end();
    });
  app.patch('/api/v1/items/:id/stock-settings', editors, async (req, res) => {
    const data = z
      .object({
        reorderLevel: z.number().int().min(0).max(1000000000),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    const id = uuid(req.params.id);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [id]);
      const item = await getItem(tx, id);
      if (item.stock_version !== data.version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Stock settings changed. Reload before saving.',
        );
      await tx.query(
        'UPDATE stock_balances SET reorder_level=$1,version=version+1 WHERE item_id=$2',
        [data.reorderLevel, id],
      );
      await audit(
        tx,
        req.user!.id,
        'stock.reorder_updated',
        'item',
        id,
        { reorderLevel: item.reorder_level },
        data,
        req.requestId,
      );
    });
    res.json(await decorateItem(await getItem(db, id)));
  });
  app.post(
    '/api/v1/items/:id/images',
    editors,
    uploadGate,
    upload.single('file'),
    async (req, res) => {
      const id = uuid(req.params.id);
      if (!req.file) throw new AppError(422, 'FILE_REQUIRED', 'Choose an image.');
      const image = await processImage(req.file.buffer);
      const key = await putFile(image.optimized, 'webp', 'image/webp');
      let thumbnail: string | undefined;
      try {
        thumbnail = await putFile(image.thumbnail, 'webp', 'image/webp');
        await db.transaction(async (tx) => {
          await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [id]);
          const item = await getItem(tx, id);
          if (item.status !== 'active')
            throw new AppError(409, 'ARCHIVED', 'Restore this item before uploading images.');
          const [count] = await tx.query(
            'SELECT count(*)::int AS total FROM item_images WHERE item_id=$1',
            [id],
          );
          if (count.total >= 5)
            throw new AppError(422, 'IMAGE_LIMIT', 'An item can have up to five images.');
          await tx.query(
            'INSERT INTO item_images(item_id,object_key,thumbnail_key,sort_order,is_primary) VALUES ($1,$2,$3,$4,$5)',
            [id, key, thumbnail, count.total, count.total === 0],
          );
          await audit(
            tx,
            req.user!.id,
            'item.image_added',
            'item',
            id,
            null,
            { objectKey: key },
            req.requestId,
          );
        });
      } catch (error) {
        await removeFile(key);
        if (thumbnail) await removeFile(thumbnail);
        throw error;
      }
      res.status(201).json(await imageMetadata(db, id));
    },
  );
  app.patch('/api/v1/items/:id/images', editors, async (req, res) => {
    const id = uuid(req.params.id);
    const data = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(5), primaryId: z.string().uuid() })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [id]);
      await getItem(tx, id);
      const images = await tx.query('SELECT id FROM item_images WHERE item_id=$1', [id]);
      if (
        data.ids.length !== images.length ||
        new Set(data.ids).size !== images.length ||
        !data.ids.includes(data.primaryId) ||
        images.some((image) => !data.ids.includes(image.id))
      )
        throw new AppError(409, 'IMAGES_CHANGED', 'Images changed. Reload before reordering.');
      await tx.query('UPDATE item_images SET is_primary=false WHERE item_id=$1', [id]);
      for (const [index, imageId] of data.ids.entries())
        await tx.query('UPDATE item_images SET sort_order=$1,is_primary=$2 WHERE id=$3', [
          index,
          imageId === data.primaryId,
          imageId,
        ]);
      await audit(tx, req.user!.id, 'item.images_reordered', 'item', id, null, data, req.requestId);
    });
    res.json(await imageMetadata(db, id));
  });
  app.delete('/api/v1/items/:id/images/:imageId', editors, async (req, res) => {
    const id = uuid(req.params.id);
    const imageId = uuid(req.params.imageId);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [id]);
      const [image] = await tx.query(
        'DELETE FROM item_images WHERE id=$1 AND item_id=$2 RETURNING *',
        [imageId, id],
      );
      if (!image) throw new AppError(404, 'NOT_FOUND', 'Image not found.');
      if (image.is_primary)
        await tx.query(
          'UPDATE item_images SET is_primary=true WHERE id=(SELECT id FROM item_images WHERE item_id=$1 ORDER BY sort_order,id LIMIT 1)',
          [id],
        );
      await tx.query(
        "INSERT INTO outbox(type,payload,available_at) VALUES ('delete-files',$1::jsonb,now()+interval '24 hours')",
        [JSON.stringify({ keys: [image.object_key, image.thumbnail_key] })],
      );
      await audit(
        tx,
        req.user!.id,
        'item.image_removed',
        'item',
        id,
        { imageId },
        null,
        req.requestId,
      );
    });
    res.status(204).end();
  });
  app.get('/api/v1/items/:id/serials', async (req, res) => {
    const data = pageSchema
      .extend({ q: z.string().max(100).default('') })
      .strict()
      .parse(req.query);
    const id = uuid(req.params.id);
    const params = [id, `%${data.q}%`];
    const [count] = await db.query(
      'SELECT count(*)::int AS total FROM serial_units WHERE item_id=$1 AND serial ILIKE $2',
      params,
    );
    res.json({
      data: await db.query(
        'SELECT id,serial,status FROM serial_units WHERE item_id=$1 AND serial ILIKE $2 ORDER BY serial LIMIT $3 OFFSET $4',
        [...params, data.pageSize, (data.page - 1) * data.pageSize],
      ),
      total: count.total,
      ...data,
    });
  });
  app.get(['/api/v1/movements', '/api/v1/items/:id/movements'], async (req, res) => {
    const data = pageSchema
      .extend({
        q: z.string().max(150).default(''),
        type: z.enum(['all', 'in', 'out', 'adjustment']).default('all'),
        itemId: z.string().uuid().optional(),
        from: z.string().date().optional(),
        to: z.string().date().optional(),
        actorId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.query);
    const params: unknown[] = [`%${data.q}%`];
    const parts = ['(i.name ILIKE $1 OR i.sku ILIKE $1 OR m.reason ILIKE $1)'];
    if (req.params.id || data.itemId) {
      params.push(uuid(req.params.id || data.itemId));
      parts.push(`m.item_id=$${params.length}`);
    }
    if (data.type !== 'all') {
      params.push(data.type);
      parts.push(`m.type=$${params.length}`);
    }
    if (data.from) {
      params.push(data.from);
      parts.push(`m.created_at >= $${params.length}::date`);
    }
    if (data.to) {
      params.push(data.to);
      parts.push(`m.created_at < $${params.length}::date+interval '1 day'`);
    }
    if (data.actorId) {
      params.push(data.actorId);
      parts.push(`m.actor_id=$${params.length}`);
    }
    const where = ` WHERE ${parts.join(' AND ')}`;
    const [count] = await db.query(
      `SELECT count(*)::int AS total FROM stock_movements m JOIN items i ON i.id=m.item_id${where}`,
      params,
    );
    res.json({
      data: await db.query(
        `${movementSelect}${where} ORDER BY m.created_at DESC,m.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, data.pageSize, (data.page - 1) * data.pageSize],
      ),
      total: count.total,
      page: data.page,
      pageSize: data.pageSize,
    });
  });
  app.post('/api/v1/stock', operators, async (req, res) =>
    res
      .status(201)
      .json(
        await changeStock(
          db,
          req.body,
          req.user!.id,
          req.user!.role,
          req.get('idempotency-key') || '',
          req.requestId,
        ),
      ),
  );
  for (const [url, type] of [
    ['in', 'in'],
    ['out', 'out'],
    ['adjustments', 'adjustment'],
  ])
    app.post(`/api/v1/stock/${url}`, operators, async (req, res) => {
      if (req.body?.type && req.body.type !== type)
        throw new AppError(
          422,
          'TYPE_MISMATCH',
          'Stock operation type does not match the endpoint.',
        );
      res
        .status(201)
        .json(
          await changeStock(
            db,
            { ...req.body, type },
            req.user!.id,
            req.user!.role,
            req.get('idempotency-key') || '',
            req.requestId,
          ),
        );
    });
  app.get('/api/v1/alerts/low-stock', async (req, res) => {
    const paging = pageSchema.strict().parse(req.query);
    const [count] = await db.query(
      "SELECT count(*)::int AS total FROM items i JOIN stock_balances b ON b.item_id=i.id WHERE i.status='active' AND b.quantity<=b.reorder_level",
    );
    const rows = await db.query(
      `${itemSelect} WHERE i.status='active' AND b.quantity<=b.reorder_level ORDER BY b.quantity,i.name LIMIT $1 OFFSET $2`,
      [paging.pageSize, (paging.page - 1) * paging.pageSize],
    );
    res.json({ data: await Promise.all(rows.map(decorateItem)), total: count.total, ...paging });
  });
  for (const table of ['categories', 'suppliers'] as const) {
    app.get(`/api/v1/${table}`, async (_req, res) =>
      res.json((await db.query(`SELECT name FROM ${table} ORDER BY name`)).map((row) => row.name)),
    );
    app.post(`/api/v1/${table}`, editors, async (req, res) => {
      const { name } = z
        .object({
          name: z
            .string()
            .trim()
            .min(1)
            .max(table === 'categories' ? 80 : 150),
        })
        .strict()
        .parse(req.body);
      await db.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${table}(name) VALUES ($1)`, [name]);
        await audit(
          tx,
          req.user!.id,
          `${table}.created`,
          table,
          name,
          null,
          { name },
          req.requestId,
        );
      });
      res.status(201).json({ name });
    });
  }
  app.get('/api/v1/settings', admin, async (_req, res) => res.json(await getBrand(db)));
  app.patch('/api/v1/settings', admin, (_req, res) => {
    res.setHeader('Allow', 'GET');
    throw new AppError(
      405,
      'COMPANY_DETAILS_FIXED',
      'Company details are fixed to Shindengen and cannot be changed.',
    );
  });
  app.post(
    '/api/v1/settings/logo',
    admin,
    uploadGate,
    logoUpload.single('file'),
    async (req, res) => {
      if (!req.file) throw new AppError(422, 'FILE_REQUIRED', 'Choose a logo file.');
      res.json(await replaceLogo(db, req.file.buffer, req.user!.id, req.requestId));
    },
  );
  app.delete('/api/v1/settings/logo', admin, async (req, res) => {
    await db.transaction(async (tx) => {
      const [old] = await tx.query(
        'SELECT logo_asset_id FROM company_settings WHERE id=1 FOR UPDATE',
      );
      await tx.query(
        'UPDATE company_settings SET logo_asset_id=NULL,brand_version=brand_version+1 WHERE id=1',
      );
      await audit(
        tx,
        req.user!.id,
        'branding.logo_removed',
        'settings',
        '1',
        { assetId: old.logo_asset_id },
        null,
        req.requestId,
      );
    });
    res.json(await getBrand(db));
  });
  app.get('/api/v1/users', admin, async (req, res) => {
    const paging = pageSchema.strict().parse(req.query);
    const [count] = await db.query('SELECT count(*)::int AS total FROM users');
    res.json({
      data: await db.query(
        'SELECT id,email,name,role,enabled,created_at FROM users ORDER BY name,id LIMIT $1 OFFSET $2',
        [paging.pageSize, (paging.page - 1) * paging.pageSize],
      ),
      total: count.total,
      ...paging,
    });
  });
    app.post('/api/v1/users', admin, async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(2).max(100),
        email: z.string().trim().email().max(254),
        password: passwordSchema,
        role: z.enum(roles),
        enabled: z.boolean().default(true),
      })
      .strict()
      .parse(req.body);
    const email = data.email.toLowerCase();
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await db.transaction(async (tx) => {
      if ((await tx.query('SELECT id FROM users WHERE email=$1', [email])).length)
        throw new AppError(409, 'DUPLICATE', 'This email already has an account.');
      // Admin-created accounts start with a temporary password that the person must replace
      // at first sign-in (see must_change_password in security.ts and auth.ts).
      const [created] = await tx.query(
        'INSERT INTO users(email,name,password_hash,role,enabled,must_change_password) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,email,name,role,enabled,created_at',
        [email, data.name, passwordHash, data.role, data.enabled, true],
      );
      // An account made directly supersedes any pending invitation for the same email.
      await tx.query(
        'UPDATE invitations SET consumed_at=now() WHERE email=$1 AND consumed_at IS NULL',
        [email],
      );
      // The password is never written to the audit log.
      await audit(
        tx,
        req.user!.id,
        'user.created',
        'user',
        created.id,
        null,
        { email, name: data.name, role: data.role, enabled: data.enabled },
        req.requestId,
      );
      return created;
    });
    res.status(201).json(user);
  });
  app.post('/api/v1/users/invitations', admin, async (req, res) => {
    const data = z
      .object({ email: z.string().trim().email().max(254), role: z.enum(roles) })
      .strict()
      .parse(req.body);
    const token = secretToken();
    await db.transaction(async (tx) => {
      if (
        (await tx.query('SELECT id FROM users WHERE email=$1', [data.email.toLowerCase()])).length
      )
        throw new AppError(409, 'DUPLICATE', 'This email already has an account.');
      await tx.query(
        'UPDATE invitations SET consumed_at=now() WHERE email=$1 AND consumed_at IS NULL',
        [data.email.toLowerCase()],
      );
      const [invite] = await tx.query(
        "INSERT INTO invitations(email,role,token_hash,invited_by,expires_at) VALUES ($1,$2,$3,$4,now()+interval '48 hours') RETURNING id",
        [data.email.toLowerCase(), data.role, hashToken(token), req.user!.id],
      );
      await tx.query("INSERT INTO outbox(type,payload) VALUES ('invitation',$1::jsonb)", [
        JSON.stringify({ to: data.email.toLowerCase(), token }),
      ]);
      await audit(
        tx,
        req.user!.id,
        'user.invited',
        'invitation',
        invite.id,
        null,
        data,
        req.requestId,
      );
    });
    res.status(201).json({ message: 'Invitation queued for delivery.' });
  });
  app.patch('/api/v1/users/:id', admin, async (req, res) => {
    const id = uuid(req.params.id);
    const data = z
      .object({ role: z.enum(roles), enabled: z.boolean() })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(781020)');
      const [user] = await tx.query('SELECT id,role,enabled FROM users WHERE id=$1 FOR UPDATE', [
        id,
      ]);
      if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found.');
      if (user.role === 'Admin' && user.enabled && (data.role !== 'Admin' || !data.enabled)) {
        const [count] = await tx.query(
          "SELECT count(*)::int AS total FROM users WHERE role='Admin' AND enabled=true",
        );
        if (count.total <= 1)
          throw new AppError(409, 'LAST_ADMIN', 'Keep at least one active Admin.');
      }
      await tx.query(
        'UPDATE users SET role=$1,enabled=$2,token_version=token_version+1 WHERE id=$3',
        [data.role, data.enabled, id],
      );
      await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [id]);
      await audit(tx, req.user!.id, 'user.access_changed', 'user', id, user, data, req.requestId);
    });
    res.status(204).end();
  });
  app.get('/api/v1/audit-events', admin, async (req, res) => {
    const data = pageSchema
      .extend({ q: z.string().max(100).default('') })
      .strict()
      .parse(req.query);
    const [count] = await db.query(
      'SELECT count(*)::int AS total FROM audit_events WHERE action ILIKE $1',
      [`%${data.q}%`],
    );
    res.json({
      data: await db.query(
        "SELECT a.*,coalesce(u.name,'Unknown account') AS actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE action ILIKE $1 ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3",
        [`%${data.q}%`, data.pageSize, (data.page - 1) * data.pageSize],
      ),
      total: count.total,
      ...data,
    });
  });
  app.get('/api/v1/stock/reconcile', admin, async (_req, res) =>
    res.json({ discrepancies: await reconcile(db) }),
  );
  app.get('/api/v1/exports/items.csv', async (req, res) => {
    const data = itemQuerySchema.parse(req.query);
    const { where, params } = itemFilters(data);
    const rows = await db.query(`${itemSelect}${where} ORDER BY i.name,i.id LIMIT 10001`, params);
    if (rows.length > 10000)
      throw new AppError(422, 'EXPORT_LIMIT', 'Narrow your filters to at most 10,000 items.');
    res
      .attachment(`SDP-Inventory-${new Date().toISOString().slice(0, 10)}.csv`)
      .type('text/csv')
      .send(
        csvRows(rows, [
          'sku',
          'name',
          'barcode',
          'category',
          'supplier',
          'quantity',
          'reorder_level',
          'status',
        ]),
      );
  });
  app.post(['/api/v1/reports/stock', '/api/v1/labels'], async (req, res) => {
    const data = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(2000).optional(),
        includeLogo: z.boolean().default(true),
        filters: itemQuerySchema.partial().optional(),
      })
      .strict()
      .parse(req.body || {});
    let items: any[];
    if (data.filters) {
      const { where, params } = itemFilters(itemQuerySchema.parse(data.filters));
      items = await db.query(`${itemSelect}${where} ORDER BY i.name,i.id LIMIT 2001`, params);
    } else items = await reportItems(db, data.ids);
    if (items.length > 2000)
      throw new AppError(422, 'EXPORT_LIMIT', 'Narrow your report to at most 2,000 items.');
    const labels = req.path.endsWith('labels');
    const bytes = await pdfReport(db, items, req.user!.name, labels, data.includeLogo);
    res
      .attachment(`SDP-${labels ? 'Labels' : 'Stock-report'}.pdf`)
      .type('pdf')
      .send(bytes);
  });
  app.post(
    '/api/v1/imports/items',
    editors,
    uploadGate,
    csvUpload.single('file'),
    async (req, res) => {
      if (!req.file) throw new AppError(422, 'FILE_REQUIRED', 'Choose a CSV file.');
      let records: Record<string, string>[];
      try {
        records = parse(req.file.buffer, {
          columns: true,
          skip_empty_lines: true,
          bom: true,
          trim: true,
          max_record_size: 20000,
        });
      } catch {
        throw new AppError(
          422,
          'INVALID_CSV',
          'This CSV could not be read. Use the provided column template.',
        );
      }
      if (!records.length || records.length > 1000)
        throw new AppError(422, 'IMPORT_LIMIT', 'Import between 1 and 1,000 rows at a time.');
      const rows: { row: number; data: any }[] = [];
      const errors: any[] = [];
      const skus = new Set<string>();
      const barcodes = new Set<string>();
      for (const [index, record] of records.entries()) {
        const parsed = itemSchema.safeParse({
          name: record.name,
          sku: record.sku,
          barcode: record.barcode || '',
          category: record.category,
          supplier: record.supplier || '',
          description: record.description || '',
          reorderLevel: record.reorder_level || 10,
          serialized: record.serialized === 'true',
        });
        if (!parsed.success) {
          for (const issue of parsed.error.issues)
            errors.push({ row: index + 2, field: issue.path.join('.'), message: issue.message });
          continue;
        }
        if (
          Object.keys(record).some(
            (key) =>
              ![
                'name',
                'sku',
                'barcode',
                'category',
                'supplier',
                'description',
                // Accept older templates, but ignore their former pricing columns.
                'unit_price',
                'unit_cost',
                'reorder_level',
                'serialized',
              ].includes(key),
          )
        ) {
          errors.push({
            row: index + 2,
            field: 'columns',
            message:
              'Unsupported column. Stock quantities must be entered through stock movements.',
          });
          continue;
        }
        const sku = identity(parsed.data.sku);
        const barcode = parsed.data.barcode ? identity(parsed.data.barcode) : '';
        const exists = (
          await db.query('SELECT id FROM items WHERE sku_normalized=$1 OR barcode_normalized=$2', [
            sku,
            barcode || null,
          ])
        ).length;
        if (exists || skus.has(sku) || (barcode && barcodes.has(barcode))) {
          errors.push({
            row: index + 2,
            field: 'sku/barcode',
            message: 'SKU or barcode already exists in inventory or this file.',
          });
          continue;
        }
        skus.add(sku);
        if (barcode) barcodes.add(barcode);
        rows.push({ row: index + 2, data: parsed.data });
      }
      const [job] = await db.query(
        'INSERT INTO import_jobs(actor_id,rows,errors) VALUES ($1,$2::jsonb,$3::jsonb) RETURNING id',
        [req.user!.id, JSON.stringify(rows), JSON.stringify(errors)],
      );
      res.status(201).json({
        id: job.id,
        validRows: rows.length,
        errors,
        preview: rows.slice(0, 10),
        status: 'preview',
      });
    },
  );
  app.get('/api/v1/imports/:id', editors, async (req, res) => {
    const [job] = await db.query('SELECT * FROM import_jobs WHERE id=$1', [uuid(req.params.id)]);
    if (!job || (job.actor_id !== req.user!.id && req.user!.role !== 'Admin'))
      throw new AppError(404, 'NOT_FOUND', 'Import not found.');
    res.json({
      id: job.id,
      validRows: job.rows.length,
      errors: job.errors,
      preview: job.rows
        .slice(0, 10)
        .map((row: any) => ({ ...row, data: itemSchema.strip().parse(row.data) })),
      status: job.status,
      result: job.result,
    });
  });
  app.get('/api/v1/imports/:id/errors', editors, async (req, res) => {
    const [job] = await db.query('SELECT * FROM import_jobs WHERE id=$1', [uuid(req.params.id)]);
    if (!job || (job.actor_id !== req.user!.id && req.user!.role !== 'Admin'))
      throw new AppError(404, 'NOT_FOUND', 'Import not found.');
    res
      .attachment('SDP-import-errors.csv')
      .type('csv')
      .send(csvRows(job.errors, ['row', 'field', 'message']));
  });
  app.post('/api/v1/imports/:id/commit', editors, async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body || {});
    const id = uuid(req.params.id);
    // One transaction with savepoints gives durable partial results and repeat-safe commit.
    const result = await db.transaction(async (tx) => {
      const [job] = await tx.query('SELECT * FROM import_jobs WHERE id=$1 FOR UPDATE', [id]);
      if (!job || (job.actor_id !== req.user!.id && req.user!.role !== 'Admin'))
        throw new AppError(404, 'NOT_FOUND', 'Import not found.');
      if (job.status === 'committed') return job.result;
      let accepted = 0;
      const errors = [...job.errors];
      for (const row of job.rows) {
        await tx.exec('SAVEPOINT import_row');
        try {
          // Reviewed jobs created by older versions may still contain removed fields.
          await saveItem(tx, itemSchema.strip().parse(row.data), req.user!.id, req.requestId);
          accepted++;
          await tx.exec('RELEASE SAVEPOINT import_row');
        } catch {
          await tx.exec('ROLLBACK TO SAVEPOINT import_row');
          await tx.exec('RELEASE SAVEPOINT import_row');
          errors.push({
            row: row.row,
            field: 'identity',
            message: 'This row could not be committed. Check for a duplicate SKU or barcode.',
          });
        }
      }
      const result = { accepted, rejected: new Set(errors.map((error) => error.row)).size, errors };
      await tx.query(
        "UPDATE import_jobs SET status='committed',result=$1::jsonb,errors=$2::jsonb WHERE id=$3",
        [JSON.stringify(result), JSON.stringify(errors), id],
      );
      await audit(
        tx,
        req.user!.id,
        'import.committed',
        'import',
        id,
        null,
        { accepted, rejected: result.rejected },
        req.requestId,
      );
      return result;
    });
    res.json(result);
  });
  app.use('/api', (_req, _res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'This endpoint does not exist.')),
  );
  if (config.production) {
    app.use(express.static(path.resolve('dist'), { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
  }
  app.use(errorHandler);
  return app;
}
