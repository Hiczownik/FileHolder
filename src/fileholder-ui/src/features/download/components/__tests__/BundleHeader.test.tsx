import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BundleHeader } from '../BundleHeader';
import type { FileGroupMetadataResponse } from '../../types';

const base: FileGroupMetadataResponse = {
    shareToken: 'header_token',
    totalSizeBytes: 0,
    fileCount: 1,
    requiresPassword: true,
    isUnlocked: false,
    isEncrypted: true,
    isExpired: false,
    files: [],
};

const heading = (metadata: FileGroupMetadataResponse): string => {
    render(<BundleHeader metadata={metadata} />);
    return screen.getByRole('heading').textContent ?? '';
};

describe('BundleHeader', () => {
    it('calls a locked encrypted bundle just that, since its title is still encrypted', () => {
        expect(heading(base)).toBe('Encrypted bundle');
    });

    it('shows the decrypted title once the bundle is unlocked', () => {
        expect(heading({ ...base, isUnlocked: true, title: 'Tax return 2026' })).toBe('Tax return 2026');
    });

    it('falls back to a generic heading for an unlocked bundle without a title', () => {
        expect(heading({ ...base, isUnlocked: true })).toBe('Shared File Group');
    });

    it('shows a plain bundle\'s title as before', () => {
        expect(heading({ ...base, isEncrypted: false, title: 'Holiday photos' })).toBe('Holiday photos');
    });
});
