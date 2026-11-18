import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionTooltipLayer } from '../components/ActionTooltip'
import { ActionButton, ActionGroup, ActionLink } from '../components/IconActions'

afterEach(() => vi.useRealTimers())

const hover = (element: Element) => fireEvent.pointerOver(element, { pointerType: 'mouse' })

// Row actions are icon-only: the label is the accessible name, the hint (or the label) is the custom tooltip.
describe('icon row actions', () => {
  it('names each icon for screen readers, without the browser title tooltip', () => {
    const onClick = vi.fn()
    render(
      <MemoryRouter>
        <ActionGroup>
          <ActionButton icon="edit" label="Edit Fire Alarm" hint="Edit record Fire Alarm" onClick={onClick} />
          <ActionLink icon="view" to="/amc/contracts/1" label="View AMC-001" hint="View contract AMC-001" />
        </ActionGroup>
      </MemoryRouter>,
    )

    const edit = screen.getByRole('button', { name: 'Edit Fire Alarm' })
    expect(edit).toHaveAttribute('data-tooltip', 'Edit record Fire Alarm')
    expect(edit).not.toHaveAttribute('title')
    expect(edit.textContent).toBe('')
    fireEvent.click(edit)
    expect(onClick).toHaveBeenCalledTimes(1)

    const view = screen.getByRole('link', { name: 'View AMC-001' })
    expect(view).toHaveAttribute('href', '/amc/contracts/1')
    expect(view).toHaveAttribute('data-tooltip', 'View contract AMC-001')
    expect(view).not.toHaveAttribute('title')
  })

  it('marks a destructive action in red, before hovering too', () => {
    render(<ActionButton icon="delete" danger label="Delete permanently Client 7" onClick={() => {}} />)
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

  it('keeps the tooltip of a disabled action on a wrapper that still receives hover', () => {
    render(<ActionButton icon="save" label="Save AMC-001 visit 1" hint="Nothing changed yet" disabled onClick={() => {}} />)
    const button = screen.getByRole('button', { name: 'Save AMC-001 visit 1' })
    expect(button).toBeDisabled()
    expect(button).not.toHaveAttribute('data-tooltip')
    expect(button.parentElement).toHaveAttribute('data-tooltip', 'Nothing changed yet')
  })
})

describe('action tooltip layer', () => {
  it('shows the tooltip within 100 ms of hovering, describes the icon, and hides it on leave, click and Escape', () => {
    vi.useFakeTimers()
    render(
      <>
        <ActionButton icon="renew" label="Start Renewal" hint="Start the renewal of AMC-001" onClick={() => {}} />
        <p>Elsewhere</p>
        <ActionTooltipLayer />
      </>,
    )
    const button = screen.getByRole('button', { name: 'Start Renewal' })

    hover(button.querySelector('svg') as Element)
    act(() => vi.advanceTimersByTime(100))
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Start the renewal of AMC-001')
    expect(tip.parentElement).toBe(document.body)
    expect(button).toHaveAttribute('aria-describedby', tip.id)

    hover(screen.getByText('Elsewhere'))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(button).not.toHaveAttribute('aria-describedby')

    hover(button)
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    hover(button)
    act(() => vi.advanceTimersByTime(100))
    fireEvent.pointerDown(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('does not open on a touch tap', () => {
    vi.useFakeTimers()
    render(
      <>
        <ActionButton icon="view" label="View AMC-001" onClick={() => {}} />
        <ActionTooltipLayer />
      </>,
    )
    fireEvent.pointerOver(screen.getByRole('button', { name: 'View AMC-001' }), { pointerType: 'touch' })
    act(() => vi.advanceTimersByTime(200))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
