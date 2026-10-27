import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

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
} as const

export type ActionIconName = keyof typeof ICONS

export function ActionIcon({ name }: { name: ActionIconName }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

const ACTION_BUTTON =
  'inline-flex h-8 w-9 items-center justify-center text-slate-500 transition-colors hover:bg-sky-50 hover:text-[#1479BD] focus-visible:relative focus-visible:z-10 disabled:cursor-not-allowed disabled:opacity-40'
const DANGER = 'hover:!bg-red-50 hover:!text-red-700'

/** The row actions of a table as one joined group of icon buttons. */
export function ActionGroup({ children }: { children: ReactNode }) {
  return <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">{children}</div>
}

/** An icon-only button in an ActionGroup. The label is its accessible name and its tooltip. */
export function ActionButton({
  label,
  icon,
  onClick,
  danger = false,
  disabled = false,
  hint,
}: {
  label: string
  icon: ActionIconName
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /** Tooltip shown instead of the label, for example why the action is unavailable. */
  hint?: string
}) {
  return (
    <button type="button" aria-label={label} title={hint ?? label} onClick={onClick} disabled={disabled} className={`${ACTION_BUTTON} ${danger ? DANGER : ''}`}>
      <ActionIcon name={icon} />
    </button>
  )
}

/** An icon-only link in an ActionGroup, for an action that opens a page. */
export function ActionLink({ label, icon, to, danger = false }: { label: string; icon: ActionIconName; to: string; danger?: boolean }) {
  return (
    <Link to={to} aria-label={label} title={label} className={`${ACTION_BUTTON} ${danger ? DANGER : ''}`}>
      <ActionIcon name={icon} />
    </Link>
  )
}
