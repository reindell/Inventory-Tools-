import { Worker } from 'node:worker_threads';
import { fileTypeFromBuffer } from 'file-type';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from './errors.js';

const allowedTags = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
  'line',
  'title',
  'desc',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
]);
const allowedAttrs = new Set([
  'xmlns',
  'width',
  'height',
  'viewBox',
  'fill',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'd',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'transform',
  'id',
  'gradientUnits',
  'gradientTransform',
  'offset',
  'stop-color',
  'stop-opacity',
  'fx',
  'fy',
  'preserveAspectRatio',
]);
export function validateSvg(source: Buffer) {
  const xml = source.toString('utf8');
  if (
    !/^\s*(?:<\?xml[^?]*\?>\s*)?<svg[\s>]/i.test(xml) ||
    /<!|&|url\s*\(|(?:https?:|data:|file:|javascript:)/i.test(
      xml.replace(/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/g, ''),
    ) ||
    XMLValidator.validate(xml) !== true
  )
    throw new AppError(
      422,
      'UNSAFE_SVG',
      'Use a simple SVG without scripts, entities, links, styles or external resources.',
    );
  const document = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: false,
    processEntities: false,
  }).parse(xml);
  let nodes = 0;
  function visit(value: any, depth = 0) {
    if (++nodes > 10000 || depth > 30)
      throw new AppError(422, 'UNSAFE_SVG', 'This SVG is too complex. Upload PNG or WebP instead.');
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '?xml' && depth === 0) continue;
      if (key === '#text') continue;
      if (key.startsWith('@_')) {
        if (!allowedAttrs.has(key.slice(2)))
          throw new AppError(
            422,
            'UNSAFE_SVG',
            `Unsupported SVG attribute. Use PNG or WebP instead.`,
          );
      } else {
        if (!allowedTags.has(key))
          throw new AppError(
            422,
            'UNSAFE_SVG',
            'Unsupported SVG content. Use PNG or WebP instead.',
          );
        visit(child, depth + 1);
      }
    }
  }
  visit(document);
}
let processing = 0;
export async function processImage(source: Buffer, logo = false) {
  if (source.length > (logo ? 2 : 10) * 1024 * 1024)
    throw new AppError(
      413,
      'FILE_TOO_LARGE',
      logo ? 'Logo must be 2 MiB or smaller.' : 'Images must be 10 MiB or smaller.',
    );
  const type = await fileTypeFromBuffer(source);
  if (!type && logo) validateSvg(source);
  else if (
    !type ||
    !(logo ? ['image/png', 'image/webp'] : ['image/png', 'image/jpeg', 'image/webp']).includes(
      type.mime,
    )
  )
    throw new AppError(
      422,
      'INVALID_IMAGE',
      logo ? 'Upload a PNG, SVG or WebP logo.' : 'Upload a PNG, JPEG or WebP image.',
    );
  if (processing >= 2)
    throw new AppError(429, 'IMAGE_BUSY', 'Image processing is busy. Try again shortly.');
  processing++;
  try {
    return await new Promise<{ optimized: Buffer; thumbnail: Buffer }>((resolve, reject) => {
      // The worker file is copied unchanged beside production bundles by scripts/copy-worker.mjs.
      const worker = new Worker(new URL('./image-worker.js', import.meta.url), {
        workerData: { bytes: source, logo },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      });
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        reject(
          new AppError(
            422,
            'INVALID_IMAGE',
            'The image cannot be safely processed. Check its format, dimensions and complexity.',
          ),
        );
      };
      const timer = setTimeout(fail, 10000);
      worker.once('message', (result) => {
        if (settled) return;
        if (result.error) {
          fail();
          return;
        }
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve({
          optimized: Buffer.from(result.optimized),
          thumbnail: Buffer.from(result.thumbnail),
        });
      });
      worker.once('error', fail);
      worker.once('exit', (code) => {
        if (code !== 0 || !settled) fail();
      });
    });
  } finally {
    processing--;
  }
}
