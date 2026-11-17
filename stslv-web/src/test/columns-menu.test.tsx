import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ColumnsMenu } from '../pages/clients/ColumnsMenu'

// Client UAT CR-030: every table starts with all its columns shown; the Columns menu brings them all back at once,
// touching only the columns it offers (a column the user may not see is never offered, so never shown by it).
describe('Columns menu "Show all columns"', () => {
  const OPTIONS = [
    { key: 'a', label: 'Alpha' },
    { key: 'b', label: 'Beta' },
  ] as const

  it('is disabled while every column is shown', async () => {
    render(<ColumnsMenu<'a' | 'b'> options={[...OPTIONS]} hidden={new Set<'a' | 'b'>()} onChange={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    expect(screen.getByRole('button', { name: 'Show all columns' })).toBeDisabled()
  })

  it('shows every offered column again and keeps nothing else', async () => {
    const onChange = vi.fn()
    render(<ColumnsMenu<'a' | 'b' | 'z'> options={[...OPTIONS]} hidden={new Set(['a', 'b', 'z'])} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Show all columns' }))
    expect(onChange).toHaveBeenCalledWith(new Set(['z']))
  })
})
