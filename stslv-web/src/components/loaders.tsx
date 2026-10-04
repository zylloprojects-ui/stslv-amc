import type { CSSProperties, ReactNode } from 'react'
import { cx } from '../lib/format'
import { useLoaderStyle } from '../lib/loaderStyle'

interface LoaderProps {
  label?: string
  /** lg: whole-page (checking the session). md: the content area of a page. sm: inside a dialog or a card. */
  size?: 'sm' | 'md' | 'lg'
  /** False for a purely visual loader that screen readers should skip. */
  announce?: boolean
}

/** The work the system keeps track of, drawn as small line icons that circle the logo while something loads. */
const ORBIT: { key: string; path: ReactNode }[] = [
  {
    key: 'schedule',
    path: (
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
        <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
      </>
    ),
  },
  {
    key: 'maintenance',
    path: <path d="M14.5 6.2a4 4 0 0 0-5 5L3.8 17a1.7 1.7 0 0 0 2.4 2.4l5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-2.3-.5-.5-2.3 2.3-2.4Z" strokeLinejoin="round" />,
  },
  {
    key: 'contract',
    path: (
      <>
        <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" strokeLinejoin="round" />
        <path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5" strokeLinecap="round" />
      </>
    ),
  },
  {
    key: 'safety',
    path: (
      <>
        <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6l-7-2.5Z" strokeLinejoin="round" />
        <path d="m9 12 2.2 2.2L15.2 10" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    key: 'project',
    path: (
      <>
        <rect x="3.5" y="7" width="17" height="12.5" rx="2.5" />
        <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17" strokeLinecap="round" />
      </>
    ),
  },
  {
    key: 'invoice',
    path: (
      <>
        <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" strokeLinejoin="round" />
        <path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" />
      </>
    ),
  },
]

// Sizes in pixels: the whole loader, the ring that holds the logo, the radius of the icon orbit and the icon badge.
const SIZES = {
  lg: { box: 300, ring: 150, radius: 126, badge: 46, glyph: 23, logo: 104 },
  md: { box: 232, ring: 116, radius: 98, badge: 40, glyph: 20, logo: 80 },
  sm: { box: 164, ring: 82, radius: 69, badge: 30, glyph: 16, logo: 56 },
} as const

function Bar() {
  return (
    <span className="relative h-2 w-44 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
      <span className="loader-bar absolute inset-y-0 w-1/2 rounded-full bg-gradient-to-r from-[#4aa3df] via-[#1479BD] to-[#4aa3df]" />
    </span>
  )
}

/**
 * The default style ("Logo ring"). No frame or box: the real logo sits in a turning gradient ring, and the icons of the
 * work the system tracks (schedule, maintenance, contracts, safety, projects, invoices) circle around it.
 * The icons stay upright while they travel. Everything stops for people who ask for reduced motion.
 */
function Brand({ label, size, announce }: Required<LoaderProps>) {
  const s = SIZES[size]
  const inset = (s.box - s.ring) / 2

  return (
    <div
      role={announce ? 'status' : undefined}
      className={cx('loader-delay flex flex-col items-center text-sm text-slate-600', size === 'lg' ? 'gap-5 py-8' : size === 'md' ? 'gap-4 py-10' : 'gap-3 py-6')}
    >
      <div className="relative" style={{ width: s.box, height: s.box }} aria-hidden="true">
        <span className="loader-glow absolute rounded-full bg-sky-400/50 blur-2xl" style={{ inset: inset - 6 }} />
        <span className="login-pulse-ring absolute rounded-full border-2 border-sky-400/70" style={{ inset }} />
        <span className="absolute rounded-full border-2 border-dashed border-sky-300" style={{ inset: s.box / 2 - s.radius }} />

        {/* The orbit turns slowly; each badge turns the other way, so its icon stays upright. */}
        <span className="loader-orbit absolute inset-0">
          {ORBIT.map((item, index) => {
            const angle = (360 / ORBIT.length) * index
            const place: CSSProperties = { transform: `rotate(${angle}deg) translateY(-${s.radius}px)` }
            const upright: CSSProperties = { transform: `rotate(${-angle}deg)` }

            return (
              <span key={item.key} className="absolute left-1/2 top-1/2" style={{ width: 0, height: 0 }}>
                <span className="absolute block" style={{ ...place, left: -s.badge / 2, top: -s.badge / 2, width: s.badge, height: s.badge }}>
                  <span className="block h-full w-full" style={upright}>
                    <span className="loader-orbit-counter flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-[#1b8ad3] to-[#0b3b66] text-white shadow-lg shadow-sky-900/30 ring-2 ring-white">
                      <svg viewBox="0 0 24 24" width={s.glyph} height={s.glyph} fill="none" stroke="currentColor" strokeWidth="1.8">
                        {item.path}
                      </svg>
                    </span>
                  </span>
                </span>
              </span>
            )
          })}
        </span>

        <span className="absolute" style={{ inset }}>
          <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
            <defs>
              <linearGradient id={`loader-ring-${size}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#1B8AD3" />
                <stop offset="35%" stopColor="#5BAF48" />
                <stop offset="65%" stopColor="#F5C622" />
                <stop offset="100%" stopColor="#D1428C" />
              </linearGradient>
            </defs>
            <circle cx="50" cy="50" r="46" fill="none" stroke="#CBD5E1" strokeWidth="4" />
            <circle
              className="loader-arc"
              cx="50"
              cy="50"
              r="46"
              fill="none"
              stroke={`url(#loader-ring-${size})`}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray="90 200"
            />
          </svg>
          <span className="absolute inset-[7%] flex items-center justify-center rounded-full bg-white shadow-xl shadow-sky-300/90 ring-1 ring-sky-100">
            <img src="/stslv-logo.png" alt="" className="loader-breathe object-contain" style={{ width: s.logo, height: s.logo }} />
          </span>
        </span>
      </div>

      {size === 'lg' && (
        <div className="text-center leading-tight">
          <p className="text-xl font-bold tracking-wide text-[#0b3b66]">STSLEV AMC</p>
          <p className="mt-0.5 text-xs text-slate-500">Smart Technical Service LLC</p>
        </div>
      )}
      <span className="loader-shimmer-text text-sm font-bold uppercase tracking-[0.3em]">{label}…</span>
      {size !== 'sm' && <Bar />}
    </div>
  )
}

// The other styles a person can pick in the header menu. They have two sizes; a whole-page loader uses the larger.
type StyleProps = { label: string; size: 'sm' | 'md'; announce: boolean }

const PETAL_COLORS = ['#F5C622', '#EFA33A', '#FF8212', '#D1428C', '#7E6FAC', '#1B8AD3', '#00A6C8', '#5BAF48']

function Shell({ announce, size, children }: { announce: boolean; size: 'sm' | 'md'; children: ReactNode }) {
  return (
    <div role={announce ? 'status' : undefined} className={cx('flex flex-col items-center gap-3 text-sm text-slate-600', size === 'sm' ? 'py-8' : 'py-5')}>
      {children}
    </div>
  )
}

/** The logo's own pinwheel: eight coloured petals that light up in turn while the mark turns. */
function Pinwheel({ label, size, announce }: StyleProps) {
  return (
    <Shell announce={announce} size={size}>
      <div className={cx('relative', size === 'sm' ? 'h-16 w-16' : 'h-24 w-24')} aria-hidden="true">
        <span className="login-pulse-ring absolute inset-3 rounded-full bg-sky-300/25" />
        <svg viewBox="-120 -120 240 240" className="loader-turn absolute inset-0 h-full w-full overflow-visible">
          {PETAL_COLORS.map((color, i) => (
            <g key={color} transform={`rotate(${i * 45})`}>
              <polygon className="loader-petal" points="6,-30 58,-104 84,-86 34,-14" fill={color} style={{ animationDelay: `${i * 0.12}s` }} />
            </g>
          ))}
        </svg>
      </div>
      <span className="font-medium tracking-wide">{label}…</span>
      <SlimBar />
    </Shell>
  )
}

function SlimBar() {
  return (
    <span className="relative h-1 w-28 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
      <span className="loader-bar absolute inset-y-0 w-1/2 rounded-full bg-gradient-to-r from-[#1B8AD3] via-[#5BAF48] to-[#F5C622]" />
    </span>
  )
}

/** The logo breathing in the middle, with soft rings spreading outwards. */
function Ripple({ label, size, announce }: StyleProps) {
  const logo = size === 'sm' ? 'h-9 w-9' : 'h-12 w-12'

  return (
    <Shell announce={announce} size={size}>
      <div className={cx('relative flex items-center justify-center', size === 'sm' ? 'h-20 w-20' : 'h-28 w-28')} aria-hidden="true">
        {[0, 1, 2].map((ring) => (
          <span key={ring} className="loader-ripple absolute inset-0 rounded-full border-2 border-[#1B8AD3]/50" style={{ animationDelay: `${ring * 0.7}s` }} />
        ))}
        <span className={cx('loader-breathe relative flex items-center justify-center rounded-full bg-white shadow-lg shadow-sky-200/80 ring-1 ring-sky-100', size === 'sm' ? 'h-14 w-14' : 'h-[4.5rem] w-[4.5rem]')}>
          <img src="/stslv-logo.png" alt="" className={cx('object-contain', logo)} />
        </span>
      </div>
      <span className="loader-shimmer-text font-semibold tracking-wide">{label}…</span>
    </Shell>
  )
}

/** Grey placeholder shapes that mimic the page while it loads. */
function Skeleton({ label, size, announce }: StyleProps) {
  if (size === 'sm') {
    return (
      <div role={announce ? 'status' : undefined} className="w-full space-y-3 py-6">
        <p className="flex items-center gap-2 text-sm font-medium text-slate-600">
          <img src="/stslv-logo.png" alt="" className="h-5 w-5 object-contain" />
          {label}…
        </p>
        <div className="skeleton h-4 w-full rounded" aria-hidden="true" />
        <div className="skeleton h-4 w-5/6 rounded" aria-hidden="true" />
        <div className="skeleton h-4 w-2/3 rounded" aria-hidden="true" />
      </div>
    )
  }

  return (
    <div role={announce ? 'status' : undefined} className="w-full space-y-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-600">
        <img src="/stslv-logo.png" alt="" className="loader-breathe h-6 w-6 object-contain" />
        {label}…
      </p>
      <div className="skeleton h-28 rounded-2xl" aria-hidden="true" />
      <div className="grid gap-4 sm:grid-cols-3" aria-hidden="true">
        {[0, 1, 2].map((card) => (
          <div key={card} className="skeleton h-32 rounded-2xl" style={{ animationDelay: `${card * 0.15}s` }} />
        ))}
      </div>
      <div className="space-y-3" aria-hidden="true">
        <div className="skeleton h-4 w-3/4 rounded" />
        <div className="skeleton h-4 w-1/2 rounded" />
      </div>
    </div>
  )
}

/** A quiet logo with a slim gradient progress bar. */
function Minimal({ label, size, announce }: StyleProps) {
  return (
    <Shell announce={announce} size={size}>
      <img src="/stslv-logo.png" alt="" className={cx('loader-breathe object-contain', size === 'sm' ? 'h-10 w-10' : 'h-16 w-16')} aria-hidden="true" />
      <SlimBar />
      <span className="text-xs font-medium uppercase tracking-[0.25em] text-slate-500">{label}</span>
    </Shell>
  )
}

const ORBIT_ICONS: { position: string; color: string; path: ReactNode }[] = [
  {
    position: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2',
    color: '#1B8AD3',
    path: (
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
        <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
      </>
    ),
  },
  {
    position: 'right-0 top-1/2 -translate-y-1/2 translate-x-1/2',
    color: '#FF8212',
    path: <path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L20.5 17l-3.5 3.5-5.6-5.6A4 4 0 0 1 6.5 9.5L9 12l3-3-2.5-2.5a4 4 0 0 1 5 0Z" strokeLinejoin="round" />,
  },
  {
    position: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2',
    color: '#5BAF48',
    path: (
      <>
        <rect x="5.5" y="4.5" width="13" height="16" rx="2.5" />
        <path d="M9.5 4.5h5v2h-5zM9 13l2.2 2.2L15 11" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    position: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2',
    color: '#D1428C',
    path: (
      <>
        <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" strokeLinejoin="round" />
        <path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" />
      </>
    ),
  },
]

/** The logo with AMC icons (schedule, maintenance, execution, invoice) orbiting it. */
function Orbit({ label, size, announce }: StyleProps) {
  return (
    <Shell announce={announce} size={size}>
      <div className={cx('relative', size === 'sm' ? 'h-24 w-24' : 'h-32 w-32')} aria-hidden="true">
        <span className="absolute inset-0 rounded-full border border-dashed border-sky-300" />
        <div className="login-orbit absolute inset-0">
          {ORBIT_ICONS.map((icon) => (
            <span key={icon.color} className={cx('absolute', icon.position)}>
              <span className="login-orbit-counter flex h-7 w-7 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-slate-100" style={{ color: icon.color }}>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
                  {icon.path}
                </svg>
              </span>
            </span>
          ))}
        </div>
        <span className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-lg ring-1 ring-sky-100">
          <img src="/stslv-logo.png" alt="" className="h-11 w-11 object-contain" />
        </span>
      </div>
      <span className="font-medium">{label}…</span>
    </Shell>
  )
}

/** The branded loader, drawn in whichever style the user picked in the header menu. */
export function BrandLoader({ label = 'Loading', size = 'md', announce = true }: LoaderProps) {
  const [style] = useLoaderStyle()
  const props: StyleProps = { label, size: size === 'sm' ? 'sm' : 'md', announce }

  switch (style) {
    case 'pinwheel':
      return <Pinwheel {...props} />
    case 'ripple':
      return <Ripple {...props} />
    case 'skeleton':
      return <Skeleton {...props} />
    case 'minimal':
      return <Minimal {...props} />
    case 'orbit':
      return <Orbit {...props} />
    default:
      return <Brand label={label} size={size} announce={announce} />
  }
}
