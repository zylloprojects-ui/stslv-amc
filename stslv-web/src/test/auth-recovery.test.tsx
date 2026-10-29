// @ts-expect-error -- the web app is compiled without Node's types; this test only reads the stylesheet from disk.
import { readFileSync } from 'node:fs'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply } from './helpers'

const GOOD_PASSWORD = 'a-good-long-password'

// Vitest does not load CSS into the test page, so the stylesheet is read as text
// (the tests run from the stslv-web folder).
const styles: string = readFileSync('src/index.css', 'utf8')

const SIGNUP_MESSAGE = 'Your registration has been submitted. An administrator will review it before you can sign in.'
const FORGOT_MESSAGE = 'Forgot your password? Please contact your system administrator to receive a temporary password.'
const CHANGED_MESSAGE = 'Your password has been changed. Please sign in again using your new password.'

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
    expect(screen.getByRole('status')).toHaveTextContent(FORGOT_MESSAGE)

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

      expect(await screen.findByRole('heading', { name: 'AMC Operations Dashboard' })).toBeInTheDocument()
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
  it('tells the person to ask their administrator, and sends nothing', async () => {
    const api = mockApi(() => undefined)
    renderApp('/forgot-password')

    expect(await screen.findByRole('heading', { level: 1, name: 'Forgot your password?' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(FORGOT_MESSAGE)
    // No email is asked for: recovery does not go through email.
    expect(screen.queryByLabelText(/Email/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reset link/i })).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/check your email/i)
    expect(screen.getByRole('link', { name: /Back to sign in/ })).toHaveAttribute('href', '/login')
    expect(api.requests).toHaveLength(0)
  })

  it('no longer has a reset-link page', async () => {
    mockApi(() => undefined)
    renderApp('/reset-password#token=old-emailed-token')

    // Not an auth page any more: an anonymous visitor is sent to sign in.
    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
  })
})

describe('required password change after a temporary password', () => {
  const TEMPORARY = 'Kp7r-Xw2m-Tq9a-Hd4e'
  const MUST_CHANGE: SessionUser = { ...ACCOUNTANT, credentialChangeRequired: true }

  /** The API as seen by a session that signed in with a temporary password. */
  function forcedApi(onComplete: () => MockReply | Promise<MockReply> = () => ok(null)) {
    return mockApi((request) => {
      if (request.path === '/auth/login') return ok({ token: 'temporary-session', expiresAt: '2026-10-29T12:00:00.000Z', user: MUST_CHANGE })
      if (request.path === '/auth/me') return ok({ user: MUST_CHANGE })
      if (request.method === 'POST' && request.path === '/auth/complete-password-change') return onComplete()
      // Anything else is refused, as the API does.
      return fail(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing.')
    })
  }

  async function signInWithTemporaryPassword() {
    renderApp('/login')
    await userEvent.type(await screen.findByLabelText(/Email/), 'accountant@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), TEMPORARY)
    await userEvent.click(screen.getByRole('button', { name: 'Login' }))

    return screen.findByLabelText(/^New password/)
  }

  async function fill(newPassword: string, confirmation = newPassword) {
    await userEvent.type(screen.getByLabelText(/^New password/), newPassword)
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), confirmation)
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))
  }

  const appRequests = (requests: { path: string }[]) => requests.map((request) => request.path).filter((path) => !path.startsWith('/auth/'))

  it('goes straight from sign in to the change-password screen', async () => {
    const api = forcedApi()

    expect(await signInWithTemporaryPassword()).toHaveFocus()
    expect(screen.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('You signed in with a temporary password for accountant@example.com.')
    expect(screen.getByRole('tablist', { hidden: true })).toHaveClass('hidden')
    expect(document.title).toBe('Change your password · STSLEV AMC')
    // Nothing of the application was loaded.
    expect(appRequests(api.requests)).toEqual([])
  })

  it.each(['/dashboard', '/clients', '/admin/users', '/account', '/login', '/forgot-password'])(
    'keeps a forced session on the change-password screen when it opens %s directly',
    async (path) => {
      signIn()
      const api = forcedApi()
      renderApp(path)

      expect(await screen.findByLabelText(/^New password/)).toBeInTheDocument()
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
      expect(appRequests(api.requests)).toEqual([])
    },
  )

  it('validates the new password before calling the API', async () => {
    const api = forcedApi()
    await signInWithTemporaryPassword()

    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByText('Password must be at least 10 characters.')).toBeInTheDocument()
    expect(screen.getByText('Confirm your new password.')).toBeInTheDocument()

    await fill(GOOD_PASSWORD, 'something-else-entirely')
    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument()
    expect(api.find('POST', '/auth/complete-password-change')).toHaveLength(0)
  })

  it('saves the new password, signs out and returns to sign in with a confirmation', async () => {
    const pending = deferred()
    const api = forcedApi(() => pending.reply)
    await signInWithTemporaryPassword()

    await fill(GOOD_PASSWORD)
    expect(await screen.findByRole('button', { name: 'Saving' })).toBeDisabled()
    expect(screen.queryByText(CHANGED_MESSAGE)).not.toBeInTheDocument()

    pending.release(ok(null))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(CHANGED_MESSAGE)
    expect(api.find('POST', '/auth/complete-password-change')[0]?.body).toEqual({ newPassword: GOOD_PASSWORD })
    // Every session ended, this one too.
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })

  it('shows a password the API refuses on the field, and keeps the form', async () => {
    forcedApi(() =>
      fail(400, 'VALIDATION_ERROR', 'Choose a password different from the temporary one.', [
        { field: 'newPassword', message: 'Choose a password different from the temporary one.' },
      ]),
    )
    await signInWithTemporaryPassword()

    await fill(GOOD_PASSWORD)

    expect(await screen.findByText('Choose a password different from the temporary one.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeEnabled()
    expect(localStorage.getItem('stslv-amc.token')).not.toBeNull()
  })

  it('lets the person sign out instead', async () => {
    forcedApi()
    await signInWithTemporaryPassword()

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })

  it('explains an expired temporary password at sign in', async () => {
    mockApi((request) =>
      request.path === '/auth/login'
        ? fail(401, 'TEMPORARY_PASSWORD_EXPIRED', 'Your temporary password has expired. Ask your administrator for a new one.')
        : undefined,
    )
    renderApp('/login')

    await userEvent.type(await screen.findByLabelText(/Email/), 'accountant@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), TEMPORARY)
    await userEvent.click(screen.getByRole('button', { name: 'Login' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your temporary password has expired. Ask your administrator for a new one.')
    expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument()
  })

  it('sends a visitor who is not signed in from the change-password screen to sign in', async () => {
    const api = mockApi(() => undefined)
    renderApp('/change-password')

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(api.requests).toHaveLength(0)
  })

  it('sends a normal session away from the change-password screen', async () => {
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/dashboard/summary') return ok({ clients: { active: 1, inactive: 0 } })
      return undefined
    })
    renderApp('/change-password')

    expect(await screen.findByRole('heading', { name: 'AMC Operations Dashboard' })).toBeInTheDocument()
  })

  it('does not show the confirmation on an ordinary visit to sign in', async () => {
    mockApi(() => undefined)
    renderApp('/login')

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.queryByText(CHANGED_MESSAGE)).not.toBeInTheDocument()
  })
})
