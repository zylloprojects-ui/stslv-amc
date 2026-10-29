// Suggestions & feedback, as the API returns them (/api/suggestions).

export const STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'] as const
export type SuggestionStatus = (typeof STATUSES)[number]

export const CATEGORIES = ['IMPROVEMENT', 'BUG', 'FEATURE'] as const
export type SuggestionCategory = (typeof CATEGORIES)[number]

export const STATUS_LABELS: Record<SuggestionStatus, string> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under Review',
  IN_PROGRESS: 'In Progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
}

export const CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  IMPROVEMENT: 'Improvement',
  BUG: 'Bug',
  FEATURE: 'Feature',
}

/** The action a reviewer takes to reach a status, as a button label. */
export const STATUS_ACTIONS: Record<SuggestionStatus, string> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Mark Under Review',
  IN_PROGRESS: 'Start Work',
  RESOLVED: 'Resolve',
  CLOSED: 'Close',
  REOPENED: 'Reopen',
}

/** Mirrors the API rule: what a status change must carry. */
export function noteRequirement(from: SuggestionStatus, to: SuggestionStatus): 'resolution' | 'reason' | null {
  if (to === 'RESOLVED') return 'resolution'
  if (to === 'REOPENED') return 'reason'
  if (to === 'CLOSED' && from !== 'RESOLVED') return 'reason'
  return null
}

export interface UserRef {
  id: string
  fullName: string
}

export interface SuggestionSummary {
  id: string
  reference: string
  category: SuggestionCategory
  subject: string
  status: SuggestionStatus
  submittedBy: UserRef
  assignedTo: UserRef | null
  createdAt: string
  updatedAt: string
  statusChangedAt: string
  lastResponseAt: string | null
}

export interface SuggestionEvent {
  id: string
  kind: 'SUBMITTED' | 'STATUS_CHANGED' | 'ASSIGNED' | 'COMMENT'
  actor: UserRef
  bySubmitter: boolean
  fromStatus: SuggestionStatus | null
  toStatus: SuggestionStatus | null
  assignedTo: UserRef | null
  body: string | null
  internal: boolean
  createdAt: string
}

export interface SuggestionDetail extends SuggestionSummary {
  description: string
  pagePath: string | null
  resolutionNotes: string | null
  resolvedAt: string | null
  resolvedBy: UserRef | null
  closedAt: string | null
  closedBy: UserRef | null
  statusChangedBy: UserRef
  events: SuggestionEvent[]
  access: {
    reviewer: boolean
    isSubmitter: boolean
    transitions: SuggestionStatus[]
    canComment: boolean
    canAssign: boolean
  }
}

export interface SuggestionList {
  items: SuggestionSummary[]
  total: number
  page: number
  pageSize: number
}

export interface ReviewList extends SuggestionList {
  counts: Record<SuggestionStatus, number>
}

export interface ReviewOptions {
  submitters: UserRef[]
  reviewers: UserRef[]
}

export const SUGGESTIONS_QUERY_KEY = ['suggestions'] as const
