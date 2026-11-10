import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Database } from './db.js';
import { audit } from './db.js';
import { changeStock, saveItem } from './inventory.js';
import { identity } from '../shared/contracts.js';
import { processImage } from './images.js';
import { putFile, removeFile } from './storage.js';

const count = z.number().int().min(0).max(1000000000).nullable();
const sampleSchema = z
  .object({
    sku: z.string().max(64),
    name: z.string().max(150),
    category: z.enum(['Tools', 'Jigs']),
    sheet: z.string(),
    rows: z.array(z.number().int().positive()).min(1),
    series: z.string(),
    chipSize: z.string(),
    article: z.string(),
    inUse: count,
    spare: count,
    stock: count,
    total: count,
    minimum: count,
    maximum: count,
    remarks: z.string(),
    setSize: z.string(),
    photos: z.array(z.string().regex(/^images\/[a-f0-9]{64}\.(png|jpe?g)$/)).max(5),
  })
  .strict();
const catalogSchema = z
  .object({
    source: z.literal('SIP Assembly Jigs.xlsx'),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    notes: z.array(z.string()),
    items: z.array(sampleSchema).min(1).max(1000),
    warnings: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();
export type JigSample = z.infer<typeof sampleSchema>;
const directory = path.resolve('samples/sip-assembly-jigs');

export async function loadSampleCatalog() {
  const catalog = catalogSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'catalog.json'), 'utf8')),
  );
  if (new Set(catalog.items.map((item) => identity(item.sku))).size !== catalog.items.length)
    throw new Error('The sample catalog has duplicate source SKUs.');
  return catalog;
}
export function sampleAvailable(item: JigSample) {
  const available = (item.spare || 0) + (item.stock || 0);
  if (available > 1000000000) throw new Error('Sample availability exceeds the inventory limit.');
  return available;
}
export function sampleDescription(item: JigSample) {
  return [
    'Source workbook: SIP Assembly Jigs.xlsx',
    `Source sheet: ${item.sheet}; row${item.rows.length > 1 ? 's' : ''}: ${item.rows.join(', ')}.`,
    `Production series: ${item.series}.`,
    item.chipSize ? `Chip size / model: ${item.chipSize}.` : '',
    item.article ? `Applicable articles: ${item.article}.` : '',
    `Workbook reference — in use: ${item.inUse ?? 'not entered'}; spare: ${item.spare ?? 'not entered'}; stock: ${item.stock ?? 'not entered'}; total: ${item.total ?? 'not entered'}.`,
    'Existing workbook in-use counts are reference data; borrowers were not provided. New handovers are tracked through tool requests.',
    item.minimum !== null ? `Workbook minimum inventory: ${item.minimum}.` : '',
    item.maximum !== null ? `Workbook maximum inventory: ${item.maximum}.` : '',
    item.setSize ? `Set size: ${item.setSize}.` : '',
    item.remarks ? `Workbook remarks: ${item.remarks}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Add samples without replacing existing items, photos, balances, loans or history. */
export async function importSampleCatalog(
  db: Database,
  actorId: string,
  options: { withStock?: boolean; skus?: string[] } = {},
) {
  const [actor] = await db.query(
    "SELECT id FROM users WHERE id=$1 AND enabled=true AND role='Admin'",
    [actorId],
  );
  if (!actor) throw new Error('An enabled Admin is required to import the sample catalog.');
  const catalog = await loadSampleCatalog();
  const items = options.skus
    ? catalog.items.filter((item) => options.skus!.includes(item.sku))
    : catalog.items;
  const summary = {
    source: catalog.source,
    created: 0,
    skipped: 0,
    photos: 0,
    availableUnitsAdded: 0,
    sourceWarnings: catalog.warnings.length,
  };
  const processed = new Map<string, Awaited<ReturnType<typeof processImage>>>();
  for (const sample of items) {
    const [existing] = await db.query('SELECT id FROM items WHERE sku_normalized=$1', [
      identity(sample.sku),
    ]);
    if (existing) {
      summary.skipped++;
      continue;
    }
    const uploads: { key: string; thumbnail: string }[] = [];
    try {
      for (const photo of sample.photos) {
        let image = processed.get(photo);
        if (!image) {
          const bytes = await readFile(path.join(directory, photo));
          if (
            createHash('sha256').update(bytes).digest('hex') !== path.basename(photo).split('.')[0]
          )
            throw new Error('Sample photo checksum mismatch.');
          image = await processImage(bytes);
          processed.set(photo, image);
        }
        const key = await putFile(image.optimized, 'webp', 'image/webp');
        try {
          const thumbnail = await putFile(image.thumbnail, 'webp', 'image/webp');
          uploads.push({ key, thumbnail });
        } catch (error) {
          await removeFile(key);
          throw error;
        }
      }
      const quantity = options.withStock ? sampleAvailable(sample) : 0;
      const created = await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(781021)');
        if (
          (await tx.query('SELECT id FROM items WHERE sku_normalized=$1', [identity(sample.sku)]))
            .length
        )
          return false;
        const item = await saveItem(
          tx,
          {
            name: sample.name,
            sku: sample.sku,
            barcode: '',
            category: sample.category,
            supplier: '',
            description: sampleDescription(sample),
            serialized: false,
            reorderLevel: sample.minimum || 0,
          },
          actorId,
        );
        if (quantity)
          await changeStock(
            db,
            {
              itemId: item.id,
              type: 'in',
              quantity,
              expectedVersion: item.stock_version,
              reason: 'Excel sample opening stock',
              note: `${catalog.source}; ${sample.sheet}; row(s) ${sample.rows.join(', ')}. SPARE + STOCK only; existing IN-USE is excluded. Sample counts require verification before live use.`,
              direction: 'add',
              serials: [],
              outStatus: 'sold',
            },
            actorId,
            'Admin',
            randomUUID(),
            undefined,
            { tx },
          );
        for (const [index, upload] of uploads.entries()) {
          await tx.query(
            'INSERT INTO item_images(item_id,object_key,thumbnail_key,sort_order,is_primary) VALUES ($1,$2,$3,$4,$5)',
            [item.id, upload.key, upload.thumbnail, index, index === 0],
          );
          await audit(tx, actorId, 'item.image_added', 'item', item.id, null, {
            objectKey: upload.key,
            source: catalog.source,
          });
        }
        await audit(tx, actorId, 'samples.imported', 'item', item.id, null, {
          source: catalog.source,
          sourceSha256: catalog.sourceSha256,
          sheet: sample.sheet,
          rows: sample.rows,
          quantity,
          photos: uploads.length,
        });
        return true;
      });
      if (created) {
        summary.created++;
        summary.photos += uploads.length;
        summary.availableUnitsAdded += quantity;
      } else {
        summary.skipped++;
        await Promise.all(
          uploads.flatMap((upload) => [removeFile(upload.key), removeFile(upload.thumbnail)]),
        );
      }
    } catch (error) {
      await Promise.all(
        uploads.flatMap((upload) => [removeFile(upload.key), removeFile(upload.thumbnail)]),
      );
      throw error;
    }
  }
  return summary;
}
