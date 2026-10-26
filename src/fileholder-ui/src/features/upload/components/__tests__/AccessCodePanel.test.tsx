import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import { AccessCodePanel } from '../AccessCodePanel';
import { useAccessCode } from '../../hooks/useAccessCode';
import { uploadApi } from '../../api/uploadApi';
import { accessCodeStore } from '../../services/accessCode';
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from '../../services/uploadLimits';

const BYTES_PER_KIB = 1024;
const MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const WITHOUT_CODE_MIB = 10;
const WITH_CODE_MIB = 250;
const WITH_CODE_HOURS = 24;
const HTTP_BAD_REQUEST = 400;
const CODE = 'a03-7F3K-9Q2M-X8PD';
const REFUSAL = "This access code isn't valid or has expired. You can still upload with the smaller limits.";
const WITHOUT_CODE: UploadLimits = { ...DEFAULT_UPLOAD_LIMITS, maxBundleSizeBytes: WITHOUT_CODE_MIB * MIB, maxExpiryHours: 1, accessCodesEnabled: true };
const WITH_CODE: UploadLimits = { ...DEFAULT_UPLOAD_LIMITS, maxBundleSizeBytes: WITH_CODE_MIB * MIB, maxExpiryHours: WITH_CODE_HOURS, accessCodesEnabled: true };

const Panel: React.FC<{ readonly enabled?: boolean }> = ({ enabled = true }) => {
    const accessCode = useAccessCode(enabled);
    return (
        <>
            <AccessCodePanel baseLimits={WITHOUT_CODE} accessCode={accessCode} />
            <output data-testid="valid-code">{accessCode.validCode ?? ''}</output>
        </>
    );
};

const UNAVAILABLE = "The access code couldn't be checked just now. Try again, or upload with the limits above.";

/** The panel's paragraph that includes `text` (it also holds a button, so its text is split across elements). */
const paragraphWith = (text: string) => (_content: string, element: Element | null): boolean =>
    element?.tagName === 'P' && (element.textContent ?? '').includes(text);

const refused = (): AxiosError =>
    new AxiosError('refused', undefined, undefined, undefined, { status: HTTP_BAD_REQUEST, data: { detail: REFUSAL } } as AxiosResponse);

describe('the access code panel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        sessionStorage.clear();
        accessCodeStore.forget();
        window.history.replaceState(null, '', '/');
    });

    it('shows the limits without a code, and a field once asked', async () => {
        render(<Panel />);

        expect(screen.getByText(paragraphWith('Demo limits: up to 10 MB, kept for at most 1 hour'))).toBeInTheDocument();
        expect(screen.queryByLabelText('Access code')).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Have an access code?' }));

        expect(screen.getByRole('textbox', { name: 'Access code' })).toBeInTheDocument();
    });

    it('applies a typed code, and shows what it unlocks', async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockResolvedValue(WITH_CODE);
        render(<Panel />);

        await userEvent.click(screen.getByRole('button', { name: 'Have an access code?' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Access code' }), ` ${CODE} `);
        await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

        expect(await screen.findByText(paragraphWith('Access code applied: up to 250 MB, kept for at most 24 hours'))).toBeInTheDocument();
        expect(uploadApi.checkAccessCode).toHaveBeenCalledWith(CODE);
        expect(screen.getByTestId('valid-code')).toHaveTextContent(CODE);
        expect(sessionStorage.getItem('access_code')).toBe(CODE);
    });

    it('applies the code from a personal link, and takes it out of the address bar', async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockResolvedValue(WITH_CODE);
        window.history.replaceState(null, '', `/?code=${CODE}`);

        render(<Panel />);

        expect(await screen.findByText(paragraphWith('Access code applied'))).toBeInTheDocument();
        expect(window.location.search).toBe('');
        expect(sessionStorage.getItem('access_code')).toBe(CODE);
    });

    it('keeps a link\'s code until the server says codes are on, and only then checks it', async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockResolvedValue(WITH_CODE);
        window.history.replaceState(null, '', `/?code=${CODE}`);

        const { rerender } = render(<Panel enabled={false} />);
        expect(window.location.search).toBe('');
        expect(uploadApi.checkAccessCode).not.toHaveBeenCalled();

        rerender(<Panel enabled />);

        expect(await screen.findByText(paragraphWith('Access code applied'))).toBeInTheDocument();
    });

    it('applies a code kept from earlier in the tab', async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockResolvedValue(WITH_CODE);
        sessionStorage.setItem('access_code', CODE);

        render(<Panel />);

        expect(await screen.findByText(paragraphWith('Access code applied'))).toBeInTheDocument();
    });

    it('explains an invalid code, forgets it, and leaves the limits without a code', async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockRejectedValue(refused());
        window.history.replaceState(null, '', `/?code=${CODE}`);

        render(<Panel />);

        expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
        expect(screen.getByText(paragraphWith('Demo limits'))).toBeInTheDocument();
        expect(screen.getByTestId('valid-code')).toHaveTextContent('');
        expect(sessionStorage.getItem('access_code')).toBeNull();
    });

    it("says when the code couldn't be checked, and lets it be tried again", async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockRejectedValueOnce(new Error('Network Error')).mockResolvedValueOnce(WITH_CODE);
        sessionStorage.setItem('access_code', CODE);
        render(<Panel />);

        expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

        expect(await screen.findByText(paragraphWith('Access code applied'))).toBeInTheDocument();
    });

    it('removes an applied code', async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockResolvedValue(WITH_CODE);
        sessionStorage.setItem('access_code', CODE);
        render(<Panel />);

        await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

        expect(screen.getByText(paragraphWith('Demo limits'))).toBeInTheDocument();
        expect(sessionStorage.getItem('access_code')).toBeNull();
        await waitFor(() => expect(screen.getByTestId('valid-code')).toHaveTextContent(''));
    });
});
