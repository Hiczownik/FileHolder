import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UploadForm } from '../UploadForm';
import type { UploadState } from '../../types';
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from '../../services/uploadLimits';

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const DEMO_BUNDLE_MIB = 250;
const HALF_DAY = 12;
const ONE_DAY = 24;

const DEMO: UploadLimits = { ...DEFAULT_UPLOAD_LIMITS, maxBundleSizeBytes: DEMO_BUNDLE_MIB * BYTES_PER_MIB, maxExpiryHours: ONE_DAY };
const idleUploadState: UploadState = { status: 'idle' };

const expirySelect = (): HTMLSelectElement => screen.getByLabelText('Expires after') as HTMLSelectElement;
const expiryOptions = (): string[] => within(expirySelect()).getAllByRole('option').map((option) => option.textContent ?? '');

describe("UploadForm with the deployment's limits", () => {
    it('offers the full range with the default limits', () => {
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);

        expect(expiryOptions()).toEqual(['1 hour', '12 hours', '24 hours', '3 days', '7 days']);
        expect(screen.getByText('Up to 50 files, 5 GB in total')).toBeInTheDocument();
    });

    it("offers only the expiries a demo's limits allow, and says how much it takes", () => {
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} limits={DEMO} />);

        expect(expiryOptions()).toEqual(['1 hour', '12 hours', '24 hours']);
        expect(expirySelect().value).toBe(String(ONE_DAY));
        expect(screen.getByText('Up to 50 files, 250 MB in total')).toBeInTheDocument();
    });

    it("moves a choice the server's limits no longer allow down to the longest they do", () => {
        const { rerender } = render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);
        expect(expirySelect().value).toBe(String(ONE_DAY));

        rerender(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} limits={{ ...DEMO, maxExpiryHours: HALF_DAY }} />);

        expect(expirySelect().value).toBe(String(HALF_DAY));
    });
});
