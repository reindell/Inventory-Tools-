import { expect, type Page } from '@playwright/test';
export async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email address', { exact: true }).fill('admin@e2e.local');
  await page.getByLabel('Password', { exact: true }).fill(process.env.E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}
