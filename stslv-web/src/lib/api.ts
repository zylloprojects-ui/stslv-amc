// Single entry point for calls to the STSLV AMC API.
// Every API response is { success: true, data } or { success: false, error }.

const TOKEN_KEY = 'stslv-amc.token'

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

// Called when the API rejects the session (expired, deactivated, password changed).
let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  let response: Response

  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
      unauthorizedHandler?.()
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
}

/** A message suitable for showing to the user, whatever was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'
}
