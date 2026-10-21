import { asciiBytes, concatBytes, FileAssembler, MetadataParseError, readBytes, startsWithAscii, u16be, uint16Bytes } from './bytes';
import { EXIF_PREFIX, minimalOrientationExif, needsOrientation, readExif } from './exif';
import { decodeText, type FormatScan, MAX_SECTIONS } from './formatScan';
import { motionPhotoVideoLength, xmpHasLocation } from './xmp';

/**
 * A JPEG is a list of segments, each a 0xFF byte, a marker byte and (for most markers) a 2-byte big-endian length that
 * counts itself. Metadata lives in the APPn and COM segments before the image data, which starts at SOS (start of
 * scan). Everything from SOS on, the compressed image and whatever follows it, is kept as it is, except for a
 * Motion Photo's video at the very end. That way only the headers are ever read, however large the photo.
 */
const MARKER_PREFIX = 0xff;
const SOI_BYTES = 2;
const MARKER_BYTES = 2;
const LENGTH_BYTES = 2;
const MIN_SEGMENT_LENGTH = LENGTH_BYTES;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;
const RST_FIRST = 0xd0;
const RST_LAST = 0xd7;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const APP14 = 0xee;
const APP15 = 0xef;
const COM = 0xfe;

// Enough to tell every identifier below apart; the longest is the Extended XMP namespace (35 bytes).
const IDENTIFIER_PEEK_BYTES = 40;

const JFIF_ID = 'JFIF\0';
const JFXX_ID = 'JFXX\0';
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const EXTENDED_XMP_ID = 'http://ns.adobe.com/xmp/extension/\0';
const ICC_PROFILE_ID = 'ICC_PROFILE\0';
const MPF_ID = 'MPF\0';
const FLASHPIX_ID = 'FPXR';
const ADOBE_ID = 'Adobe';
// An ISO media file (the Motion Photo's MP4) has "ftyp" 4 bytes in.
const FTYP = 'ftyp';
const FTYP_OFFSET = 4;
const FTYP_CHECK_BYTES = FTYP_OFFSET + FTYP.length;

type SegmentAction = { readonly keep: true } | { readonly keep: false; readonly label: string };
const KEEP: SegmentAction = { keep: true };
const remove = (label: string): SegmentAction => ({ keep: false, label });

/** A JPEG APP1 segment holding `tiff` as EXIF. */
const exifSegment = (tiff: Uint8Array): Uint8Array => {
    const payload = concatBytes(asciiBytes(EXIF_PREFIX), tiff);
    return concatBytes(Uint8Array.of(MARKER_PREFIX, APP1), uint16Bytes(LENGTH_BYTES + payload.length, false), payload);
};

class JpegScanner {
    private readonly assembler: FileAssembler;
    private readonly removed = new Set<string>();
    private hasLocation = false;
    private orientationWritten = false;
    private videoLength: number | undefined;
    private readonly file: Blob;

    constructor(file: Blob) {
        this.file = file;
        this.assembler = new FileAssembler(file);
    }

    async scan(): Promise<FormatScan> {
        this.assembler.keep(0, SOI_BYTES);
        const imageDataStart = await this.walk(SOI_BYTES, 0);
        const isMotionPhoto = await this.keepImageData(imageDataStart);
        return { removed: [...this.removed], hasLocation: this.hasLocation, isMotionPhoto, parts: this.assembler.build() };
    }

    /** Walks the segments from `offset` up to SOS, keeping or removing each; returns where SOS starts. */
    private async walk(offset: number, count: number): Promise<number> {
        if (count > MAX_SECTIONS) {
            throw new MetadataParseError('Too many JPEG segments before the image data.');
        }
        const [prefix, marker] = await readBytes(this.file, offset, MARKER_BYTES);
        if (prefix !== MARKER_PREFIX) {
            throw new MetadataParseError(`Expected a JPEG marker at ${offset}.`);
        }
        // A 0xFF before a marker is padding; it can go.
        if (marker === MARKER_PREFIX) return this.walk(offset + 1, count + 1);
        if (marker === SOS) return offset;
        if (marker === SOI || marker === EOI) {
            throw new MetadataParseError('The JPEG ends or restarts before its image data.');
        }
        if (marker === TEM || (marker >= RST_FIRST && marker <= RST_LAST)) {
            this.assembler.keep(offset, offset + MARKER_BYTES);
            return this.walk(offset + MARKER_BYTES, count + 1);
        }

        const length = u16be(await readBytes(this.file, offset + MARKER_BYTES, LENGTH_BYTES), 0);
        const end = offset + MARKER_BYTES + length;
        if (length < MIN_SEGMENT_LENGTH || end > this.file.size) {
            throw new MetadataParseError(`A JPEG segment at ${offset} runs past the end of the file.`);
        }

        const action = await this.classify(marker, offset + MARKER_BYTES + LENGTH_BYTES, end);
        if (action.keep) {
            this.assembler.keep(offset, end);
        } else {
            this.removed.add(action.label);
        }
        return this.walk(end, count + 1);
    }

    /** Whether a segment stays, reading its identifier and, for EXIF and XMP, its content. */
    private async classify(marker: number, payloadStart: number, end: number): Promise<SegmentAction> {
        const isApp = marker >= APP0 && marker <= APP15;
        if (!isApp) return marker === COM ? remove('Comment') : KEEP;

        const id = await readBytes(this.file, payloadStart, Math.min(IDENTIFIER_PEEK_BYTES, end - payloadStart));
        if (marker === APP0) {
            if (startsWithAscii(id, JFIF_ID)) return KEEP;
            return remove(startsWithAscii(id, JFXX_ID) ? 'JFIF thumbnail' : 'APP0');
        }
        if (marker === APP1) return this.classifyApp1(id, payloadStart, end);
        if (marker === APP2) {
            if (startsWithAscii(id, ICC_PROFILE_ID) || startsWithAscii(id, MPF_ID)) return KEEP;
            return remove(startsWithAscii(id, FLASHPIX_ID) ? 'FlashPix' : 'APP2');
        }
        if (marker === APP13) return remove('Photoshop/IPTC');
        if (marker === APP14 && startsWithAscii(id, ADOBE_ID)) return KEEP;
        return remove(`APP${marker - APP0}`);
    }

    private async classifyApp1(id: Uint8Array, payloadStart: number, end: number): Promise<SegmentAction> {
        if (startsWithAscii(id, EXIF_PREFIX)) {
            const payload = await readBytes(this.file, payloadStart, end - payloadStart);
            const exif = readExif(payload.subarray(EXIF_PREFIX.length));
            this.hasLocation ||= exif.hasLocation;
            // The rotation stays where the EXIF was, as a fresh EXIF holding nothing else.
            if (needsOrientation(exif.orientation) && !this.orientationWritten) {
                this.assembler.add(exifSegment(minimalOrientationExif(exif.orientation)));
                this.orientationWritten = true;
            }
            return remove('EXIF');
        }
        const xmpId = [XMP_ID, EXTENDED_XMP_ID].find((candidate) => startsWithAscii(id, candidate));
        if (xmpId) {
            const xmp = decodeText(await readBytes(this.file, payloadStart + xmpId.length, end - payloadStart - xmpId.length));
            this.hasLocation ||= xmpHasLocation(xmp);
            this.videoLength ??= motionPhotoVideoLength(xmp);
            return remove('XMP');
        }
        return remove('APP1');
    }

    /**
     * Keeps everything from SOS on: the image, and anything stored after it such as an HDR gain map, which the MPF
     * segment points to. Only a Motion Photo's video, the last thing in the file, is left out. Returns whether it was.
     */
    private async keepImageData(start: number): Promise<boolean> {
        if (this.videoLength === undefined) {
            this.assembler.keep(start, this.file.size);
            return false;
        }
        const videoStart = this.file.size - this.videoLength;
        if (videoStart <= start) {
            throw new MetadataParseError('A Motion Photo claims a video longer than the file.');
        }
        // Only a real video is cut off; a wrong length must never cut into the photo.
        const head = await readBytes(this.file, videoStart, FTYP_CHECK_BYTES);
        if (!startsWithAscii(head, FTYP, FTYP_OFFSET)) {
            throw new MetadataParseError('A Motion Photo\'s video is not where its XMP says.');
        }
        this.assembler.keep(start, videoStart);
        this.removed.add('Motion Photo video');
        return true;
    }
}

/** Scans a JPEG's segments. Throws MetadataParseError when the file can't be read safely. */
export const scanJpeg = (file: Blob): Promise<FormatScan> => new JpegScanner(file).scan();
