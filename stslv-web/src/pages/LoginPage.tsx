import { zodResolver } from '@hookform/resolvers/zod'
import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation } from 'react-router-dom'
import { z } from 'zod'
import { useAuth } from '../auth/context'
import { Alert, BrandLoader } from '../components/ui'
import { errorMessage } from '../lib/api'

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required.').pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Password is required.'),
})

type LoginForm = z.infer<typeof loginSchema>

// Brand colours taken from the STSLEV logo.
const BRAND = ['#F5C622', '#EFA33A', '#FF8212', '#D1428C', '#7E6FAC', '#1B8AD3', '#00A6C8', '#5BAF48']

const COPYRIGHT_YEAR = new Date().getFullYear()

const HEADINGS = {
  signin: {
    eyebrow: 'Secure sign in',
    title: 'Welcome back',
    text: 'Sign in to STSLEV ERP to manage contracts, projects and invoices.',
  },
  signup: {
    eyebrow: 'New to STSLEV ERP',
    title: 'Get your account',
    text: 'Access is granted by your administrator so every action stays auditable.',
  },
  forgot: {
    eyebrow: 'Account recovery',
    title: 'Forgot your password?',
    text: 'No problem. Here is how to get back in.',
  },
} as const

const SIGNUP_STEPS = [
  { title: 'Ask your administrator', text: 'Share your name, work email and the role you need.' },
  { title: 'Receive your credentials', text: 'The administrator creates your account and assigns permissions.' },
  { title: 'Sign in', text: 'Use the Sign in tab and change your password after first login.' },
]

const WORKFLOW = [
  { title: 'AMC contracts & schedules', text: 'Every visit generated from contract frequency and validity.' },
  { title: 'Projects & procurement', text: 'Job numbers, LPOs, suppliers and quotations in one place.' },
  { title: 'Expenses & invoice tracking', text: 'Every cost and invoice traced to its job or visit.' },
]

const ORBS = [
  { color: BRAND[5], className: '-left-24 -top-24 h-96 w-96', delay: '0s' },
  { color: BRAND[3], className: 'bottom-[-6rem] right-[-4rem] h-[26rem] w-[26rem]', delay: '-5s' },
  { color: BRAND[6], className: 'left-1/3 top-1/2 h-72 w-72', delay: '-9s' },
  { color: BRAND[2], className: 'right-1/4 top-[-4rem] h-56 w-56', delay: '-3s' },
]

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" strokeLinecap="round" />
    </svg>
  )
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="m4 4 16 16" strokeLinecap="round" />}
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
function LoginField({ label, icon, error, trailing, required, ...rest }: FieldProps) {
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

/** The logo with a slow pinwheel of rings behind it. */
function LogoMark() {
  return (
    <div className="relative flex h-32 w-32 shrink-0 items-center justify-center">
      <span className="login-pulse-ring absolute inset-4 rounded-full border border-white/40" aria-hidden="true" />
      <span className="login-pulse-ring absolute inset-4 rounded-full border border-white/30 [animation-delay:1.6s]" aria-hidden="true" />
      <svg viewBox="0 0 200 200" className="login-spin-slow absolute inset-0 h-full w-full" aria-hidden="true">
        <circle cx="100" cy="100" r="96" fill="none" stroke="white" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 8" />
        {BRAND.map((color, i) => (
          <circle key={color} cx={100 + 96 * Math.cos((i * Math.PI) / 4)} cy={100 + 96 * Math.sin((i * Math.PI) / 4)} r="4" fill={color} />
        ))}
      </svg>
      <svg viewBox="0 0 200 200" className="login-spin-reverse absolute inset-3 h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)]" aria-hidden="true">
        <circle cx="100" cy="100" r="92" fill="none" stroke="white" strokeOpacity="0.2" strokeWidth="1" />
      </svg>
      <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-white ring-1 ring-sky-100 shadow-[0_16px_40px_rgba(27,138,211,0.25)]">
        <img src="/stslv-logo.png" alt="" className="h-14 w-14 object-contain" />
      </div>
    </div>
  )
}

/** Animated AMC → Execution → Invoice pipeline. */
function FlowDiagram() {
  const steps = ['Contract', 'Schedule', 'Execution', 'Invoice']

  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-1.5">
          <span
            className="login-rise rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[11px] font-medium tracking-wide text-white/90 backdrop-blur"
            style={{ animationDelay: `${1.1 + i * 0.18}s` }}
          >
            {step}
          </span>
          {i < steps.length - 1 && (
            <svg width="22" height="6" viewBox="0 0 22 6" className="text-sky-300/70">
              <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" className="login-flow" />
            </svg>
          )}
        </div>
      ))}
    </div>
  )
}

export function LoginPage() {
  const auth = useAuth()
  const location = useLocation()
  const [failure, setFailure] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const [reveal, setReveal] = useState(false)
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>('signin')
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })

  if (auth.status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from

    return <Navigate to={from && from !== '/login' ? from : '/dashboard'} replace />
  }

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null)

    try {
      await auth.login(values.email, values.password)
    } catch (error) {
      setFailure(errorMessage(error))
      setAttempts((count) => count + 1)
    }
  })

  return (
    <div className="grid h-dvh overflow-hidden bg-slate-950 lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden overflow-hidden bg-gradient-to-br from-[#06182c] via-[#0a2e52] to-[#07203a] lg:block">
        <div
          className="login-grid absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: 'linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
          aria-hidden="true"
        />
        {ORBS.map((orb) => (
          <span
            key={orb.className}
            className={`login-float absolute rounded-full opacity-30 blur-3xl ${orb.className}`}
            style={{ backgroundColor: orb.color, animationDelay: orb.delay }}
            aria-hidden="true"
          />
        ))}

        <div className="relative flex h-full flex-col justify-between p-10 xl:p-12">
          <div className="login-rise flex items-center gap-5">
            <LogoMark />
            <div className="login-slide-in border-l-2 border-sky-400/40 pl-5 [animation-delay:0.3s]">
              <p className="text-2xl font-bold leading-tight tracking-tight text-white xl:text-[1.7rem]">
                Smart Technical
                <span className="block bg-gradient-to-r from-[#4DB8FF] to-[#7ED36B] bg-clip-text text-transparent">Service LLC</span>
              </p>
              <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.28em] text-sky-200/70">STSLEV ERP · Operations Suite</p>
            </div>
          </div>

          <div>
            <h2 className="login-rise text-3xl font-semibold leading-tight tracking-tight text-white [animation-delay:0.35s] xl:text-4xl">
              One connected workflow
              <span className="login-gradient mt-1 block bg-gradient-to-r from-[#4DB8FF] via-[#2DD4D4] to-[#7ED36B] bg-clip-text text-transparent">
                for every contract and job.
              </span>
            </h2>
            <p className="login-rise mt-3 max-w-lg text-sm text-sky-100/75 [animation-delay:0.5s] xl:text-base [@media(max-height:620px)]:hidden">
              Enter information once. Keep AMC visits, projects, procurement, expenses and invoices traceable from start to finish.
            </p>

            <ul className="mt-6 space-y-3 [@media(max-height:800px)]:hidden">
              {WORKFLOW.map((item, i) => (
                <li key={item.title} className="login-slide-in flex items-start gap-4" style={{ animationDelay: `${0.7 + i * 0.15}s` }}>
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white shadow-md"
                    style={{ backgroundColor: [BRAND[5], BRAND[6], BRAND[7]][i] }}
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">{item.title}</p>
                    <p className="text-sm text-sky-100/65">{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-3">
            <FlowDiagram />
            <p className="text-xs text-sky-200/50">© {COPYRIGHT_YEAR} Smart Technical Service LLC. All rights reserved.</p>
          </div>
        </div>
      </section>

      {/* Sign-in panel */}
      <main className="relative flex items-center justify-center overflow-hidden bg-gradient-to-br from-slate-100 via-sky-50 to-slate-200 px-5 py-3 sm:px-10">
        <span className="login-float absolute -right-24 -top-24 h-80 w-80 rounded-full bg-sky-400/25 blur-3xl" aria-hidden="true" />
        <span className="login-float absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-emerald-400/20 blur-3xl [animation-delay:-7s]" aria-hidden="true" />

        <div className="login-rise relative w-full max-w-md">
          <div className="mb-4 text-center lg:text-left [@media(max-height:640px)]:mb-2">
            <img src="/stslv-logo.png" alt="" className="mx-auto mb-2 h-11 w-11 object-contain lg:hidden [@media(max-height:720px)]:hidden" />
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[#1479BD]">{HEADINGS[mode].eyebrow}</p>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-900">{HEADINGS[mode].title}</h1>
            <p className="mt-1.5 text-sm text-slate-600 [@media(max-height:620px)]:hidden">{HEADINGS[mode].text}</p>
          </div>

          <div className="login-gradient rounded-[1.4rem] bg-gradient-to-br from-[#1B8AD3] via-[#5BAF48] to-[#F5C622] p-[1.5px] shadow-[0_30px_80px_-24px_rgba(20,121,189,0.55)] transition-shadow duration-300 hover:shadow-[0_34px_90px_-20px_rgba(20,121,189,0.7)]">
          <div className="relative overflow-hidden rounded-[calc(1.4rem-1.5px)] bg-white/95 p-6 backdrop-blur [@media(max-height:640px)]:p-4">
            <span className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-sky-200/50 blur-2xl" aria-hidden="true" />
            <span className="pointer-events-none absolute -bottom-12 -left-10 h-32 w-32 rounded-full bg-emerald-200/40 blur-2xl" aria-hidden="true" />

            <div role="tablist" aria-label="Account" className={`relative mb-4 grid grid-cols-2 rounded-xl bg-slate-100/90 p-1 ring-1 ring-slate-200 ${mode === 'forgot' ? 'hidden' : ''}`}>
              <span
                className={`absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-lg bg-gradient-to-r from-[#0f5f98] to-[#0b7a96] shadow-md shadow-sky-700/30 transition-transform duration-300 ease-out ${
                  mode === 'signup' ? 'translate-x-full' : ''
                }`}
                aria-hidden="true"
              />
              {(['signin', 'signup'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={mode === tab}
                  onClick={() => setMode(tab)}
                  className={`relative rounded-lg py-2 text-sm font-semibold transition-colors duration-200 ${
                    mode === tab ? 'text-white' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {tab === 'signin' ? 'Sign in' : 'Sign up'}
                </button>
              ))}
            </div>

            {mode === 'forgot' ? (
              <div key="forgot" className="login-rise space-y-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-[#1479BD]" aria-hidden="true">
                  <LockIcon />
                </span>
                <p className="text-sm text-slate-600">
                  For security, passwords are reset by an administrator. Contact your STSLEV administrator with your work email and ask for a password reset.
                  You will receive a temporary password to sign in with.
                </p>
                <Alert tone="info">Online password reset by email is not available yet.</Alert>
                <button
                  type="button"
                  onClick={() => setMode('signin')}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-[#1479BD] hover:text-[#1479BD]"
                >
                  ← Back to sign in
                </button>
              </div>
            ) : mode === 'signup' ? (
              <div key="signup" className="login-rise space-y-4" role="tabpanel">
                <ol className="space-y-3">
                  {SIGNUP_STEPS.map((step, i) => (
                    <li key={step.title} className="flex items-start gap-3">
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                        style={{ backgroundColor: [BRAND[5], BRAND[6], BRAND[7]][i] }}
                        aria-hidden="true"
                      >
                        {i + 1}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{step.title}</p>
                        <p className="text-sm text-slate-600">{step.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <Alert tone="info">Self-registration is not available. Please contact your STSLEV administrator to request access.</Alert>
                <button
                  type="button"
                  onClick={() => setMode('signin')}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-[#1479BD] hover:text-[#1479BD]"
                >
                  I already have an account
                </button>
              </div>
            ) : auth.status === 'loading' ? (
              <BrandLoader label="Checking your session" size="sm" />
            ) : (
              <form onSubmit={onSubmit} noValidate className="relative space-y-3.5">
                {failure && (
                  <div key={attempts} className="login-shake">
                    <Alert>{failure}</Alert>
                  </div>
                )}

                <LoginField
                  label="Email"
                  type="email"
                  autoComplete="username"
                  placeholder="name@company.com"
                  icon={<MailIcon />}
                  required
                  error={errors.email?.message}
                  {...register('email')}
                />
                <LoginField
                  label="Password"
                  type={reveal ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  icon={<LockIcon />}
                  required
                  error={errors.password?.message}
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
                  {...register('password')}
                />

                <div className="-mt-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setMode('forgot')}
                    className="rounded text-sm font-medium text-[#1479BD] transition-colors hover:text-[#0b3b66] hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  aria-busy={isSubmitting || undefined}
                  className="group relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-[#0f5f98] to-[#0b7a96] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-700/30 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-sky-700/40 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
                >
                  <span className="login-sheen absolute inset-y-0 left-0 w-1/3 bg-white/25" aria-hidden="true" />
                  {isSubmitting && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/80 border-t-transparent" aria-hidden="true" />
                  )}
                  <span className="relative">{isSubmitting ? 'Signing in' : 'Login'}</span>
                </button>
              </form>
            )}
          </div>
          </div>

          <p className="mt-3 text-center text-xs text-slate-500 [@media(max-height:560px)]:hidden">
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" aria-hidden="true" />
            Accounts are created by an administrator.
          </p>
        </div>
      </main>
    </div>
  )
}
