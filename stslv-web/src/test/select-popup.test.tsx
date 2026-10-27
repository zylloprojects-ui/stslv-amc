import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import * as selectPopupModule from '../layout/SelectPopup'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'

describe('select popup', () => {
  // AppLayout imports this by name; if the export goes missing every signed-in page is blank.
  it('provides the named SelectPopup export AppLayout imports', () => {
    expect(typeof selectPopupModule.SelectPopup).toBe('function')
  })

  it('renders nothing until a select is pressed', () => {
    const { container } = render(<selectPopupModule.SelectPopup />)

    expect(container).toBeEmptyDOMElement()
    expect(document.querySelector('.select-popup')).toBeNull()
  })

  it('lets the application shell load with it mounted', async () => {
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      return undefined
    })
    renderApp('/dashboard')

    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
  })
})
