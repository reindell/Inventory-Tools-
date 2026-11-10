import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Brand } from '../shared/contracts.js';
import { COMPANY_NAME } from '../shared/contracts.js';
import type { Database, Sql } from './db.js';
import { audit } from './db.js';
import { fileUrl, putFile, readStoredFile } from './storage.js';
import { processImage } from './images.js';
import { config } from './config.js';

const bundled = (filename: string) =>
  existsSync(path.resolve('public/brand', filename)) ? `/brand/${filename}` : null;
export async function getBrand(db: Sql): Promise<Brand> {
  const [settings] = await db.query(
    'SELECT c.*,l.name AS location_name,a.object_key FROM company_settings c CROSS JOIN locations l LEFT JOIN brand_assets a ON a.id=c.logo_asset_id WHERE c.id=1',
  );
  const override = settings.object_key
    ? `/api/v1/settings/brand-logo?v=${settings.brand_version}`
    : null;
  return {
    companyName: COMPANY_NAME,
    appName: settings.app_name,
    locationName: settings.location_name,
    timezone: settings.timezone,
    version: settings.brand_version,
    logoUrl: override,
    fullLogoUrl: override || bundled('sdp-logo.svg'),
    darkLogoUrl: override || bundled('sdp-logo-dark.svg'),
    markUrl: override || bundled('sdp-mark.svg') || bundled('sdp-mark.png'),
    darkMarkUrl: override || bundled('sdp-mark-dark.svg') || bundled('sdp-mark.png'),
  };
}
export async function logoBytes(db: Sql): Promise<Buffer | null> {
  const [asset] = await db.query(
    'SELECT a.object_key FROM company_settings c JOIN brand_assets a ON a.id=c.logo_asset_id WHERE c.id=1',
  );
  if (asset) return readStoredFile(asset.object_key);
  const official = path.resolve('public/brand/sdp-logo.svg');
  if (existsSync(official)) {
    const sharp = (await import('sharp')).default;
    return sharp(readFileSync(official)).resize({ width: 600 }).png().toBuffer();
  }
  return null;
}
export async function replaceLogo(db: Database, bytes: Buffer, actor: string, requestId: string) {
  const { optimized } = await processImage(bytes, true);
  const key = await putFile(optimized, 'png', 'image/png');
  try {
    await db.transaction(async (tx) => {
      const [old] = await tx.query(
        'SELECT logo_asset_id FROM company_settings WHERE id=1 FOR UPDATE',
      );
      const [asset] = await tx.query(
        'INSERT INTO brand_assets(object_key,checksum,uploaded_by) VALUES ($1,$2,$3) RETURNING id',
        [key, createHash('sha256').update(optimized).digest('hex'), actor],
      );
      await tx.query(
        'UPDATE company_settings SET logo_asset_id=$1,brand_version=brand_version+1 WHERE id=1',
        [asset.id],
      );
      await audit(
        tx,
        actor,
        'branding.logo_replaced',
        'settings',
        '1',
        { assetId: old.logo_asset_id },
        { assetId: asset.id, checksum: createHash('sha256').update(optimized).digest('hex') },
        requestId,
      );
    });
  } catch (error) {
    const { removeFile } = await import('./storage.js');
    await removeFile(key);
    throw error;
  }
  return getBrand(db);
}
export async function imageMetadata(tx: Sql, itemId: string) {
  const images = await tx.query(
    'SELECT id,object_key,thumbnail_key,sort_order,is_primary FROM item_images WHERE item_id=$1 ORDER BY sort_order,id',
    [itemId],
  );
  return Promise.all(
    images.map(async (image) => ({
      id: image.id,
      sort_order: image.sort_order,
      is_primary: image.is_primary,
      url: await fileUrl(image.object_key),
      thumbnailUrl: await fileUrl(image.thumbnail_key),
    })),
  );
}
export function absoluteUrl(url: string) {
  return new URL(url, config.origin).toString();
}
