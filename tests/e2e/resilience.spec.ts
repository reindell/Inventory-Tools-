import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('protects unsaved item edits and commits search only after IME composition', async ({
  page,
}) => {
  await login(page);
  await page.goto('/inventory/new');
  await page.getByLabel('Item name', { exact: false }).fill('Unsaved production part');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Stock movements' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Item name', { exact: false })).toHaveValue(
    'Unsaved production part',
  );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Inventory', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search inventory' });
  await search.dispatchEvent('compositionstart');
  await search.fill('MOSFET');
  await page.waitForTimeout(450); // Intentionally exceed the documented 300 ms debounce.
  expect(new URL(page.url()).searchParams.get('q')).toBeNull();
  await search.dispatchEvent('compositionend');
  await expect(page).toHaveURL(/q=MOSFET/);
  await expect(page.getByRole('link', { name: 'Power MOSFET P40NF03', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search inventory' }).click();
  await expect(search).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page.locator('html').evaluate((element) => getComputedStyle(element).scrollbarColor),
  ).not.toBe('auto');
  const stockFilter = page.getByLabel('Stock level', { exact: true });
  await stockFilter.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(stockFilter).toHaveValue('in');
});
