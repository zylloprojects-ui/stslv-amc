import type { Page } from '@playwright/test'

/** Every page of the application, with the heading it must show. Super Admin sees them all. */
export const PAGES: { path: string; heading: RegExp }[] = [
  { path: '/dashboard', heading: /AMC Operations Dashboard/ },
  { path: '/amc/contracts', heading: /AMC Contracts/ },
  { path: '/amc/master-status', heading: /Master AMC Status/ },
  { path: '/amc/service-status', heading: /Service Status/ },
  { path: '/amc/calendar', heading: /Monthly Calendar/ },
  { path: '/amc/renewal', heading: /AMC Renewal/ },
  { path: '/amc/service-sales', heading: /Service Sales/ },
  { path: '/clients', heading: /Clients/ },
  { path: '/invoices', heading: /Invoice Tracking/ },
  { path: '/finance/accounts', heading: /Accounts/ },
  { path: '/finance/invoice-acknowledgements', heading: /Invoice Acknowledgements/ },
  { path: '/master-data', heading: /Master Data Center/ },
  { path: '/master-data/departments', heading: /Departments/ },
  { path: '/master-data/maintenance-frequencies', heading: /Maintenance Frequencies/ },
  { path: '/master-data/sales-engineers', heading: /Sales Engineers/ },
  { path: '/master-data/system-types', heading: /System Types/ },
  { path: '/reports', heading: /Reports/ },
  { path: '/settings', heading: /Settings/ },
  { path: '/settings/backups', heading: /Settings|Backup/ },
  { path: '/settings/security', heading: /Settings|Security/ },
  { path: '/account', heading: /My Account/ },
  { path: '/notifications', heading: /Notifications/ },
  { path: '/suggestions', heading: /Suggestions/ },
  { path: '/help', heading: /Help/ },
  { path: '/admin/users', heading: /Users/ },
  { path: '/admin/roles', heading: /Roles/ },
  { path: '/admin/audit-log', heading: /Audit Log/ },
  { path: '/admin/deletion-log', heading: /Recycle Bin/ },
  { path: '/admin/login-history', heading: /Login History/ },
  { path: '/admin/suggestions', heading: /Suggestions Review/ },
]

/** Collects browser errors and failed API answers while a page is open. */
export function watchProblems(page: Page): string[] {
  const problems: string[] = []

  page.on('pageerror', (error) => problems.push(`JavaScript error: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`Console error: ${message.text()}`)
  })
  page.on('response', (response) => {
    const url = new URL(response.url())

    if (url.pathname.startsWith('/api/') && response.status() >= 400) problems.push(`HTTP ${response.status()} ${url.pathname}`)
  })

  return problems
}

/** Opens a page and waits until its data has loaded (no spinner, no request in flight). */
export async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
  await page.locator('text=/^Loading/i').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined)
}

/** The signed-in user's API token (kept in localStorage by the web app). */
export async function apiToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => /token/i.test(name))

    return key ? localStorage.getItem(key) : null
  })

  if (!token) throw new Error('Not signed in: no token in localStorage.')

  return token
}
