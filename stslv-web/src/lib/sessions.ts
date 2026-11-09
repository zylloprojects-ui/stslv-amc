// Server-side sessions (API migration 0108): the shape the API returns and a readable device label.

export interface SessionSummary {
  id: string
  createdAt: string
  lastActivityAt: string
  expiresAt: string
  idleExpiresAt: string
  ipAddress: string | null
  userAgent: string | null
  passwordChange: boolean
  current: boolean
}

/** "Chrome on Windows" from a browser's self-description. Only a label: the text is the sender's to choose. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'

  const browsers: [RegExp, string][] = [
    [/Edg\//, 'Edge'],
    [/OPR\//, 'Opera'],
    [/Firefox\//, 'Firefox'],
    [/Chrome\//, 'Chrome'],
    [/Safari\//, 'Safari'],
  ]
  const systems: [RegExp, string][] = [
    [/Windows/, 'Windows'],
    [/iPhone|iPad/, 'iOS'],
    [/Android/, 'Android'],
    [/Mac OS X/, 'macOS'],
    [/Linux/, 'Linux'],
  ]
  const browser = browsers.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Browser'
  const system = systems.find(([pattern]) => pattern.test(userAgent))?.[1]

  return system ? `${browser} on ${system}` : browser
}
