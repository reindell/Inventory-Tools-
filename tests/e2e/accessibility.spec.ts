import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login } from './helpers';

test('login and primary screens pass automated WCAG AA checks in light and dark', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/login.png', fullPage: true });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await login(page);
  for (const route of ['/', '/inventory', '/movements', '/settings']) {
    await page.goto(route);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading' })).not.toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
      route,
    ).toEqual([]);
  }
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
    'dark settings',
  ).toEqual([]);
  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Manage stock', exact: true }).first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
    'stock dialog',
  ).toEqual([]);
});
