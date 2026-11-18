import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { actionButtonClass } from './table'

// The row actions of a table are icons only. The name of each one is its label: read aloud by screen readers and shown on hover.
const ICONS = {
  view: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  edit: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM14 8l3 3" strokeLinecap="round" strokeLinejoin="round" />,
  deactivate: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" strokeLinecap="round" />
    </>
  ),
  reactivate: <path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4" strokeLinecap="round" strokeLinejoin="round" />,
  delete: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 11v5M13.5 11v5" strokeLinecap="round" strokeLinejoin="round" />,
  void: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 8.5 7 7M15.5 8.5l-7 7" strokeLinecap="round" />
    </>
  ),
  download: <path d="M12 4v10m0 0-4-4m4 4 4-4M5 19h14" strokeLinecap="round" strokeLinejoin="round" />,
  replace: <path d="M12 20V10m0 0-4 4m4-4 4 4M5 5h14" strokeLinecap="round" strokeLinejoin="round" />,
  versions: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="3.5" />
      <path d="m10.5 12.5 8-8M15 8l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  roles: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.2 2.7-5 6-5s6 1.8 6 5M17 8v6M14 11h6" strokeLinecap="round" />
    </>
  ),
  invoice: (
    <>
      <path d="M7 3.5h10a.5.5 0 0 1 .5.5v16.5l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5V4a.5.5 0 0 1 .5-.5Z" strokeLinejoin="round" />
      <path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" />
    </>
  ),
  archive: <path d="M4 5.5h16v4H4zM5.5 9.5V19h13V9.5M10 13h4" strokeLinecap="round" strokeLinejoin="round" />,
  approve: <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />,
  reject: <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />,
  details: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6v.1" strokeLinecap="round" strokeWidth="2" />
    </>
  ),
  restore: (
    <>
      <path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8v4l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  renew: <path d="M19.5 9A8 8 0 0 0 5 7.5M4.5 15A8 8 0 0 0 19 16.5M19.5 4v5h-5M4.5 20v-5h5" strokeLinecap="round" strokeLinejoin="round" />,
  schedule: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="1.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4M9 14.5h2M13 14.5h2" strokeLinecap="round" />
    </>
  ),
  signOut: <path d="M14 4.5H6.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H14M10.5 12H20m0 0-3.5-3.5M20 12l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />,
  devices: (
    <>
      <rect x="3" y="5" width="13" height="9.5" rx="1" />
      <path d="M6.5 18h6M9.5 14.5V18" strokeLinecap="round" />
      <rect x="17" y="9" width="4.5" height="9.5" rx="1" />
    </>
  ),
  save: (
    <>
      <path d="M5 4.5h11.5L19.5 7.5V19a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5Z" strokeLinejoin="round" />
      <path d="M8 4.5v4.5h7V4.5M8 19.5v-5.5h8v5.5" strokeLinejoin="round" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  visitActions: (
    <>
      <path d="M8.5 4.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1h-2.5" strokeLinejoin="round" />
      <path d="M9 3.5h6v2.5H9zM9 13l2.2 2.2L15.5 11" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
} as const

export type ActionIconName = keyof typeof ICONS

export function ActionIcon({ name }: { name: ActionIconName }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

function ActionSpinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] animate-spin" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" strokeLinecap="round" />
    </svg>
  )
}

/** The row actions of a table: loose icon buttons in a row, with no box around them. */
export function ActionGroup({ children }: { children: ReactNode }) {
  return <div className="inline-flex items-center gap-0.5">{children}</div>
}

/** An icon-only button in an ActionGroup. The label is its accessible name; the hint (or else the label) its tooltip,
 *  drawn by ActionTooltipLayer (components/ActionTooltip), never the browser's own small title tooltip. */
export function ActionButton({
  label,
  icon,
  onClick,
  danger = false,
  disabled = false,
  loading = false,
  hint,
}: {
  label: string
  icon: ActionIconName
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /** Shows a spinner in place of the icon and blocks a second click while the action runs. */
  loading?: boolean
  /** Tooltip shown instead of the label: a clearer sentence, or why the action is unavailable. */
  hint?: string
}) {
  const off = disabled || loading
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-busy={loading || undefined}
      data-tooltip={off ? undefined : (hint ?? label)}
      onClick={onClick}
      disabled={off}
      className={actionButtonClass(danger)}
    >
      {loading ? <ActionSpinner /> : <ActionIcon name={icon} />}
    </button>
  )
  // A disabled button receives no pointer events, so its tooltip (often the reason it is disabled) sits on a wrapper.
  return off ? (
    <span className="inline-flex cursor-not-allowed" data-tooltip={hint ?? label}>
      {button}
    </span>
  ) : (
    button
  )
}

/** An icon-only link in an ActionGroup, for an action that opens a page. */
export function ActionLink({ label, icon, to, danger = false, hint }: { label: string; icon: ActionIconName; to: string; danger?: boolean; hint?: string }) {
  return (
    <Link to={to} aria-label={label} data-tooltip={hint ?? label} className={actionButtonClass(danger)}>
      <ActionIcon name={icon} />
    </Link>
  )
}
