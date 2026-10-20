/**
 * Client-side copy of the server's file name rules (FileSecurityUtils.cs). The server applies them to
 * plain bundles, but in an encrypted bundle it only ever sees "{uuid}.enc": the real names live in the
 * encrypted manifest, which the uploader wrote and only the recipient's browser can read. So the
 * recipient enforces the same rules on the decrypted names. Keep both copies in sync.
 */

// Same list as FileSecurityUtils.ForbiddenExtensions.
const FORBIDDEN_EXTENSIONS: ReadonlySet<string> = new Set([
    '.exe', '.bat', '.sh', '.cmd', '.dll', '.ps1', '.vbs', '.js', '.scr', '.pif', '.application', '.msi', '.com',
    '.hta', '.jar', '.lnk', '.msc', '.vbe', '.wsf', '.cpl', '.reg', '.iso',
]);

const MAX_BODY_LENGTH = 190;
const FALLBACK_NAME = 'unnamed_file';
// The first duplicate becomes "name (2).ext": the original counts as copy 1.
const FIRST_COPY_NUMBER = 2;

// Matches every character the server's [^\w\.\-] replaces (.NET's \w covers Unicode letters, marks,
// digits and connectors): in "zażółć report.txt" only the space matches; "ż", "_", "." and "-" don't.
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

/** Splits like .NET's Path.GetExtension: from the last dot, empty when the name ends with one. */
const splitExtension = (name: string): { readonly body: string; readonly extension: string } => {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) {
        return { body: name, extension: '' };
    }
    return { body: name.slice(0, dot), extension: name.slice(dot) };
};

/**
 * Reduces a name to a single safe path segment: anything up to the last "/" or "\" is dropped, so a
 * name like "../../Startup/x.bat" can't climb out of the folder a ZIP is extracted into.
 */
export function sanitizeFileName(fileName: string): string {
    // Trailing dots and spaces go first, as Windows and browsers drop them on saving: otherwise "invoice.exe."
    // would have no extension here, pass the blocked-extension check, and still be saved as "invoice.exe".
    const baseName = (fileName.split(PATH_SEPARATOR).pop() ?? '').replace(TRAILING_DOTS_AND_SPACES, '');
    if (baseName.trim() === '') return FALLBACK_NAME;

    const { body, extension } = splitExtension(baseName);
    const sanitizedBody = body.replace(INVALID_CHARS, '_').slice(0, MAX_BODY_LENGTH);
    const sanitizedExtension = extension.replace(INVALID_CHARS, '');
    const finalName = `${sanitizedBody}${sanitizedExtension}`;

    // Unlike the server, also refuse names made only of dots: "." and ".." mean a folder to extractors.
    if (finalName.trim() === '' || finalName === sanitizedExtension || DOTS_ONLY.test(finalName)) {
        return `${FALLBACK_NAME}${DOTS_ONLY.test(sanitizedExtension) ? '' : sanitizedExtension}`;
    }

    return finalName;
}

/** Checks the name as it will be saved, so "evil.exe " or "evil.e x e" can't dodge the list. */
export function isExtensionForbidden(fileName: string): boolean {
    const { extension } = splitExtension(sanitizeFileName(fileName));
    return extension !== '' && FORBIDDEN_EXTENSIONS.has(extension.toLowerCase());
}

const firstFreeCopyName = (body: string, extension: string, taken: ReadonlySet<string>, copy: number): string => {
    const candidate = `${body} (${copy})${extension}`;
    return taken.has(candidate.toLowerCase()) ? firstFreeCopyName(body, extension, taken, copy + 1) : candidate;
};

/**
 * Makes names unique ignoring case (Windows and macOS file systems do), so no file overwrites another
 * when they are saved to one folder or ZIP: "a.txt", "A.txt" becomes "a.txt", "A (2).txt".
 */
export function makeFileNamesUnique(fileNames: readonly string[]): string[] {
    const taken = new Set<string>();

    return fileNames.map((name) => {
        const { body, extension } = splitExtension(name);
        const unique = taken.has(name.toLowerCase()) ? firstFreeCopyName(body, extension, taken, FIRST_COPY_NUMBER) : name;
        taken.add(unique.toLowerCase());
        return unique;
    });
}
