import { describe, it, expect } from 'vitest';
import { buildDiagnosticsReport } from '../diagnosticsReport';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const BYTES_PER_KB = 1024;
const BYTES_PER_GB = BYTES_PER_KB * BYTES_PER_KB * BYTES_PER_KB;
const QUOTA_GB = 10;
const USED_GB = 4;

describe('buildDiagnosticsReport', () => {
    it('describes what Safari on an iPhone would do, line by line', () => {
        const report = buildDiagnosticsReport({
            capabilities: { serviceWorker: true, isWebKit: true, fileSystemAccess: false, opfs: true },
            storage: { quota: QUOTA_GB * BYTES_PER_GB, usage: USED_GB * BYTES_PER_GB },
            lastSaveReport: 'Saved "big.bin" via opfs. Skipped: service-worker (held back on WebKit).',
            userAgent: IPHONE_SAFARI,
            secureContext: true,
        });

        expect(report.split('\n')).toEqual([
            'Will try, in order: opfs → memory',
            'Left out up front: service-worker (held back on WebKit), file-system-access (no showSaveFilePicker)',
            'Secure context (HTTPS): yes',
            'Site storage: 6 GB free of 10 GB',
            'Last download: Saved "big.bin" via opfs. Skipped: service-worker (held back on WebKit).',
            `Browser: ${IPHONE_SAFARI}`,
        ]);
    });

    it('makes a page served over plain HTTP obvious, since it switches off everything but memory', () => {
        const report = buildDiagnosticsReport({
            capabilities: { serviceWorker: false, isWebKit: true, fileSystemAccess: false, opfs: false },
            storage: null,
            lastSaveReport: null,
            userAgent: IPHONE_SAFARI,
            secureContext: false,
        });

        expect(report).toContain('Will try, in order: memory');
        expect(report).toContain('Secure context (HTTPS): no');
        expect(report).toContain('Site storage: no estimate available');
        expect(report).toContain('Last download: none yet');
    });
});
