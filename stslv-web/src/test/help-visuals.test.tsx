// @ts-expect-error -- the web app is compiled without Node's types; this test only reads stylesheets from disk.
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { HelpArticle } from '../help/HelpArticle'
import { HELP_TOPICS } from '../help/helpTopics'
import { HELP_VISUALS } from '../help/helpVisuals'

// The pictures shipped in public/help, and the stylesheets that decide how table headings wrap.
const PICTURES = new Set(Object.keys(import.meta.glob('../../public/help/*.jpg')).map((file) => `/help/${file.split('/').pop()}`))
// Read from disk: with `css: false` in the test config, a CSS import comes back empty.
const STYLESHEETS: Record<string, string> = Object.fromEntries(
  Object.keys(import.meta.glob(['../index.css', '../pages/**/*.css'])).map((file) => [file, readFileSync(file.replace('../', 'src/'), 'utf8') as string]),
)

const topic = (id: string) => HELP_TOPICS.find((item) => item.id === id)!

describe('help pictures', () => {
  it('belong to existing topics, ship their picture, and point inside it', () => {
    const entries = Object.entries(HELP_VISUALS)
    expect(entries.length).toBeGreaterThanOrEqual(10)
    for (const [id, visual] of entries) {
      expect(HELP_TOPICS.some((item) => item.id === id), id).toBe(true)
      expect(PICTURES.has(visual!.src), visual!.src).toBe(true)
      expect(visual!.alt.length, id).toBeGreaterThan(10)
      expect(visual!.callouts.length, id).toBeGreaterThan(0)
      for (const { box, badge, text } of visual!.callouts) {
        const [x, y, w, h] = box
        expect(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= visual!.width && y + h <= visual!.height, `${id}: ${text}`).toBe(true)
        expect(badge[0] > 0 && badge[0] < visual!.width && badge[1] > 0 && badge[1] < visual!.height, `${id}: ${text}`).toBe(true)
      }
    }
  })

  it('cover the main working pages', () => {
    for (const id of ['getting-started', 'amc-contracts', 'contract-360', 'service-status', 'accounts', 'service-sales', 'amc-renewal']) {
      expect(HELP_VISUALS[id], id).toBeDefined()
    }
  })

  it('show the picture with numbered pointers and the matching numbered legend', () => {
    const visual = HELP_VISUALS['amc-contracts']!
    render(
      <MemoryRouter>
        <HelpArticle topic={topic('amc-contracts')} visibleIds={new Set(HELP_TOPICS.map((item) => item.id))} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'On the screen' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: visual.alt })).toHaveAttribute('src', visual.src)
    const legend = screen.getByRole('list', { name: 'What the numbers on the picture show' })
    const items = within(legend).getAllByRole('listitem')
    expect(items).toHaveLength(visual.callouts.length)
    expect(items[0]).toHaveTextContent(`1. ${visual.callouts[0].text}`)
    expect(screen.getByRole('link', { name: /open the picture full size/i })).toHaveAttribute('href', visual.src)

    // Pointing at a line of the legend highlights it; leaving clears it.
    fireEvent.mouseEnter(items[1])
    expect(items[1]).toHaveClass('bg-orange-50')
    fireEvent.mouseLeave(items[1])
    expect(items[1]).not.toHaveClass('bg-orange-50')
  })

  it('leave a topic without a picture unchanged', () => {
    render(
      <MemoryRouter>
        <HelpArticle topic={topic('billing-basis')} visibleIds={new Set()} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('heading', { name: 'On the screen' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('table headings', () => {
  it('stay on one line in every table: no stylesheet lets a heading wrap', () => {
    for (const [file, css] of Object.entries(STYLESHEETS)) {
      for (const rule of css.matchAll(/([^{}]*\bth\b[^{}]*)\{([^}]*)\}/g)) {
        expect(rule[2], `${file}: ${rule[1].trim()}`).not.toMatch(/white-space:\s*normal|text-wrap:\s*balance/)
      }
    }
    expect(STYLESHEETS['../index.css']).toMatch(/\.table-scroll th \{\s*white-space: nowrap;/)
  })
})
