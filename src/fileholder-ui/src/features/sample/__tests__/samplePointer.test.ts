import { describe, it, expect } from 'vitest';
import { parseSamplePointer, shareTokenOf } from '../samplePointer';

const ORIGIN = 'https://fileholder.app';
const LINK = `${ORIGIN}/f/abc123#k=linkKey`;
const CREATED_AT = '2026-10-26T12:00:00.000Z';
const EXPIRES_AT = '2026-10-27T12:00:00.000Z';
const POINTER = { link: LINK, createdAt: CREATED_AT, expiresAt: EXPIRES_AT };

describe('the sample pointer', () => {
    it('is read back as written', () => {
        expect(parseSamplePointer(POINTER, ORIGIN)).toEqual(POINTER);
        expect(shareTokenOf(POINTER)).toBe('abc123');
    });

    it('drops anything else in the file', () => {
        expect(parseSamplePointer({ ...POINTER, extra: 'ignored' }, ORIGIN)).toEqual(POINTER);
    });

    it.each([
        ['another site', 'https://evil.example/f/abc123#k=linkKey'],
        ['the same host over http', 'http://fileholder.app/f/abc123#k=linkKey'],
        ['a page that is not a bundle', `${ORIGIN}/terms#k=linkKey`],
        ['no share token', `${ORIGIN}/f/#k=linkKey`],
        ['a deeper path', `${ORIGIN}/f/abc123/x#k=linkKey`],
        ['a query', `${ORIGIN}/f/abc123?next=x#k=linkKey`],
        ['no key', `${ORIGIN}/f/abc123`],
        ['not a URL', 'f/abc123#k=linkKey'],
    ])('refuses a link to %s', (_case, link) => {
        expect(parseSamplePointer({ ...POINTER, link }, ORIGIN)).toBeUndefined();
    });

    it.each([
        ['nothing', null],
        ['a string', LINK],
        ['no dates', { link: LINK }],
        ['a date that is not one', { ...POINTER, expiresAt: 'tomorrow' }],
    ])('refuses %s', (_case, value) => {
        expect(parseSamplePointer(value, ORIGIN)).toBeUndefined();
    });
});
