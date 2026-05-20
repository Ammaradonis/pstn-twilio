import { expect, test } from './fixtures';

async function signIn(page: Parameters<typeof test.fn>[0]['page']) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('owner@example.com');
  await page.getByLabel(/password/i).fill('correct-horse');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe('Numbers', () => {
  test('lists provisioned numbers and opens detail', async ({ page }) => {
    await signIn(page);
    await page
      .getByRole('link', { name: /numbers/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/numbers$/);
    await expect(page.getByRole('cell', { name: 'Demo Number' })).toBeVisible();
    await expect(page.getByRole('link', { name: '+1 (555) 123-4567' })).toBeVisible();

    await page.getByRole('link', { name: '+1 (555) 123-4567' }).click();
    await expect(page).toHaveURL(/\/numbers\/n1$/);
    await expect(page.getByRole('heading', { name: '+1 (555) 123-4567' })).toBeVisible();
    await expect(page.locator('main p').filter({ hasText: 'Demo Number' })).toBeVisible();
  });
});
