import axios from 'axios';
import type { ValidationProblemDetails, ProblemDetails } from '../types/apiErrors';

export function parseApiError(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const data = error.response?.data as ValidationProblemDetails | ProblemDetails | undefined;

        if (error.response?.status === 401) {
            return (data && typeof data === 'object' && (data.detail || data.title)) || 'Incorrect password. Please try again.';
        }

        if (error.response?.status === 410) {
            return (data && typeof data === 'object' && (data.detail || data.title)) || 'This shared bundle has expired or reached its download limit.';
        }

        if (error.response?.status === 404) {
            return (data && typeof data === 'object' && (data.detail || data.title)) || 'This shared bundle was not found or has been removed.';
        }

    if (data && typeof data === 'object') {

      if ('errors' in data && data.errors && typeof data.errors === 'object') {
        const messages = Object.values(data.errors).flat().filter(Boolean);
        if (messages.length > 0) {
          return messages.join(' ');
        }
      }

      if (data.detail && typeof data.detail === 'string') {
        return data.detail;
      }

      if (data.title && typeof data.title === 'string') {
        return data.title;
      }
    }

    if (error.message) {
      return `Client Error: ${error.message}`;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'An unexpected error occurred. Please check your connection and settings.';
}