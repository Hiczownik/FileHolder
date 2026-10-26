import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ServiceStatusBanner } from '../ServiceStatusBanner';
import { ClosedPage } from '../ClosedPage';
import { NORMAL_STATUS, type ServiceStatus } from '../../services/serviceStatus';

const MS_PER_DAY = 86_400_000;
const IN_A_DAY = new Date(Date.now() + MS_PER_DAY);

describe('ServiceStatusBanner', () => {
    it.each<[string, ServiceStatus | null]>([
        ['before the status is known', null],
        ['in Normal', NORMAL_STATUS],
        ['in Closed, which has its own page', { mode: 'Closed', message: null, until: null, apiBuild: null }],
    ])('shows nothing %s', (_, status) => {
        const { container } = render(<ServiceStatusBanner status={status} />);

        expect(container).toBeEmptyDOMElement();
    });

    it("shows the owner's message and when they expect to be back", () => {
        render(<ServiceStatusBanner status={{ mode: 'UploadsPaused', message: 'Looking into abuse reports.', until: IN_A_DAY, apiBuild: null }} />);

        const banner = screen.getByRole('status');
        expect(banner).toHaveTextContent('Looking into abuse reports.');
        expect(banner).toHaveTextContent('Expected back');
    });

    it.each([
        ['UploadsPaused', 'New uploads are paused for now. Shared links still work.'],
        ['ReadOnly', "FileHolder is read-only for now: bundles can be viewed, but new uploads and downloads can't start."],
    ] as const)('explains %s itself when the owner gave no message', (mode, text) => {
        render(<ServiceStatusBanner status={{ mode, message: null, until: null, apiBuild: null }} />);

        expect(screen.getByRole('status')).toHaveTextContent(text);
    });
});

describe('ClosedPage', () => {
    it("says FileHolder is closed, with the owner's message, and focuses it for screen readers", () => {
        render(<ClosedPage status={{ mode: 'Closed', message: 'Down for an upgrade.', until: IN_A_DAY, apiBuild: null }} />);

        const heading = screen.getByRole('heading', { name: 'FileHolder is closed for now' });
        expect(heading).toHaveFocus();
        expect(screen.getByText('Down for an upgrade.')).toBeInTheDocument();
        expect(screen.getByText('Expected back', { exact: false })).toBeInTheDocument();
    });

    it('asks to check back later without an until', () => {
        render(<ClosedPage status={{ mode: 'Closed', message: null, until: null, apiBuild: null }} />);

        expect(screen.getByText('Please check back later.', { exact: false })).toBeInTheDocument();
    });
});
