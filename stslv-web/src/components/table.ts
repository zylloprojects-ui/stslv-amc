/** Shared table styling. Put the table inside <TableScroll> so a wide table scrolls within its card. */
export const TABLE = {
  wrapper: 'relative table-scroll overflow-x-auto',
  table: 'min-w-full divide-y divide-slate-100 text-sm',
  th: 'whitespace-nowrap border-b border-slate-200 bg-slate-50/70 px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500',
  td: 'px-4 py-3.5 align-middle text-slate-700',
  row: 'transition-colors duration-150 hover:bg-sky-50',
  /** The serial number column (#): narrow, centred, quiet. */
  snHead: 'w-12 whitespace-nowrap border-b border-slate-200 bg-slate-50/70 px-3 py-3 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-500',
  sn: 'w-12 px-3 py-3.5 text-center align-middle text-xs font-semibold tabular-nums text-slate-400',
  /** For a cell holding a name or other free text: wraps long values instead of pushing the other columns off screen. */
  text: 'min-w-40 max-w-56 break-words sm:max-w-xs',
  /** For a cell holding an email address or reference with no spaces to wrap at. Short values stay on one line. */
  unbroken: 'min-w-44 max-w-80 [overflow-wrap:anywhere]',
}

/** An icon-only row action (see components/IconActions). Touch screens (phones, tablets) get a larger target. */
const ACTION_BUTTON =
  'inline-flex h-7 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-sky-50 hover:text-[#1479BD] focus-visible:relative focus-visible:z-10 disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-9 pointer-coarse:w-9'
/** Destructive actions are red at rest as well as on hover, so they are never mistaken for a harmless one. */
const ACTION_DANGER = '!text-red-600 hover:!bg-red-50 hover:!text-red-700'

/** The classes of an icon row action; also for a link component of its own (for example ContractLink). */
export function actionButtonClass(danger = false) {
  return danger ? `${ACTION_BUTTON} ${ACTION_DANGER}` : ACTION_BUTTON
}
