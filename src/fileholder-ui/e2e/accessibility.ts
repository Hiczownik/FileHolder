import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// WCAG 2.1 A and AA, which includes colour-contrast (4.5:1 text, 3:1 large text).
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Fails with one line per broken rule and the elements that break it, e.g.
 * "color-contrast: .text-muted > span". Run it once the screen has settled: a theme cross-fade in progress would
 * be measured half way.
 */
export const expectNoAccessibilityViolations = async (page: Page): Promise<void> => {
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const violations = results.violations.map(
        (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    );
    expect(violations).toEqual([]);
};
