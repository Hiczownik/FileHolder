import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Components colour themselves only through the roles in index.css (bg-surface, text-muted, ...), which switch with
// the theme (#67). A raw palette class (text-slate-400) or arbitrary colour (bg-[#123456]) stays the same in both
// themes and usually breaks one of them, so it fails here.
// Matches "bg-slate-950", "hover:text-indigo-400", "border-rose-500/30" and "bg-[#0f1211]"; not "bg-surface" or
// "text-accent".
// https://regex101.com/?regex=%5Cb%28%3F%3Abg%7Ctext%7Cborder%28%3F%3A-%5Bxytrbl%5D%29%3F%7Cring%28%3F%3A-offset%29%3F%7Cfrom%7Cto%7Cvia%7Cfill%7Cstroke%7Cdivide%7Coutline%7Cshadow%7Cplaceholder%7Caccent%7Ccaret%7Cdecoration%29-%28%3F%3A%28%3F%3Aslate%7Cgray%7Czinc%7Cneutral%7Cstone%7Cred%7Corange%7Camber%7Cyellow%7Clime%7Cgreen%7Cemerald%7Cteal%7Ccyan%7Csky%7Cblue%7Cindigo%7Cviolet%7Cpurple%7Cfuchsia%7Cpink%7Crose%29-%5Cd%7B2%2C3%7D%7Cwhite%5Cb%7Cblack%5Cb%7C%5C%5B%23%29&flags=g&testString=bg-slate-950%20hover%3Atext-indigo-400%20border-rose-500%2F30%20bg-%5B%230f1211%5D%20bg-surface%20text-accent%20text-white
const RAW_COLOUR = /\b(?:bg|text|border(?:-[xytrbl])?|ring(?:-offset)?|from|to|via|fill|stroke|divide|outline|shadow|placeholder|accent|caret|decoration)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white\b|black\b|\[#)/g;

const SOURCE_ROOT = path.resolve(__dirname, '..');

const componentFiles = (): string[] =>
    (fs.readdirSync(SOURCE_ROOT, { recursive: true }) as string[])
        .filter((file) => file.endsWith('.tsx') && !file.includes('__tests__'))
        .map((file) => path.join(SOURCE_ROOT, file));

describe('colour roles', () => {
    it('finds the components it checks', () => {
        expect(componentFiles().length).toBeGreaterThan(0);
    });

    it('components use colour roles, never raw palette colours', () => {
        const offenders = componentFiles().flatMap((file) =>
            (fs.readFileSync(file, 'utf8').match(RAW_COLOUR) ?? []).map(
                (match) => `${path.relative(SOURCE_ROOT, file)}: ${match}`,
            ),
        );

        expect(offenders).toEqual([]);
    });
});
