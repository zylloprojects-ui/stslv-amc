import { useContext, useEffect, useRef, useState } from 'react'
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom'
import { ConfirmDialog } from '../components/ui'
import { setLeaveGuard } from './leaveGuard'

// Asks before unsaved changes are lost, whatever takes the user away from the page:
// - any navigation inside the app (sidebar, header search, links, Back/Forward): useBlocker;
// - signing out: the sign-out buttons call signOutSafely() (lib/leaveGuard.ts) first;
// - reloading or closing the tab: the browser's own leave-page prompt.
// A session that expires is still signed out; the API keeps whatever was saved.

interface GuardProps {
  /** Whether there are unsaved changes now. */
  when: boolean
  message: string
}

function RouteBlocker({ when, message, bypass }: GuardProps & { bypass: { current: boolean } }) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && !bypass.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  )

  if (blocker.state !== 'blocked') {
    return null
  }

  return (
    <ConfirmDialog
      title="Discard unsaved changes?"
      message={message}
      confirmLabel="Discard changes"
      danger
      onConfirm={() => blocker.proceed()}
      onCancel={() => blocker.reset()}
    />
  )
}

/** Render while a page holds unsaved changes. */
export function UnsavedChangesGuard({ when, message }: GuardProps) {
  // Navigations can only be blocked under a data router (the app has one; some tests render without it).
  const dataRouter = useContext(UNSAFE_DataRouterContext)
  const bypass = useRef(false)
  const [asking, setAsking] = useState<((discard: boolean) => void) | null>(null)

  useEffect(() => {
    if (!when) return undefined
    bypass.current = false

    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    setLeaveGuard(() =>
      new Promise<boolean>((resolve) => {
        setAsking(() => (discard: boolean) => {
          // Signing out navigates to the sign-in page: let that navigation through.
          bypass.current = discard
          resolve(discard)
        })
      }),
    )

    return () => {
      window.removeEventListener('beforeunload', warn)
      setLeaveGuard(null)
    }
  }, [when])

  return (
    <>
      {dataRouter && <RouteBlocker when={when} message={message} bypass={bypass} />}
      {asking && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message={message}
          confirmLabel="Discard changes"
          danger
          onConfirm={() => {
            asking(true)
            setAsking(null)
          }}
          onCancel={() => {
            asking(false)
            setAsking(null)
          }}
        />
      )}
    </>
  )
}

