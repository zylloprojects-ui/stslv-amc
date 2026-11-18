import { expect, test as setup } from '@playwright/test'

// Signs in once through the real login form and keeps the session for the other tests.
setup('sign in through the login page', async ({ page }) => {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD

  if (!email || !password) throw new Error('Set E2E_EMAIL and E2E_PASSWORD (or e2e/.env.e2e).')

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByPlaceholder('Enter your password').fill(password)
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: /AMC Operations Dashboard/ })).toBeVisible()
  // The cookie policy opens once after sign-in until a choice is made: choose "Decline" (essential storage only).
  const cookies = page.getByRole('dialog', { name: 'Cookie Policy' })

  if (await cookies.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await cookies.getByRole('button', { name: 'Decline' }).first().click()
    await expect(cookies).toBeHidden()
  }
  await page.context().storageState({ path: 'e2e/.auth/user.json' })
})
