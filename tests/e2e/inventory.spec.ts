import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('complete item lifecycle: create, stock in/out, edit, archive, restore and export', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByText('In-stock items', { exact: true })).toBeVisible();
  await expect(page.getByText('Stock value', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await page.getByRole('link', { name: 'Add item', exact: true }).click();
  const sku = `E2E-${Date.now()}`;
  await page.getByLabel('Item name', { exact: false }).fill('E2E production diode');
  await page.getByLabel('SKU', { exact: false }).fill(sku);
  await page.getByLabel('Category', { exact: false }).fill('Semiconductors');
  await expect(page.getByLabel(/unit price|unit cost/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Create item' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search inventory' }).fill(sku);
  await expect(page.getByRole('link', { name: 'E2E production diode', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /price|cost|value/i })).toHaveCount(0);
  await page.getByRole('link', { name: 'E2E production diode', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'E2E production diode', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^(Unit price|Unit cost|Stock value)$/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage stock', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Quantity', { exact: true }).fill('8');
  await dialog.getByLabel('Reason', { exact: true }).fill('E2E supplier receipt');
  await dialog.getByRole('button', { name: 'Record stock in' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.detail-stock-value strong')).toHaveText('8');
  await page.getByRole('button', { name: 'Manage stock', exact: true }).click();
  await dialog.getByRole('button', { name: 'Stock out', exact: true }).click();
  await dialog.getByLabel('Quantity', { exact: true }).fill('9');
  await dialog.getByLabel('Reason', { exact: true }).fill('E2E issue validation');
  await dialog.getByRole('button', { name: 'Record stock out' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Only 8 units');
  await dialog.getByLabel('Quantity', { exact: true }).fill('8');
  await dialog.getByRole('button', { name: 'Record stock out' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.detail-stock-value strong')).toHaveText('0');
  await page.getByRole('link', { name: 'Edit item', exact: true }).click();
  await expect(page.getByLabel(/unit price|unit cost/i)).toHaveCount(0);
  await page.getByLabel('Item name', { exact: false }).fill('E2E verified diode');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'E2E verified diode', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'E2E verified diode', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Archive item', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive item', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore item' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stock position', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Restore item' }).click();
  await expect(page.getByRole('button', { name: 'Manage stock', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stock position', exact: true })).toBeFocused();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download printable label' }).click();
  expect((await download).suggestedFilename()).toBe('SDP-SKU-label.pdf');
});

test('search handles empty results, clearing, sorting and paging', async ({ page }) => {
  await login(page);
  await page.goto('/inventory');
  const search = page.getByRole('searchbox', { name: 'Search inventory' });
  await search.fill('NO-SUCH-PART-1234');
  await expect(page.getByText('No matching items', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search inventory' }).click();
  await expect(search).toBeFocused();
  await expect(
    page.getByRole('link', { name: 'Bridge rectifier D25XB80', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  await expect(page).toHaveURL(/sort=quantity/);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('Page 2');
});

test('keyboard dialog focus and server error recovery preserve input', async ({ page }) => {
  await login(page);
  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Manage stock', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Reason', { exact: true }).fill('Keep this note');
  await page.route('**/api/v1/stock', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAVAILABLE', message: 'Stock service unavailable. Try again.' },
      }),
    }),
  );
  await dialog.getByRole('button', { name: 'Record stock in' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Stock service unavailable');
  await expect(dialog.getByLabel('Reason', { exact: true })).toHaveValue('Keep this note');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Manage stock', exact: true }).first(),
  ).toBeFocused();
});

test('mobile navigation, inventory cards and dark mode remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('link', { name: 'Inventory', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'docs/screenshots/inventory-mobile-dark.png', fullPage: true });
});

test('loading and error states reserve usable list controls', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/items?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAVAILABLE', message: 'Inventory is temporarily unavailable.' },
      }),
    });
  });
  await page.goto('/inventory');
  await expect(page.getByRole('status', { name: 'Loading' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Inventory is temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('Admin branding upload changes shared logo and records an audit event', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Company logo' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Company details' })).toHaveCount(0);
  await expect(page.getByLabel('Company name', { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('Production location name', { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('Display timezone', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save company details' })).toHaveCount(0);
  await expect(page.getByLabel('Currency code', { exact: false })).toHaveCount(0);
  await expect(page.locator('.sidebar .sidebar-company')).toHaveText(
    'SHINDENGEN ELECTRIC MFG.CO.,LTD',
  );
  const sidebarLogo = page.locator('.sidebar .brand img');
  await expect(sidebarLogo).toBeVisible();
  await expect(sidebarLogo).toHaveAttribute('src', '/brand/sdp-logo.svg');
  await expect
    .poll(() =>
      sidebarLogo.evaluate(
        (image) =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebarLogo).toHaveAttribute('src', '/brand/sdp-mark.png');
  await expect(sidebarLogo).toBeVisible();
  await expect
    .poll(() =>
      sidebarLogo.evaluate(
        (image) =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(sidebarLogo).toHaveAttribute('src', '/brand/sdp-logo.svg');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(sidebarLogo).toBeVisible();
  await expect(sidebarLogo).toHaveClass(/logo-plate/);
  await expect(sidebarLogo).toHaveAttribute('src', '/brand/sdp-logo.svg');
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await page.getByLabel('Choose company logo').setInputFiles({
    name: 'brand.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="50"><rect width="180" height="50" fill="#1D4ED8"/><path d="M10 10L30 40" stroke="white" stroke-width="4"/></svg>',
    ),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Company logo updated.' })).toBeVisible();
  await expect(page.locator('.sidebar .brand img')).toHaveAttribute('src', /brand-logo/);
  await page.getByRole('link', { name: 'View branding audit events' }).click();
  await expect(page.getByText('branding.logo_replaced').first()).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Remove custom logo' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove custom logo' }).click();
  await expect(sidebarLogo).toHaveAttribute('src', '/brand/sdp-logo.svg');
  await expect(sidebarLogo).toBeVisible();
  await expect
    .poll(() =>
      sidebarLogo.evaluate(
        (image) =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(page.locator('.sidebar .sidebar-company')).toHaveText(
    'SHINDENGEN ELECTRIC MFG.CO.,LTD',
  );
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('.auth-company-name')).toHaveText('SHINDENGEN ELECTRIC MFG.CO.,LTD');
  const loginLogo = page.locator('.auth-brand img');
  await expect(loginLogo).toHaveAttribute('src', '/brand/sdp-logo.svg');
  await expect(loginLogo).toBeVisible();
  await expect
    .poll(() =>
      loginLogo.evaluate(
        (image) =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
});

test('captures desktop screens and has no client runtime errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await login(page);
  await page.screenshot({ path: 'docs/screenshots/dashboard.png', fullPage: true });
  await page.goto('/inventory');
  await expect(
    page.getByRole('link', { name: 'Bridge rectifier D25XB80', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/inventory.png', fullPage: true });
  await page.goto('/movements');
  await expect(page.getByRole('heading', { name: 'Stock movements', exact: true })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Company logo' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/settings.png', fullPage: true });
  expect(errors).toEqual([]);
});
