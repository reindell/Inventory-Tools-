import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve('public/brand');
await mkdir(directory, { recursive: true });
const mark = path.join(
  directory,
  existsSync(path.join(directory, 'sdp-mark.svg')) ? 'sdp-mark.svg' : 'sdp-mark.png',
);
const provisional = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="80" fill="#1D4ED8"/><text x="256" y="303" text-anchor="middle" font-family="Arial,sans-serif" font-size="170" font-weight="700" fill="white">SDP</text></svg>',
);
for (const size of [16, 32, 180, 192, 512]) {
  const target =
    size < 100 ? `favicon-${size}.png` : size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  const bytes = await sharp(existsSync(mark) ? mark : provisional)
    .resize(size, size, { fit: 'contain' })
    .png()
    .toBuffer();
  await writeFile(path.join(directory, target), bytes);
  if (size === 180) await writeFile(path.join(directory, 'icon-180.png'), bytes);
}
await writeFile(
  path.join(directory, 'manifest.webmanifest'),
  JSON.stringify(
    {
      name: 'SDP Inventory',
      short_name: 'SDP',
      start_url: '/',
      display: 'standalone',
      background_color: '#FFFFFF',
      theme_color: '#1D4ED8',
      icons: [192, 512].map((size) => ({
        src: `/brand/icon-${size}.png`,
        sizes: `${size}x${size}`,
        type: 'image/png',
      })),
    },
    null,
    2,
  ) + '\n',
);
console.info(
  existsSync(mark)
    ? 'Icons generated from approved mark.'
    : 'Provisional SDP text icons generated. No company logo was fabricated.',
);
