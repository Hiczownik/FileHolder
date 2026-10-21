import { describe, expect, it } from 'vitest';
import { cleanPhotos, describeMetadataSummary } from '../photoCleaning';
import { asciiBytes } from '../../../../shared/utils/imageMetadata/bytes';
import {
    asFile, BASE_JPEG, buildJpeg, bytesOf, leakedSecrets, MOTION_VIDEO, segments,
} from '../../../../shared/utils/imageMetadata/__tests__/photoFixtures';

const JPEG_TYPE = 'image/jpeg';
const HEIC = asciiBytes('\0\0\0\x18ftypheic\0\0\0\0heicmif1HEIC-DATA');
// A damaged JPEG: cut to a fifth of its length, mid-segment.
const DAMAGED_FRACTION = 5;
// The photos cleaned in the mixed bundle: the one with GPS and the Motion Photo.
const CLEANED_IN_MIXED_BUNDLE = 2;
const MANY_PHOTOS = 7;
const SOME_PHOTOS = 2;

describe('cleanPhotos', () => {
    it('cleans the photos, leaves everything else, keeps the order, and sums up what it did', async () => {
        const gps = asFile(buildJpeg([segments.exif(), segments.xmp({ gps: true })]), 'IMG_0001.jpg', JPEG_TYPE);
        const clean = asFile(BASE_JPEG, 'already-clean.jpg', JPEG_TYPE);
        const heic = asFile(HEIC, 'IMG_0002.HEIC', 'image/heic');
        const pdf = asFile(asciiBytes('%PDF-1.7'), 'report.pdf', 'application/pdf');
        const damaged = asFile(buildJpeg([segments.exif()]).subarray(0, BASE_JPEG.length / DAMAGED_FRACTION), 'broken.jpg', JPEG_TYPE);
        const motion = asFile(buildJpeg([segments.xmp({ motion: { format: 'container', length: MOTION_VIDEO.length } })], [MOTION_VIDEO]), 'PXL_motion.jpg', JPEG_TYPE);

        const { files, summary } = await cleanPhotos([gps, clean, heic, pdf, damaged, motion]);

        expect(files.map((file) => file.name)).toEqual(['IMG_0001.jpg', 'already-clean.jpg', 'IMG_0002.HEIC', 'report.pdf', 'broken.jpg', 'PXL_motion.jpg']);
        expect(leakedSecrets(await bytesOf(files[0]))).toEqual([]);
        expect(files[0].size).toBeLessThan(gps.size);
        expect([files[1], files[2], files[3], files[4]]).toEqual([clean, heic, pdf, damaged]);
        expect(summary).toEqual({ cleaned: CLEANED_IN_MIXED_BUNDLE, notCleaned: ['IMG_0002.HEIC', 'broken.jpg'], motionPhotos: 1 });
    });
});

describe('describeMetadataSummary', () => {
    it.each([
        [{ cleaned: 1, notCleaned: [], motionPhotos: 0 }, 'Removed metadata from 1 photo.'],
        [{ cleaned: MANY_PHOTOS, notCleaned: ['a.heic', 'b.mov'], motionPhotos: 0 },
            'Removed metadata from 7 photos. 2 files couldn\'t be cleaned and keep their metadata: a.heic, b.mov.'],
        [{ cleaned: SOME_PHOTOS, notCleaned: ['a.heic'], motionPhotos: 1 },
            'Removed metadata from 2 photos. 1 Motion Photo is now a still photo. 1 file couldn\'t be cleaned and keeps its metadata: a.heic.'],
        [{ cleaned: 0, notCleaned: ['a', 'b', 'c', 'd', 'e'], motionPhotos: 0 },
            '5 files couldn\'t be cleaned and keep their metadata: a, b, c and 2 more.'],
    ])('%o: "%s"', (summary, expected) => {
        expect(describeMetadataSummary(summary)).toBe(expected);
    });

    it('says nothing when no file had metadata to remove', () => {
        expect(describeMetadataSummary({ cleaned: 0, notCleaned: [], motionPhotos: 0 })).toBeNull();
    });
});
