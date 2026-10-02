import JSZip from 'jszip';

export const zipUtils = {
    createZipFromFiles: async (files: File[]): Promise<Uint8Array> => {
        const zip = new JSZip();

        for (const file of files) {
            const buffer = await file.arrayBuffer();
            zip.file(file.name, buffer);
        }

        const zipBuffer = await zip.generateAsync({
            type: 'uint8array',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });

        return zipBuffer;
    }
}