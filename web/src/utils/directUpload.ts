import axios from 'axios';
import { post } from './api';

export type PresignFile = { filename?: string; contentType?: string; size?: number };

export type PresignItem = {
  uuid: string;
  original: { key: string; putUrl: string; url: string; contentType?: string };
  compressed: { key: string; putUrl: string; url: string; contentType: 'image/webp' };
};

export interface PresignResponse {
  code: number;
  message?: string;
  data: {
    items: PresignItem[];
  };
}

export async function presign(files: PresignFile[]) {
  const res = (await post('/attachments/presign', { files })) as PresignResponse;
  if (res.code !== 0) throw new Error(res.message || 'presign failed');
  return res.data.items as PresignItem[];
}

export async function uploadToSignedUrl(putUrl: string, blob: Blob) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error('Empty upload payload');
  }

  let resp;
  try {
    resp = await axios.put(putUrl, blob, {
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
      },
      transformRequest: [(data) => data as Blob],
      transitional: { clarifyTimeoutError: true },
      validateStatus: () => true,
    });
  } catch (err: any) {
    // axios throws on network-level failures (CORS blocked, DNS, offline, etc.)
    if (err?.code === 'ERR_NETWORK' || err?.message === 'Network Error') {
      throw new Error(
        `CORS/Network Error: unable to PUT to storage. ` +
          `Please check S3/R2 bucket CORS configuration allows the current origin. ` +
          `(${err.message})`
      );
    }
    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
      throw new Error(`Upload timeout: ${err.message}`);
    }
    throw err;
  }

  if (resp.status < 200 || resp.status >= 300) {
    const reqId = resp.headers?.['x-amz-request-id'] || resp.headers?.['cf-ray'] || '';
    const bodyText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
    throw new Error(`Upload failed: HTTP ${resp.status} ${reqId} ${bodyText}`.trim());
  }
}

/**
 * Extract a human-readable error message from upload errors for debugging.
 * Handles CORS, network, timeout, HTTP status, and business-level errors.
 */
export function getUploadErrorMessage(error: unknown): string {
  if (!error) return 'Unknown error';

  const err = error as any;

  // Already formatted by uploadToSignedUrl
  if (err.message && typeof err.message === 'string') {
    // CORS / Network
    if (err.message.startsWith('CORS/Network Error')) return err.message;
    if (err.message.startsWith('Upload timeout')) return err.message;
    if (err.message.startsWith('Upload failed: HTTP')) return err.message;
  }

  // axios error with response (HTTP-level error from presign/finalize API)
  if (err.response) {
    const status = err.response.status;
    const serverMsg =
      err.response.data?.message || err.response.data?.error || err.response.statusText || '';
    if (serverMsg) return `HTTP ${status}: ${serverMsg}`;
    return `HTTP ${status}`;
  }

  // axios error codes
  if (err.code === 'ERR_NETWORK' || err.message === 'Network Error') {
    return `CORS/Network Error: ${err.message}. Check browser console for details.`;
  }
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return `Request Timeout: ${err.message}`;
  }

  // Generic Error with message
  if (err.message && typeof err.message === 'string') {
    return err.message;
  }

  // Fallback
  return String(error);
}

export type FinalizeAttachment = {
  uuid: string;
  originalKey: string;
  compressedKey?: string;
  size?: number;
  mimetype?: string;
  hash?: string;
};

export async function finalize(attachments: FinalizeAttachment[], noteId?: string) {
  const res = (await post('/attachments/finalize', { attachments, noteId })) as Record<string, any>;
  if (res.code !== 0) throw new Error(res.message || 'finalize failed');
  return (res.data as any[]) || [];
}
