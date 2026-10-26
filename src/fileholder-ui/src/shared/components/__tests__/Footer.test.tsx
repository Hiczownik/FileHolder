import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Footer } from '../Footer';
import { UI_BUILD, describeBuild } from '../../utils/buildInfo';

describe('Footer', () => {
    it("shows which build the page is", () => {
        render(<Footer />);

        expect(screen.getByTestId('ui-build')).toHaveTextContent(describeBuild(UI_BUILD));
        expect(screen.getByTestId('ui-build').textContent?.startsWith(`v${UI_BUILD.version}`)).toBe(true);
    });
});
