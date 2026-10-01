import { useEffect, useState } from 'react'
import { BrandLoader } from '../components/ui'

const SHOW_MS = 1600
const FADE_MS = 400

/** Full-screen branded loader shown for a moment when the application opens after sign-in. */
export function SplashLoader() {
  const [phase, setPhase] = useState<'show' | 'fade' | 'gone'>('show')

  useEffect(() => {
    const fade = window.setTimeout(() => setPhase('fade'), SHOW_MS)
    const gone = window.setTimeout(() => setPhase('gone'), SHOW_MS + FADE_MS)

    return () => {
      window.clearTimeout(fade)
      window.clearTimeout(gone)
    }
  }, [])

  if (phase === 'gone') {
    return null
  }

  return (
    <div
      className={`fixed inset-0 z-[200] flex flex-col items-center justify-center bg-gradient-to-br from-white via-sky-50 to-emerald-50 transition-opacity duration-[400ms] ${
        phase === 'fade' ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
      aria-hidden="true"
    >
      <BrandLoader label="Loading STSLEV AMC" announce={false} />
      <div className="mt-2 flex h-1 w-40 overflow-hidden rounded-full">
        {['#1B8AD3', '#00A6C8', '#5BAF48', '#F5C622', '#FF8212', '#D1428C'].map((color) => (
          <span key={color} className="flex-1" style={{ backgroundColor: color }} />
        ))}
      </div>
    </div>
  )
}
