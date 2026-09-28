import axios from 'axios';
import type {
    CreatePresignedUrlRequest,
    PresignedUrlResponse,
    ConfirmUploadRequest,
} from '../types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api/v1/files';

export const uploadApi = {
    getPresignedUrl: async (request: CreatePresignedUrlRequest): Promise<PresignedUrlResponse> => {
        const response = await axios.post<PresignedUrlResponse>(`${API_BASE_URL}/presign`, request);
        return response.data;
    },

    uploadDirectToS3: async (
        uploadUrl: string,
        file: File,
        onProgress?: (percent: number) => void
    ) : Promise<void> => {
        await axios.put(uploadUrl, file, {
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
            },
            onUploadProgress: (progressEvent) => {
                if (progressEvent.total && onProgress) {
                    const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                    onProgress(percent);
                }
            },
        });
    },

    confirmUpload: async (request: ConfirmUploadRequest): Promise<string> => {
        const response = await axios.post<string>(`${API_BASE_URL}/confirm`, request);
        return response.data;
    },
};