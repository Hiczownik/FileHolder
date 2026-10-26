import { describe, it, expect } from 'vitest';
import packageJson from '../../../../package.json' with { type: 'json' };
import { UI_BUILD, describeBuild } from '../buildInfo';

describe('build info', () => {
    it("is this UI's package version, fixed at build time", () => {
        expect(UI_BUILD.version).toBe(packageJson.version);
        expect(UI_BUILD.commit).not.toBe('');
    });

    it('reads as "v0.9.0 · abc1234"', () => {
        expect(describeBuild({ version: '0.9.0', commit: 'abc1234' })).toBe('v0.9.0 · abc1234');
    });

    it('leaves out a commit nobody passed', () => {
        expect(describeBuild({ version: '0.9.0', commit: 'unknown' })).toBe('v0.9.0');
    });
});
