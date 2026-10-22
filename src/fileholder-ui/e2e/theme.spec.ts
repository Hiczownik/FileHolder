import { test, expect, type Page } from '@playwright/test';
import { expectNoAccessibilityViolations } from './accessibility';

// Light and dark themes (#67, #126). Playwright's colorScheme stands in for the system setting.
const SCHEMES = ['light', 'dark'] as const;
const SWITCHING_CLASS = 'theme-switching';
const SCRIPT_EXTENSIONS = ['.js', '.ts', '.tsx'];

const isSwitching = (page: Page): Promise<boolean> =>
  page.evaluate((name) => document.documentElement.classList.contains(name), SWITCHING_CLASS);

const isScript = (url: URL): boolean => SCRIPT_EXTENSIONS.some((extension) => url.pathname.endsWith(extension));

SCHEMES.forEach((colorScheme) => {
  test.describe(`${colorScheme} system theme`, () => {
    test.use({ colorScheme });

    test(`is applied before the app's JavaScript runs (${colorScheme})`, async ({ page }) => {
      // Only theme-init.js may run: if the theme still comes out right, the first paint already had it.
      await page.route(isScript, (route) =>
        new URL(route.request().url()).pathname === '/theme-init.js' ? route.continue() : route.abort(),
      );
      await page.goto('/');

      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    });

    test(`the upload page passes the accessibility checks (${colorScheme})`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Theme: system' })).toBeVisible();

      await expectNoAccessibilityViolations(page);
    });
  });
});

test.describe('theme toggle', () => {
  test.use({ colorScheme: 'light' });

  test('a theme picked by hand wins over the system and survives a reload', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');

    // System → Light → Dark.
    await page.getByRole('button', { name: 'Theme: system' }).click();
    await page.getByRole('button', { name: 'Theme: light' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Theme: dark' })).toBeVisible();
  });

  test('switching cross-fades, then drops the transition', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Theme: system' }).click();
    await page.getByRole('button', { name: 'Theme: light' }).click();
    await expect.poll(() => isSwitching(page)).toBe(true);
    await expect.poll(() => isSwitching(page)).toBe(false);
  });

  test.describe('with reduced motion', () => {
    test('switching does not animate', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      await page.getByRole('button', { name: 'Theme: system' }).click();
      await page.getByRole('button', { name: 'Theme: light' }).click();

      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await isSwitching(page)).toBe(false);
    });
  });
});
