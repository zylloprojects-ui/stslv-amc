import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

const ICONS = {
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  edit: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM14 8l3 3" strokeLinecap="round" strokeLinejoin="round" />,
  stop: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" strokeLinecap="round" />
    </>
  ),
  restore: <path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4" strokeLinecap="round" strokeLinejoin="round" />,
}

export type ActionIconName = keyof typeof ICONS

export function ActionIcon({ name }: { name: ActionIconName }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

const ACTION_BUTTON =
  'inline-flex h-8 w-9 items-center justify-center text-slate-500 transition-colors hover:bg-sky-50 hover:text-[#1479BD] focus-visible:relative focus-visible:z-10'

/** The row actions of a table as one joined group of icon buttons: view, edit, deactivate. */
export function ActionGroup({ children }: { children: ReactNode }) {
  return <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">{children}</div>
}

/** An icon-only button in an ActionGroup. The accessible name is the label; it also shows on hover. */
export function ActionButton({ label, icon, onClick, danger = false }: { label: string; icon: ActionIconName; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={`${ACTION_BUTTON} ${danger ? 'hover:!bg-red-50 hover:!text-red-700' : ''}`}>
      <ActionIcon name={icon} />
    </button>
  )
}

/** An icon-only link in an ActionGroup, for an action that opens a page. */
export function ActionLink({ label, icon, to }: { label: string; icon: ActionIconName; to: string }) {
  return (
    <Link to={to} aria-label={label} title={label} className={ACTION_BUTTON}>
      <ActionIcon name={icon} />
    </Link>
  )
}
