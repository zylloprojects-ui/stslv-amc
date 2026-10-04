// The dashboard uses one family of blues from the STSLEV logo, so colour is never mistaken for meaning.
// Only status (amber for attention, green for live, red for a failure) is coloured differently.
export const ACCENTS = ['#1479BD', '#1B8AD3', '#4aa3df', '#2b94d6']

/** The card shared by every dashboard figure: rounded, lifts on hover, rises into place. */
export const DASHBOARD_CARD =
  'surface metric-card login-rise relative overflow-hidden rounded-2xl p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-sky-200/50'

export const DASHBOARD_LABEL = 'text-xs font-semibold uppercase tracking-[0.14em] text-slate-500'
