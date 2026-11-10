import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
const [hostname, email] = process.argv.slice(2);
if (
  !hostname ||
  !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(hostname) ||
  !email ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
)
  throw new Error('Usage: node scripts/configure.mjs inventory.example.internal admin@example.com');
if (existsSync('.env')) throw new Error('.env already exists. It has not been changed.');
const secret = () => randomBytes(32).toString('hex');
const settings = {
  APP_HOST: hostname,
  APP_ORIGIN: `https://${hostname}`,
  ADMIN_EMAIL: email,
  ADMIN_PASSWORD: secret(),
  JWT_SECRET: secret(),
  COOKIE_SECRET: secret(),
  DB_PASSWORD: `Sdp!${secret()}`,
  APP_DB_PASSWORD: `Sdp!${secret()}`,
  SQLSERVER_SA_PASSWORD: `Sdp!${secret()}`,
  SQLSERVER_TRUST_SERVER_CERTIFICATE: 'true',
  MINIO_ROOT_USER: 'sdp-storage-root',
  MINIO_ROOT_PASSWORD: secret(),
  S3_ACCESS_KEY: randomBytes(10).toString('hex'),
  S3_SECRET_KEY: secret(),
  SMTP_URL: '',
  EMAIL_FROM: `SDP Inventory <${email}>`,
  SEED_SAMPLE_DATA: 'false',
};
writeFileSync(
  '.env',
  Object.entries(settings)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n') + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.info(
  'Created .env with unique secrets. Set SMTP_URL and review EMAIL_FROM before docker compose up --build -d. The initial Admin password is in .env; never commit or share this file.',
);
