import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('edits, archives and restores directly from the inventory list while retaining filters', async ({
  page,
}) => {
  await login(page);
  await page.goto('/inventory');
  await page.getByRole('link', { name: 'Add item', exact: true }).click();

  const suffix = Date.now();
  const sku = `E2E-ROW-${suffix}`;
  const name = `Row action diode ${suffix}`;
  const updatedName = `Updated row diode ${suffix}`;
  await page.getByLabel('Item name', { exact: false }).fill(name);
  await page.getByLabel('SKU', { exact: false }).fill(sku);
  await page.getByLabel('Category', { exact: false }).fill('Semiconductors');
  await page.getByRole('button', { name: 'Create item', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();

  await page.goto(`/inventory?q=${sku}&sort=sku&direction=desc`);
  await page.getByRole('link', { name: `Edit ${name}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit item', exact: true })).toBeVisible();
  await expect(page.getByLabel('Item name', { exact: false })).toHaveValue(name);
  await page.getByLabel('Item name', { exact: false }).fill(updatedName);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: updatedName, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('q')).toBe(sku);
  expect(new URL(page.url()).searchParams.get('sort')).toBe('sku');
  expect(new URL(page.url()).searchParams.get('direction')).toBe('desc');

  await page.getByRole('button', { name: `Archive ${updatedName}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Archive ${updatedName}?`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Archive item', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('link', { name: updatedName, exact: true })).toHaveCount(0);
  await expect(page.locator('.table-summary > span')).toBeFocused();
  expect(new URL(page.url()).searchParams.get('q')).toBe(sku);

  await page.getByLabel('Status', { exact: true }).selectOption('archived');
  await expect(page.getByRole('link', { name: updatedName, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `Edit ${updatedName}`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Restore ${updatedName}`, exact: true }).click();
  await expect(page.getByRole('link', { name: updatedName, exact: true })).toHaveCount(0);
  await expect(page.locator('.table-summary > span')).toBeFocused();
  expect(new URL(page.url()).searchParams.get('status')).toBe('archived');
  expect(new URL(page.url()).searchParams.get('q')).toBe(sku);

  await page.getByLabel('Status', { exact: true }).selectOption('active');
  await expect(page.getByRole('link', { name: updatedName, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `Edit ${updatedName}`, exact: true })).toBeVisible();
});

test('keeps a stocked item active and shows the archive error in its confirmation dialog', async ({
  page,
}) => {
  await login(page);
  await page.goto('/inventory?q=SDP-BR-0025');
  const name = 'Bridge rectifier D25XB80';
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Archive ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Archive ${name}?`, exact: true });
  await dialog.getByRole('button', { name: 'Archive item', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Remove or reconcile remaining stock before archiving this item.',
  );
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('q')).toBe('SDP-BR-0025');
});
