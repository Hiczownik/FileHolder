import axios from 'axios';
import type { 
    CreatePresignedUrlRequest, 
    PresignedUrlResponse, 
    PresignPartBatchRequest, 
    PresignPartBatchResponse, 
    CompleteMultipartUploadRequest, 
    AbortMultipartUploadRequest, 
    ConfirmUploadRequest } from '../../download/types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api/v1/files';
const PERCENT_COMPLETE = 100;

// Matches the quotes S3 wraps an ETag in: in "\"9b2cf535f27731c974343645a3985328\"" both quotes match, the hex digits don't.
// https://regex101.com/?regex=%5B%27%22%5D&flags=g&testString=%229b2cf535f27731c974343645a3985328%22
const ETAG_QUOTES = /['"]/g;

export const uploadApi = {
    getPresignedUrl: async (request: CreatePresignedUrlRequest): Promise<PresignedUrlResponse> => {
        const response = await axios.post<PresignedUrlResponse>(`${API_BASE_URL}/presign`, request);
        return response.data;
    },

    uploadDirectToS3: async (
        uploadUrl: string,
        file: Blob,
        onProgress?: (percent: number) => void,
        signal?: AbortSignal
    ) : Promise<void> => {
        await axios.put(uploadUrl, file, {
            signal,
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
            },
            onUploadProgress: (progressEvent) => {
                if (progressEvent.total && onProgress) {
                    const percent = Math.round((progressEvent.loaded * PERCENT_COMPLETE) / progressEvent.total);
                    onProgress(percent);
                }
            },
        });
    },

    presignPartBatch: async (request: PresignPartBatchRequest): Promise<PresignPartBatchResponse> => {
        const response = await axios.post<PresignPartBatchResponse>(`${API_BASE_URL}/multipart/presign-batch`, request);
        return response.data;
    },

    uploadMultipartChunkDirectToS3: async (
        uploadUrl: string,
        chunk: Blob,
        signal?: AbortSignal,
    ): Promise<string> => {
        const response = await axios.put(uploadUrl, chunk, {
            signal,
            headers: {
                'Content-Type': 'application/octet-stream',
            },
        });
        const eTag = response.headers['etag'] || response.headers['ETag'] || '';
        return eTag ? String(eTag).replace(ETAG_QUOTES, '') : '';
    },

    completeMultipartUpload: async (request: CompleteMultipartUploadRequest): Promise<boolean> => {
        const response = await axios.post<boolean>(`${API_BASE_URL}/multipart/complete`, request);
        return response.data;
    },
    
    abortMultipartUpload: async (request: AbortMultipartUploadRequest): Promise<boolean> => {
        const response = await axios.post<boolean>(`${API_BASE_URL}/multipart/abort`, request);
        return response.data;
    },

    confirmUpload: async (request: ConfirmUploadRequest): Promise<string> => {
        const response = await axios.post<string>(`${API_BASE_URL}/confirm`, request);
        return response.data;
    },
};