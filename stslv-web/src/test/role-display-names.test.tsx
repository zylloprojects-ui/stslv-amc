import { describe, expect, it } from 'vitest'
import { ADMINISTRATOR_NAME, BUILT_IN_ROLE_NAMES, FINANCE_ROLE_NAME, MASTER_DATA_ROLE_NAME, PRIVILEGED_ROLES_LABEL } from '../auth/roleNames'
import { HELP_TOPICS } from '../help/helpTopics'

// Client role names (2026-11-11, API migration 0117): Admin -> Service Dept, Finance Executive -> Accounts,
// Master Data Executive -> AMC Sales. Role lists show what the API sends; fixed text uses auth/roleNames.ts.

const SOURCES = import.meta.glob(['../**/*.{ts,tsx}', '!../test/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const GUIDE = Object.values(import.meta.glob('../../../docs/user-guide/USER_GUIDE.md', { query: '?raw', import: 'default', eager: true }))[0] as string

/** The source without comments, so only text that can reach the screen is checked. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

// Phrases that can only mean one of the renamed roles.
const OLD_ROLE_TEXT = [/Finance Executive/, /Master Data Executive/, /Super Admin (and|or) Admin\b/, /(?<!Super )\bAdmin (only|included|with Users)/, /(?<!Super )\bAdmin users\b/]

describe('role display names', () => {
  it('are the client names, codes unchanged', () => {
    expect(BUILT_IN_ROLE_NAMES).toEqual({
      ADMIN: 'Super Admin',
      ADMINISTRATOR: 'Service Dept',
      FINANCE_EXECUTIVE: 'Accounts',
      MASTER_DATA_EXECUTIVE: 'AMC Sales',
      AMC_OPERATIONS_EXECUTIVE: 'AMC Operations Executive',
      VIEWER: 'Viewer',
    })
    expect([ADMINISTRATOR_NAME, FINANCE_ROLE_NAME, MASTER_DATA_ROLE_NAME, PRIVILEGED_ROLES_LABEL]).toEqual(['Service Dept', 'Accounts', 'AMC Sales', 'Super Admin and Service Dept'])
  })

  it('Help lists the built-in roles by their new names', () => {
    const topic = HELP_TOPICS.find((entry) => entry.id === 'roles-permissions')
    const terms = topic?.sections.flatMap((section) => section.terms ?? []).map((term) => term.term)

    expect(terms).toEqual(['Super Admin', 'Service Dept', 'Accounts', 'AMC Sales', 'AMC Operations Executive', 'Viewer'])
  })

  it('no help topic, page or message uses an old role name', () => {
    const help = JSON.stringify(HELP_TOPICS)
    expect(help).not.toMatch(/(?<!Super )\bAdmin\b/)

    for (const [file, source] of Object.entries(SOURCES)) {
      for (const pattern of OLD_ROLE_TEXT) {
        expect(code(source), `${file} ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('the user guide uses the new names', () => {
    // The one paragraph that records the rename names the old roles on purpose.
    const guide = GUIDE.split('\n').filter((line) => !line.startsWith('Role names (renamed for the client')).join('\n')
    expect(guide).not.toBe(GUIDE)

    for (const pattern of [...OLD_ROLE_TEXT, /(?<!Super |Super Admin\/)\bAdmin\b(?! is now)/]) {
      expect(guide, String(pattern)).not.toMatch(pattern)
    }
    expect(GUIDE).toContain('Service Dept')
    expect(GUIDE).toContain('AMC Sales')
  })
})
