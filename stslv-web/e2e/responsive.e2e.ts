import { expect, test } from '@playwright/test'
import { PAGES, openPage, watchProblems } from './pages.ts'

// On a phone every page still loads cleanly, and the page itself never scrolls sideways
// (wide tables scroll inside their own card instead).
for (const { path, heading } of PAGES) {
  test(`phone: ${path} fits the screen`, async ({ page }, testInfo) => {
    const problems = watchProblems(page)

    await openPage(page, path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(heading)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

    await testInfo.attach(`${path}-phone.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    expect(overflow, 'page scrolls sideways by this many pixels').toBeLessThanOrEqual(1)
    expect(problems).toEqual([])
  })
}
