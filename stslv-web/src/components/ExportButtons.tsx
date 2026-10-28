import { useState } from 'react'
import { download, errorMessage, saveFile } from '../lib/api'
import { cx } from '../lib/format'

// At rest the buttons look like the controls around them (white, thin border, blue icon); a format shows its own colour when pointed at: green for a spreadsheet, red for a PDF.
const FORMATS = [
  { format: 'xlsx', label: 'Excel', tile: 'group-hover:bg-emerald-600 group-hover:text-white', edge: 'hover:border-emerald-400 focus-visible:ring-emerald-200' },
  { format: 'pdf', label: 'PDF', tile: 'group-hover:bg-rose-600 group-hover:text-white', edge: 'hover:border-rose-400 focus-visible:ring-rose-200' },
] as const

type Format = (typeof FORMATS)[number]['format']

interface ExportButtonsProps {
  /** What is exported, for the names of the buttons: "AMC schedule". */
  what: string
  /** The export address for a format, with the page's current filters. */
  path: (format: Format) => string
  /** The file name used when the API does not give one, without its extension. */
  fileStem: string
  /** Small inside a card, where the buttons sit beside a section heading. */
  size?: 'sm' | 'md'
  onError: (message: string | null) => void
}

/**
 * The export actions of a page: one button per format. The page shows them only
 * to a user who holds the module's EXPORT permission; the API checks it again.
 */
export function ExportButtons({ what, path, fileStem, size = 'md', onError }: ExportButtonsProps) {
  const [busy, setBusy] = useState<Format | null>(null)

  const run = async (format: Format) => {
    setBusy(format)
    onError(null)
    try {
      saveFile(await download(path(format)), `${fileStem}.${format}`)
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div role="group" aria-label={`Export ${what}`} className="flex flex-wrap gap-2.5">
      {FORMATS.map(({ format, label, tile, edge }) => {
        const loading = busy === format

        return (
          <button
            key={format}
            type="button"
            aria-label={`Export ${what} to ${label}`}
            aria-busy={loading || undefined}
            disabled={busy !== null}
            onClick={() => void run(format)}
            className={cx(
              'group inline-flex items-center gap-2.5 rounded-lg border border-slate-300 bg-white font-semibold text-[#0b3b66] shadow-sm transition-all duration-200 hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-4 active:translate-y-0 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-sm',
              size === 'sm' ? 'py-1 pl-1 pr-3.5 text-sm' : 'py-1.5 pl-1.5 pr-4 text-sm',
              edge,
            )}
          >
            <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-[#1479BD] transition-colors duration-200', tile)} aria-hidden="true">
              {loading ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin motion-reduce:animate-none" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4 transition-transform duration-200 group-hover:translate-y-px" fill="none" stroke="currentColor" strokeWidth="1.9">
                  <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            {label}
          </button>
        )
      })}
    </div>
  )
}
