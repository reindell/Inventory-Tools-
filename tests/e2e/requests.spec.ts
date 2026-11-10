import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { login } from './helpers';

async function adminSession(page: Page) {
  const response = page.waitForResponse(
    (value) => value.url().endsWith('/api/v1/auth/login') && value.request().method() === 'POST',
  );
  await login(page);
  const authenticated = await response;
  const body = await authenticated.json();
  return {
    Authorization: `Bearer ${body.token}`,
    'X-CSRF-Token': authenticated.request().headers()['x-csrf-token'],
    Origin: 'http://127.0.0.1:5174',
  };
}

async function provisionRequester(page: Page, headers: Record<string, string>) {
  const suffix = randomUUID().slice(0, 8);
  const email = `requester-${suffix}@e2e.local`;
  const name = `Production requester ${suffix}`;
  const password = `Request-test-${randomUUID()}`;
  const invite = await page.request.post('/api/v1/users/invitations', {
    headers,
    data: { email, role: 'Staff' },
  });
  expect(invite.status(), await invite.text()).toBe(201);
  // This is the isolated browser-test mail directory, never the real bootstrap account.
  const mailDirectory = path.resolve(process.env.E2E_DATA_DIR!, 'mail');
  let token: string | undefined;
  await expect
    .poll(
      async () => {
        for (const file of await readdir(mailDirectory).catch(() => [])) {
          if (!file.endsWith('.eml')) continue;
          const mail = await readFile(path.join(mailDirectory, file), 'utf8');
          if (!mail.includes(email)) continue;
          const decoded = mail.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
          token = decoded.match(/\/activate#token=([A-Za-z0-9_-]{32,128})/)?.[1];
          if (token) return true;
        }
        return false;
      },
      { timeout: 30000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  const accepted = await page.request.post('/api/v1/auth/accept-invitation', {
    headers,
    data: { token, name, password },
  });
  expect(accepted.status(), await accepted.text()).toBe(201);
  return { email, name, password };
}

test('a request-only user requests and cancels photographed jigs while Admin monitors issues and returns', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const headers = await adminSession(page);
  const account = await provisionRequester(page, headers);
  const suffix = randomUUID().slice(0, 8);
  const name = `Photographed production jig ${suffix}`;
  const sku = `E2E-JIG-${suffix}`;
  const created = await page.request.post('/api/v1/items', {
    headers,
    data: { name, sku, category: 'Tools and jigs', reorderLevel: 0, serialized: false },
  });
  expect(created.status(), await created.text()).toBe(201);
  const tool = await created.json();
  const receipt = await page.request.post('/api/v1/stock', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: {
      itemId: tool.id,
      type: 'in',
      quantity: 8,
      reason: 'Browser workflow fixture receipt',
      expectedVersion: tool.stock_version,
    },
  });
  expect(receipt.status(), await receipt.text()).toBe(201);
  const image = await sharp({
    create: { width: 48, height: 40, channels: 3, background: '#003e6f' },
  })
    .png()
    .toBuffer();
  const photo = await page.request.post(`/api/v1/items/${tool.id}/images`, {
    headers,
    multipart: { file: { name: 'production-jig.png', mimeType: 'image/png', buffer: image } },
  });
  expect(photo.status(), await photo.text()).toBe(201);
  const physicalQuantity = async () => {
    const detail = await page.request.get(`/api/v1/items/${tool.id}`, { headers });
    expect(detail.status()).toBe(200);
    return (await detail.json()).item.quantity;
  };

  const context = await browser.newContext();
  const requester = await context.newPage();
  try {
    await requester.goto('http://127.0.0.1:5174/login');
    await requester.getByLabel('Email address', { exact: true }).fill(account.email);
    await requester.getByLabel('Password', { exact: true }).fill(account.password);
    await requester.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      requester.getByRole('heading', { name: 'Tool requests', exact: true }),
    ).toBeVisible();
    await expect(requester).toHaveURL(/\/requests$/);
    for (const label of [
      'Dashboard',
      'Stock movements',
      'Users & roles',
      'Audit log',
      'Settings',
    ]) {
      await expect(
        requester
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: label, exact: true }),
      ).toHaveCount(0);
    }
    await requester.goto('http://127.0.0.1:5174/inventory/new');
    await expect(requester.getByRole('heading', { name: 'Access restricted' })).toBeVisible();

    const sendRequest = async (quantity: number) => {
      await requester.goto(`http://127.0.0.1:5174/inventory?q=${sku}`);
      await expect(requester.getByRole('link', { name: 'Add item', exact: true })).toHaveCount(0);
      await expect(
        requester.getByRole('button', { name: 'Manage stock', exact: true }),
      ).toHaveCount(0);
      await requester.getByRole('button', { name: `Request ${name}`, exact: true }).click();
      const dialog = requester.getByRole('dialog', { name: 'Request tools or jigs', exact: true });
      await expect(dialog.locator('img')).toBeVisible();
      await expect
        .poll(() =>
          dialog.locator('img').evaluate((value) => (value as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      expect(
        (
          await new AxeBuilder({ page: requester })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await dialog.getByLabel('Quantity requested', { exact: false }).fill(String(quantity));
      await dialog
        .getByLabel('Purpose', { exact: false })
        .fill('Assembly line changeover and fixture setup');
      const response = requester.waitForResponse(
        (value) => value.url().endsWith('/api/v1/requests') && value.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
      const sent = await response;
      expect(sent.status(), await sent.text()).toBe(201);
      const value = await sent.json();
      await expect(dialog).not.toBeVisible();
      return value;
    };

    const cancelled = await sendRequest(2);
    expect(await physicalQuantity()).toBe(8);
    await requester.goto(`http://127.0.0.1:5174/requests?requestId=${cancelled.id}`);
    const requestRow = requester
      .getByRole('row')
      .filter({ has: requester.getByRole('link', { name, exact: true }) });
    await requestRow.getByRole('button', { name: 'Cancel request', exact: true }).click();
    const cancelDialog = requester.getByRole('dialog', { name: 'Cancel request', exact: true });
    await cancelDialog.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(cancelDialog).not.toBeVisible();
    await expect(requestRow.locator('[data-label="Status"]')).toHaveText('Cancelled');
    expect(await physicalQuantity()).toBe(8);

    const requested = await sendRequest(5);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Request notifications', exact: true }).click();
    const notices = page.getByRole('dialog', { name: 'Request notifications', exact: true });
    await expect(notices).toContainText(name);
    await notices.locator(`a[href="/requests?requestId=${requested.id}"]`).click();
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name, exact: true }) });
    await expect(row).toContainText(account.name);
    await expect(row.locator('img')).toBeVisible();
    await row.getByRole('button', { name: 'Approve request', exact: true }).click();
    const approval = page.getByRole('dialog', { name: 'Approve request', exact: true });
    await approval.getByRole('button', { name: 'Approve request', exact: true }).click();
    await expect(approval).not.toBeVisible();
    await expect(row.locator('[data-label="Status"]')).toHaveText('Approved');
    expect(await physicalQuantity()).toBe(8);
    await row.getByRole('button', { name: 'Issue tools', exact: true }).click();
    const issue = page.getByRole('dialog', { name: 'Issue tools', exact: true });
    await issue.getByLabel('Quantity to issue', { exact: false }).fill('3');
    await issue.getByRole('button', { name: 'Issue tools', exact: true }).click();
    await expect(issue).not.toBeVisible();
    await expect(row.locator('[data-label="Status"]')).toHaveText('In use');
    await expect(row.getByText('Requested', { exact: true }).locator('..')).toContainText('5');
    await expect(row.getByText('Issued', { exact: true }).first().locator('..')).toContainText('3');
    expect(await physicalQuantity()).toBe(5);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: 'docs/screenshots/tool-requests-admin.png', fullPage: true });

    await requester.goto(`http://127.0.0.1:5174/requests?requestId=${requested.id}`);
    await expect(requestRow.locator('[data-label="Status"]')).toHaveText('In use');
    await expect(
      requestRow.getByRole('button', { name: 'Cancel request', exact: true }),
    ).toHaveCount(0);
    await expect(requestRow.getByRole('button', { name: 'Issue tools', exact: true })).toHaveCount(
      0,
    );
    await requester.setViewportSize({ width: 390, height: 844 });
    expect(
      await requester.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page: requester })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await requester.screenshot({
      path: 'docs/screenshots/tool-requests-mobile.png',
      fullPage: true,
    });

    for (const amount of [1, 2]) {
      await row.getByRole('button', { name: 'Record return', exact: true }).click();
      const returned = page.getByRole('dialog', { name: 'Record return', exact: true });
      await returned.getByLabel('Quantity returned', { exact: false }).fill(String(amount));
      await returned.getByRole('button', { name: 'Record return', exact: true }).click();
      await expect(returned).not.toBeVisible();
    }
    await expect(row.locator('[data-label="Status"]')).toHaveText('Returned');
    await expect(row.getByText('Returned', { exact: true }).first().locator('..')).toContainText(
      '3',
    );
    expect(await physicalQuantity()).toBe(8);
  } finally {
    await context.close();
  }
});

test('a failed request retains quantity and purpose and can be retried safely', async ({
  page,
}) => {
  await login(page);
  await page.goto('/inventory?q=SDP-BR-0025');
  await page.getByRole('button', { name: 'Request Bridge rectifier D25XB80', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Request tools or jigs', exact: true });
  await dialog.getByLabel('Quantity requested', { exact: false }).fill('2');
  await dialog
    .getByLabel('Purpose', { exact: false })
    .fill('Test retained request input after a network failure');
  await page.route('**/api/v1/requests', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'UNAVAILABLE', message: 'Requests are temporarily unavailable.' },
        }),
      });
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Requests are temporarily unavailable.');
  await expect(dialog.getByLabel('Quantity requested', { exact: false })).toHaveValue('2');
  await expect(dialog.getByLabel('Purpose', { exact: false })).toHaveValue(
    'Test retained request input after a network failure',
  );
  await page.unroute('**/api/v1/requests');
  await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Tool request sent.' })).toBeVisible();
});
