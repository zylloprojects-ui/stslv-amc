import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { cx } from '../lib/format'
import { useDialogBehavior, usePageTitle } from './hooks'
import { BrandLoader } from './loaders'
import { pageMetaFor } from './pageMeta'

// Stripe of the logo's colours, used under page banners and dialog titles.

// Small shared building blocks so every page uses the same controls and spacing.

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-gradient-to-b from-[#1a7fc4] to-[#0f62a3] text-white hover:from-[#1673b3] hover:to-[#0c5590] border-transparent shadow-sm shadow-blue-900/25',
  secondary: 'bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 border-slate-300 shadow-sm',
  danger: 'bg-gradient-to-b from-red-500 to-red-600 text-white hover:from-red-600 hover:to-red-700 border-transparent shadow-sm shadow-red-900/25',
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
        'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-all duration-150 active:translate-y-px',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
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
  'block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-500 disabled:bg-slate-100 disabled:text-slate-500 disabled:shadow-none'

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
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600">
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
        aria-required={required || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(INPUT_STYLE, error ? 'border-red-500' : 'border-slate-300', className)}
        {...rest}
      />
    </FieldShell>
  )
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>
  label: string
  error?: string | undefined
  hint?: string | undefined
}

export function SelectField({ label, error, hint, required, className, children, ...rest }: SelectFieldProps) {
  const id = useId()

  return (
    <FieldShell id={id} label={label} error={error} hint={hint} required={required}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(INPUT_STYLE, error ? 'border-red-500' : 'border-slate-300', className)}
        {...rest}
      >
        {children}
      </select>
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
    <span
      className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', BADGE_STYLES[tone])}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden="true" />
      {children}
    </span>
  )
}

export function StatusBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'green' : 'slate'}>{active ? 'Active' : 'Inactive'}</Badge>
}

export { BrandLoader }

/** The loader for part of a page. Pages use the default size; dialogs and small cards pass size="sm". */
export function Spinner({ label = 'Loading', size = 'md' }: { label?: string; size?: 'sm' | 'md' }) {
  return <BrandLoader label={label} size={size} />
}

interface AlertProps {
  tone?: 'error' | 'success' | 'info'
  children: ReactNode
  /** Adds a button that removes the message. Use it for confirmations that would otherwise stay on screen. */
  onDismiss?: (() => void) | undefined
}

export function Alert({ tone = 'error', children, onDismiss }: AlertProps) {
  const styles = {
    error: 'border-red-200 border-l-red-500 bg-red-50 text-red-800',
    success: 'border-green-200 border-l-green-500 bg-green-50 text-green-800',
    info: 'border-blue-200 border-l-blue-500 bg-blue-50 text-blue-900',
  }[tone]

  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-3 rounded-xl border border-l-4 px-4 py-3 text-sm shadow-sm', styles)}>
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="-m-1 shrink-0 rounded p-1 opacity-70 hover:opacity-100">
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  )
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-[#1479BD] ring-1 ring-sky-100" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5v-9Z" strokeLinejoin="round" />
          <path d="M4 7.5 12 11l8-3.5M12 11v9" strokeLinejoin="round" />
        </svg>
      </span>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/**
 * The heading of a page, as a banner: icon tile, title and subtitle, with optional actions on the right.
 * The icon and the default subtitle come from the current address. It also names the browser tab after the page.
 */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  usePageTitle(title)

  const location = useLocation()
  const meta = pageMetaFor(location.pathname)
  const subtitle = description ?? meta.description

  return (
    <div className="login-rise relative mb-6 overflow-hidden rounded-2xl app-banner shadow-lg shadow-sky-900/10">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-7 sm:py-6">
        <div className="flex min-w-0 items-center gap-4">
          <span className="bn-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-xl backdrop-blur sm:h-14 sm:w-14" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-6 w-6 sm:h-7 sm:w-7" fill="none" stroke="currentColor" strokeWidth="1.7">
              {meta.icon}
            </svg>
          </span>
          <div className="min-w-0">
            <h1 className="bn-strong break-words text-xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            {subtitle && <p className="bn-sub mt-0.5 break-words text-sm">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2 max-sm:w-full [&>*]:max-sm:flex-1">{actions}</div>}
      </div>
      <div className="flex h-[3px]" aria-hidden="true">
        <span className="flex-1 bg-gradient-to-r from-white/30 via-white/80 to-white/30" />
      </div>
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('surface overflow-hidden rounded-xl', className)}>{children}</div>
}

/**
 * Wraps a table that may be wider than the screen. The table scrolls sideways inside
 * this region instead of widening the page, and the region can be reached and
 * scrolled with the keyboard.
 */
export function TableScroll({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="region" aria-label={`${label} table`} tabIndex={0} className={cx('table-scroll overflow-x-auto', className)}>
      {children}
    </div>
  )
}

export function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md text-center">{children}</div>
    </main>
  )
}

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg' | 'xl'
}

/**
 * Accessible dialog: labelled, closes on Escape, keeps keyboard focus inside, restores focus on close.
 * The title and the footer buttons stay in view; long content scrolls between them.
 */
export function Modal({ title, onClose, children, footer, size = 'md' }: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useDialogBehavior(panelRef, onClose, 'input, select, textarea')

  const [hasRequired, setHasRequired] = useState(false)

  useEffect(() => {
    setHasRequired(panelRef.current?.querySelector('[aria-required="true"]') != null)
  }, [children, footer])

  const width = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size]

  // Rendered at the end of the page, so a dialog opened from the header is not confined to the header.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-6">
      {/* The backdrop does not close the dialog: a stray click must not discard a half-filled form. */}
      <div className="login-fade fixed inset-0 bg-slate-900/25 backdrop-blur-[3px]" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'login-pop relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white outline-none sm:max-h-full sm:rounded-2xl',
          'shadow-[0_28px_80px_-18px_rgba(8,32,60,0.55)] ring-1 ring-slate-900/10',
          width,
        )}
      >
        {/* Header: light and clean. A logo tile, the title in navy, a quiet brand line, a round close button, and the brand colours along the bottom edge. */}
        <div className="app-modal-header relative shrink-0 px-4 pb-4 pt-4 sm:px-6 sm:pt-5">
          <div className="relative flex items-center gap-3.5">
            <span className="app-modal-logo flex h-12 w-12 shrink-0 items-center justify-center rounded-xl">
              <img src="/stslv-logo.png" alt="" className="h-9 w-9 object-contain" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="app-modal-title break-words text-lg font-bold leading-tight tracking-tight sm:text-xl">
                {title}
              </h2>
              <p className="app-modal-sub mt-0.5 flex items-center gap-1.5 text-xs font-medium">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                <span className="truncate">STSLEV AMC · Smart Technical Service LLC</span>
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="app-modal-x group shrink-0 rounded-full p-2 transition-all">
              <svg viewBox="0 0 20 20" className="h-5 w-5 transition-transform group-hover:rotate-90" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <span className="app-modal-edge absolute inset-x-0 bottom-0 h-[3px]" aria-hidden="true" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-5 sm:px-6 sm:py-6">{children}</div>

        {/* Footer: a white bar with a clear top line. On the left a quiet hint (required fields, or how to close), the actions on the right. */}
        {footer && (
          <div className="app-modal-footer flex shrink-0 flex-col-reverse gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-6">
            <p className="hidden items-center gap-1.5 whitespace-nowrap text-xs text-slate-500 sm:flex" aria-hidden="true">
              {hasRequired ? (
                <>
                  <span className="text-sm font-bold text-red-600">*</span> Required field
                </>
              ) : (
                <>
                  <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 shadow-sm">Esc</kbd> to close
                </>
              )}
            </p>
            <div className="flex flex-col-reverse gap-2.5 sm:min-w-0 sm:flex-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end [&>*]:max-sm:w-full [&_button]:sm:min-w-24">{footer}</div>
          </div>
        )}
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
      <div className="space-y-3 break-words text-sm text-slate-700">
        <div>{message}</div>
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  )
}
