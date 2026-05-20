import { expect, test } from './fixtures';

test.describe('Authentication', () => {
  test('redirects unauthenticated visitors to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  });

  test('shows an error message when the password is wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('owner@example.com');
    await page.getByLabel(/password/i).fill('definitely-wrong');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('signs in with valid credentials and lands on the dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('owner@example.com');
    await page.getByLabel(/password/i).fill('correct-horse');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
    await expect(page.getByText(/active numbers/i)).toBeVisible();
  });

  test('signs out and returns to /login', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('owner@example.com');
    await page.getByLabel(/password/i).fill('correct-horse');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
