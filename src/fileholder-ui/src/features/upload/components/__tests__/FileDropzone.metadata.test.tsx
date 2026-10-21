import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileDropzone } from '../FileDropzone';
import { asciiBytes } from '../../../../shared/utils/imageMetadata/bytes';
import {
    asFile, BASE_JPEG, buildJpeg, MOTION_VIDEO, segments,
} from '../../../../shared/utils/imageMetadata/__tests__/photoFixtures';

const JPEG_TYPE = 'image/jpeg';
const LOCATION = '📍 Contains location';
const WILL_REMOVE = 'Metadata will be removed';

const withGps = asFile(buildJpeg([segments.exif()]), 'holiday.jpg', JPEG_TYPE);
const noGps = asFile(buildJpeg([segments.exif({ gps: 'none' })]), 'camera.jpg', JPEG_TYPE);
const clean = asFile(BASE_JPEG, 'clean.jpg', JPEG_TYPE);
const heic = asFile(asciiBytes('\0\0\0\x18ftypheic\0\0\0\0heicmif1HEIC-DATA'), 'IMG_0002.HEIC', 'image/heic');
const pdf = asFile(asciiBytes('%PDF-1.7'), 'report.pdf', 'application/pdf');
const motion = asFile(buildJpeg([segments.xmp({ motion: { format: 'microvideo', length: MOTION_VIDEO.length } })], [MOTION_VIDEO]), 'PXL.jpg', JPEG_TYPE);

/** The labels in the row of the file named `name`. */
const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('li')!;

const renderList = (files: File[], stripMetadata: boolean): void => {
    render(<FileDropzone selectedFiles={files} onFilesSelect={vi.fn()} onRemoveFile={vi.fn()} stripMetadata={stripMetadata} />);
};

describe('FileDropzone metadata labels', () => {
    it('labels each file by what its metadata holds and what will happen to it', async () => {
        renderList([withGps, noGps, clean, heic, pdf, motion], true);

        await screen.findAllByText(LOCATION);
        expect(rowOf('holiday.jpg')).toHaveTextContent(LOCATION);
        expect(rowOf('holiday.jpg')).toHaveTextContent(WILL_REMOVE);
        expect(rowOf('camera.jpg')).not.toHaveTextContent(LOCATION);
        expect(rowOf('camera.jpg')).toHaveTextContent(WILL_REMOVE);
        expect(rowOf('clean.jpg')).not.toHaveTextContent('Metadata');
        expect(rowOf('IMG_0002.HEIC')).toHaveTextContent("Metadata can't be removed (HEIC)");
        expect(rowOf('report.pdf')).not.toHaveTextContent('Metadata');
        expect(rowOf('PXL.jpg')).toHaveTextContent('Motion Photo becomes a still');
    });

    it('still warns about a location when removal is off, and promises nothing', async () => {
        renderList([withGps, heic], false);

        expect(await screen.findByText(LOCATION)).toBeInTheDocument();
        expect(screen.queryByText(WILL_REMOVE)).not.toBeInTheDocument();
        expect(screen.queryByText("Metadata can't be removed (HEIC)")).not.toBeInTheDocument();
    });
});
