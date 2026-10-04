import { useEffect, useRef, type RefObject } from 'react'

const APP_NAME = 'STSLEV AMC'

/** Names the browser tab after the current page, so tabs and history entries can be told apart. */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME
  }, [title])
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Several layers can be open at once (a confirmation over a form). Only the top one
// answers the keyboard, and the page stays locked until the last one closes.
const openLayers: symbol[] = []

/**
 * Behaviour shared by everything that opens over the page (dialogs, the mobile menu):
 * moves keyboard focus inside, keeps it there, closes on Escape, stops the page
 * behind from scrolling, and returns focus to where it was on close.
 */
export function useDialogBehavior(panelRef: RefObject<HTMLElement | null>, onClose: () => void, initialFocus: string): void {
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(initialFocus) ?? panel

    const layer = Symbol('layer')

    first?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (openLayers[openLayers.length - 1] !== layer) {
        return
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) {
        return
      }

      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const firstItem = focusable[0]
      const lastItem = focusable[focusable.length - 1]

      if (!firstItem || !lastItem) {
        event.preventDefault()
        return
      }

      const active = document.activeElement

      if (!panel.contains(active)) {
        event.preventDefault()
        firstItem.focus()
      } else if (event.shiftKey && (active === firstItem || active === panel)) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    openLayers.push(layer)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)

      openLayers.splice(openLayers.indexOf(layer), 1)
      if (openLayers.length === 0) {
        document.body.style.overflow = ''
      }

      previouslyFocused?.focus?.()
    }
  }, [panelRef, initialFocus])
}
