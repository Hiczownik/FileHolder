import axios from 'axios';
import type { FileGroupMetadataResponse, DownloadUrlResponse } from '../types';

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

    getDownloadUrl: async (shareToken: string, fileId: string, password?: string): Promise<string> => {
        const response = await axios.post<DownloadUrlResponse>(
            `${API_BASE_URL}/${shareToken}/download/${fileId}`,
            { password }
        );
        return response.data.downloadUrl;
    },

    downloadAllZip: async (
        shareToken: string,
        bundleTitle?: string,
        password?: string,
        leaseToken?: string | null
    ): Promise<string | null> => {
        const url = leaseToken
            ? `${API_BASE_URL}/${shareToken}/download-all?lease=${encodeURIComponent(leaseToken)}`
            : `${API_BASE_URL}/${shareToken}/download-all`;

        const response = await axios.post(
            url,
            { password },
            { responseType: 'blob' }
        );

        const issuedLease = (response.headers['x-download-lease'] as string) || null;

        const blob = new Blob([response.data], { type: 'application/zip' });
        const downloadUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = downloadUrl;

        const safeTitle = bundleTitle ? bundleTitle.replace(/[^\w\.\-]/g, '_'): 'bundle';
        link.setAttribute('download', `${safeTitle}_${shareToken}.zip`);

        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(downloadUrl);

        return issuedLease;
    },
};