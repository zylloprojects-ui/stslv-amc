import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OPTIONS_NOTICE_VALUE, OptionsNotice } from '../components/ui'
import { ApiError } from '../lib/api'

function list(source: { isPending: boolean; isError: boolean; error?: unknown }, count: number) {
  render(
    <select aria-label="Client" defaultValue="">
      <option value="">All clients</option>
      <OptionsNotice source={source} count={count} empty="No clients yet" />
    </select>,
  )

  return [...(screen.getByLabelText('Client') as HTMLSelectElement).options].slice(1)
}

describe('OptionsNotice', () => {
  it('says the list is loading while its query is pending', () => {
    const [entry] = list({ isPending: true, isError: false }, 0)

    expect(entry).toHaveTextContent('Loading…')
    expect(entry).toBeDisabled()
    expect(entry).toHaveValue(OPTIONS_NOTICE_VALUE)
  })

  it('says the list could not be loaded when its query failed', () => {
    expect(list({ isPending: false, isError: true }, 0)[0]).toHaveTextContent('The list could not be loaded')
  })

  it('gives the reason when the server returned no entries', () => {
    const [entry] = list({ isPending: false, isError: false }, 0)

    expect(entry).toHaveTextContent('No clients yet')
    expect(entry).toBeDisabled()
  })

  it('adds nothing once there are entries', () => {
    expect(list({ isPending: false, isError: false }, 3)).toHaveLength(0)
  })

  it('never becomes the chosen value', () => {
    list({ isPending: false, isError: false }, 0)

    expect(screen.getByLabelText('Client')).toHaveValue('')
  })
})

describe('OptionsNotice for a list the role may not read', () => {
  it('says the list is not available for the role, not that it could not be loaded', () => {
    const forbidden = new ApiError(403, 'FORBIDDEN', 'You do not have permission.', [])
    const [entry] = list({ isPending: false, isError: true, error: forbidden }, 0)

    expect(entry).toHaveTextContent('Not available for your role')
    expect(entry).toBeDisabled()
  })
})
