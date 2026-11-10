import type { User } from '../shared/contracts';

let token: string | null = null;
let tokenExpiry = 0;
let csrfToken: string | null = null;
let csrfPromise: Promise<string> | null = null;
let refreshPromise: Promise<{ token: string; user: User }> | null = null;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}
export const setToken = (value: string | null) => {
  token = value;
  try {
    tokenExpiry = value
      ? JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000
      : 0;
  } catch {
    tokenExpiry = 0;
  }
};
export async function ensureCsrf() {
  if (csrfToken) return csrfToken;
  if (!csrfPromise)
    csrfPromise = fetch('/api/v1/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Unable to establish a secure connection.');
        const data = await res.json();
        csrfToken = data.token;
        return data.token as string;
      })
      .finally(() => {
        csrfPromise = null;
      });
  return csrfPromise;
}
export async function refreshSession() {
  const rotate = async () => {
    const csrf = await ensureCsrf();
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': csrf },
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!res.ok) {
      setToken(null);
      throw new ApiError(res.status, data.error.code, data.error.message);
    }
    setToken(data.token);
    return data as { token: string; user: User };
  };
  if (!refreshPromise)
    refreshPromise = (async () =>
      navigator.locks
        ? await navigator.locks.request('sdp-refresh', rotate)
        : await rotate())().finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}
export async function apiResponse(
  url: string,
  options: RequestInit = {},
  retry = true,
): Promise<Response> {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (!['GET', 'HEAD'].includes(method)) headers.set('x-csrf-token', await ensureCsrf());
  if (options.body && typeof options.body === 'string')
    headers.set('content-type', 'application/json');
  let res: Response;
  const timeout = AbortSignal.timeout(30000);
  try {
    res = await fetch(`/api/v1${url}`, {
      ...options,
      headers,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      0,
      timeout.aborted ? 'TIMEOUT' : 'NETWORK',
      timeout.aborted
        ? 'The request timed out. Your change may have completed; retry the same stock request to check safely.'
        : 'Cannot reach SDP Inventory. Check your connection and try again.',
    );
  }
  if (res.status === 401 && !url.startsWith('/auth/') && retry) {
    try {
      await refreshSession();
    } catch {
      window.dispatchEvent(new Event('sdp-session-expired'));
      throw new ApiError(401, 'SESSION_EXPIRED', 'Your session expired. Sign in again.');
    }
    return apiResponse(url, options, false);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (data?.error?.code === 'CSRF') csrfToken = null;
    throw new ApiError(
      res.status,
      data?.error?.code || 'REQUEST_FAILED',
      data?.error?.message || 'The request failed. Please try again.',
      data?.error?.fieldErrors,
    );
  }
  return res;
}
export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await apiResponse(url, options);
  return res.status === 204 ? (undefined as T) : res.json();
}
export const jsonBody = (data: unknown) => JSON.stringify(data);
export async function download(url: string, filename: string, body?: unknown) {
  const response = await apiResponse(
    url,
    body === undefined ? {} : { method: 'POST', body: jsonBody(body) },
  );
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
export async function uploadFile<T>(
  url: string,
  file: File,
  progress: (value: number) => void,
): Promise<T> {
  if (token && tokenExpiry < Date.now() + 30000) await refreshSession();
  const csrf = await ensureCsrf();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1${url}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-csrf-token', csrf);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.timeout = 60000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let data: any;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new ApiError(xhr.status, 'UPLOAD_FAILED', 'Upload failed. Try again.'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event('sdp-session-expired'));
        reject(
          new ApiError(
            xhr.status,
            data.error?.code,
            data.error?.message || 'Upload failed. Try again.',
          ),
        );
      }
    };
    xhr.onerror = xhr.ontimeout = () =>
      reject(
        new ApiError(0, 'NETWORK', 'Upload interrupted. Check your connection and try again.'),
      );
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
