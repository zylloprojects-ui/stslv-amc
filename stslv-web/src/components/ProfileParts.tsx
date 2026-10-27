import type { ReactNode } from 'react'

// Building blocks of a record's profile card (a client, a sales engineer): a line with an icon tile, a contact tile.

const ICONS = {
  badge: <path d="M5 4.5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM8.5 14.5h7M8.5 10.5h3" strokeLinecap="round" strokeLinejoin="round" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  phone: <path d="M6.5 4h3l1.5 4-2 1.2a11 11 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z" strokeLinejoin="round" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" strokeLinecap="round" />
    </>
  ),
  note: <path d="M6 4h9l3 3v13H6zM9 11h6M9 15h6" strokeLinecap="round" strokeLinejoin="round" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21Z" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  building: <path d="M5 20V5.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V20M15 9.5h3a1 1 0 0 1 1 1V20M3.5 20h17M8.5 8.5h3M8.5 12h3M8.5 15.5h3" strokeLinecap="round" strokeLinejoin="round" />,
  receipt: (
    <>
      <path d="M7 3.5h10a.5.5 0 0 1 .5.5v16.5l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5V4a.5.5 0 0 1 .5-.5Z" strokeLinejoin="round" />
      <path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" />
    </>
  ),
} as const

export type ProfileIconName = keyof typeof ICONS

function IconTile({ icon, tone }: { icon: ProfileIconName; tone: 'soft' | 'white' }) {
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#1479BD] ring-1 ring-inset ring-sky-100 ${tone === 'white' ? 'bg-white shadow-sm' : 'bg-sky-50'}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7">
        {ICONS[icon]}
      </svg>
    </span>
  )
}

/** One line of a profile card: an icon tile, the caption above, the value below. */
export function ProfileLine({ icon, label, children }: { icon: ProfileIconName; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3 py-2.5">
      <IconTile icon={icon} tone="soft" />
      <div className="min-w-0 flex-1">
        <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</dt>
        <dd className="mt-0.5 min-w-0 break-words text-sm font-semibold text-slate-900">{children}</dd>
      </div>
    </div>
  )
}

/** A contact detail as a small tile on its own: an icon, the caption above, the value below (cut with … when long, or wrapped with wrap). */
export function ContactChip({ icon, label, children, wrap = false }: { icon: ProfileIconName; label: string; children: ReactNode; wrap?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5">
      <IconTile icon={icon} tone="white" />
      <div className="min-w-0 flex-1">
        <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</dt>
        <dd className={`mt-0.5 min-w-0 text-sm font-semibold text-slate-900 ${wrap ? 'break-all leading-snug' : 'truncate'}`}>{children}</dd>
      </div>
    </div>
  )
}
