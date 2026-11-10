import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './db.js';
import { config } from './config.js';
import { getBrand, logoBytes } from './branding.js';
import { emailHtml } from './reports.js';
import { logger } from './errors.js';
import { removeFile } from './storage.js';

export function startWorker(db: Database) {
  let running = false;
  const smtp = config.smtpUrl ? new URL(config.smtpUrl) : null;
  const transport = config.smtpUrl
    ? nodemailer.createTransport({
        host: smtp!.hostname,
        port: Number(smtp!.port || (smtp!.protocol === 'smtps:' ? 465 : 587)),
        secure: smtp!.protocol === 'smtps:',
        auth: smtp!.username
          ? { user: decodeURIComponent(smtp!.username), pass: decodeURIComponent(smtp!.password) }
          : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
        disableFileAccess: true,
        disableUrlAccess: true,
      })
    : nodemailer.createTransport({ streamTransport: true, buffer: true });
  async function tick() {
    if (running) return;
    running = true;
    try {
      const job = await db.transaction(async (tx) => {
        await tx.query(
          "UPDATE outbox SET state='failed',lease_until=NULL,last_error='Retry limit reached after an interrupted delivery' WHERE state='processing' AND lease_until<now() AND attempts>=5",
        );
        const [row] = await tx.query(
          "SELECT * FROM outbox WHERE ((state='pending' AND available_at<=now()) OR (state='processing' AND lease_until<now())) AND attempts<5 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
        );
        if (!row) return null;
        await tx.query(
          "UPDATE outbox SET state='processing',attempts=attempts+1,lease_until=now()+interval '2 minutes' WHERE id=$1",
          [row.id],
        );
        return row;
      });
      if (!job) return;
      try {
        if (job.type === 'delete-files') {
          for (const key of job.payload.keys) await removeFile(key);
        } else {
          const brand = await getBrand(db);
          const logo = await logoBytes(db);
          let targets: string[];
          let heading: string;
          let message: string;
          let link: string | undefined;
          if (job.type === 'low-stock') {
            targets = (
              await db.query(
                "SELECT email FROM users WHERE enabled=true AND role IN ('Admin','Manager')",
              )
            ).map((user) => user.email);
            heading = job.payload.quantity === 0 ? 'Out-of-stock alert' : 'Low-stock alert';
            message = `${job.payload.name} (${job.payload.sku}) has ${job.payload.quantity} units available. Reorder level: ${job.payload.reorderLevel}.`;
            link = `${config.origin}/inventory/${job.payload.itemId}`;
          } else if (job.type === 'tool-request') {
            targets = (
              await db.query(
                `SELECT email FROM users WHERE enabled=true AND (role='Admin'${job.payload.includeRequester ? ' OR id=$1' : ''})`,
                job.payload.includeRequester ? [job.payload.requesterId] : [],
              )
            ).map((user) => user.email);
            heading = job.payload.title;
            message = job.payload.message;
            link = `${config.origin}/requests?requestId=${job.payload.requestId}`;
          } else {
            targets = [job.payload.to];
            heading =
              job.type === 'invitation' ? 'Activate your SDP account' : 'Reset your SDP password';
            message =
              job.type === 'invitation'
                ? 'Your Admin invited you to SDP Inventory. This invitation expires in 48 hours.'
                : 'Use the link below within 30 minutes. If you did not request a reset, you can ignore this email.';
            link = `${config.origin}/${job.type === 'invitation' ? 'activate' : 'reset-password'}#token=${job.payload.token}`;
          }
          for (const target of targets) {
            const sent = await transport.sendMail({
              from: config.emailFrom,
              to: target,
              subject: `${brand.appName} | ${heading}`,
              text: `${brand.companyName}\n\n${heading}\n${message}\n${link || ''}`,
              html: emailHtml(brand, heading, message, link, !!logo),
              attachments: logo
                ? [
                    {
                      filename: 'sdp-logo.png',
                      content: logo,
                      cid: 'sdp-logo',
                      contentType: 'image/png',
                    },
                  ]
                : [],
            });
            if (!config.smtpUrl) {
              const directory = path.join(config.dataDir, 'mail');
              await mkdir(directory, { recursive: true });
              await writeFile(
                path.join(directory, `${job.id}-${targets.indexOf(target)}.eml`),
                (sent as unknown as { message: Buffer }).message,
                { mode: 0o600 },
              );
            }
          }
        }
        // Remove reset/invitation token payloads after delivery; do not retain bearer secrets indefinitely.
        await db.query(
          "UPDATE outbox SET state='sent',lease_until=NULL,payload='{}'::jsonb,last_error=NULL WHERE id=$1",
          [job.id],
        );
      } catch {
        await db.query(
          "UPDATE outbox SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,available_at=now()+interval '1 minute' * power(2,attempts),lease_until=NULL,last_error='Delivery or storage operation failed' WHERE id=$1",
          [job.id],
        );
        logger.warn({ jobId: job.id }, 'background job failed');
      }
    } catch {
      logger.error('Worker poll failed');
    } finally {
      running = false;
    }
  }
  const interval = setInterval(() => void tick(), 3000);
  interval.unref();
  return {
    tick,
    stop: async () => {
      clearInterval(interval);
      while (running) await new Promise((resolve) => setTimeout(resolve, 30));
      transport.close();
    },
  };
}
