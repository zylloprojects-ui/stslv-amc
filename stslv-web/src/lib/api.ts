// Single entry point for calls to the STS-ELV AMC API.
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

// --- Inactivity --------------------------------------------------------------------------------
// The API ends a session after SESSION_IDLE_TIMEOUT_MINUTES without use (30 by default). Background requests
// (the permission refresh every minute, notifications) are not use, so every request reports how long ago the
// person last pressed a key, clicked, touched or scrolled, in ANY tab of this browser (shared via localStorage).
// The API records "now minus that" as the last activity. Nothing about the input itself is recorded or sent.
const ACTIVITY_KEY = 'stslv-amc.lastActivity'
const ACTIVITY_SHARE_MS = 5_000
let lastActivity = Date.now()
let lastShared = 0

function markActive(): void {
  const now = Date.now()

  lastActivity = now
  if (now - lastShared < ACTIVITY_SHARE_MS) return
  lastShared = now
  try {
    localStorage.setItem(ACTIVITY_KEY, String(now))
  } catch {
    // Storage unavailable: this tab's own activity still counts.
  }
}

if (typeof window !== 'undefined') {
  for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const) {
    window.addEventListener(event, markActive, { passive: true, capture: true })
  }
}

/** Whole seconds since the person last used the application in any tab. */
export function idleSeconds(now = Date.now()): number {
  let shared = 0

  try {
    shared = Number(localStorage.getItem(ACTIVITY_KEY) ?? 0) || 0
  } catch {
    shared = 0
  }

  return Math.max(0, Math.floor((now - Math.max(lastActivity, shared)) / 1000))
}

/** A sign-in is activity: a session starts fresh. */
export function resetActivity(): void {
  lastShared = 0
  markActive()
}

// Called when the API rejects the session (expired, deactivated, password changed, signed out elsewhere, idle),
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

// Called when the API refuses a request for lack of permission: the session's permissions may have changed.
let forbiddenHandler: (() => void) | null = null

export function setForbiddenHandler(handler: (() => void) | null): void {
  forbiddenHandler = handler
}

async function request<T>(method: string, path: string, body?: unknown, raw?: RawBody): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()

  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['X-Idle-Seconds'] = String(idleSeconds())
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
    if (response.status === 403) {
      forbiddenHandler?.()
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
  /** A body only where the API asks for one (a permanent deletion's typed confirmation). */
  delete: <T = null>(path: string, body?: unknown) => request<T>('DELETE', path, body),
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
    response = await fetch(apiUrl(`/api${path}`), { headers: token ? { Authorization: `Bearer ${token}`, 'X-Idle-Seconds': String(idleSeconds()) } : {} })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.')
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const error = new ApiError(response.status, payload?.error?.code ?? 'UNKNOWN_ERROR', payload?.error?.message ?? 'The file could not be produced. Please try again.')

    if (response.status === 401) {
      unauthorizedHandler?.(error)
    }
    if (response.status === 403) {
      forbiddenHandler?.()
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

/** The server refused because the user's role lacks the permission (not because something failed). */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403
}

/** A message suitable for showing to the user, whatever was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'
}
