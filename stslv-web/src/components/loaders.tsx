import type { ReactNode } from 'react'
import { useLoaderStyle } from '../lib/loaderStyle'
import { cx } from '../lib/format'

interface LoaderProps {
  label?: string
  size?: 'sm' | 'md'
  /** False for a purely visual loader that screen readers should skip. */
  announce?: boolean
}

const PETAL_COLORS = ['#F5C622', '#EFA33A', '#FF8212', '#D1428C', '#7E6FAC', '#1B8AD3', '#00A6C8', '#5BAF48']

function Shell({ announce, size, children }: { announce: boolean; size: 'sm' | 'md'; children: ReactNode }) {
  return (
    <div role={announce ? 'status' : undefined} className={cx('flex flex-col items-center gap-3 text-sm text-slate-600', size === 'sm' ? 'py-8' : 'py-5')}>
      {children}
    </div>
  )
}

/** The real logo, large, inside a spinning gradient ring, with the company name and a progress bar. */
function Brand({ label, size, announce }: Required<LoaderProps>) {
  const small = size === 'sm'

  return (
    <Shell announce={announce} size={size}>
      <div className={cx('relative', small ? 'h-20 w-20' : 'h-32 w-32')} aria-hidden="true">
        <span className="loader-glow absolute inset-2 rounded-full bg-sky-300/40 blur-xl" />
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
          <defs>
            <linearGradient id="loader-ring-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#1B8AD3" />
              <stop offset="35%" stopColor="#5BAF48" />
              <stop offset="65%" stopColor="#F5C622" />
              <stop offset="100%" stopColor="#D1428C" />
            </linearGradient>
          </defs>
          <circle cx="50" cy="50" r="46" fill="none" stroke="#E2E8F0" strokeWidth="3" />
          <circle
            className="loader-arc"
            cx="50"
            cy="50"
            r="46"
            fill="none"
            stroke="url(#loader-ring-gradient)"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray="90 200"
          />
        </svg>
        <span className="absolute inset-[9px] flex items-center justify-center rounded-full bg-white shadow-lg shadow-sky-200/80">
          <img src="/stslv-logo.png" alt="" className={cx('loader-breathe object-contain', small ? 'h-10 w-10' : 'h-[4.5rem] w-[4.5rem]')} />
        </span>
      </div>
      {!small && <span className="text-base font-semibold tracking-wide text-[#0b3b66]">Smart Technical Service LLC</span>}
      <span className="loader-shimmer-text text-xs font-semibold uppercase tracking-[0.25em]">{label}…</span>
      <Bar />
    </Shell>
  )
}

/** The logo's own pinwheel: eight coloured petals that light up in turn while the mark turns. */
function Pinwheel({ label, size, announce }: Required<LoaderProps>) {
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
      <Bar />
    </Shell>
  )
}

function Bar() {
  return (
    <span className="relative h-1 w-28 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
      <span className="loader-bar absolute inset-y-0 w-1/2 rounded-full bg-gradient-to-r from-[#1B8AD3] via-[#5BAF48] to-[#F5C622]" />
    </span>
  )
}

/** The logo breathing in the middle, with soft rings spreading outwards. */
function Ripple({ label, size, announce }: Required<LoaderProps>) {
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
function Skeleton({ label, size, announce }: Required<LoaderProps>) {
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
function Minimal({ label, size, announce }: Required<LoaderProps>) {
  return (
    <Shell announce={announce} size={size}>
      <img src="/stslv-logo.png" alt="" className={cx('loader-breathe object-contain', size === 'sm' ? 'h-10 w-10' : 'h-16 w-16')} aria-hidden="true" />
      <Bar />
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
function Orbit({ label, size, announce }: Required<LoaderProps>) {
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
  const props = { label, size, announce }

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
      return <Brand {...props} />
  }
}
