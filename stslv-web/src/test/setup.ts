import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Pages render charts and animated cards; give slower machines more time to settle.
configure({ asyncUtilTimeout: 6000 })

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})
