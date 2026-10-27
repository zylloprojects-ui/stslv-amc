import { useEffect, useRef, useState } from 'react'
import { LOADERS, useLoaderStyle } from '../lib/loaderStyle'
import { PALETTES, type PaletteId } from '../lib/preferences'

/** Header button that lets the user pick the colour palette of the sidebar and page banners. */
export function PaletteMenu({ palette, onChoose, dark }: { palette: PaletteId; onChoose: (id: PaletteId) => void; dark: boolean }) {
  const [open, setOpen] = useState(false)
  const [loader, setLoader] = useLoaderStyle()
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Colour theme"
        title="Colour theme and loader"
        className="shrink-0 rounded-full p-2 text-slate-600 transition-colors hover:bg-sky-50"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 2-1.8 0-1.2-1-1.5-1-2.7 0-1 .8-1.7 1.8-1.7H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.9 16.8 3.5 12 3.5Z" strokeLinejoin="round" />
          <circle cx="8" cy="11" r="1" fill="currentColor" />
          <circle cx="11" cy="7.5" r="1" fill="currentColor" />
          <circle cx="15.5" cy="8.5" r="1" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div role="group" aria-label="Colour theme options" className="login-rise absolute right-0 top-full z-50 mt-2 w-64 max-h-[80vh] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl ring-1 ring-black/5">
          <p className="border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Colour theme</p>
          <ul className="p-1.5">
            {PALETTES.map((item) => {
              const selected = item.id === palette

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChoose(item.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sky-50 ${selected ? 'bg-sky-50' : ''}`}
                  >
                    <span
                      className="h-8 w-8 shrink-0 rounded-lg border border-slate-200 shadow-sm"
                      style={{ background: swatch(item.id) }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-slate-900">{item.name}</span>
                      <span className="block text-[11px] text-slate-500">{item.note}</span>
                    </span>
                    {selected && (
                      <svg viewBox="0 0 20 20" className="h-4 w-4 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                        <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="border-y border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Loader style</p>
          <ul className="p-1.5">
            {LOADERS.map((item) => {
              const selected = item.id === loader

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setLoader(item.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sky-50 ${selected ? 'bg-sky-50' : ''}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-slate-900">{item.name}</span>
                      <span className="block text-[11px] text-slate-500">{item.note}</span>
                    </span>
                    {selected && (
                      <svg viewBox="0 0 20 20" className="h-4 w-4 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                        <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
          {dark &&<p className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-[11px] text-slate-500">Dark mode is on, so palettes show when you switch back to light.</p>}
        </div>
      )}
    </div>
  )
}

function swatch(id: PaletteId): string {
  switch (id) {
    case 'ocean':
      return 'linear-gradient(135deg, #06182c, #0b4a7a)'
    case 'sky':
      return 'linear-gradient(135deg, #ffffff, #cfe6f8)'
    case 'mint':
      return 'linear-gradient(135deg, #ffffff, #bfe7cf)'
    case 'sand':
      return 'linear-gradient(135deg, #fffdf8, #f9d9a3)'
    case 'lavender':
      return 'linear-gradient(135deg, #ffffff, #d6cbef)'
  }
}
