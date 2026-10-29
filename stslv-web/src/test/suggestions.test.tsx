import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { SuggestionDetail, SuggestionStatus } from '../pages/suggestions/suggestionTypes'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// Suggestions & feedback: the popup, My Suggestions, the detail page and Suggestions Review.
// Every record here is invented test data. The mock API applies the same
// ownership and transition rules as the real one only as far as each test needs.

const SUBMITTER = { id: ACCOUNTANT.id, fullName: ACCOUNTANT.fullName }
const REVIEWER = { id: ADMIN.id, fullName: ADMIN.fullName }

function suggestion(overrides: Partial<SuggestionDetail> = {}): SuggestionDetail {
  return {
    id: '7',
    reference: 'SUG-00007',
    category: 'BUG',
    subject: 'Export button is slow',
    status: 'SUBMITTED',
    submittedBy: SUBMITTER,
    assignedTo: null,
    createdAt: '2026-10-28T08:00:00.000Z',
    updatedAt: '2026-10-28T08:00:00.000Z',
    statusChangedAt: '2026-10-28T08:00:00.000Z',
    lastResponseAt: null,
    description: 'The schedule export takes a long time to start.',
    pagePath: '/amc/schedule',
    resolutionNotes: null,
    resolvedAt: null,
    resolvedBy: null,
    closedAt: null,
    closedBy: null,
    statusChangedBy: SUBMITTER,
    events: [{ id: '1', kind: 'SUBMITTED', actor: SUBMITTER, bySubmitter: true, fromStatus: null, toStatus: null, assignedTo: null, body: null, internal: false, createdAt: '2026-10-28T08:00:00.000Z' }],
    access: { reviewer: false, isSubmitter: true, transitions: [], canComment: true, canAssign: false },
    ...overrides,
  }
}

const REVIEWER_TRANSITIONS: Record<SuggestionStatus, SuggestionStatus[]> = {
  SUBMITTED: ['UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  UNDER_REVIEW: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['UNDER_REVIEW', 'RESOLVED', 'CLOSED'],
  REOPENED: ['UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  CLOSED: ['REOPENED'],
}

function asViewer(record: SuggestionDetail, user: SessionUser): SuggestionDetail {
  const reviewer = user.roles.some((role) => role.code === 'ADMIN')
  const isSubmitter = record.submittedBy.id === user.id

  return {
    ...record,
    events: reviewer ? record.events : record.events.filter((event) => !event.internal),
    access: {
      reviewer,
      isSubmitter,
      transitions: reviewer ? REVIEWER_TRANSITIONS[record.status] : record.status === 'RESOLVED' ? ['REOPENED'] : [],
      canComment: reviewer || record.status !== 'CLOSED',
      canAssign: reviewer,
    },
  }
}

/** A small stateful stand-in for /api/suggestions. */
function suggestionsApi(user: SessionUser, initial: SuggestionDetail[] = [], override?: (request: MockRequest) => MockReply | undefined) {
  signIn()
  const records = new Map(initial.map((record) => [record.id, record]))
  let nextEvent = 100

  const event = (kind: SuggestionDetail['events'][number]['kind'], extra: Partial<SuggestionDetail['events'][number]> = {}) => ({
    id: String(nextEvent++),
    kind,
    actor: { id: user.id, fullName: user.fullName },
    bySubmitter: false,
    fromStatus: null,
    toStatus: null,
    assignedTo: null,
    body: null,
    internal: false,
    createdAt: '2026-10-29T09:00:00.000Z',
    ...extra,
  })

  const api = mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/dashboard/summary') return ok({ clients: null, amc: null, projects: null, invoices: null })
    if (request.path === '/notifications') return ok({ items: [], unreadCount: 0 })

    const body = (request.body ?? {}) as Record<string, string | boolean | null>

    if (request.method === 'POST' && request.path === '/suggestions') {
      const created = suggestion({
        id: '12',
        reference: 'SUG-00012',
        category: body.category as SuggestionDetail['category'],
        subject: body.subject as string,
        description: body.description as string,
        pagePath: body.pagePath as string,
        submittedBy: { id: user.id, fullName: user.fullName },
      })
      records.set(created.id, created)
      return ok(asViewer(created, user), 201)
    }
    if (request.method === 'GET' && request.path === '/suggestions/mine') {
      const status = request.query.get('status')
      const items = [...records.values()].filter((record) => record.submittedBy.id === user.id && (!status || record.status === status))
      return ok({ items, total: items.length, page: 1, pageSize: 20 })
    }
    if (request.method === 'GET' && request.path === '/suggestions/review/options') {
      return ok({ submitters: [{ ...SUBMITTER, email: ACCOUNTANT.email }], reviewers: [{ ...REVIEWER, email: ADMIN.email }, { id: '9', fullName: 'Second Admin', email: 'second.admin@example.com' }] })
    }
    if (request.method === 'GET' && request.path === '/suggestions/review') {
      // As the API: a status filter wins; otherwise view=OPEN leaves out Resolved and Closed.
      const status = request.query.get('status')
      const openOnly = !status && request.query.get('view') === 'OPEN'
      const items = [...records.values()].filter((record) => (status ? record.status === status : !openOnly || !['RESOLVED', 'CLOSED'].includes(record.status)))
      const counts = { SUBMITTED: 0, UNDER_REVIEW: 0, IN_PROGRESS: 0, RESOLVED: 0, CLOSED: 0, REOPENED: 0 }
      for (const record of records.values()) counts[record.status] += 1
      return ok({ items, total: items.length, page: 1, pageSize: 25, counts })
    }

    const match = /^\/suggestions\/(\d+)(?:\/(comments|reopen|status|assignment))?$/.exec(request.path)
    const record = match ? records.get(match[1] as string) : undefined
    if (!match) return undefined
    if (!record || (record.submittedBy.id !== user.id && !user.roles.some((role) => role.code === 'ADMIN'))) return fail(404, 'NOT_FOUND', 'Suggestion not found.')

    const save = (next: SuggestionDetail) => {
      records.set(next.id, next)
      return ok(asViewer(next, user))
    }

    switch (match[2]) {
      case undefined:
        return ok(asViewer(record, user))
      case 'comments':
        return save({ ...record, events: [...record.events, event('COMMENT', { body: body.body as string, internal: body.internal === true, bySubmitter: record.submittedBy.id === user.id })] })
      case 'reopen':
      case 'status': {
        const to = (match[2] === 'reopen' ? 'REOPENED' : body.status) as SuggestionStatus
        const note = (match[2] === 'reopen' ? body.reason : body.note) as string
        return save({
          ...record,
          status: to,
          resolutionNotes: to === 'RESOLVED' ? note : to === 'REOPENED' ? null : record.resolutionNotes,
          resolvedAt: to === 'RESOLVED' ? '2026-10-29T09:00:00.000Z' : record.resolvedAt,
          resolvedBy: to === 'RESOLVED' ? REVIEWER : record.resolvedBy,
          events: [...record.events, event('STATUS_CHANGED', { fromStatus: record.status, toStatus: to, body: note || null })],
        })
      }
      case 'assignment': {
        const assignee = body.assignedTo === '9' ? { id: '9', fullName: 'Second Admin' } : null
        return save({ ...record, assignedTo: assignee, events: [...record.events, event('ASSIGNED', { assignedTo: assignee })] })
      }
    }
    return undefined
  })

  return { ...api, records }
}

describe('suggestions popup', () => {
  it('submits a suggestion with the page and a request id, then links to it', async () => {
    const api = suggestionsApi(ACCOUNTANT)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Suggestions and improvements' }))
    const dialog = await screen.findByRole('dialog', { name: 'Suggestions & Improvements' })
    await userEvent.click(within(dialog).getByText('Feature'))
    await userEvent.type(within(dialog).getByLabelText('Subject'), 'Dark mode')
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Please add a dark theme for night shifts.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit Feedback' }))

    expect(await within(dialog).findByText('Thank you for your feedback')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('submitted as SUG-00012')
    const [sent] = api.find('POST', '/suggestions')
    expect(sent?.body).toMatchObject({ category: 'FEATURE', subject: 'Dark mode', description: 'Please add a dark theme for night shifts.', pagePath: '/dashboard' })
    expect((sent?.body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/)

    await userEvent.click(within(dialog).getByRole('link', { name: 'View SUG-00012' }))
    expect(await screen.findByRole('heading', { name: 'SUG-00012 · Dark mode' })).toBeInTheDocument()
  })

  it('shows the reason when the API refuses the suggestion', async () => {
    suggestionsApi(ACCOUNTANT, [], (request) =>
      request.method === 'POST' && request.path === '/suggestions'
        ? fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ field: 'subject', message: 'Subject must be at most 150 characters.' }])
        : undefined,
    )
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Suggestions and improvements' }))
    const dialog = await screen.findByRole('dialog', { name: 'Suggestions & Improvements' })
    await userEvent.type(within(dialog).getByLabelText('Subject'), 'Dark mode')
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Please add a dark theme for night shifts.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit Feedback' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Subject must be at most 150 characters.')
  })
})

describe('My Suggestions', () => {
  it('lists the user’s suggestions with reference, status and dates, and filters by status', async () => {
    const api = suggestionsApi(ACCOUNTANT, [
      suggestion(),
      suggestion({ id: '8', reference: 'SUG-00008', subject: 'Show contract number', status: 'RESOLVED', lastResponseAt: '2026-10-29T07:00:00.000Z' }),
    ])
    renderApp('/suggestions')

    const table = await screen.findByRole('table')
    expect(within(table).getByRole('link', { name: 'SUG-00007' })).toHaveAttribute('href', '/suggestions/7')
    expect(within(table).getByText('Show contract number')).toBeInTheDocument()
    expect(within(table).getByText('Resolved')).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'RESOLVED')
    await waitFor(() => expect(api.requests.some((request) => request.path === '/suggestions/mine' && request.query.get('status') === 'RESOLVED')).toBe(true))
    await waitFor(() => expect(screen.queryByText('Export button is slow')).not.toBeInTheDocument())
  })

  it('explains how to submit when there are none yet, and is reachable from the user menu', async () => {
    suggestionsApi(ACCOUNTANT)
    renderApp('/suggestions')

    expect(await screen.findByText('You have not submitted any suggestions yet')).toBeInTheDocument()
  })

  it('says when the database update is missing', async () => {
    suggestionsApi(ACCOUNTANT, [], (request) => (request.path === '/suggestions/mine' ? fail(503, 'FEATURE_UNAVAILABLE', 'Not applied.') : undefined))
    renderApp('/suggestions')

    expect(await screen.findByText(/migration 0085/)).toBeInTheDocument()
  })
})

describe('suggestion detail for the submitter', () => {
  it('shows the response and resolution, and reopens with a required reason', async () => {
    const resolved = suggestion({
      status: 'RESOLVED',
      resolutionNotes: 'Export now starts at once.',
      resolvedAt: '2026-10-29T08:00:00.000Z',
      resolvedBy: REVIEWER,
      events: [
        ...suggestion().events,
        { id: '2', kind: 'COMMENT', actor: REVIEWER, bySubmitter: false, fromStatus: null, toStatus: null, assignedTo: null, body: 'Thanks, we can reproduce this.', internal: false, createdAt: '2026-10-28T09:00:00.000Z' },
        { id: '3', kind: 'COMMENT', actor: REVIEWER, bySubmitter: false, fromStatus: null, toStatus: null, assignedTo: null, body: 'Internal cause analysis', internal: true, createdAt: '2026-10-28T09:05:00.000Z' },
        { id: '4', kind: 'STATUS_CHANGED', actor: REVIEWER, bySubmitter: false, fromStatus: 'SUBMITTED', toStatus: 'RESOLVED', assignedTo: null, body: 'Export now starts at once.', internal: false, createdAt: '2026-10-29T08:00:00.000Z' },
      ],
    })
    const api = suggestionsApi(ACCOUNTANT, [resolved])
    renderApp('/suggestions/7')

    expect(await screen.findByRole('heading', { name: 'SUG-00007 · Export button is slow' })).toBeInTheDocument()
    const history = screen.getByRole('list', { name: /Responses and history/ })
    expect(history).toHaveTextContent('Thanks, we can reproduce this.')
    expect(history).not.toHaveTextContent('Internal cause analysis')
    expect(screen.getByRole('heading', { name: 'Resolution' }).parentElement).toHaveTextContent('Export now starts at once.')
    expect(screen.queryByRole('heading', { name: 'Responsible person' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    const reopenButtons = screen.getAllByRole('button', { name: 'Reopen' })
    await userEvent.click(reopenButtons.at(-1)!)
    expect(await screen.findByText('Give a reason for this change.')).toBeInTheDocument()
    expect(api.find('POST', '/suggestions/7/reopen')).toHaveLength(0)

    await userEvent.type(screen.getByLabelText(/^Reason/), 'Still slow for large schedules.')
    await userEvent.click(screen.getAllByRole('button', { name: 'Reopen' }).at(-1)!)

    await waitFor(() => expect(api.find('POST', '/suggestions/7/reopen')[0]?.body).toEqual({ fromStatus: 'RESOLVED', reason: 'Still slow for large schedules.' }))
    expect(await screen.findAllByText('Reopened')).not.toHaveLength(0)
  })

  it('adds a follow-up comment', async () => {
    const api = suggestionsApi(ACCOUNTANT, [suggestion()])
    renderApp('/suggestions/7')

    await userEvent.type(await screen.findByLabelText('Add a comment'), 'It happens every morning.')
    await userEvent.click(screen.getByRole('button', { name: 'Add Comment' }))

    await waitFor(() => expect(api.find('POST', '/suggestions/7/comments')[0]?.body).toEqual({ body: 'It happens every morning.', internal: false }))
    expect(await screen.findByText('It happens every morning.')).toBeInTheDocument()
  })

  it('does not offer comments on a closed suggestion', async () => {
    suggestionsApi(ACCOUNTANT, [suggestion({ status: 'CLOSED', closedAt: '2026-10-29T08:00:00.000Z', closedBy: REVIEWER })])
    renderApp('/suggestions/7')

    expect(await screen.findByText(/This suggestion is closed/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Add a comment')).not.toBeInTheDocument()
  })

  it('treats another user’s suggestion as not found', async () => {
    suggestionsApi(ACCOUNTANT, [suggestion({ submittedBy: { id: '99', fullName: 'Someone Else' } })])
    renderApp('/suggestions/7')

    expect(await screen.findByText(/does not exist, or it was submitted by someone else/)).toBeInTheDocument()
  })
})

describe('Suggestions Review', () => {
  it('is offered to Admin only', async () => {
    suggestionsApi({ ...ACCOUNTANT, permissions: [...ACCOUNTANT.permissions, 'USERS:VIEW'] })
    renderApp('/admin/suggestions')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Suggestions Review' })).not.toBeInTheDocument()
  })

  it('lists every suggestion with counts and filters', async () => {
    const api = suggestionsApi(ADMIN, [suggestion(), suggestion({ id: '8', reference: 'SUG-00008', subject: 'Show contract number', status: 'CLOSED' })])
    renderApp('/admin/suggestions')

    expect(await screen.findByRole('link', { name: 'Suggestions Review' })).toHaveAttribute('href', '/admin/suggestions')
    const table = await screen.findByRole('table')
    expect(within(table).getAllByText('Arun Accountant', { selector: 'td' })).toHaveLength(1)
    expect(within(table).queryByText('Show contract number')).not.toBeInTheDocument()
    expect(api.requests.find((request) => request.path === '/suggestions/review')?.query.get('view')).toBe('OPEN')

    await userEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'All' }))
    expect(await within(screen.getByRole('table')).findByText('Show contract number')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByText('Arun Accountant', { selector: 'td' })).toHaveLength(2)

    await userEvent.click(within(screen.getByLabelText('Suggestions by status')).getByRole('button', { name: /Closed/ }))
    await waitFor(() => expect(api.requests.some((request) => request.path === '/suggestions/review' && request.query.get('status') === 'CLOSED')).toBe(true))
    await waitFor(() => expect(within(screen.getByRole('table')).queryByText('Export button is slow')).not.toBeInTheDocument())

    await userEvent.selectOptions(screen.getByLabelText('Assigned to'), 'none')
    await waitFor(() => expect(api.requests.some((request) => request.query.get('assignedTo') === 'none')).toBe(true))
  })

  it('reviews, responds, assigns, resolves and closes a suggestion', async () => {
    const api = suggestionsApi(ADMIN, [suggestion()])
    renderApp('/suggestions/7')

    await userEvent.click(await screen.findByRole('button', { name: 'Mark Under Review' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Mark Under Review' }).at(-1)!)
    await waitFor(() => expect(api.find('PATCH', '/suggestions/7/status')[0]?.body).toEqual({ status: 'UNDER_REVIEW', fromStatus: 'SUBMITTED', note: '' }))

    await userEvent.selectOptions(await screen.findByLabelText('Assigned to'), '9')
    await waitFor(() => expect(api.find('PATCH', '/suggestions/7/assignment')[0]?.body).toEqual({ assignedTo: '9' }))

    await userEvent.type(screen.getByLabelText('Add a response or note'), 'Thanks, looking into it.')
    await userEvent.click(screen.getByRole('button', { name: 'Send Response' }))
    await waitFor(() => expect(api.find('POST', '/suggestions/7/comments')[0]?.body).toEqual({ body: 'Thanks, looking into it.', internal: false }))

    await userEvent.type(screen.getByLabelText('Add a response or note'), 'Root cause in the export queue.')
    await userEvent.click(screen.getByLabelText('Internal note (reviewers only)'))
    await userEvent.click(screen.getByRole('button', { name: 'Add Note' }))
    await waitFor(() => expect(api.find('POST', '/suggestions/7/comments')[1]?.body).toEqual({ body: 'Root cause in the export queue.', internal: true }))
    expect(await screen.findByText('Internal — not shown to the submitter')).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Resolve' }).at(-1)!)
    expect(await screen.findByText('Describe how the suggestion was resolved.')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^Resolution notes/), 'Export now starts at once.')
    await userEvent.click(screen.getAllByRole('button', { name: 'Resolve' }).at(-1)!)
    await waitFor(() => expect(api.find('PATCH', '/suggestions/7/status')[1]?.body).toEqual({ status: 'RESOLVED', fromStatus: 'UNDER_REVIEW', note: 'Export now starts at once.' }))
    expect(await screen.findByRole('heading', { name: 'Resolution' })).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    await waitFor(() => expect(api.find('PATCH', '/suggestions/7/status')[2]?.body).toEqual({ status: 'CLOSED', fromStatus: 'RESOLVED', note: '' }))
    expect(api.records.get('7')?.status).toBe('CLOSED')
  })

  it('opens the All tab from a link with view=all', async () => {
    const api = suggestionsApi(ADMIN, [suggestion({ status: 'RESOLVED' })])
    renderApp('/admin/suggestions?view=all')

    const table = await screen.findByRole('table')
    expect(within(table).getByText('Resolved')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(api.requests.find((request) => request.path === '/suggestions/review')?.query.get('view')).toBe('ALL')
  })

  it('confirms a resolve, and leads to the All tab where the suggestion still shows and opens', async () => {
    const api = suggestionsApi(ADMIN, [suggestion({ status: 'IN_PROGRESS' })])
    renderApp('/admin/suggestions')

    // Open tab: listed while In Progress.
    await userEvent.click(within(await screen.findByRole('table')).getByRole('link', { name: 'SUG-00007' }))
    expect(await screen.findByRole('heading', { name: 'SUG-00007 · Export button is slow' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Suggestions Review' }).every((link) => link.getAttribute('href') === '/admin/suggestions')).toBe(true)

    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }))
    await userEvent.type(screen.getByLabelText(/^Resolution notes/), 'Export now starts at once.')
    await userEvent.click(screen.getAllByRole('button', { name: 'Resolve' }).at(-1)!)

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('SUG-00007 is now Resolved.')
    expect(notice).toHaveTextContent('stays listed under All')
    expect(within(notice).getByRole('link', { name: 'View in All suggestions' })).toHaveAttribute('href', '/admin/suggestions?view=all')
    const bannerLinks = screen.getAllByRole('link', { name: 'Suggestions Review' })
    expect(bannerLinks.some((link) => link.getAttribute('href') === '/admin/suggestions?view=all')).toBe(true)

    await userEvent.click(within(notice).getByRole('link', { name: 'View in All suggestions' }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Resolved')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByLabelText('Suggestions by status')).getByRole('button', { name: /Resolved/ })).toHaveTextContent('1')

    // Still opens, with its resolution, history and the next actions.
    await userEvent.click(within(table).getByRole('link', { name: 'SUG-00007' }))
    expect(await screen.findByRole('heading', { name: 'Resolution' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: /Responses and history/ })).toHaveTextContent('Export now starts at once.')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()

    // The Open tab still leaves it out.
    await userEvent.click(screen.getAllByRole('link', { name: 'Suggestions Review' }).find((link) => link.getAttribute('href') === '/admin/suggestions?view=all')!)
    await userEvent.click(within(await screen.findByRole('group', { name: 'Show' })).getByRole('button', { name: 'Open' }))
    expect(await screen.findByText('No open suggestions')).toBeInTheDocument()
    expect(api.records.get('7')?.status).toBe('RESOLVED')
  })

  it('confirms a close with the same pointer to All', async () => {
    suggestionsApi(ADMIN, [suggestion({ status: 'RESOLVED', resolutionNotes: 'Fixed.', resolvedAt: '2026-10-29T08:00:00.000Z', resolvedBy: REVIEWER })])
    renderApp('/suggestions/7')

    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('SUG-00007 is now Closed.')
    expect(within(notice).getByRole('link', { name: 'View in All suggestions' })).toHaveAttribute('href', '/admin/suggestions?view=all')
  })

  it('confirms other status changes without the All pointer', async () => {
    suggestionsApi(ADMIN, [suggestion()])
    renderApp('/suggestions/7')

    await userEvent.click(await screen.findByRole('button', { name: 'Start Work' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Start Work' }).at(-1)!)

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('SUG-00007 is now In Progress.')
    expect(within(notice).queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Suggestions Review' }).every((link) => link.getAttribute('href') === '/admin/suggestions')).toBe(true)
  })

  it('reports a change made by someone else meanwhile and reloads', async () => {
    const api = suggestionsApi(ADMIN, [suggestion()], (request) =>
      request.method === 'PATCH' && request.path === '/suggestions/7/status'
        ? fail(409, 'CONFLICT', 'This suggestion is now Under Review: it was updated by someone else. Reload it and try again.')
        : undefined,
    )
    renderApp('/suggestions/7')

    await userEvent.click(await screen.findByRole('button', { name: 'Start Work' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Start Work' }).at(-1)!)

    expect(await screen.findByText(/updated by someone else/)).toBeInTheDocument()
    await waitFor(() => expect(api.find('GET', '/suggestions/7').length).toBeGreaterThanOrEqual(2))
  })
})

describe('Suggestions Review people lists', () => {
  it('adds the email only where two people share a name, in the filters and the assignment list', async () => {
    const people = {
      submitters: [
        { id: '21', fullName: 'Ravi Kumar', email: 'ravi@example.com' },
        { id: '22', fullName: 'ravi kumar', email: 'ravi.k@example.com' },
        { id: '23', fullName: 'Arun Accountant', email: 'arun@example.com' },
      ],
      reviewers: [
        { id: '1', fullName: 'Asha Admin', email: 'asha@example.com' },
        { id: '9', fullName: 'Asha Admin', email: 'asha.two@example.com' },
      ],
    }
    suggestionsApi(ADMIN, [suggestion()], (request) => (request.method === 'GET' && request.path === '/suggestions/review/options' ? ok(people) : undefined))
    renderApp('/admin/suggestions')

    const texts = (label: string) => [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((option) => option.textContent)
    await waitFor(() => expect(texts('Submitted by')).toEqual(['Everyone', 'Ravi Kumar (ravi@example.com)', 'ravi kumar (ravi.k@example.com)', 'Arun Accountant']))
    expect(texts('Assigned to')).toEqual(['Anyone', 'Not assigned', 'Asha Admin (asha@example.com)', 'Asha Admin (asha.two@example.com)'])
  })
})
