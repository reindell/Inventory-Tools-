import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './db.js';
import { config } from './config.js';
import { changeStock, saveItem } from './inventory.js';
import { randomUUID } from 'node:crypto';
import { logger } from './errors.js';
import { importSampleCatalog } from './sample-catalog.js';

export async function seed(db: Database) {
  if ((await db.query('SELECT id FROM users LIMIT 1')).length) return;
  let email = process.env.ADMIN_EMAIL;
  let password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    if (config.production)
      throw new Error(
        'ADMIN_EMAIL and ADMIN_PASSWORD are required for the initial production seed.',
      );
    const target = path.join(config.dataDir, 'bootstrap.json');
    let credentials: { email: string; password: string };
    try {
      credentials = JSON.parse(await readFile(target, 'utf8'));
    } catch {
      credentials = { email: 'admin@sdp.local', password: randomBytes(18).toString('base64url') };
      await writeFile(target, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    }
    email = credentials.email;
    password = credentials.password;
    logger.info(
      { credentialsFile: target },
      'Local Admin credentials are stored in this private file; never commit it',
    );
  }
  if (password.length < 12 || password.length > 128 || !email.includes('@'))
    throw new Error('Use a valid ADMIN_EMAIL and an ADMIN_PASSWORD of 12–128 characters.');
  const [admin] = await db.query(
    "INSERT INTO users(email,name,password_hash,role) VALUES ($1,'SDP Administrator',$2,'Admin') RETURNING id",
    [email.toLowerCase().trim(), await bcrypt.hash(password, 12)],
  );
  if (config.production && process.env.SEED_SAMPLE_DATA !== 'true') return;
  if (process.env.SEED_SAMPLE_SOURCE !== 'legacy-components') {
    logger.info(
      await importSampleCatalog(db, admin.id, { withStock: true }),
      'SIP Excel sample catalog imported',
    );
    return;
  }
  const samples = [
    ['Bridge rectifier D25XB80', 'SDP-BR-0025', 'Semiconductors', 'Shindengen', 1240, 250, false],
    ['Power MOSFET P40NF03', 'SDP-MS-0040', 'Semiconductors', 'Shindengen', 86, 100, false],
    ['DC-DC converter 24V / 5V', 'SDP-DC-2405', 'Power modules', 'Shindengen', 64, 20, false],
    [
      'Control board assembly C200',
      'SDP-PC-0200',
      'Assemblies',
      'Internal production',
      18,
      10,
      true,
    ],
    ['Schottky diode S10U60', 'SDP-SD-1060', 'Semiconductors', 'Shindengen', 0, 500, false],
    [
      'Aluminium heatsink 80 mm',
      'SDP-HS-0080',
      'Mechanical parts',
      'Precision Components',
      210,
      50,
      false,
    ],
    [
      'Ceramic capacitor 100 nF',
      'SDP-CC-0100',
      'Passive components',
      'Precision Components',
      8400,
      1000,
      false,
    ],
    ['Wire harness WH-12', 'SDP-WH-0012', 'Assemblies', 'Internal production', 32, 50, false],
    [
      'Insulating thermal pad',
      'SDP-TP-0001',
      'Consumables',
      'Precision Components',
      620,
      100,
      false,
    ],
    ['Gate driver IC G120', 'SDP-GD-0120', 'Semiconductors', 'Shindengen', 168, 60, false],
    [
      'M3 stainless mounting screw',
      'SDP-SC-0003',
      'Mechanical parts',
      'Precision Components',
      3200,
      500,
      false,
    ],
    ['Power supply unit PS-48', 'SDP-PS-0048', 'Power modules', 'Shindengen', 7, 10, true],
    [
      'ESD-safe component tray',
      'SDP-ES-0020',
      'Consumables',
      'Precision Components',
      48,
      20,
      false,
    ],
    [
      'Current sensing resistor',
      'SDP-CR-0010',
      'Passive components',
      'Precision Components',
      4500,
      500,
      false,
    ],
  ] as const;
  for (const [name, sku, category, supplier, quantity, reorderLevel, serialized] of samples) {
    const item = await db.transaction((tx) =>
      saveItem(
        tx,
        {
          name,
          sku,
          category,
          supplier,
          reorderLevel,
          serialized,
          barcode: '',
          description: `Production component: ${name}. Store in the designated ESD-safe area and verify the SKU before issuing stock.`,
        },
        admin.id,
      ),
    );
    if (quantity)
      await changeStock(
        db,
        {
          itemId: item.id,
          type: 'in',
          quantity,
          expectedVersion: item.stock_version,
          reason: 'Opening stock count',
          note: 'Sample data for local evaluation. Replace with a verified opening count before live use.',
          direction: 'add',
          serials: serialized
            ? Array.from({ length: quantity }, (_, i) => `${sku}-${String(i + 1).padStart(5, '0')}`)
            : [],
          outStatus: 'sold',
        },
        admin.id,
        'Admin',
        randomUUID(),
      );
  }
}
