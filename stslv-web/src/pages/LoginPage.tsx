import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { useAuth } from '../auth/context'
import { usePageTitle } from '../components/hooks'
import { Alert, Spinner } from '../components/ui'
import { errorMessage } from '../lib/api'
import { AuthSubmitButton, LoginField, MailIcon, PasswordField } from './auth/authUi'

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
    text: 'Sign in to STSLEV AMC to manage contracts, projects and invoices.',
  },
  signup: {
    eyebrow: 'New to STSLEV AMC',
    title: 'Get your account',
    text: 'Access is granted by your administrator so every action stays auditable.',
  },
  forgot: {
    eyebrow: 'Account recovery',
    title: 'Forgot your password?',
    text: 'No problem. Here is how to get back in.',
  },
  reset: {
    eyebrow: 'Account recovery',
    title: 'Choose a new password',
    text: 'Set a new password for your STSLEV AMC account.',
  },
} as const

type AuthMode = keyof typeof HEADINGS

// Each mode has its own address, so it can be linked to, bookmarked and reached with Back.
const MODE_PATHS: Record<AuthMode, string> = {
  signin: '/login',
  signup: '/signup',
  forgot: '/forgot-password',
  reset: '/reset-password',
}

function modeOf(pathname: string): AuthMode {
  return (Object.keys(MODE_PATHS) as AuthMode[]).find((mode) => MODE_PATHS[mode] === pathname) ?? 'signin'
}

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

/**
 * The frame shared by the sign in, sign up and password recovery pages: the brand
 * panel, the heading, the card and its Sign in / Sign up tabs. The page for the
 * current address is shown inside the card.
 */
export function AuthLayout() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const mode = modeOf(location.pathname)

  // A reset link must still work for someone who is signed in on this browser.
  if (auth.status === 'authenticated' && mode !== 'reset') {
    const from = (location.state as { from?: string } | null)?.from

    return <Navigate to={from && from !== '/login' ? from : '/dashboard'} replace />
  }

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
              <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.28em] text-sky-200/70">STSLEV AMC · Operations Suite</p>
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
      <main className="relative overflow-hidden bg-gradient-to-br from-slate-100 via-sky-50 to-slate-200">
        <span className="login-float absolute -right-24 -top-24 h-80 w-80 rounded-full bg-sky-400/25 blur-3xl" aria-hidden="true" />
        <span className="login-float absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-emerald-400/20 blur-3xl [animation-delay:-7s]" aria-hidden="true" />

        {/* Centred while it fits; scrolls when a form is taller than the screen ("safe" keeps the top reachable). */}
        <div className="relative flex h-full items-center-safe justify-center overflow-y-auto px-5 py-3 sm:px-10">
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

            <div role="tablist" aria-label="Account" className={`relative mb-4 grid grid-cols-2 rounded-xl bg-slate-100/90 p-1 ring-1 ring-slate-200 ${mode === 'forgot' || mode === 'reset' ? 'hidden' : ''}`}>
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
                  onClick={() => navigate(MODE_PATHS[tab], { state: location.state })}
                  className={`relative rounded-lg py-2 text-sm font-semibold transition-colors duration-200 ${
                    mode === tab ? 'text-white' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {tab === 'signin' ? 'Sign in' : 'Sign up'}
                </button>
              ))}
            </div>

            <Outlet />
          </div>
          </div>

          <p className="mt-3 text-center text-xs text-slate-500 [@media(max-height:560px)]:hidden">
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" aria-hidden="true" />
            Every account is approved by an administrator.
          </p>
        </div>
        </div>
      </main>
    </div>
  )
}

export function LoginPage() {
  const auth = useAuth()
  const [failure, setFailure] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })

  usePageTitle('Sign in')

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null)

    try {
      await auth.login(values.email, values.password)
    } catch (error) {
      setFailure(errorMessage(error))
      setAttempts((count) => count + 1)
    }
  })

  if (auth.status === 'loading') {
    return <Spinner label="Checking your session" />
  }

  return (
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
        autoFocus
        required
        error={errors.email?.message}
        {...register('email')}
      />
      <PasswordField
        label="Password"
        autoComplete="current-password"
        placeholder="Enter your password"
        required
        error={errors.password?.message}
        {...register('password')}
      />

      <div className="-mt-1 flex justify-end">
        <Link
          to="/forgot-password"
          className="rounded text-sm font-medium text-[#1479BD] transition-colors hover:text-[#0b3b66] hover:underline"
        >
          Forgot password?
        </Link>
      </div>

      <AuthSubmitButton busy={isSubmitting}>{isSubmitting ? 'Signing in' : 'Login'}</AuthSubmitButton>
    </form>
  )
}
