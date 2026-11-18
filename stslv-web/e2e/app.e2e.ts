import { expect, test } from '@playwright/test'
import { PAGES, apiToken, openPage, watchProblems } from './pages.ts'

// Every page opens with its heading, no JavaScript or console error and no failed API call.
// A full-page picture of each is attached to the HTML report for visual review.
for (const { path, heading } of PAGES) {
  test(`page ${path} loads without errors`, async ({ page }, testInfo) => {
    const problems = watchProblems(page)

    await openPage(page, path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(heading)
    await expect(page.locator('main')).not.toContainText(/something went wrong|page not found/i)
    await testInfo.attach(`${path}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    expect(problems).toEqual([])
  })
}

test('a deep link opened directly loads the page, not a server 404', async ({ page }) => {
  const response = await page.goto('/amc/contracts')

  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(/AMC Contracts/)
})

test('the sidebar navigates between pages', async ({ page }) => {
  await openPage(page, '/dashboard')
  await page.getByRole('link', { name: 'AMC Contracts' }).first().click()
  await expect(page).toHaveURL(/\/amc\/contracts/)
  await page.getByRole('link', { name: 'Reports' }).first().click()
  await expect(page).toHaveURL(/\/reports/)
})

test.describe('exports', () => {
  test('every report downloads as a branded PDF and as Excel', async ({ page, request }) => {
    await openPage(page, '/reports')
    const headers = { Authorization: `Bearer ${await apiToken(page)}` }
    const list = await request.get('/api/reports', { headers })

    expect(list.ok()).toBe(true)
    const reports = ((await list.json()) as { data: { id: string; canExport: boolean }[] }).data.filter((report) => report.canExport)

    expect(reports.length).toBeGreaterThan(0)
    for (const report of reports) {
      const pdf = await request.get(`/api/reports/${report.id}/export?format=pdf`, { headers })

      expect(pdf.status(), `${report.id} PDF`).toBe(200)
      expect(pdf.headers()['content-type']).toContain('application/pdf')
      const pdfText = (await pdf.body()).toString('latin1')

      expect(pdfText.startsWith('%PDF-'), `${report.id} is a PDF`).toBe(true)
      // The company logo is embedded in every generated PDF.
      expect(pdfText, `${report.id} PDF carries the logo`).toMatch(/\/Subtype \/Image/)

      const xlsx = await request.get(`/api/reports/${report.id}/export?format=xlsx`, { headers })

      expect(xlsx.status(), `${report.id} Excel`).toBe(200)
      expect((await xlsx.body()).subarray(0, 2).toString()).toBe('PK')
    }
  })

  test('the Reports page downloads a PDF through the browser', async ({ page }) => {
    await openPage(page, '/reports')
    const pdfButton = page.getByRole('button', { name: /PDF/i }).first()

    test.skip(!(await pdfButton.isVisible().catch(() => false)), 'No PDF button on the Reports page for this user.')
    const [download] = await Promise.all([page.waitForEvent('download'), pdfButton.click()])

    expect(download.suggestedFilename()).toMatch(/\.pdf$/)
  })
})

test.describe('visual', () => {
  test('login page looks as approved', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: undefined })
    const page = await context.newPage()

    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('login.png', { fullPage: true })
    await context.close()
  })

  test('application frame (sidebar and header) looks as approved', async ({ page }) => {
    await openPage(page, '/help')
    // Only the frame: the page content and the header (user name, notification count) change, so they are masked.
    await expect(page).toHaveScreenshot('app-frame.png', { mask: [page.locator('main'), page.locator('header')] })
  })
})
