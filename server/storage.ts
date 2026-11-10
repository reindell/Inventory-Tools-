import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { config } from './config.js';
import { AppError } from './errors.js';

const s3 = new S3Client({
  endpoint: config.s3Endpoint,
  region: config.s3Region,
  forcePathStyle: true,
});
const directory = path.join(config.dataDir, 'uploads');
export async function storageReady() {
  if (config.storage === 's3') await s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket }));
  else await mkdir(directory, { recursive: true });
}
const validKey = (key: string) => /^[a-f0-9-]{36}\.(png|webp|csv|pdf)$/.test(key);
export async function putFile(
  bytes: Buffer,
  extension: 'png' | 'webp' | 'csv' | 'pdf',
  contentType: string,
) {
  const key = `${randomUUID()}.${extension}`;
  if (config.storage === 's3')
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ServerSideEncryption: process.env.S3_ENCRYPTION === 'AES256' ? 'AES256' : undefined,
      }),
    );
  else {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, key), bytes, { mode: 0o600 });
  }
  return key;
}
export async function readStoredFile(key: string) {
  if (!validKey(key)) throw new AppError(404, 'NOT_FOUND', 'File not found.');
  if (config.storage === 's3') {
    const result = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return Buffer.from(await result.Body!.transformToByteArray());
  }
  return readFile(path.join(directory, key));
}
export async function removeFile(key: string) {
  if (!validKey(key)) return;
  if (config.storage === 's3')
    await s3.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  else await unlink(path.join(directory, key)).catch(() => {});
}
export async function fileUrl(key: string) {
  // Sign same-origin API reads so private MinIO addresses never reach the browser.
  const expires = String(Date.now() + 15 * 60000);
  const signature = createHmac('sha256', config.cookieSecret)
    .update(`${key}:${expires}`)
    .digest('hex');
  return `/api/v1/files/${key}?expires=${expires}&signature=${signature}`;
}
export function validFileSignature(key: string, expires: unknown, signature: unknown) {
  if (
    !validKey(key) ||
    typeof expires !== 'string' ||
    typeof signature !== 'string' ||
    !/^\d{13}$/.test(expires) ||
    Number(expires) < Date.now() ||
    Number(expires) > Date.now() + 16 * 60000
  )
    return false;
  const expected = createHmac('sha256', config.cookieSecret)
    .update(`${key}:${expires}`)
    .digest('hex');
  return (
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
