import axios from 'axios';
import type { FileGroupMetadataResponse, DownloadUrlResponse, DownloadSessionResponse } from '../types';
import { triggerDirectDownload } from '../../../shared/utils/downloadUtils';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api/v1/files';

export const downloadApi = {
    getGroupMetadata: async (shareToken: string): Promise<FileGroupMetadataResponse> => {
        const response = await axios.get<FileGroupMetadataResponse>(`${API_BASE_URL}/${shareToken}`);
        return response.data;
    },

    unlockGroup: async (shareToken: string, password: string): Promise<FileGroupMetadataResponse> => {
        const response = await axios.post<FileGroupMetadataResponse>(
            `${API_BASE_URL}/${shareToken}/unlock`,
            { password }
        );
        return response.data;
    },

    /** Consumes one of the bundle's downloads; the session then covers every file in it. */
    openDownloadSession: async (shareToken: string, password?: string): Promise<DownloadSessionResponse> => {
        const response = await axios.post<DownloadSessionResponse>(
            `${API_BASE_URL}/${shareToken}/downloads`,
            { password }
        );
        return response.data;
    },

    getDownloadUrl: async (shareToken: string, fileId: string, downloadSessionId: string): Promise<string> => {
        const response = await axios.post<DownloadUrlResponse>(
            `${API_BASE_URL}/${shareToken}/download/${fileId}`,
            { downloadSessionId }
        );
        return response.data.downloadUrl;
    },

    /** The ciphertext as it arrives, for decrypting on the fly instead of after the whole file has downloaded. */
    openCiphertextStream: async (url: string): Promise<ReadableStream<Uint8Array>> => {
        const response = await fetch(url);
        if (!response.ok || !response.body) {
            throw new Error(`Downloading the encrypted file failed (HTTP ${response.status}).`);
        }
        return response.body;
    },

    /**
     * Lets the browser download the ZIP itself, so it streams to disk instead of being held in page memory.
     * The server names the file. The session must still be valid: an error response would replace the page.
     */
    downloadAllZip: (shareToken: string, downloadSessionId: string): void => {
        const query = new URLSearchParams({ downloadSessionId });
        triggerDirectDownload(`${API_BASE_URL}/${encodeURIComponent(shareToken)}/download-all?${query.toString()}`);
    },
};
