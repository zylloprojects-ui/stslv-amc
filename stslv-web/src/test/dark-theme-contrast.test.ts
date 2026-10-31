// @ts-expect-error -- the web app is compiled without Node's types; this test only reads the stylesheet from disk.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Read from disk: with `css: false` in the test config, a CSS import comes back empty.
const css: string = readFileSync('src/index.css', 'utf8')

// Component tests run without CSS, so they cannot see an unreadable colour pair. These pairs are the
// status colours that went unreadable in dark mode; each must keep at least 4.5:1 contrast.
function ruleValue(selector: string, property: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const rules = [...css.matchAll(new RegExp(`(?:^|[,}/])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'gm'))]
  const last = rules.at(-1)

  if (!last) throw new Error(`No dark rule for ${selector}`)
  const value = new RegExp(`${property}:\\s*(#[0-9a-fA-F]{6})`).exec(last[1])?.[1]

  if (!value) throw new Error(`No ${property} in ${selector}`)
  return value
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255

    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (light + 0.05) / (dark + 0.05)
}

describe('dark theme status colours', () => {
  it.each([
    ['Not Completed badge', '.dark .text-rose-800', '.dark .bg-rose-100'],
    ['overdue calendar cell', '.dark .text-rose-700', '.dark .bg-rose-50'],
    ['15-day expiry band', '.dark .text-red-900', '.dark .bg-red-50'],
    ['Master Status yellow badge', '.dark .text-yellow-900', '.dark .bg-yellow-100'],
    ['Postponed calendar visit', '.dark .text-violet-900', '.dark .bg-violet-50'],
  ])('%s stays readable', (_name, text, background) => {
    expect(contrast(ruleValue(text, 'color'), ruleValue(background, 'background-color'))).toBeGreaterThanOrEqual(4.5)
  })
})
