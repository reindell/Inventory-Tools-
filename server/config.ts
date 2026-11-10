import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const production = process.env.NODE_ENV === 'production';
const dataDir = path.resolve(process.env.DATA_DIR || '.data');
mkdirSync(dataDir, { recursive: true });
let devSecrets: { jwt: string; cookie: string } | undefined;
if (!production && (!process.env.JWT_SECRET || !process.env.COOKIE_SECRET)) {
  const target = path.join(dataDir, 'development-secrets.json');
  if (!existsSync(target))
    writeFileSync(
      target,
      JSON.stringify({
        jwt: randomBytes(48).toString('hex'),
        cookie: randomBytes(48).toString('hex'),
      }),
      { mode: 0o600 },
    );
  devSecrets = JSON.parse(readFileSync(target, 'utf8'));
}
export const config = {
  production,
  dataDir,
  port: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.PORT || 3001),
  origin: z
    .string()
    .url()
    .parse(process.env.APP_ORIGIN || 'http://localhost:5173'),
  jwtSecret: z
    .string()
    .min(32)
    .parse(process.env.JWT_SECRET || devSecrets?.jwt),
  cookieSecret: z
    .string()
    .min(32)
    .parse(process.env.COOKIE_SECRET || devSecrets?.cookie),
  databaseUrl: process.env.DATABASE_URL,
  storage: process.env.STORAGE_DRIVER || (production ? 's3' : 'local'),
  s3Endpoint: process.env.S3_ENDPOINT,
  s3Bucket: process.env.S3_BUCKET || 'sdp-private',
  s3Region: process.env.S3_REGION || 'us-east-1',
  smtpUrl: process.env.SMTP_URL,
  emailFrom: process.env.EMAIL_FROM || 'SDP Inventory <inventory@localhost>',
};
if (production) {
  if (!config.databaseUrl)
    throw new Error(
      'DATABASE_URL is required in production; use mssql:// for Microsoft SQL Server.',
    );
  if (!config.origin.startsWith('https://'))
    throw new Error('APP_ORIGIN must use HTTPS in production.');
  if (config.storage !== 's3') throw new Error('Production requires private S3 storage.');
  if (!config.smtpUrl) throw new Error('SMTP_URL is required in production.');
}
