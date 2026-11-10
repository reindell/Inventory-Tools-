import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';

sharp.concurrency(1);
sharp.cache(false);
try {
  const source = Buffer.from(workerData.bytes);
  const logo = workerData.logo;
  const options = { limitInputPixels: logo ? 4096 * 4096 : 25000000, failOn: 'warning' };
  const metadata = await sharp(source, options).metadata();
  if (
    (metadata.pages || 1) > 1 ||
    !metadata.width ||
    !metadata.height ||
    (logo && (metadata.width > 4096 || metadata.height > 4096))
  )
    throw new Error('Invalid dimensions');
  const image = sharp(source, options).rotate();
  const optimized = logo
    ? await image
        .resize({ width: 1200, height: 400, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()
    : await image
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
  const thumbnail = await sharp(optimized)
    .resize(160, 160, { fit: 'contain', background: '#f4f6fa' })
    .webp({ quality: 80 })
    .toBuffer();
  parentPort.postMessage({ optimized, thumbnail });
} catch {
  parentPort.postMessage({ error: true });
}
