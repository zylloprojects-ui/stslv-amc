import { useEffect, useState } from 'react'
import { BrandLoader } from '../components/ui'
import { useLoaderPreviews, useLoaderStyle } from '../lib/loaderStyle'

const SHOW_MS = 1600
const FADE_MS = 350

/**
 * Loader shown over the page content (not the sidebar or header) for a moment when the application
 * opens, and again whenever a different loader style is picked so it can be previewed. The content
 * behind it stays faintly visible. Place it inside a relatively positioned container.
 */
export function SplashLoader() {
  // A new key restarts the timers, which replays the loader for each preview request.
  return <Splash key={useLoaderPreviews()} />
}

function Splash() {
  const [style] = useLoaderStyle()
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

  const wide = style === 'skeleton'

  return (
    <div
      className={`absolute inset-0 z-20 flex justify-center bg-white/60 backdrop-blur-[2px] transition-opacity duration-[350ms] ${
        wide ? 'items-start px-4 py-6 sm:px-6 lg:px-8' : 'items-start pt-[16vh]'
      } ${phase === 'fade' ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
      aria-hidden="true"
    >
      {wide ? (
        <div className="w-full max-w-7xl">
          <BrandLoader label="Loading" announce={false} />
        </div>
      ) : (
        <div className="rounded-2xl bg-white/85 px-12 py-3 shadow-xl shadow-sky-200/60 ring-1 ring-sky-100">
          <BrandLoader label="Loading" announce={false} />
        </div>
      )}
    </div>
  )
}
