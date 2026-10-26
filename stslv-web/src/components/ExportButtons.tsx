import { useState } from 'react'
import { download, errorMessage, saveFile } from '../lib/api'
import { Button } from './ui'

const FORMATS = [
  { format: 'xlsx', label: 'Excel' },
  { format: 'pdf', label: 'PDF' },
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
    <div role="group" aria-label={`Export ${what}`} className="flex flex-wrap gap-2">
      {FORMATS.map(({ format, label }) => (
        <Button key={format} variant="secondary" size={size} loading={busy === format} disabled={busy !== null} aria-label={`Export ${what} to ${label}`} onClick={() => void run(format)}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {label}
        </Button>
      ))}
    </div>
  )
}
