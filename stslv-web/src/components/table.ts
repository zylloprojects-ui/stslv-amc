/** Shared table styling. Put the table inside <TableScroll> so a wide table scrolls within its card. */
export const TABLE = {
  wrapper: 'overflow-x-auto',
  table: 'min-w-full divide-y divide-slate-200 text-sm',
  th: 'whitespace-nowrap bg-slate-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600',
  td: 'px-4 py-3 align-middle text-slate-700',
  row: 'hover:bg-slate-50',
  /** For a cell holding a name or other free text: wraps long values instead of pushing the other columns off screen. */
  text: 'min-w-40 max-w-56 break-words sm:max-w-xs',
  /** For a cell holding an email address or reference with no spaces to wrap at. Short values stay on one line. */
  unbroken: 'min-w-44 max-w-64 break-all',
}
