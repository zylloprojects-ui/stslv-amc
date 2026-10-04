import { useEffect, useRef, useState } from 'react'

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

/** A whole number that counts up from zero when it appears, and between values when it changes. It does not move for people who ask for reduced motion. */
export function CountUp({ value, duration = 800 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(0)
  const from = useRef(0)
  const reduce = prefersReducedMotion() || typeof requestAnimationFrame !== 'function'

  useEffect(() => {
    if (reduce) {
      return
    }

    const start = from.current
    const began = performance.now()
    let frame = 0

    const tick = (now: number) => {
      const t = Math.min((now - began) / duration, 1)
      const current = Math.round(start + (value - start) * (1 - Math.pow(1 - t, 3)))

      from.current = current
      setShown(current)

      if (t < 1) {
        frame = requestAnimationFrame(tick)
      }
    }

    frame = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(frame)
  }, [value, duration, reduce])

  return <>{reduce ? value : shown}</>
}
