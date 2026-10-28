import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { cx } from '../lib/format'

// The tab section of a record page (a client, a sales engineer, an AMC contract): a deep-blue tab bar, and below it a panel with its
// own header (an icon tile, a title, one line saying what the tab shows, and room for its actions) whose content fades in.
// Review only: ?tabs=side turns the bar into a menu down the left, with the panel on the right.

const ICONS: Record<string, ReactNode> = {
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
    </>
  ),
  contract: (
    <>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" strokeLinejoin="round" />
      <path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5" strokeLinecap="round" />
    </>
  ),
  invoice: (
    <>
      <path d="M7 3.5h10a.5.5 0 0 1 .5.5v16.5l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5V4a.5.5 0 0 1 .5-.5Z" strokeLinejoin="round" />
      <path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" />
    </>
  ),
  renew: <path d="M20 11a8 8 0 0 0-14.3-4.5M4 13a8 8 0 0 0 14.3 4.5M5 3.5v3.5h3.5M19 20.5V17h-3.5" strokeLinecap="round" strokeLinejoin="round" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  folder: <path d="M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" strokeLinejoin="round" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="4" />,
}

/** The icon of a tab, by the id of the tab; a tab not listed here gets a dot. */
const ICON_OF: Record<string, keyof typeof ICONS> = {
  visits: 'calendar',
  schedule: 'calendar',
  work: 'calendar',
  contracts: 'contract',
  invoices: 'invoice',
  renewals: 'renew',
  queue: 'renew',
  history: 'clock',
  documents: 'folder',
  details: 'info',
}

const iconOf = (id: string) => ICONS[ICON_OF[id] ?? 'dot']

// The same deep blue as the sidebar and the page banners, with a fine dotted texture.
const BAR_STYLE = {
  backgroundImage: 'radial-gradient(rgba(255,255,255,0.13) 1px, transparent 1.3px), linear-gradient(120deg, #0a3a66 0%, #0e5a96 55%, #1479bd 100%)',
  backgroundSize: '14px 14px, auto',
}

/** Whether the tabs are shown down the left (?tabs=side), and the class that puts the bar and the panel side by side. */
export function useTabsLayout() {
  const side = useSearchParams()[0].get('tabs') === 'side'

  return { side, wrapper: side ? 'lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start lg:gap-5' : '' }
}

export interface PageTab<T extends string = string> {
  id: T
  label: string
  count?: number | undefined
}

interface PageTabsProps<T extends string> {
  tabs: PageTab<T>[]
  active: T
  onChange: (id: T) => void
  /** The name of the tab list for assistive technology. */
  label: string
  /** Prefix of the ids: each tab is "<prefix>-<id>" and the panel it controls is "<prefix>-panel". */
  idPrefix: string
}

export function PageTabs<T extends string>({ tabs, active, onChange, label, idPrefix }: PageTabsProps<T>) {
  const { side } = useTabsLayout()

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation={side ? 'vertical' : 'horizontal'}
      style={BAR_STYLE}
      className={cx(
        'flex flex-wrap items-center gap-1.5 rounded-t-2xl p-2 shadow-lg shadow-sky-900/20 ring-1 ring-inset ring-white/10',
        side && 'lg:sticky lg:top-20 lg:flex-col lg:rounded-2xl lg:items-stretch lg:gap-1 lg:p-3',
      )}
    >
      {tabs.map((tab) => {
        const on = tab.id === active

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-${tab.id}`}
            aria-selected={on}
            aria-controls={`${idPrefix}-panel`}
            onClick={() => onChange(tab.id)}
            className={cx(
              'group relative flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-bold outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-white/80',
              on ? 'bg-white text-[#0b3b66] shadow-lg shadow-black/25' : 'text-sky-100/90 hover:bg-white/15 hover:text-white',
              side && 'lg:justify-start',
            )}
          >
            <svg
              viewBox="0 0 24 24"
              className={cx('h-[18px] w-[18px] shrink-0 transition-colors', on ? 'text-[#1479BD]' : 'text-sky-200/80 group-hover:text-white')}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              {iconOf(tab.id)}
            </svg>
            <span className="leading-tight">{tab.label}</span>
            {tab.count !== undefined && (
              <span
                className={cx(
                  'rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums transition-colors',
                  side && 'lg:ml-auto',
                  on ? 'bg-gradient-to-br from-[#0e5a96] to-[#2f9bd8] text-white shadow-sm' : 'bg-white/15 text-sky-50 group-hover:bg-white/25',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

interface TabPanelProps {
  idPrefix: string
  /** The id of the open tab. */
  active: string
  title: string
  /** One line saying what the tab shows. */
  description: string
  /** Buttons at the right of the header, such as the exports. */
  actions?: ReactNode
  children: ReactNode
}

/** The panel of the open tab: its header, and its content, which fades in each time another tab is opened. */
export function TabPanel({ idPrefix, active, title, description, actions, children }: TabPanelProps) {
  const { side } = useTabsLayout()

  return (
    <section
      role="tabpanel"
      id={`${idPrefix}-panel`}
      aria-labelledby={`${idPrefix}-${active}`}
      className={cx("relative min-w-0 overflow-hidden border border-slate-200 bg-white shadow-md shadow-sky-900/5 [&_.table-scroll]:rounded-none! [&_.table-scroll]:border-0!", side ? "rounded-2xl" : "rounded-b-2xl border-t-0")}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#0e5a96] to-[#2f9bd8] text-white shadow-md shadow-sky-900/25" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              {iconOf(active)}
            </svg>
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold leading-tight text-[#0b3b66]">{title}</h3>
            <p className="mt-0.5 text-xs text-slate-600">{description}</p>
          </div>
        </div>
        {actions}
      </header>
      <div key={active} className="login-rise">
        {children}
      </div>
    </section>
  )
}
