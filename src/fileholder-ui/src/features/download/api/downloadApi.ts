import axios from 'axios';
import type { FileGroupMetadataResponse, DownloadUrlResponse, DownloadSessionResponse } from '../types';
import { saveBlobAsFile } from '../../../shared/utils/downloadUtils';

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

    downloadCiphertextBlob: async (url: string): Promise<ArrayBuffer> => {
        const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
        return response.data;
    },

    downloadAllZip: async (
        shareToken: string,
        downloadSessionId: string,
        bundleTitle?: string
    ): Promise<void> => {
        const response = await axios.post(
            `${API_BASE_URL}/${shareToken}/download-all`,
            { downloadSessionId },
            { responseType: 'blob' }
        );

        const blob = new Blob([response.data], { type: 'application/zip' });
        // Replaces every character that is not a word character, dot or hyphen with "_":
        // "Q3 Report/v2" becomes "Q3_Report_v2", while "notes-v1.2" is left unchanged.
        // https://regex101.com/?regex=%5B%5E%5Cw.-%5D&flags=g&testString=Q3%20Report%2Fv2%0Anotes-v1.2
        const safeTitle = bundleTitle ? bundleTitle.replace(/[^\w.-]/g, '_') : 'bundle';
        saveBlobAsFile(blob, `${safeTitle}_${shareToken}.zip`);
    },
};
