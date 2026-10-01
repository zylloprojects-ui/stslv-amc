import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { Link } from 'react-router-dom'

// The controls shared by the sign in, sign up and password recovery pages, so
// all four look and behave the same. The frame around them is AuthLayout.

export function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" strokeLinecap="round" />
    </svg>
  )
}

export function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="m4 4 16 16" strokeLinecap="round" />}
    </svg>
  )
}

export function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" strokeLinecap="round" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" strokeLinecap="round" />
    </svg>
  )
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>
  label: string
  icon: ReactNode
  error?: string | undefined
  trailing?: ReactNode
}

/** A login input with a leading icon and a focus glow. */
export function LoginField({ label, icon, error, trailing, required, ...rest }: FieldProps) {
  const id = useId()

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
        {required && (
          <span className="text-red-600" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <div className="group relative">
        <span
          className={`pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 transition-colors duration-200 ${
            error ? 'text-red-500' : 'text-slate-400 group-focus-within:text-blue-600'
          }`}
        >
          {icon}
        </span>
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`block w-full rounded-xl border bg-slate-50/70 py-3 pl-11 text-sm text-slate-900 placeholder:text-slate-400 transition-all duration-200 hover:border-slate-400 focus:bg-white focus:shadow-[0_0_0_4px_rgba(37,99,235,0.12)] focus:outline-none ${
            trailing ? 'pr-12' : 'pr-4'
          } ${error ? 'border-red-500 focus:shadow-[0_0_0_4px_rgba(239,68,68,0.12)]' : 'border-slate-300 focus:border-blue-600'}`}
          {...rest}
        />
        {trailing && <span className="absolute inset-y-0 right-0 flex items-center pr-2">{trailing}</span>}
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

/** A password input with the lock icon and a button that shows or hides what was typed. */
export function PasswordField(props: Omit<FieldProps, 'icon' | 'trailing' | 'type'>) {
  const [reveal, setReveal] = useState(false)

  return (
    <LoginField
      type={reveal ? 'text' : 'password'}
      icon={<LockIcon />}
      trailing={
        <button
          type="button"
          onClick={() => setReveal((value) => !value)}
          aria-pressed={reveal}
          aria-label="Show or hide characters"
          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <EyeIcon off={reveal} />
        </button>
      }
      {...props}
    />
  )
}

const PRIMARY_STYLE =
  'group relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-[#0f5f98] to-[#0b7a96] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-700/30 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-sky-700/40 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0'

const SECONDARY_STYLE =
  'block w-full rounded-xl border border-slate-300 px-4 py-3 text-center text-sm font-semibold text-slate-700 transition-colors hover:border-[#1479BD] hover:text-[#1479BD]'

/** The main button of an auth form. While busy it is disabled and shows a spinner. */
export function AuthSubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy} aria-busy={busy || undefined} className={PRIMARY_STYLE}>
      <span className="login-sheen absolute inset-y-0 left-0 w-1/3 bg-white/25" aria-hidden="true" />
      {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/80 border-t-transparent" aria-hidden="true" />}
      <span className="relative">{children}</span>
    </button>
  )
}

/** A link to another auth page that looks like the main button. */
export function AuthPrimaryLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={PRIMARY_STYLE}>
      <span className="login-sheen absolute inset-y-0 left-0 w-1/3 bg-white/25" aria-hidden="true" />
      <span className="relative">{children}</span>
    </Link>
  )
}

/** The quieter, outlined way out of an auth page, usually back to sign in. */
export function AuthSecondaryLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={SECONDARY_STYLE}>
      {children}
    </Link>
  )
}

const NOTICE_TONES = {
  info: 'bg-sky-100 text-[#1479BD]',
  success: 'bg-emerald-100 text-emerald-700',
  warning: 'bg-amber-100 text-amber-700',
}

interface AuthNoticeProps {
  icon: ReactNode
  tone?: keyof typeof NOTICE_TONES
  title?: string
  children: ReactNode
}

/** A round icon with a short explanation: the outcome of a step, or what the page is for. */
export function AuthNotice({ icon, tone = 'info', title, children }: AuthNoticeProps) {
  return (
    <div role={title ? 'status' : undefined} className="space-y-3">
      <span className={`flex h-12 w-12 items-center justify-center rounded-full ${NOTICE_TONES[tone]}`} aria-hidden="true">
        {icon}
      </span>
      {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
      <div className="space-y-2 text-sm text-slate-600">{children}</div>
    </div>
  )
}
