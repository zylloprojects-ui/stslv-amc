// Single entry point for calls to the STSLEV AMC API.
// Every API response is { success: true, data } or { success: false, error }.

const TOKEN_KEY = 'stslv-amc.token'

// Where the API lives. Empty in local development, where Vite forwards /api to
// the API (vite.config.ts). A hosted build sets VITE_API_BASE_URL to the API's
// address, for example https://api.example.com (see docs/DEPLOYMENT.md).
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')

/** The full address of an API path such as /api/health. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

export interface ApiErrorDetail {
  field: string
  message: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: ApiErrorDetail[]

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[] = []) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) {
      localStorage.removeItem(TOKEN_KEY)
    } else {
      localStorage.setItem(TOKEN_KEY, token)
    }
  } catch {
    // Storage unavailable: the session then lasts until the page is reloaded.
  }
}

// Called when the API rejects the session (expired, deactivated, password changed),
// with the refusal, so the sign-in page can say why when that matters.
let unauthorizedHandler: ((error: ApiError) => void) | null = null

export function setUnauthorizedHandler(handler: ((error: ApiError) => void) | null): void {
  unauthorizedHandler = handler
}

/** A file sent as the raw request body, with its own headers (see api.upload). */
interface RawBody {
  data: Blob
  headers: Record<string, string>
}

async function request<T>(method: string, path: string, body?: unknown, raw?: RawBody): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  if (raw) {
    Object.assign(headers, raw.headers)
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  let response: Response

  try {
    response = await fetch(apiUrl(`/api${path}`), {
      method,
      headers,
      body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.')
  }

  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: { code?: string; message?: string; details?: ApiErrorDetail[] } }
    | null

  if (!response.ok || !payload?.success) {
    const error = new ApiError(
      response.status,
      payload?.error?.code ?? 'UNKNOWN_ERROR',
      payload?.error?.message ?? 'Something went wrong. Please try again.',
      payload?.error?.details ?? [],
    )

    if (response.status === 401 && error.code !== 'INVALID_CREDENTIALS') {
      unauthorizedHandler?.(error)
    }

    throw error
  }

  return payload.data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T = null>(path: string) => request<T>('DELETE', path),
  /** Sends one file as the raw body; its name travels URI-encoded in X-File-Name. */
  upload: <T>(path: string, file: File) =>
    request<T>('POST', path, undefined, {
      data: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    }),
}

export interface DownloadedFile {
  blob: Blob
  /** The name the API gave the file, or null when it gave none. */
  filename: string | null
}

/** Fetches a file the API produces, such as an export. A refusal arrives as the usual error, never as a file. */
export async function download(path: string): Promise<DownloadedFile> {
  const token = getToken()
  let response: Response

  try {
    response = await fetch(apiUrl(`/api${path}`), { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.')
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const error = new ApiError(response.status, payload?.error?.code ?? 'UNKNOWN_ERROR', payload?.error?.message ?? 'The file could not be produced. Please try again.')

    if (response.status === 401) {
      unauthorizedHandler?.(error)
    }

    throw error
  }

  const filename = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? null

  return { blob: await response.blob(), filename }
}

/** Hands a downloaded file to the browser to save. */
export function saveFile(file: DownloadedFile, fallbackName: string): void {
  const url = URL.createObjectURL(file.blob)
  const link = document.createElement('a')

  link.href = url
  link.download = file.filename ?? fallbackName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** A message suitable for showing to the user, whatever was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'
}
