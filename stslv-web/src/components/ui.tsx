import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { pageMetaFor } from './pageMeta'
import { cx } from '../lib/format'

// Small shared building blocks so every page uses the same controls and spacing.

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-blue-700 text-white hover:bg-blue-800 border-transparent',
  secondary: 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300',
  danger: 'bg-red-600 text-white hover:bg-red-700 border-transparent',
  ghost: 'bg-transparent text-blue-700 hover:bg-blue-50 border-transparent',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  loading?: boolean
}

export function Button({ variant = 'primary', size = 'md', loading = false, disabled, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm',
        BUTTON_STYLES[variant],
        className,
      )}
      {...rest}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {children}
    </button>
  )
}

const INPUT_STYLE =
  'block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 disabled:bg-slate-100 disabled:text-slate-500'

interface FieldShellProps {
  id: string
  label: string
  error?: string | undefined
  hint?: string | undefined
  required?: boolean | undefined
  children: ReactNode
}

function FieldShell({ id, label, error, hint, required, children }: FieldShellProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && (
          <span className="text-red-600" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>
  label: string
  error?: string | undefined
  hint?: string | undefined
}

export function TextField({ label, error, hint, required, className, ...rest }: TextFieldProps) {
  const id = useId()

  return (
    <FieldShell id={id} label={label} error={error} hint={hint} required={required}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(INPUT_STYLE, error ? 'border-red-500' : 'border-slate-300', className)}
        {...rest}
      />
    </FieldShell>
  )
}

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>
  label: string
  error?: string | undefined
  hint?: string | undefined
}

export function TextAreaField({ label, error, hint, required, className, rows = 3, ...rest }: TextAreaFieldProps) {
  const id = useId()

  return (
    <FieldShell id={id} label={label} error={error} hint={hint} required={required}>
      <textarea
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(INPUT_STYLE, error ? 'border-red-500' : 'border-slate-300', className)}
        {...rest}
      />
    </FieldShell>
  )
}

type BadgeTone = 'green' | 'slate' | 'blue' | 'amber'

const BADGE_STYLES: Record<BadgeTone, string> = {
  green: 'bg-green-50 text-green-800 ring-green-600/20',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  blue: 'bg-blue-50 text-blue-800 ring-blue-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
}

export function Badge({ tone = 'slate', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', BADGE_STYLES[tone])}>
      {children}
    </span>
  )
}

export function StatusBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'green' : 'slate'}>{active ? 'Active' : 'Inactive'}</Badge>
}

const LOADER_ICONS: { position: string; color: string; path: ReactNode }[] = [
  {
    // calendar: scheduled visits
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
    // wrench: maintenance
    position: 'right-0 top-1/2 -translate-y-1/2 translate-x-1/2',
    color: '#FF8212',
    path: <path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L20.5 17l-3.5 3.5-5.6-5.6A4 4 0 0 1 6.5 9.5L9 12l3-3-2.5-2.5a4 4 0 0 1 5 0Z" strokeLinejoin="round" />,
  },
  {
    // clipboard with a tick: execution completed
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
    // receipt: invoicing
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

/** Branded loader: the logo with AMC icons (schedule, maintenance, execution, invoice) orbiting it. */
export function BrandLoader({ label = 'Loading', size = 'md', announce = true }: { label?: string; size?: 'sm' | 'md'; announce?: boolean }) {
  const box = size === 'sm' ? 'h-24 w-24' : 'h-36 w-36'
  const core = size === 'sm' ? 'h-12 w-12' : 'h-[4.5rem] w-[4.5rem]'
  const logo = size === 'sm' ? 'h-8 w-8' : 'h-12 w-12'

  return (
    <div role={announce ? 'status' : undefined} className={cx('flex flex-col items-center gap-4 text-sm text-slate-500', size === 'sm' ? 'py-8' : 'py-10')}>
      <div className={cx('relative', box)} aria-hidden="true">
        <span className="absolute inset-0 rounded-full border border-dashed border-sky-300" />
        <span className="login-pulse-ring absolute inset-3 rounded-full border border-sky-300" />
        <div className="login-orbit absolute inset-0">
          {LOADER_ICONS.map((icon) => (
            <span key={icon.color} className={cx('absolute', icon.position)}>
              <span className="login-orbit-counter flex h-7 w-7 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-slate-100" style={{ color: icon.color }}>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
                  {icon.path}
                </svg>
              </span>
            </span>
          ))}
        </div>
        <span className={cx('absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-lg shadow-sky-200/70 ring-1 ring-sky-100', core)}>
          <img src="/stslv-logo.png" alt="" className={cx('object-contain', logo)} />
        </span>
      </div>
      <span className="font-medium">{label}…</span>
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <BrandLoader label={label} size="sm" />
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-green-200 bg-green-50 text-green-800',
    info: 'border-blue-200 bg-blue-50 text-blue-900',
  }[tone]

  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-md border px-4 py-3 text-sm', styles)}>
      {children}
    </div>
  )
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Page banner: icon tile, title and subtitle for the active page, with optional actions on the right. */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  const location = useLocation()
  const meta = pageMetaFor(location.pathname)
  const subtitle = description ?? meta.description

  return (
    <div className="login-rise relative mb-6 overflow-hidden rounded-2xl app-banner shadow-lg shadow-sky-900/10">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-7">
        <div className="flex min-w-0 items-center gap-4">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white shadow-lg shadow-black/20"
            style={{ backgroundImage: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.7">
              {meta.icon}
            </svg>
          </span>
          <div className="min-w-0">
            <h1 className="bn-strong truncate text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            {subtitle && <p className="bn-sub mt-0.5 text-sm">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="flex h-1" aria-hidden="true">
        {['#1B8AD3', '#00A6C8', '#5BAF48', '#F5C622', '#FF8212', '#D1428C'].map((color) => (
          <span key={color} className="flex-1" style={{ backgroundColor: color }} />
        ))}
      </div>
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>{children}</div>
}

export function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg' | 'xl'
}

/** Accessible dialog: labelled, closes on Escape, keeps keyboard focus inside, restores focus on close. */
export function Modal({ title, onClose, children, footer, size = 'md' }: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>('input, select, textarea') ?? panel

    first?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) {
        return
      }

      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const firstItem = focusable[0]
      const lastItem = focusable[focusable.length - 1]

      if (!firstItem || !lastItem) {
        return
      }
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [])

  const width = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size]

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center overflow-y-auto p-3 sm:items-center sm:p-6">
      <div className="login-fade fixed inset-0 bg-slate-900/25 backdrop-blur-[3px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'login-pop relative my-auto flex max-h-[94vh] w-full flex-col overflow-hidden rounded-3xl bg-white shadow-[0_30px_80px_-20px_rgba(20,121,189,0.45)] ring-1 ring-sky-100',
          width,
        )}
      >
        <div className="relative shrink-0 overflow-hidden bg-gradient-to-br from-white via-sky-50 to-emerald-50 px-5 pb-4 pt-5 sm:px-6">
          <span className="login-float absolute -right-10 -top-12 h-36 w-36 rounded-full bg-sky-300/40 blur-2xl" aria-hidden="true" />
          <span className="login-float absolute -bottom-14 left-1/3 h-32 w-32 rounded-full bg-emerald-300/40 blur-2xl [animation-delay:-5s]" aria-hidden="true" />
          <div className="relative flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white shadow-lg shadow-sky-200/70 ring-1 ring-sky-100">
              <img src="/stslv-logo.png" alt="" className="h-9 w-9 object-contain" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-lg font-semibold leading-tight text-[#0b3b66]">
                {title}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">STSLEV ERP · Smart Technical Service LLC</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-2 text-slate-400 transition-colors hover:bg-white hover:text-slate-700 hover:shadow"
            >
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="relative mt-4 flex h-1 overflow-hidden rounded-full" aria-hidden="true">
            {['#1B8AD3', '#00A6C8', '#5BAF48', '#F5C622', '#FF8212', '#D1428C'].map((color) => (
              <span key={color} className="flex-1" style={{ backgroundColor: color }} />
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-3 border-t border-slate-100 bg-gradient-to-r from-white to-sky-50/60 px-5 py-3.5 sm:px-6">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

interface ConfirmDialogProps {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  loading?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, message, confirmLabel, danger = false, loading = false, error, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <div>{message}</div>
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  )
}
