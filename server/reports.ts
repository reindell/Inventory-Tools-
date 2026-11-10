import PDFDocument from 'pdfkit';
import bwip from 'bwip-js';
import { stringify } from 'csv-stringify/sync';
import type { Sql } from './db.js';
import { itemSelect } from './inventory.js';
import { getBrand, logoBytes } from './branding.js';
import type { Brand } from '../shared/contracts.js';

export function safeCell(value: unknown) {
  const text = String(value ?? '');
  return /^[\s]*[=+@\-\t\r]/.test(text) ? `'${text}` : text;
}
export function csvRows(rows: Record<string, unknown>[], columns: string[]) {
  return (
    '\uFEFF' +
    stringify(
      rows.map((row) =>
        Object.fromEntries(columns.map((column) => [column, safeCell(row[column])])),
      ),
      { header: true, columns },
    )
  );
}
export async function pdfReport(
  db: Sql,
  items: any[],
  actor: string,
  labels = false,
  includeLogo = true,
) {
  const brand = await getBrand(db);
  const logo = includeLogo ? await logoBytes(db) : null;
  const doc = new PDFDocument({
    size: 'A4',
    margin: 44,
    info: {
      Title: `${brand.appName} | ${labels ? 'SKU labels' : 'Stock report'}`,
      Author: brand.companyName,
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const header = () => {
    if (logo) doc.image(logo, 44, 35, { fit: [140, 45] });
    else doc.fontSize(26).fillColor('#1D4ED8').text('SDP', 44, 40);
    doc
      .fillColor('#0F172A')
      .fontSize(10)
      .text(brand.companyName, 205, 40, { width: 345, align: 'right' });
    doc
      .fontSize(9)
      .text(`${brand.locationName} | ${brand.appName}`, 205, 58, { width: 345, align: 'right' });
    doc.moveTo(44, 100).lineTo(550, 100).strokeColor('#DCE2EC').stroke();
    doc.y = 116;
  };
  header();
  doc
    .fontSize(19)
    .fillColor('#0F172A')
    .text(labels ? 'SKU labels' : 'Stock report', 44);
  doc
    .fontSize(9)
    .text(
      `Generated ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: brand.timezone }).format(new Date())} | ${actor}`,
      { width: 505 },
    );
  doc.moveDown();
  let page = 1;
  for (const item of items) {
    if (doc.y > (labels ? 650 : 700)) {
      doc.fontSize(8).text(`${brand.appName} | Page ${page++}`, 44, 780);
      doc.addPage();
      header();
    }
    if (labels) {
      const top = doc.y;
      if (includeLogo) {
        if (logo) doc.image(logo, 44, top, { fit: [90, 22] });
        else doc.fontSize(15).text('SDP', 44, top);
      }
      doc.fillColor('#0F172A').fontSize(11).text(item.name, 150, top, { width: 350 });
      const barcode = await bwip.toBuffer({
        bcid: 'code128',
        text: item.barcode || item.sku,
        scale: 2,
        height: 12,
        includetext: true,
        textxalign: 'center',
      });
      doc.image(barcode, 150, top + 23, { fit: [300, 70] });
      doc.y = top + 112;
    } else {
      const top = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').text(item.name, 44, top, { width: 295 });
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#526078')
        .text(`${item.sku} | ${item.category}`, 44, top + 18, { width: 320 });
      doc
        .fillColor('#0F172A')
        .fontSize(10)
        .text(`${item.quantity} units`, 370, top, { width: 180, align: 'right' });
      doc.fontSize(9).text(`Reorder level: ${item.reorder_level} units`, 350, top + 18, {
        width: 200,
        align: 'right',
      });
      doc.y = top + 46;
    }
  }
  if (!items.length) doc.fontSize(11).text('No items match the selected filters.');
  doc.fontSize(8).fillColor('#526078').text(`${brand.appName} | Page ${page}`, 44, 780);
  doc.end();
  return done;
}
export async function reportItems(db: Sql, ids?: string[]) {
  return db.query(
    `${itemSelect} WHERE i.status='active'${ids ? ' AND i.id=ANY($1::uuid[])' : ''} ORDER BY i.name,i.id LIMIT 2000`,
    ids ? [ids] : [],
  );
}
export function emailHtml(
  brand: Brand,
  heading: string,
  message: string,
  link?: string,
  hasLogo = false,
) {
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  return `<html><body style="font-family:Arial,sans-serif;color:#0f172a;background:#f4f6fa;padding:32px"><main style="max-width:560px;margin:auto;background:white;padding:32px">${hasLogo ? '<img src="cid:sdp-logo" alt="SDP logo" width="160" style="height:auto;max-height:80px;object-fit:contain">' : '<p style="font-size:28px;font-weight:bold;color:#1d4ed8">SDP</p>'}<p>${escape(brand.companyName)}</p><h1 style="font-size:22px">${escape(heading)}</h1><p>${escape(message)}</p>${link ? `<p><a href="${escape(link)}">${escape(heading)}</a></p>` : ''}<hr><small>${escape(brand.appName)} · ${escape(brand.locationName)}</small></main></body></html>`;
}
