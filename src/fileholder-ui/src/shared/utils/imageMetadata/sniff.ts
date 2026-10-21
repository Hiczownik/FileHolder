import { ascii, readBytes, startsWithAscii } from './bytes';
import type { FileFormat } from './types';

/** Formats are told apart by their first bytes, never by name or the browser's guess of the type. */
const SNIFF_BYTES = 16;
// Magic bytes, as Latin-1 strings.
const JPEG_MAGIC = '\xff\xd8\xff';
const PNG_MAGIC = '\x89PNG\r\n\x1a\n';
// Matroska and WebM.
const EBML_MAGIC = '\x1aE\xdf\xa3';
const TIFF_LITTLE_ENDIAN = 'II*\0';
const TIFF_BIG_ENDIAN = 'MM\0*';
const RIFF = 'RIFF';
const RIFF_FORMAT_OFFSET = 8;
const FTYP = 'ftyp';
const FTYP_OFFSET = 4;
const BRAND_OFFSET = 8;
const BRAND_BYTES = 4;

// ISO media "major brands" (the 4 characters after "ftyp").
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const VIDEO_BRANDS = new Set(['qt  ', 'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'M4V ', 'avc1', 'dash', '3gp4', '3gp5', '3gp6', '3g2a', 'MSNV']);

function isoMediaFormat(bytes: Uint8Array): FileFormat {
    const brand = ascii(bytes, BRAND_OFFSET, BRAND_BYTES);
    if (HEIF_BRANDS.has(brand)) return 'heic';
    if (AVIF_BRANDS.has(brand)) return 'avif';
    return VIDEO_BRANDS.has(brand) ? 'video' : 'other';
}

/** What the file is, from its first bytes. */
export async function sniffFormat(file: Blob): Promise<FileFormat> {
    const bytes = await readBytes(file, 0, Math.min(SNIFF_BYTES, file.size));
    if (startsWithAscii(bytes, JPEG_MAGIC)) return 'jpeg';
    if (startsWithAscii(bytes, PNG_MAGIC)) return 'png';
    if (startsWithAscii(bytes, RIFF)) {
        if (startsWithAscii(bytes, 'WEBP', RIFF_FORMAT_OFFSET)) return 'webp';
        return startsWithAscii(bytes, 'AVI ', RIFF_FORMAT_OFFSET) ? 'video' : 'other';
    }
    if (startsWithAscii(bytes, TIFF_LITTLE_ENDIAN) || startsWithAscii(bytes, TIFF_BIG_ENDIAN)) return 'tiff';
    if (startsWithAscii(bytes, FTYP, FTYP_OFFSET) && bytes.length >= BRAND_OFFSET + BRAND_BYTES) return isoMediaFormat(bytes);
    if (startsWithAscii(bytes, EBML_MAGIC)) return 'video';
    return 'other';
}
