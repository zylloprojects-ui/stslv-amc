import { useEffect, useState } from 'react'

/** Round "back to top" button that appears once the page has been scrolled down. */
export function ScrollToTop() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 300)

    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })

    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!visible) {
    return null
  }

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Scroll to top"
      title="Back to top"
      className="login-rise fixed bottom-6 right-6 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[#1479BD] to-[#0E93B5] text-white shadow-lg shadow-sky-700/40 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl active:translate-y-0"
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
        <path d="m6 14 6-6 6 6M12 8v11" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
