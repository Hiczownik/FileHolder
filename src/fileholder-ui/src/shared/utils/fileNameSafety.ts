/**
 * Client-side copy of the server's file name rules (FileSecurityUtils.cs). The server applies them to
 * plain bundles, but in an encrypted bundle it only ever sees "{uuid}.enc": the real names live in the
 * encrypted manifest, which the uploader wrote and only the recipient's browser can read. So the
 * recipient enforces the same rules on the decrypted names. Both copies take the same steps, in the same order;
 * keep them in sync.
 */

// Same list as FileSecurityUtils.ForbiddenExtensions.
const FORBIDDEN_EXTENSIONS: ReadonlySet<string> = new Set([
    '.EXE', '.BAT', '.SH', '.CMD', '.DLL', '.PS1', '.VBS', '.JS', '.SCR', '.PIF', '.APPLICATION', '.MSI', '.COM',
    '.HTA', '.JAR', '.LNK', '.MSC', '.VBE', '.WSF', '.CPL', '.REG', '.ISO',
]);

const MAX_BODY_LENGTH = 190;
// 190 + 64 = 254, which fits the server's varchar(255) FileName column.
const MAX_EXTENSION_LENGTH = 64;
const MAX_STORED_LENGTH = 255;
const FALLBACK_NAME = 'unnamed_file';
// The first duplicate becomes "name (2).ext": the original counts as copy 1.
const FIRST_COPY_NUMBER = 2;
// Sanitizing repeats until nothing changes; it settles within a pass or two, this only bounds it.
const MAX_SANITIZE_PASSES = 5;

// Matches every code point the server replaces (anything but a letter, mark, decimal digit, connector, "." or "-"):
// in "zażółć report.txt" only the space matches; "ż", "_", "." and "-" don't.
// https://regex101.com/?regex=%5B%5E%5Cp%7BL%7D%5Cp%7BM%7D%5Cp%7BNd%7D%5Cp%7BPc%7D.-%5D&flags=gu&testString=za%C5%BC%C3%B3%C5%82%C4%87%20report.txt
const INVALID_CHARS = /[^\p{L}\p{M}\p{Nd}\p{Pc}.-]/gu;

// Matches either path separator, "/" or "\": "../../Startup/x.bat" and "C:\Users\x.bat" both split on it.
// https://regex101.com/?regex=%5B%2F%5C%5C%5D&flags=g&testString=..%2F..%2FStartup%2Fx.bat%0AC%3A%5CUsers%5Cx.bat
const PATH_SEPARATOR = /[/\\]/;

// Matches the trailing dots and spaces Windows drops when it saves a file: in "invoice.exe. ." the final ". ." matches,
// so "invoice.exe" is what lands on disk; "report.pdf" has none.
// https://regex101.com/?regex=%5B.%20%5D%2B%24&flags=gm&testString=invoice.exe.%20.%0Areport.pdf
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;

// Matches a name made only of dots, like "." or "..", but not "a.b" or ".env".
// https://regex101.com/?regex=%5E%5C.%2B%24&flags=gm&testString=.%0A..%0Aa.b%0A.env
const DOTS_ONLY = /^\.+$/;

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

/** Splits like .NET's Path.GetExtension: from the last dot, empty when the name ends with one. */
const splitExtension = (name: string): { readonly body: string; readonly extension: string } => {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) {
        return { body: name, extension: '' };
    }
    return { body: name.slice(0, dot), extension: name.slice(dot) };
};

const isHighSurrogate = (unit: number): boolean => unit >= HIGH_SURROGATE_FIRST && unit <= HIGH_SURROGATE_LAST;

/** The first `maxLength` UTF-16 units, one fewer if that would cut a surrogate pair in half. */
const truncate = (text: string, maxLength: number): string => {
    if (text.length <= maxLength) return text;
    return isHighSurrogate(text.charCodeAt(maxLength - 1)) ? text.slice(0, maxLength - 1) : text.slice(0, maxLength);
};

const withoutTrailingDotsAndSpaces = (name: string): string => name.replace(TRAILING_DOTS_AND_SPACES, '');

/** One pass of the rules; see sanitizeFileName. */
function sanitizeOnce(fileName: string): string {
    const lastSegment = fileName.split(PATH_SEPARATOR).pop() ?? '';
    const { body, extension } = splitExtension(withoutTrailingDotsAndSpaces(lastSegment));
    const sanitizedBody = truncate(body.replace(INVALID_CHARS, '_'), MAX_BODY_LENGTH);
    // Capped too, so even "unnamed_file" plus the extension fits the varchar(255) FileName column.
    const sanitizedExtension = truncate(extension.replace(INVALID_CHARS, ''), MAX_EXTENSION_LENGTH);
    const finalName = withoutTrailingDotsAndSpaces(`${sanitizedBody}${sanitizedExtension}`);

    // Names made only of dots, like "." and "..", mean a folder to extractors, so they fall back too.
    if (finalName === '' || finalName === sanitizedExtension || DOTS_ONLY.test(finalName)) {
        return sanitizedExtension === '' || DOTS_ONLY.test(sanitizedExtension) ? FALLBACK_NAME : `${FALLBACK_NAME}${sanitizedExtension}`;
    }
    return finalName;
}

const settle = (name: string, pass: number): string => {
    const next = sanitizeOnce(name);
    return next === name || pass >= MAX_SANITIZE_PASSES ? next : settle(next, pass + 1);
};

/**
 * Reduces a name to a single safe path segment, as SanitizeFileName on the server does: keep only what follows the
 * last "/" or "\" (so "../../Startup/x.bat" can't climb out of the folder a ZIP is extracted into); drop trailing dots
 * and spaces, which Windows and browsers drop on saving (otherwise "invoice.exe." would pass the blocked-extension
 * check and still be saved as "invoice.exe"); replace each code point that isn't a letter, mark, digit, connector, "."
 * or "-" with "_" in the body and drop it from the extension; cap both without splitting a character; and drop
 * trailing dots and spaces again, since removing characters can leave one ("a.\u001C" would otherwise become "a.").
 * Removing characters can also move the last dot, so this repeats until nothing changes, which makes it idempotent.
 */
export function sanitizeFileName(fileName: string): string {
    return settle(sanitizeOnce(fileName), 1);
}

/**
 * Upper case per code point, only where that maps to a single code point: the closest match to .NET's
 * OrdinalIgnoreCase, which the server compares names with. JavaScript's full mapping would turn "ß" into "SS".
 */
const caseKey = (text: string): string =>
    Array.from(text, (char) => {
        const upper = char.toUpperCase();
        return upper.length === char.length ? upper : char;
    }).join('');

/** Checks the name as it will be saved, so "evil.exe " or "evil.e x e" can't dodge the list. */
export function isExtensionForbidden(fileName: string): boolean {
    const { extension } = splitExtension(sanitizeFileName(fileName));
    return extension !== '' && FORBIDDEN_EXTENSIONS.has(caseKey(extension));
}

/** "name (copy).ext", with the body shortened if needed to stay within 255 characters. */
const copyName = (body: string, extension: string, copy: number): string => {
    const suffix = ` (${copy})${extension}`;
    return `${truncate(body, MAX_STORED_LENGTH - suffix.length)}${suffix}`;
};

const firstFreeCopyName = (body: string, extension: string, taken: ReadonlySet<string>, copy: number): string => {
    const candidate = copyName(body, extension, copy);
    return taken.has(caseKey(candidate)) ? firstFreeCopyName(body, extension, taken, copy + 1) : candidate;
};

/**
 * Makes names unique ignoring case (Windows and macOS file systems do), so no file overwrites another
 * when they are saved to one folder or ZIP: "a.txt", "A.txt" becomes "a.txt", "A (2).txt".
 */
export function makeFileNamesUnique(fileNames: readonly string[]): string[] {
    const taken = new Set<string>();

    return fileNames.map((name) => {
        const { body, extension } = splitExtension(name);
        const unique = taken.has(caseKey(name)) ? firstFreeCopyName(body, extension, taken, FIRST_COPY_NUMBER) : name;
        taken.add(caseKey(unique));
        return unique;
    });
}
