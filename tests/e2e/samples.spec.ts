import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login } from './helpers';

test('the Excel sample catalog shows the original jig photo and requestable spare quantity', async ({
  page,
}) => {
  test.skip(
    process.env.E2E_SAMPLE_SOURCE !== 'workbook',
    'Runs against the dedicated workbook sample seed.',
  );
  await login(page);
  await page.goto('/inventory?q=SIP-3S-SBD-003');
  const name = 'SBD CHIP TRANSFER JIG [3S (SBD)]';
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(row).toBeVisible();
  const image = row.locator('img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await row.getByRole('button', { name: `Request ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Request tools or jigs', exact: true });
  await expect(dialog).toContainText('8 units available');
  await expect(dialog.locator('img')).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: 'docs/screenshots/excel-jig-sample.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await row.getByRole('link', { name, exact: true }).click();
  await expect(page.locator('.description-text')).toContainText('in use: 2; spare: 8');
  await expect(page.locator('.gallery-main img')).toBeVisible();
});
