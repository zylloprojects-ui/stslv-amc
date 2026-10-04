import { useState, type ReactNode } from 'react'
import { Modal } from '../components/ui'

const CONSENT_KEY = 'stslev.cookie-consent'

type Choice = 'all' | 'essential'

function stored(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) !== null
  } catch {
    return false
  }
}

const ITEMS: { title: string; text: string; color: string; icon: ReactNode }[] = [
  {
    title: 'Sign-in session',
    text: 'A secure token keeps you signed in while you work. It is removed when you sign out.',
    color: '#1B8AD3',
    icon: (
      <>
        <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
        <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: 'Display preferences',
    text: 'Your theme (light or dark) and whether the sidebar is minimised are remembered in this browser.',
    color: '#5BAF48',
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v2.2M12 18.8V21M4.6 7.5l1.9 1.1M17.5 15.4l1.9 1.1M4.6 16.5l1.9-1.1M17.5 8.6l1.9-1.1" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: 'No tracking',
    text: 'We do not use advertising, analytics or third-party cookies.',
    color: '#FF8212',
    icon: (
      <>
        <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6l-7-2.5Z" strokeLinejoin="round" />
        <path d="m9 12 2.2 2.2L15.2 10" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
]

const PILL_BUTTON =
  'inline-flex items-center justify-center rounded-full px-4 py-1.5 text-sm font-semibold transition-all duration-200'

/**
 * Cookie policy shown after sign-in. It opens as a popup; minimising it leaves a slim bar at the
 * bottom of the page (Settings / Decline / Accept All) until a choice is made.
 */
export function CookieNotice() {
  const [mode, setMode] = useState<'dialog' | 'bar' | 'hidden'>(() => (stored() ? 'hidden' : 'dialog'))

  function choose(choice: Choice) {
    try {
      localStorage.setItem(CONSENT_KEY, choice)
    } catch {
      // Storage may be blocked; the notice then appears again next time.
    }
    setMode('hidden')
  }

  if (mode === 'hidden') {
    return null
  }

  if (mode === 'bar') {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3">
        <div
          role="region"
          aria-label="Cookie notice"
          className="login-pop login-gradient pointer-events-auto rounded-full bg-gradient-to-r from-[#1B8AD3] via-[#5BAF48] to-[#FF8212] p-[2px] shadow-xl shadow-sky-900/20"
        >
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-full bg-white px-4 py-2 sm:px-5">
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-[#FF8212]" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M20.5 12.5A8.5 8.5 0 1 1 11.5 3.5a3.5 3.5 0 0 0 4 4 3.5 3.5 0 0 0 5 5Z" strokeLinejoin="round" />
                <circle cx="9" cy="10" r="1" fill="currentColor" />
                <circle cx="11" cy="15.5" r="1" fill="currentColor" />
                <circle cx="15.5" cy="14" r="1" fill="currentColor" />
              </svg>
              We use cookies
            </span>
            <span className="hidden h-5 w-px bg-slate-200 sm:block" aria-hidden="true" />
            <button type="button" onClick={() => setMode('dialog')} className="flex items-center gap-1.5 rounded-full px-2 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-[#1479BD]">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M4 7h9M17 7h3M4 17h3M11 17h9" strokeLinecap="round" />
                <circle cx="15" cy="7" r="2" />
                <circle cx="9" cy="17" r="2" />
              </svg>
              Settings
            </button>
            <button type="button" onClick={() => choose('essential')} className={`${PILL_BUTTON} border border-slate-300 text-slate-700 hover:bg-slate-50`}>
              Decline
            </button>
            <button
              type="button"
              onClick={() => choose('all')}
              className={`${PILL_BUTTON} bg-gradient-to-r from-[#FF8212] to-[#E9A23B] text-white shadow-md shadow-orange-500/30 hover:-translate-y-0.5 hover:shadow-lg`}
            >
              Accept All
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Modal
      title="Cookie Policy"
      onClose={() => setMode('bar')}
      footer={
        <>
          <button
            type="button"
            onClick={() => setMode('bar')}
            className="mr-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Minimise
          </button>
          <button
            type="button"
            onClick={() => choose('essential')}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => choose('all')}
            className="inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-[#0f5f98] to-[#0b7a96] px-5 py-2 text-sm font-semibold text-white shadow-md shadow-sky-700/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0"
          >
            Accept All
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-600">STSLEV AMC stores a small amount of information in your browser so the application works properly. This is what we keep:</p>

      <ul className="mt-4 space-y-3">
        {ITEMS.map((item) => (
          <li key={item.title} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm" style={{ backgroundColor: item.color }} aria-hidden="true">
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
                {item.icon}
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-900">{item.title}</p>
              <p className="text-xs leading-relaxed text-slate-600">{item.text}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-slate-500">
        All of the above is essential, so Decline and Accept All currently behave the same. Minimise keeps a small bar at the bottom of the page until you choose.
      </p>
    </Modal>
  )
}
