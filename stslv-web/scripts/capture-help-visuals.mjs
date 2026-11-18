/**
 * Captures the annotated screenshots shown in Help ("On the screen") and writes:
 *   public/help/<topic>.jpg      the pictures
 *   src/help/helpVisuals.ts      where each numbered pointer goes (measured from the real controls)
 *
 * Run it against a LOCAL development copy holding sample data only. The repository is public: never capture real
 * client names, values or people.
 *
 *   npm install --no-save playwright          # one-off; Playwright is not a project dependency
 *   HELP_CAPTURE_EMAIL=… HELP_CAPTURE_PASSWORD=… node scripts/capture-help-visuals.mjs [topic-id …]
 *
 * HELP_CAPTURE_URL defaults to http://localhost:5173. The account needs to see every page (Super Admin).
 * Uses the installed Google Chrome (channel "chrome"). Re-run it whenever a page's layout changes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.HELP_CAPTURE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.HELP_CAPTURE_EMAIL
const PASSWORD = process.env.HELP_CAPTURE_PASSWORD
if (!EMAIL || !PASSWORD) throw new Error('Set HELP_CAPTURE_EMAIL and HELP_CAPTURE_PASSWORD (a local test account).')
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('Capture only from a local development server.')

const W = 1440
const H = 960

const button = (name) => (p) => p.getByRole('button', { name })
const link = (name) => (p) => p.getByRole('link', { name })
const field = (name) => (p) => p.getByLabel(name, { exact: true })
const hideFilters = async (p) => {
  const hide = p.getByRole('button', { name: /^hide filters$/i }).first()
  if (await hide.count()) await hide.click()
}

/** One entry per help topic. side: where the numbered marker goes relative to the control (default: chosen). */
const VISUALS = [
  {
    topic: 'getting-started',
    route: '/dashboard',
    alt: 'The application window: the sidebar on the left and the header buttons at the top right.',
    callouts: [
      { target: (p) => p.locator('aside nav, nav').first(), side: 'right', text: 'Sidebar: only the pages your role may open. Choose a group to open it; the page you are on is highlighted.' },
      { target: link(/^notifications/i), text: 'The bell: alerts for overdue services, contracts past validity and work waiting for an invoice.' },
      { target: button('Help for this page'), text: 'Help & User Guide: opens help for the page you are on. Search it, or follow the related topics.' },
      { target: button('Suggestions and improvements'), text: 'Suggestions and improvements: send an idea or report a problem to the administrators.' },
      { target: button(/^account menu/i), side: 'left', text: 'Account menu: your account, the whole Help & User Guide, and sign out.' },
    ],
  },
  {
    topic: 'dashboard',
    route: '/dashboard',
    alt: 'The AMC Operations Dashboard with its key figure cards.',
    callouts: [
      { target: link(/new amc/i), side: 'top', text: '+ New AMC: start a new AMC contract.' },
      { target: button(/^refresh$/i), side: 'right', text: 'Refresh reloads the figures; the footer shows when they were taken.' },
      { target: (p) => p.getByText(/^key figures$/i).first(), textOnly: true, side: 'right', text: 'Key figures in four rows: AMC Portfolio, Current Month, Overall and Current Year (YTD). Amounts exclude VAT.' },
      { target: (p) => p.getByText('Invoices Not Generated', { exact: true }).first(), side: 'left', text: 'Invoices Not Generated: services without an Invoice No. The line below says how many are completed and awaiting invoice.' },
    ],
  },
  {
    topic: 'amc-contracts',
    route: '/amc/contracts',
    alt: 'The AMC Contracts register with its buttons, filters and table headings.',
    callouts: [
      { target: button(/^add contract$/i), side: 'right', text: 'Add Contract: reference, client, system, Sales Engineer, frequency, validity and AMC Value / Year, then attach the contract document and save.' },
      { target: button(/export amc contracts to excel/i), side: 'bottom', text: 'Export to Excel or PDF: every filtered row; hidden columns are left out.' },
      { target: field(/^search$/i), side: 'top', text: 'Search by reference, client, system or engineer.' },
      { target: field(/^validity$/i), side: 'top', text: 'Validity → Due: Active contracts ending within 45 days. Expired: ended, or marked Expired.' },
      { target: button(/^columns/i), side: 'right', text: 'Columns: hide or show columns. Your choice is remembered in this browser.' },
      { target: button(/^amc reference: sort/i), side: 'bottom', text: 'Click a heading to sort the list; click again to reverse it.' },
    ],
  },
  {
    topic: 'contract-360',
    route: '/amc/contracts/1',
    alt: 'Contract 360: one contract with its actions, linked modules and tabs.',
    callouts: [
      { target: link(/all contracts/i), side: 'top', text: 'Back to the contract register.' },
      { target: button(/^start renewal$/i), side: 'top', text: 'Start Renewal: opens the renewal form, filled from this contract.' },
      { target: button(/^service schedule$/i), side: 'top', text: 'Service Schedule: jumps to this contract’s own schedule tab.' },
      { target: button(/^edit$/i), side: 'right', text: 'Contract actions: Edit, Mark as expired, Cancel contract (need Edit on AMC Contracts).' },
      { target: (p) => p.getByText(/^linked modules$/i).first(), textOnly: true, side: 'right', text: 'Linked modules: schedule, invoices, documents, renewals and calendar at a glance. Click one to open it.' },
      { target: (p) => p.getByRole('tablist').first(), side: 'top', text: 'Tabs: Service schedule, Invoices, Renewals, Documents, Contract history and Details.' },
    ],
  },
  {
    topic: 'service-status',
    route: '/amc/service-status',
    alt: 'Service Status: figures, filters and the list of services to complete.',
    prepare: async (p) => {
      await p.getByLabel(/^scheduled month$/i).selectOption({ index: 0 })
      await p.waitForTimeout(800)
      await hideFilters(p)
      // The list itself: scrolled down to the rows, and sideways to the Upload Report, Status and Save controls.
      await p.evaluate(() => {
        const box = document.querySelector('.table-scroll')
        if (!box) return
        window.scrollTo(0, box.getBoundingClientRect().top + window.scrollY - 330)
        const status = [...box.querySelectorAll('thead th')].find((th) => th.textContent?.trim() === 'Service Status')
        box.scrollLeft = status ? status.offsetLeft - 8 : box.scrollWidth
      })
    },
    callouts: [
      { target: button(/^show filters$/i), side: 'top', text: 'Filters: defaults to the current month and year. Reset Filters clears them.' },
      { target: button(/^hide columns/i), side: 'left', text: 'Hide Columns chooses the columns shown.' },
      { target: (p) => p.locator('tr[data-status="NOT_COMPLETED"]').first().getByText('Upload Report', { exact: true }), side: 'top', optional: true, text: 'Upload Report: choose the signed service report (PDF, DOC or DOCX).' },
      { target: (p) => p.locator('tr[data-status="NOT_COMPLETED"]').first().locator('select').first(), side: 'top', optional: true, text: 'Set the status to Completed. Without a report, nothing is saved.' },
      { target: (p) => p.locator('tr[data-status="NOT_COMPLETED"]').first().getByRole('button', { name: /^save/i }), side: 'bottom', optional: true, text: 'Save in the row. Today’s date is recorded as the completion date; completion is final.' },
    ],
  },
  {
    topic: 'monthly-calendar',
    route: '/amc/calendar',
    alt: 'The Monthly Calendar in year view, with a card per month.',
    callouts: [
      { target: button(/^year view$/i), side: 'bottom', text: 'Year view: a card per month. Month view: one card per service, or one entry per contract.' },
      { target: field(/^year$/i), side: 'bottom', text: 'Choose the year, or step with the arrows. This year returns to today.' },
      { target: (p) => p.getByRole('heading', { name: /renewal warnings/i }), textOnly: true, side: 'right', text: 'Renewal warnings: contracts ending soon, with a link to each.' },
      { target: field(/^paid \/ unpaid$/i), side: 'top', text: 'Paid / Unpaid: an Invoice No. entered or not. A reference status, not proof of payment.' },
      { target: button(/^open january/i), side: 'top', text: 'Click a month to open it in month view.' },
    ],
  },
  {
    topic: 'master-amc-status',
    route: '/amc/master-status',
    alt: 'Master AMC Status: figures, filters and the colour-coded list of services.',
    callouts: [
      { target: button(/^customize kpi cards$/i), side: 'bottom', text: 'Figures for the filtered services. Customize KPI cards renames and reorders them.' },
      { target: field(/^row colour$/i), side: 'top', text: 'Row Colour: red not completed, yellow invoice pending, blue quote pending, green paid and quoted.' },
      { target: button(/^apply$/i), side: 'right', text: 'Press Apply to filter; Reset clears the filters.' },
      { target: button(/^hide columns/i), side: 'left', text: 'Hide Columns chooses the columns shown.' },
      { target: button(/export master amc status to excel/i), side: 'bottom', text: 'Export to Excel or PDF.' },
    ],
  },
  {
    topic: 'amc-renewal',
    route: '/amc/renewal',
    alt: 'AMC Renewal: the renewal queue with its figures and the Start Renewal button.',
    callouts: [
      { target: (p) => p.getByRole('tab', { name: /^renewal queue/i }), side: 'bottom', text: 'Renewal Queue: contracts ending within 45 days or already ended. Renewal History: renewals made.' },
      { target: (p) => p.getByRole('link', { name: /^show$/i }).first(), side: 'bottom', text: 'Show lists the contracts behind a figure.' },
      { target: field(/^renewal status$/i), side: 'top', text: 'Filter by renewal status: Due / Expired, Under Client Approval, Renewed or Cancelled.' },
      { target: button(/^start renewal$/i), side: 'left', text: 'Start Renewal: the Add AMC Contract form, filled from this contract. Attach the renewal document and create it.' },
      { target: button(/export renewal queue to excel/i), side: 'bottom', text: 'Export the queue to Excel or PDF.' },
    ],
  },
  {
    topic: 'accounts',
    route: '/finance/accounts',
    alt: 'Accounts: figures, filters and the list of services with their Invoice No.',
    callouts: [
      { target: button(/export accounts to excel/i), side: 'bottom', text: 'Export to Excel or PDF (needs Export on Accounts).' },
      { target: button(/^customize kpi cards$/i), side: 'bottom', text: 'Figures: Rows, Completed, Not Completed, Invoice No. Filled and Total Value (ex VAT).' },
      { target: field(/^search$/i), side: 'top', text: 'Filter to the month and find the completed (blue) service.' },
      { target: field(/^paid \/ unpaid$/i), side: 'top', text: 'Paid means an Invoice No. was entered: a reference status, not proof of payment.' },
    ],
  },
  {
    topic: 'service-sales',
    route: '/amc/service-sales',
    alt: 'Service Sales: filters and the list of completed services waiting for a Quote No.',
    prepare: async (p) => {
      await p.evaluate(() => {
        const box = document.querySelector('.table-scroll')
        if (box) box.scrollLeft = box.scrollWidth
      })
    },
    callouts: [
      { target: button(/^customize kpis$/i), side: 'bottom', text: 'Customize KPIs renames and reorders the figures.' },
      { target: button(/^hide columns$/i), side: 'bottom', text: 'Hide Columns chooses the columns shown.' },
      { target: field(/^quote$/i), side: 'top', text: 'Quote filter: completed services with or without a Quote No.' },
      { target: (p) => p.getByRole('textbox', { name: /^quote no\. for/i }).first(), side: 'top', optional: true, text: 'Type the Quote No. of a completed service …' },
      { target: button(/^save quote no\. for/i), side: 'bottom', optional: true, text: '… and click Save (needs Edit on Service Sales). The row turns green.' },
    ],
  },
  {
    topic: 'reports',
    route: '/reports',
    alt: 'Reports: the report picker, its filters and the report table.',
    callouts: [
      { target: field(/^report$/i), side: 'bottom', text: 'Choose a report. The list shows only the reports your role may open.' },
      { target: field(/^from$/i), side: 'bottom', text: 'Set the period and any other filters; the report updates.' },
      { target: button(/to excel$/i), side: 'bottom', text: 'Export the report to Excel or PDF.' },
    ],
  },
  {
    topic: 'clients',
    route: '/clients',
    alt: 'The Clients directory with its filters and row actions.',
    callouts: [
      { target: button(/^add client$/i), side: 'left', text: 'Add Client: only the client name is required.' },
      { target: field(/^search$/i), side: 'bottom', text: 'Search by name, code, VAT, phone, email or contact. Status defaults to Active.' },
      { target: button(/^columns/i), side: 'bottom', text: 'Columns: hide columns. Hidden columns are left out of exports.' },
      { target: (p) => p.getByRole('link', { name: /sample/i }).first(), side: 'bottom', text: 'Click a client name to open Client 360.' },
      { target: (p) => p.getByRole('button', { name: /^deactivate /i }).first(), side: 'left', text: 'Row actions: View, Edit, Deactivate (instead of delete) and Recycle Bin.' },
    ],
  },
  {
    topic: 'master-data-center',
    route: '/master-data',
    alt: 'The Master Data Center with a card for each list.',
    callouts: [
      { target: link(/^clients:/i), side: 'top', text: 'Each card shows the number of active records and opens its list.' },
      { target: link(/^maintenance frequencies:/i), side: 'bottom', text: 'Only Active records are offered for new contracts; disabling one never changes existing contracts.' },
    ],
  },
  {
    topic: 'users-and-roles',
    route: '/admin/users',
    alt: 'Users & Access: the user list and its row actions.',
    callouts: [
      { target: button(/^create user$/i), side: 'left', text: 'Create User.' },
      { target: field(/^status$/i), side: 'bottom', text: 'Status: filter Pending to find sign-up requests waiting for approval.' },
      { target: (p) => p.getByRole('button', { name: /^change role of /i }).nth(1), side: 'left', text: 'Change role: assign the role before approving. You cannot change your own role.' },
      { target: (p) => p.getByRole('button', { name: /^generate temporary password/i }).nth(1), side: 'bottom', text: 'Forgotten password: a temporary password, shown once, valid for 15 minutes and one sign-in.' },
    ],
  },
]

/** Places the marker beside the control, keeps it inside the picture and away from earlier markers. */
function placeBadge([x, y, w, h], side, taken) {
  const gap = 64
  const cx = x + w / 2
  const cy = y + h / 2
  const chosen = side ?? (y < 70 ? 'bottom' : cx > W * 0.6 ? 'left' : 'right')
  let [bx, by] = {
    top: [cx, y - gap],
    bottom: [cx, y + h + gap],
    left: [x - gap, cy],
    right: [x + w + gap, cy],
  }[chosen]
  if (chosen === 'right' && w > W * 0.5) bx = x + Math.min(w, 360) + gap
  const clamp = (value, max) => Math.min(Math.max(value, 22), max - 22)
  bx = clamp(bx, W)
  by = clamp(by, H)
  while (taken.some(([tx, ty]) => Math.hypot(tx - bx, ty - by) < 34)) by = clamp(by + 36, H)
  return [Math.round(bx), Math.round(by)]
}

const only = new Set(process.argv.slice(2))
const browser = await chromium.launch({ channel: 'chrome' })
// Reduced motion: no fade-in or loader animation is caught half-way in a picture.
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5, reducedMotion: 'reduce' })
await context.addInitScript(() => localStorage.setItem('stslev.cookie-consent', 'essential'))
const page = await context.newPage()
await page.goto(`${BASE}/login`)
await page.getByLabel(/email/i).fill(EMAIL)
await page.getByLabel(/password/i).first().fill(PASSWORD)
await page.getByRole('button', { name: /^login$/i }).click()
await page.waitForURL((url) => !url.pathname.startsWith('/login'))

const output = path.join(ROOT, 'src/help/helpVisuals.ts')
const previous = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : ''
const existing = previous ? JSON.parse(previous.slice(previous.indexOf('{', previous.indexOf('HELP_VISUALS')))) : {}
const result = { ...existing }

for (const visual of VISUALS) {
  if (only.size && !only.has(visual.topic)) continue
  await page.goto(BASE + visual.route)
  await page.waitForLoadState('networkidle')
  // Wait until no loading overlay or "Loading…" text is left, before and after the page is prepared.
  // The splash loader (SplashLoader.tsx) shows over the content for about two seconds after each page load.
  const settled = () =>
    page
      .waitForFunction(() => !/loading/i.test(document.body.innerText) && !document.querySelector('.inset-0.z-20[aria-hidden="true"]'), null, { timeout: 15000 })
      .catch(() => {})
  await settled()
  if (visual.prepare) {
    await visual.prepare(page)
    await page.waitForLoadState('networkidle')
    await settled()
  }
  await page.mouse.move(0, H - 1)
  await settled()
  await page.waitForTimeout(600)

  const callouts = []
  for (const callout of visual.callouts) {
    const locator = callout.target(page).first()
    // textOnly: the box hugs the words of a heading instead of its full-width row.
    const box = !(await locator.count())
      ? null
      : callout.textOnly
        ? await locator.evaluate((element) => {
            const range = document.createRange()
            range.selectNodeContents(element)
            const { x, y, width, height } = range.getBoundingClientRect()
            return { x, y, width, height }
          })
        : await locator.boundingBox()
    const visible = box && box.width > 0 && box.y >= 0 && box.y + box.height <= H && box.x >= 0 && box.x + box.width <= W
    if (!visible) {
      if (callout.optional) {
        console.warn(`  ${visual.topic}: skipped (not on screen) "${callout.text.slice(0, 40)}…"`)
        continue
      }
      throw new Error(`${visual.topic}: control not on screen for "${callout.text}"`)
    }
    const rect = [box.x, box.y, box.width, box.height].map(Math.round)
    callouts.push({ text: callout.text, box: rect, badge: placeBadge(rect, callout.side, callouts.map((c) => c.badge)) })
  }

  const file = `public/help/${visual.topic}.jpg`
  await page.screenshot({ path: path.join(ROOT, file), type: 'jpeg', quality: 82 })
  result[visual.topic] = { src: `/help/${visual.topic}.jpg`, width: W, height: H, alt: visual.alt, callouts }
  console.log(`ok ${visual.topic} (${callouts.length} pointers)`)
}
await browser.close()

const ordered = Object.fromEntries(VISUALS.filter((v) => result[v.topic]).map((v) => [v.topic, result[v.topic]]))
fs.writeFileSync(
  output,
  `// Generated by scripts/capture-help-visuals.mjs from sample data. Do not edit by hand: change the script and run it again.\n` +
    `import type { HelpVisualData } from './HelpVisual'\n\n` +
    `export const HELP_VISUALS: Partial<Record<string, HelpVisualData>> = ${JSON.stringify(ordered, null, 2)}\n`,
)
console.log(`wrote ${path.relative(ROOT, output)}`)
