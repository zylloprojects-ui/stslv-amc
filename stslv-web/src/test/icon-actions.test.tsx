import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ActionButton, ActionGroup, ActionLink } from '../components/IconActions'

// Row actions are icon-only: the label is the accessible name, the hint (or the label) is the hover tooltip.
describe('icon row actions', () => {
  it('names each icon for screen readers and shows a tooltip on hover', () => {
    const onClick = vi.fn()
    render(
      <MemoryRouter>
        <ActionGroup>
          <ActionButton icon="edit" label="Edit Fire Alarm" hint="Edit" onClick={onClick} />
          <ActionLink icon="view" to="/amc/contracts/1" label="View AMC-001" hint="View contract" />
        </ActionGroup>
      </MemoryRouter>,
    )

    const edit = screen.getByRole('button', { name: 'Edit Fire Alarm' })
    expect(edit).toHaveAttribute('title', 'Edit')
    expect(edit.textContent).toBe('')
    fireEvent.click(edit)
    expect(onClick).toHaveBeenCalledTimes(1)

    const view = screen.getByRole('link', { name: 'View AMC-001' })
    expect(view).toHaveAttribute('href', '/amc/contracts/1')
    expect(view).toHaveAttribute('title', 'View contract')
  })

  it('marks a destructive action in red, before hovering too', () => {
    render(<ActionButton icon="delete" danger label="Delete permanently Client 7" hint="Delete permanently" onClick={() => {}} />)
    expect(screen.getByRole('button', { name: 'Delete permanently Client 7' }).className).toContain('text-red-600')
  })

  it('blocks a second click while the action is running', () => {
    const onClick = vi.fn()
    render(<ActionButton icon="download" label="Download report" loading onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'Download report' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})
