import { test, expect } from '@playwright/test';
import { expectNoAccessibilityViolations } from './accessibility';

// The terms and privacy pages (#82): reachable from every page's footer and from the upload form, readable, and
// naming who runs the site and how to reach them.
test.describe('legal pages', () => {
  test('the footer leads to the terms and the privacy page', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('link', { name: 'Terms', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeVisible();
    await expect(page).toHaveTitle('Terms of use · FileHolder');

    await page.getByRole('link', { name: 'Privacy', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  });

  test('the upload form links the terms it asks uploaders to accept', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('link', { name: 'terms of use' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeVisible();
  });

  ['/terms', '/privacy'].forEach((address) => {
    test(`${address} names who runs the site and how to reach them, and is accessible`, async ({ page }) => {
      await page.goto(address);

      const contact = page.getByRole('complementary', { name: 'Contact' });
      await expect(contact).toContainText('Henryk I');
      await expect(contact.getByRole('link', { name: 'security@fileholder.app' })).toHaveAttribute('href', 'mailto:security@fileholder.app');
      await expectNoAccessibilityViolations(page);
    });
  });
});
