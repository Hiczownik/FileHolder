import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BundleHeader } from '../BundleHeader';
import type { FileGroupMetadataResponse } from '../../types';

const BYTES_PER_KB = 1024;

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
        expect(heading({ ...base, isUnlocked: true })).toBe('Shared files');
    });

    it('leaves out the size of a locked bundle until it is known', () => {
        render(<BundleHeader metadata={base} />);
        expect(screen.getByText('1 file')).toBeInTheDocument();
    });

    it('shows the size once the bundle is unlocked', () => {
        render(<BundleHeader metadata={{ ...base, isUnlocked: true, totalSizeBytes: BYTES_PER_KB }} />);
        expect(screen.getByText('1 file · 1 KB')).toBeInTheDocument();
    });

    it('shows a plain bundle\'s title as before', () => {
        expect(heading({ ...base, isEncrypted: false, title: 'Holiday photos' })).toBe('Holiday photos');
    });

    it('gives a locked plain bundle a generic heading, since the server withholds its title', () => {
        expect(heading({ ...base, isEncrypted: false })).toBe('Shared files');
    });
});
