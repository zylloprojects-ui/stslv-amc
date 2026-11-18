import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// One tooltip for every icon action in the application. An element opts in with data-tooltip="<text>" (ActionButton
// and ActionLink do it for you). It appears almost at once on mouse hover or keyboard focus, is drawn on top of the
// page (never clipped by a scrolling table) and is kept inside the window. Touch screens skip it: a tap acts at once.
const SHOW_DELAY_MS = 60
const GAP = 8
const EDGE = 8
const TOOLTIP_ID = 'action-tooltip'

interface Tip {
  text: string
  target: HTMLElement
}

export function ActionTooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; arrowLeft: number; below: boolean } | null>(null)

  useEffect(() => {
    let current: HTMLElement | null = null
    let timer: number | undefined

    const describe = (target: HTMLElement | null, on: boolean) => {
      if (!target) return
      // The tooltip adds to the accessible name only when it says something more.
      if (on && target.dataset.tooltip !== target.getAttribute('aria-label')) target.setAttribute('aria-describedby', TOOLTIP_ID)
      else if (target.getAttribute('aria-describedby') === TOOLTIP_ID) target.removeAttribute('aria-describedby')
    }
    const hide = () => {
      window.clearTimeout(timer)
      describe(current, false)
      current = null
      setTip(null)
    }
    const show = (target: HTMLElement) => {
      if (target === current) return
      window.clearTimeout(timer)
      describe(current, false)
      current = target
      timer = window.setTimeout(() => {
        const text = target.dataset.tooltip
        if (!text || !target.isConnected) return
        describe(target, true)
        setTip({ text, target })
      }, SHOW_DELAY_MS)
    }
    const targetOf = (node: EventTarget | null) => (node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null)

    const onOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const target = targetOf(event.target)
      if (target) show(target)
      else if (current) hide()
    }
    const onFocusIn = (event: FocusEvent) => {
      const target = targetOf(event.target)
      if (target && target.matches(':focus-visible')) show(target)
    }
    const onFocusOut = (event: FocusEvent) => {
      if (current && targetOf(event.target) === current) hide()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }

    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerdown', hide)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerdown', hide)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  // Above the icon, centred; below it when there is no room above; always inside the window.
  useLayoutEffect(() => {
    if (!tip || !box.current) {
      setPlace(null)
      return
    }
    const anchor = tip.target.getBoundingClientRect()
    const { width, height } = box.current.getBoundingClientRect()
    const centre = anchor.left + anchor.width / 2
    const left = Math.min(Math.max(EDGE, centre - width / 2), window.innerWidth - width - EDGE)
    const below = anchor.top - GAP - height < EDGE
    const top = below ? anchor.bottom + GAP : anchor.top - GAP - height
    setPlace({ left, top, below, arrowLeft: Math.min(Math.max(10, centre - left), width - 10) })
  }, [tip])

  if (!tip) return null
  return createPortal(
    <div
      ref={box}
      id={TOOLTIP_ID}
      role="tooltip"
      className="action-tooltip"
      data-placement={place?.below ? 'below' : 'above'}
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden' }}
    >
      {tip.text}
      <span className="action-tooltip-arrow" style={{ left: place?.arrowLeft ?? 0 }} aria-hidden="true" />
    </div>,
    document.body,
  )
}
