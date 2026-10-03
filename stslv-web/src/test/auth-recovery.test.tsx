// @ts-expect-error -- the web app is compiled without Node's types; this test only reads the stylesheet from disk.
import { readFileSync } from 'node:fs'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply } from './helpers'

const GOOD_PASSWORD = 'a-good-long-password'

// Vitest does not load CSS into the test page, so the stylesheet is read as text
// (the tests run from the stslv-web folder).
const styles: string = readFileSync('src/index.css', 'utf8')

const SIGNUP_MESSAGE = 'Your registration has been submitted. An administrator will review it before you can sign in.'
const RESET_MESSAGE = 'If an active account exists for that email, a password reset link has been sent to it.'
const RESET_DONE_MESSAGE = 'Your password has been reset successfully. Please sign in again using your new password.'

/** Holds back the reply to one request until the test releases it. */
function deferred() {
  let release: (reply: MockReply) => void = () => {}
  const reply = new Promise<MockReply>((resolve) => {
    release = resolve
  })

  return { reply, release: (value: MockReply) => release(value) }
}

describe('login page design', () => {
  it('keeps the redesigned layout: brand panel, logo, tabs, focused email and the forgot-password link', async () => {
    mockApi(() => undefined)
    renderApp('/login')

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument()
    expect(document.title).toBe('Sign in · STSLEV AMC')
    expect(screen.getByLabelText(/Email/)).toHaveFocus()

    // Brand panel and product naming.
    expect(screen.getByText('Service LLC').parentElement).toHaveTextContent('Smart TechnicalService LLC')
    expect(screen.getByText('STSLEV AMC · Operations Suite')).toBeInTheDocument()
    expect(screen.getByText(/Smart Technical Service LLC\. All rights reserved\./)).toBeInTheDocument()
    expect(document.querySelectorAll('img[src="/stslv-logo.png"]')).toHaveLength(2)
    expect(document.body).not.toHaveTextContent('STSLV AMC')
    expect(document.body).not.toHaveTextContent('STSLEV ERP')

    const tabs = within(screen.getByRole('tablist', { name: 'Account' })).getAllByRole('tab')

    expect(tabs.map((tab) => tab.textContent)).toEqual(['Sign in', 'Sign up'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password')
    expect(screen.getByRole('button', { name: 'Login' })).toHaveAttribute('type', 'submit')
  })

  it('shows and hides the password', async () => {
    mockApi(() => undefined)
    renderApp('/login')

    const password = await screen.findByLabelText(/Password/)
    const toggle = screen.getByRole('button', { name: 'Show or hide characters' })

    expect(password).toHaveAttribute('type', 'password')
    await userEvent.click(toggle)
    expect(password).toHaveAttribute('type', 'text')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(toggle)
    expect(password).toHaveAttribute('type', 'password')
  })

  it('switches every decorative animation off for people who prefer reduced motion', () => {
    const sources = Object.values(import.meta.glob('../pages/**/*.tsx', { query: '?raw', import: 'default', eager: true })) as string[]
    const used = new Set(sources.flatMap((source) => source.match(/\blogin-[a-z]+(?:-[a-z]+)*/g) ?? []))
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''

    expect(used.size).toBeGreaterThan(8)
    for (const name of used) {
      // Defined in the stylesheet, and named in the reduced-motion rule.
      expect(styles, name).toContain(`.${name} {`)
      expect(reduced, name).toMatch(new RegExp(`\\.${name}[,\\s{]`))
    }
  })
})

describe('navigation between the auth pages', () => {
  it('moves between sign in and sign up with the tabs, keeping the same frame', async () => {
    const api = mockApi(() => undefined)
    renderApp('/login')

    const brand = await screen.findByText('STSLEV AMC · Operations Suite')

    await userEvent.click(screen.getByRole('tab', { name: 'Sign up' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Get your account' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Sign up' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText(/Full name/)).toBeInTheDocument()
    expect(document.title).toBe('Sign up · STSLEV AMC')
    // The frame was not rebuilt.
    expect(screen.getByText('STSLEV AMC · Operations Suite')).toBe(brand)

    await userEvent.click(screen.getByRole('tab', { name: 'Sign in' }))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(document.title).toBe('Sign in · STSLEV AMC')
    expect(api.requests).toHaveLength(0)
  })

  it('goes from sign in to forgot password and back', async () => {
    mockApi(() => undefined)
    renderApp('/login')

    await userEvent.click(await screen.findByRole('link', { name: 'Forgot password?' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Forgot your password?' })).toBeInTheDocument()
    expect(document.title).toBe('Forgot password · STSLEV AMC')
    // The tabs make no sense while recovering an account, so the frame hides them.
    expect(screen.getByRole('tablist', { hidden: true })).toHaveClass('hidden')
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: /Back to sign in/ }))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Account' })).not.toHaveClass('hidden')
  })

  it('returns from sign up to sign in with the back link', async () => {
    mockApi(() => undefined)
    renderApp('/signup')

    await userEvent.click(await screen.findByRole('link', { name: /Back to sign in/ }))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
  })

  it('sends a signed-in user away from sign up and forgot password', async () => {
    for (const path of ['/signup', '/forgot-password']) {
      signIn()
      mockApi((request) => {
        if (request.path === '/auth/me') return ok({ user: ADMIN })
        if (request.path === '/dashboard/summary') return ok({ clients: { active: 1, inactive: 0 } })
        return undefined
      })
      const view = renderApp(path)

      expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
      view.unmount()
    }
  })
})

describe('sign up', () => {
  async function fill(values: { fullName?: string; email?: string; password?: string; confirmation?: string }) {
    if (values.fullName) await userEvent.type(screen.getByLabelText(/Full name/), values.fullName)
    if (values.email) await userEvent.type(screen.getByLabelText(/Email/), values.email)
    if (values.password) await userEvent.type(screen.getByLabelText(/^Password/), values.password)
    if (values.confirmation) await userEvent.type(screen.getByLabelText(/^Confirm password/), values.confirmation)
  }

  const submit = () => userEvent.click(screen.getByRole('button', { name: 'Request account' }))

  it('asks only for name, email and password: there is no role or permission to choose', async () => {
    mockApi(() => undefined)
    renderApp('/signup')

    expect(await screen.findByLabelText(/Full name/)).toHaveFocus()
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText(/^Confirm password/)).toHaveAttribute('type', 'password')
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument()
  })

  it('validates every field before calling the API', async () => {
    const api = mockApi(() => undefined)
    renderApp('/signup')

    await screen.findByLabelText(/Full name/)
    await submit()

    expect(await screen.findByText('Full name is required.')).toBeInTheDocument()
    expect(screen.getByText('Email is required.')).toBeInTheDocument()
    expect(screen.getByText('Password must be at least 10 characters.')).toBeInTheDocument()
    expect(screen.getByText('Confirm your password.')).toBeInTheDocument()
    expect(screen.getByLabelText(/Full name/)).toHaveAttribute('aria-invalid', 'true')

    await fill({ fullName: 'Nadia Newcomer', email: 'not-an-email', password: 'short', confirmation: 'different' })
    await submit()

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByText('Password must be at least 10 characters.')).toBeInTheDocument()
    expect(screen.queryByText('Full name is required.')).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/^Password/), '-now-long-enough')
    await submit()

    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument()
    expect(api.requests).toHaveLength(0)
  })

  it('shows and hides each password separately', async () => {
    mockApi(() => undefined)
    renderApp('/signup')

    const [first, second] = await screen.findAllByRole('button', { name: 'Show or hide characters' })

    await userEvent.click(first as HTMLElement)

    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText(/^Confirm password/)).toHaveAttribute('type', 'password')

    await userEvent.click(second as HTMLElement)

    expect(screen.getByLabelText(/^Confirm password/)).toHaveAttribute('type', 'text')
  })

  it('submits the request, shows a loading state, then confirms without signing the person in', async () => {
    const pending = deferred()
    const api = mockApi((request) => (request.method === 'POST' && request.path === '/auth/signup' ? pending.reply : undefined))
    renderApp('/signup')

    await screen.findByLabelText(/Full name/)
    await fill({ fullName: '  Nadia Newcomer ', email: 'nadia@example.com', password: GOOD_PASSWORD, confirmation: GOOD_PASSWORD })
    await submit()

    expect(await screen.findByRole('button', { name: 'Submitting' })).toBeDisabled()
    // Nothing is claimed before the API answers.
    expect(screen.queryByText('Registration submitted')).not.toBeInTheDocument()

    pending.release(ok({ message: SIGNUP_MESSAGE }, 202))

    expect(await screen.findByRole('heading', { name: 'Registration submitted' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(SIGNUP_MESSAGE)
    // Exactly these fields: no role, no status, no confirmation copy.
    expect(api.find('POST', '/auth/signup')).toHaveLength(1)
    expect(api.find('POST', '/auth/signup')[0]?.body).toEqual({
      fullName: 'Nadia Newcomer',
      email: 'nadia@example.com',
      password: GOOD_PASSWORD,
    })
    expect(api.find('POST', '/auth/signup')[0]?.authorization).toBeNull()
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
    expect(screen.queryByLabelText(/Full name/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: /Back to sign in/ }))
    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
  })

  it('shows a problem the API reports on the field it belongs to, and keeps the form', async () => {
    mockApi((request) =>
      request.path === '/auth/signup'
        ? fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ field: 'password', message: 'Password must be at most 72 bytes.' }])
        : undefined,
    )
    renderApp('/signup')

    await screen.findByLabelText(/Full name/)
    await fill({ fullName: 'Nadia Newcomer', email: 'nadia@example.com', password: GOOD_PASSWORD, confirmation: GOOD_PASSWORD })
    await submit()

    expect(await screen.findByText('Password must be at most 72 bytes.')).toBeInTheDocument()
    expect(screen.queryByText('Registration submitted')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Request account' })).toBeEnabled()
  })

  it('reports a refused or unreachable request instead of claiming success', async () => {
    let reply: 'limit' | 'offline' = 'limit'
    mockApi((request) => {
      if (request.path !== '/auth/signup') return undefined
      if (reply === 'offline') throw new TypeError('Failed to fetch')
      return fail(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Please wait a few minutes and try again.')
    })
    renderApp('/signup')

    await screen.findByLabelText(/Full name/)
    await fill({ fullName: 'Nadia Newcomer', email: 'nadia@example.com', password: GOOD_PASSWORD, confirmation: GOOD_PASSWORD })
    await submit()

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Please wait a few minutes and try again.')

    reply = 'offline'
    await submit()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server'))
    expect(screen.queryByText('Registration submitted')).not.toBeInTheDocument()
  })
})

describe('forgot password', () => {
  it('validates the email before calling the API', async () => {
    const api = mockApi(() => undefined)
    renderApp('/forgot-password')

    expect(await screen.findByLabelText(/Email/)).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText('Email is required.')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/Email/), 'not-an-email')
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(api.requests).toHaveLength(0)
  })

  it('sends the request, shows a loading state, then the same confirmation for any email', async () => {
    const pending = deferred()
    const api = mockApi((request) => (request.method === 'POST' && request.path === '/auth/forgot-password' ? pending.reply : undefined))
    renderApp('/forgot-password')

    await userEvent.type(await screen.findByLabelText(/Email/), ' someone@example.com ')
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(await screen.findByRole('button', { name: 'Sending' })).toBeDisabled()

    pending.release(ok({ message: RESET_MESSAGE }))

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(RESET_MESSAGE)
    // The page never says whether the account exists.
    expect(screen.getByRole('status')).not.toHaveTextContent('someone@example.com')
    expect(api.find('POST', '/auth/forgot-password')[0]?.body).toEqual({ email: 'someone@example.com' })
    expect(screen.queryByLabelText(/Email/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Back to sign in/ })).toHaveAttribute('href', '/login')
  })

  it('reports a failed request and lets the person try again', async () => {
    mockApi((request) =>
      request.path === '/auth/forgot-password'
        ? fail(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Please wait a few minutes and try again.')
        : undefined,
    )
    renderApp('/forgot-password')

    await userEvent.type(await screen.findByLabelText(/Email/), 'someone@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts.')
    expect(screen.queryByText('Check your email')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled()
  })
})

describe('reset password', () => {
  function resetApi(status: string, onReset: () => MockReply = () => ok(null)) {
    return mockApi((request) => {
      if (request.method === 'POST' && request.path === '/auth/reset-password/check') return ok({ status })
      if (request.method === 'POST' && request.path === '/auth/reset-password') return onReset()
      return undefined
    })
  }

  it('treats a link without a token as invalid, without calling the API', async () => {
    const api = mockApi(() => undefined)
    renderApp('/reset-password')

    expect(await screen.findByRole('heading', { name: 'This link is not valid' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password')
    expect(screen.getByRole('link', { name: /Back to sign in/ })).toHaveAttribute('href', '/login')
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument()
    expect(document.title).toBe('Reset password · STSLEV AMC')
    expect(api.requests).toHaveLength(0)
  })

  it('checks the link first, sending the token in the request body', async () => {
    const pending = deferred()
    const api = mockApi((request) => (request.path === '/auth/reset-password/check' ? pending.reply : undefined))
    renderApp('/reset-password#token=emailed-token')

    expect(await screen.findByRole('status')).toHaveTextContent('Checking your reset link')
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument()

    pending.release(ok({ status: 'valid' }))

    expect(await screen.findByLabelText(/^New password/)).toHaveFocus()
    expect(screen.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { hidden: true })).toHaveClass('hidden')
    expect(api.find('POST', '/auth/reset-password/check')[0]?.body).toEqual({ token: 'emailed-token' })
    expect(api.requests.every((request) => !request.query.has('token') && !request.path.includes('emailed-token'))).toBe(true)
  })

  it.each([
    ['invalid', 'This link is not valid'],
    ['expired', 'This link has expired'],
    ['used', 'This link has already been used'],
  ])('explains a link that is %s and offers a new one', async (status, title) => {
    resetApi(status)
    renderApp('/reset-password#token=emailed-token')

    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password')
  })

  it('validates the new password before calling the API', async () => {
    const api = resetApi('valid')
    renderApp('/reset-password#token=emailed-token')

    await screen.findByLabelText(/^New password/)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByText('Password must be at least 10 characters.')).toBeInTheDocument()
    expect(screen.getByText('Confirm your new password.')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/^New password/), GOOD_PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), 'something-else-entirely')
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument()
    expect(api.find('POST', '/auth/reset-password')).toHaveLength(0)
  })

  it('sets the new password, shows a loading state, then returns to sign in with a confirmation', async () => {
    const pending = deferred()
    const api = mockApi((request) => {
      if (request.path === '/auth/reset-password/check') return ok({ status: 'valid' })
      if (request.path === '/auth/reset-password') return pending.reply
      return undefined
    })
    renderApp('/reset-password#token=emailed-token')

    await userEvent.type(await screen.findByLabelText(/^New password/), GOOD_PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), GOOD_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByRole('button', { name: 'Saving' })).toBeDisabled()
    // Nothing is claimed before the API answers.
    expect(screen.queryByText(RESET_DONE_MESSAGE)).not.toBeInTheDocument()

    pending.release(ok(null))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(RESET_DONE_MESSAGE)
    expect(api.find('POST', '/auth/reset-password')).toHaveLength(1)
    expect(api.find('POST', '/auth/reset-password')[0]?.body).toEqual({ token: 'emailed-token', password: GOOD_PASSWORD })
    // Resetting does not sign the person in.
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })

  async function completeReset() {
    renderApp('/reset-password#token=emailed-token')

    await userEvent.type(await screen.findByLabelText(/^New password/), GOOD_PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), GOOD_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByText(RESET_DONE_MESSAGE)).toBeInTheDocument()
  }

  it('keeps the confirmation while the person types, and removes it when they dismiss it', async () => {
    resetApi('valid')
    await completeReset()

    await userEvent.type(screen.getByLabelText(/Email/), 'someone@example.com')
    expect(screen.getByText(RESET_DONE_MESSAGE)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
    expect(screen.queryByText(RESET_DONE_MESSAGE)).not.toBeInTheDocument()

    // It does not come back when moving between the tabs.
    await userEvent.click(screen.getByRole('tab', { name: 'Sign up' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Sign in' }))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.queryByText(RESET_DONE_MESSAGE)).not.toBeInTheDocument()
  })

  it('removes the confirmation once the person signs in', async () => {
    const api = mockApi((request) => {
      if (request.path === '/auth/reset-password/check') return ok({ status: 'valid' })
      if (request.path === '/auth/reset-password') return ok(null)
      if (request.path === '/auth/login') return fail(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.')
      return undefined
    })
    await completeReset()

    await userEvent.type(screen.getByLabelText(/Email/), 'someone@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), 'not-the-new-password')
    await userEvent.click(screen.getByRole('button', { name: 'Login' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.')
    expect(screen.queryByText(RESET_DONE_MESSAGE)).not.toBeInTheDocument()
    expect(api.find('POST', '/auth/login')).toHaveLength(1)
  })

  it('does not show the confirmation on an ordinary visit to sign in', async () => {
    mockApi(() => undefined)
    renderApp('/login')

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.queryByText(RESET_DONE_MESSAGE)).not.toBeInTheDocument()
  })

  it.each([
    ['RESET_TOKEN_USED', 'This link has already been used'],
    ['RESET_TOKEN_EXPIRED', 'This link has expired'],
    ['RESET_TOKEN_INVALID', 'This link is not valid'],
  ])('shows the dead-link state when the API answers %s at the last moment', async (code, title) => {
    resetApi('valid', () => fail(400, code, 'This password reset link cannot be used.'))
    renderApp('/reset-password#token=emailed-token')

    await userEvent.type(await screen.findByLabelText(/^New password/), GOOD_PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), GOOD_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.queryByText(RESET_DONE_MESSAGE)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument()
  })

  it('shows a password the API refuses on the field, and keeps the form', async () => {
    resetApi('valid', () =>
      fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ field: 'password', message: 'Password must be at most 72 bytes.' }]),
    )
    renderApp('/reset-password#token=emailed-token')

    await userEvent.type(await screen.findByLabelText(/^New password/), GOOD_PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), GOOD_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByText('Password must be at most 72 bytes.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeEnabled()
  })

  it('lets the person retry when the link could not be checked', async () => {
    let online = false
    mockApi((request) => {
      if (request.path !== '/auth/reset-password/check') return undefined
      if (!online) throw new TypeError('Failed to fetch')
      return ok({ status: 'valid' })
    })
    renderApp('/reset-password#token=emailed-token')

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server')
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument()

    online = true
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByLabelText(/^New password/)).toBeInTheDocument()
  })

  it('works for someone already signed in on this browser, and ends that session', async () => {
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/auth/reset-password/check') return ok({ status: 'valid' })
      if (request.path === '/auth/reset-password') return ok(null)
      return undefined
    })
    renderApp('/reset-password#token=emailed-token')

    await userEvent.type(await screen.findByLabelText(/^New password/), GOOD_PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), GOOD_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    // Sent to sign in, not on to the dashboard of the session that just ended.
    expect(await screen.findByText(RESET_DONE_MESSAGE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })
})
