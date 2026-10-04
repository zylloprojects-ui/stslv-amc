/** Shared table styling. Put the table inside <TableScroll> so a wide table scrolls within its card. */
export const TABLE = {
  wrapper: 'table-scroll overflow-x-auto',
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
