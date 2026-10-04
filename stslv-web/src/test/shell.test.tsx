import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Alert, Button, Modal } from '../components/ui'
import { formatCount, initialsOf } from '../lib/format'
import { ACCOUNTANT, ADMIN, makeClient, mockApi, ok, renderApp, signIn } from './helpers'

function session(user: typeof ADMIN) {
  signIn()
  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/dashboard/summary') return ok({ clients: { active: 4, inactive: 1 } })
    if (request.path === '/clients') return ok({ items: [makeClient()], total: 1, page: 1, pageSize: 25 })
    return undefined
  })
}

describe('application shell', () => {
  it('offers a skip link to the main content', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    const skip = await screen.findByRole('link', { name: 'Skip to main content' })

    expect(skip).toHaveAttribute('href', '#main-content')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content')
    // It is the first thing the keyboard reaches.
    await userEvent.tab()
    expect(skip).toHaveFocus()
  })

  it('names the browser tab after the page', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    await screen.findByRole('heading', { name: 'Dashboard' })
    expect(document.title).toBe('Dashboard · STSLEV AMC')

    const nav = screen.getByRole('navigation', { name: 'Main' })
    await userEvent.click(within(nav).getByRole('button', { name: 'Finance' }))
    await userEvent.click(within(nav).getByRole('link', { name: 'Invoice Tracking' }))

    await screen.findByRole('heading', { name: 'Invoice Tracking' })
    expect(document.title).toBe('Invoice Tracking · STSLEV AMC')
  })

  it('names the tab on the login, access-denied and not-found pages', async () => {
    mockApi(() => undefined)
    const login = renderApp('/login')
    await screen.findByRole('button', { name: 'Login' })
    expect(document.title).toBe('Sign in · STSLEV AMC')
    login.unmount()

    session(ACCOUNTANT)
    const denied = renderApp('/admin/users')
    await screen.findByRole('heading', { name: 'Access denied' })
    expect(document.title).toBe('Access denied · STSLEV AMC')
    denied.unmount()

    renderApp('/no-such-page')
    await screen.findByRole('heading', { name: 'Page not found' })
    expect(document.title).toBe('Page not found · STSLEV AMC')
  })

  it('moves keyboard focus to the new page after navigation', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await userEvent.click(within(nav).getByRole('button', { name: 'Operations' }))
    await userEvent.click(within(nav).getByRole('link', { name: 'Clients' }))

    await screen.findByRole('heading', { name: 'Clients' })
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('marks the current page in the navigation', async () => {
    session(ADMIN)
    renderApp('/clients')

    const nav = await screen.findByRole('navigation', { name: 'Main' })

    expect(within(nav).getByRole('link', { name: 'Clients' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })
})

describe('mobile menu', () => {
  it('opens as a dialog with focus on the current page, and closes on Escape', async () => {
    session(ADMIN)
    renderApp('/clients')

    const open = await screen.findByRole('button', { name: 'Open menu' })
    expect(open).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(open)

    const menu = await screen.findByRole('dialog', { name: 'Menu' })
    expect(open).toHaveAttribute('aria-expanded', 'true')
    expect(within(menu).getByRole('link', { name: 'Clients' })).toHaveFocus()
    expect(document.body.style.overflow).toBe('hidden')

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(open).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('has its own close button', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }))
    const menu = await screen.findByRole('dialog', { name: 'Menu' })

    await userEvent.click(within(menu).getByRole('button', { name: 'Close menu' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps keyboard focus inside while open', async () => {
    session(ACCOUNTANT)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }))
    const menu = await screen.findByRole('dialog', { name: 'Menu' })
    const close = within(menu).getByRole('button', { name: 'Close menu' })
    // Sign Out closes the sidebar, so it is the last control in the menu.
    const last = within(menu).getByRole('button', { name: 'Sign Out' })

    // Backwards from the first control wraps to the last; forwards from the last wraps to the first.
    close.focus()
    await userEvent.tab({ shift: true })
    expect(last).toHaveFocus()

    await userEvent.tab()
    expect(close).toHaveFocus()
  })

  it('closes after a page is chosen and shows only what the role may view', async () => {
    session(ACCOUNTANT)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }))
    const menu = await screen.findByRole('dialog', { name: 'Menu' })

    const links = () =>
      within(menu)
        .getAllByRole('link')
        .map((link) => link.textContent)

    // One group is open at a time; the role has no Administration group and no Settings link.
    expect(within(menu).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Operations', 'Finance'])
    await userEvent.click(within(menu).getByRole('button', { name: 'Finance' }))
    expect(links()).toEqual(['Dashboard', 'Expenses'])
    await userEvent.click(within(menu).getByRole('button', { name: 'Operations' }))
    expect(links()).toEqual(['Dashboard', 'Clients', 'Projects'])

    await userEvent.click(within(menu).getByRole('link', { name: 'Clients' }))

    expect(await screen.findByRole('heading', { name: 'Clients' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('shared tables', () => {
  it('puts a wide table in a labelled region the keyboard can reach and scroll', async () => {
    session(ADMIN)
    renderApp('/clients')

    const region = await screen.findByRole('region', { name: 'Clients table' })

    expect(region).toHaveAttribute('tabindex', '0')
    expect(within(region).getByRole('table', { name: 'Clients' })).toBeInTheDocument()
  })
})

function DialogHarness() {
  const [outer, setOuter] = useState(false)
  const [inner, setInner] = useState(false)

  return (
    <>
      <Button onClick={() => setOuter(true)}>Open form</Button>
      {outer && (
        <Modal title="Form" onClose={() => setOuter(false)} footer={<Button onClick={() => setInner(true)}>Ask</Button>}>
          <label>
            Name <input />
          </label>
        </Modal>
      )}
      {inner && (
        <Modal title="Confirm" onClose={() => setInner(false)}>
          <p>Are you sure?</p>
        </Modal>
      )}
    </>
  )
}

describe('shared dialog', () => {
  it('focuses the first field, traps focus, locks the page and restores focus on close', async () => {
    render(<DialogHarness />)

    const opener = screen.getByRole('button', { name: 'Open form' })
    await userEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Form' })
    expect(within(dialog).getByRole('textbox')).toHaveFocus()
    expect(document.body.style.overflow).toBe('hidden')

    // Close button -> field -> footer button, then back round to the close button.
    await userEvent.tab()
    expect(within(dialog).getByRole('button', { name: 'Ask' })).toHaveFocus()
    await userEvent.tab()
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(within(dialog).getByRole('button', { name: 'Ask' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('does not close when the backdrop is clicked, so a half-filled form is not lost', async () => {
    render(<DialogHarness />)

    await userEvent.click(screen.getByRole('button', { name: 'Open form' }))
    const dialog = screen.getByRole('dialog', { name: 'Form' })
    await userEvent.type(within(dialog).getByRole('textbox'), 'Half typed')

    // The backdrop is the dialog's sibling, covering the page behind it.
    await userEvent.click(dialog.previousElementSibling as HTMLElement)

    expect(screen.getByRole('dialog', { name: 'Form' })).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox')).toHaveValue('Half typed')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('carries the product name, never an outdated one', async () => {
    render(<DialogHarness />)

    await userEvent.click(screen.getByRole('button', { name: 'Open form' }))

    expect(screen.getByRole('dialog', { name: 'Form' })).toHaveTextContent('STSLEV AMC · Smart Technical Service LLC')
    expect(document.body).not.toHaveTextContent('STSLEV ERP')
  })

  it('lets Escape close only the dialog on top', async () => {
    render(<DialogHarness />)

    await userEvent.click(screen.getByRole('button', { name: 'Open form' }))
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Form' })).toBeInTheDocument()
    // The page stays locked while the first dialog is still open.
    expect(document.body.style.overflow).toBe('hidden')

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.body.style.overflow).toBe('')
  })
})

describe('shared alert', () => {
  it('can be dismissed when the page allows it', async () => {
    function Harness() {
      const [shown, setShown] = useState(true)

      return shown ? (
        <Alert tone="success" onDismiss={() => setShown(false)}>
          Saved.
        </Alert>
      ) : null
    }

    render(<Harness />)
    expect(screen.getByRole('status')).toHaveTextContent('Saved.')

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('has no dismiss button unless asked for one', () => {
    render(<Alert>Something failed.</Alert>)

    expect(screen.getByRole('alert')).toHaveTextContent('Something failed.')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('formatting', () => {
  it('formats counts with thousands separators', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1234567)).toBe('1,234,567')
  })

  it('takes up to two initials from a name', () => {
    expect(initialsOf('Asha Admin')).toBe('AA')
    expect(initialsOf('  mock   middle  person ')).toBe('MP')
    expect(initialsOf('Single')).toBe('S')
    expect(initialsOf('')).toBe('')
  })
})
