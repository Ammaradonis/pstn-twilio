import { expect, test } from './fixtures';

test.describe('Messages', () => {
  test('shows the inbound SMS and lets the user send a reply', async ({ page, state }) => {
    // sign in
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('owner@example.com');
    await page.getByLabel(/password/i).fill('correct-horse');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    // navigate to inbox
    await page.goto('/numbers/n1/messages');
    await expect(page.getByText('hi from the past')).toBeVisible();
    await expect(page.getByText('+1 (555) 867-5309')).toBeVisible();

    // compose
    await page.getByLabel(/to/i).fill('+15558675309');
    await page.getByLabel(/message/i).fill('reply from the test');
    await page.getByRole('button', { name: /send/i }).click();

    // optimistic update via mock
    await expect(page.getByText('reply from the test')).toBeVisible();
    expect(state.messagesByNumberId['n1']?.[0]?.body).toBe('reply from the test');
  });
});
