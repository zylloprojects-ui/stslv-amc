import type { HelpTopic } from './helpModel'

// The in-app help. Each topic is a short version of a chapter of docs/user-guide/USER_GUIDE.md
// (named in guideChapter; a test checks the chapter exists). Keep the two in step: when a page
// changes, update both. Wording follows the labels on screen.

const GENERAL: HelpTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    group: 'Getting started',
    access: { kind: 'everyone' },
    pages: ['/account', '/notifications'],
    guideChapter: 'Getting started',
    summary:
      'STS-ELV AMC keeps every AMC contract, its scheduled services, their completion and their invoice numbers in one place, so no visit and no invoice is missed.',
    sections: [
      {
        heading: 'The everyday flow',
        steps: [
          'Master Data: the client, system type, sales engineer and maintenance frequency exist.',
          'AMC Contracts: the contract is added with its validity, frequency and value, and made Active.',
          'Schedule: the services are generated from the contract dates and frequency.',
          'Service Status: each service is carried out, its Service Report uploaded, and it is marked Completed.',
          'Accounts: the invoice is raised in Zoho, and its number is entered on the completed service (Paid reference status).',
          'Invoice Tracking (optional): the Zoho invoice details are recorded and allocated to the work.',
          'AMC Renewal: contracts ending within 45 days are renewed.',
        ],
      },
      {
        heading: 'Finding your way',
        bullets: [
          'The sidebar shows only the pages your role may open. On a phone, open it with the menu button at the top left.',
          'The search box in the header finds the pages you may open (use each page’s own search for records).',
          'The bell shows alerts for your work: overdue services, contracts past validity and work waiting for an invoice.',
          'The question-mark button opens help for the page you are on. Help & User Guide in your account menu opens the whole guide.',
          'Dates follow Oman time (Asia/Muscat) everywhere: "today", due and overdue services, contract expiry and "this month" change at midnight in Oman, wherever you are. A contract is valid through its Valid To date and shows as expired from the next day.',
          'The light-bulb button (if your role allows suggestions) sends an idea or a problem report to the administrators.',
        ],
      },
      {
        heading: 'If something is missing',
        text: [
          'A page or button you do not see is not part of your role. "Access denied" means the same. Ask an administrator to update your role in Roles & Permissions; the server checks every action again, whatever the screen shows.',
        ],
      },
      {
        heading: 'Your account',
        bullets: [
          'My Profile (account menu) shows your name, email and role, lets you change your password, and lists your active sessions so you can sign out one device or all of them.',
          'A new password needs at least 12 characters, three of lower-case, upper-case, digits and symbols, and must not be a well-known password or contain your name.',
          'You are signed out after 30 minutes without using the application. A password change or a temporary password signs you out everywhere.',
          'Forgotten password: an administrator issues a temporary password in Users & Access. It is valid for 15 minutes and must be changed at the next sign-in.',
          'Sign out from the account menu when you leave a shared computer: it ends the session on the server too.',
        ],
      },
    ],
    related: ['paid-vs-zoho', 'billing-basis', 'suggestions'],
  },
  {
    id: 'billing-basis',
    title: 'Billing Basis and service amounts',
    group: 'Getting started',
    access: { kind: 'nav', path: '/amc/contracts' },
    pages: [],
    guideChapter: 'Billing Basis, Regenerate and Paid status',
    summary: 'How the amount of each scheduled service is worked out from the contract. All amounts are OMR, excluding VAT, with three decimals.',
    sections: [
      {
        heading: 'Billing Basis options',
        terms: [
          { term: 'AMC Value / Year', meaning: "The contract's AMC Value / Year is the annual amount." },
          { term: 'Final Credit Value', meaning: "The contract's Final Credit Value is the annual amount." },
          { term: 'Custom Billing Value', meaning: 'An annual amount typed on the contract.' },
          { term: '(none)', meaning: 'No calculation: each service keeps the Cost per Visit entered by hand.' },
        ],
      },
      {
        heading: 'The calculation',
        bullets: [
          "Amount per service = annual amount ÷ number of services in one annual cycle, rounded to three decimals. Example: 500.000 ÷ 6 = 83.333.",
          'The last service of each complete annual cycle takes the rounding remainder, so the year adds up exactly: 5 × 83.333 + 83.335 = 500.000.',
          'A partial contract year is not prorated: each service actually scheduled gets the standard amount.',
          'Values entered before this rule may be whole-term amounts. They are never reinterpreted automatically. Check the Contract Value Review report before choosing AMC Value / Year on an older multi-year contract.',
        ],
      },
      {
        heading: 'When amounts change',
        text: [
          'New services use the basis when the schedule is generated. Editing a contract never changes the amounts of services that already exist: that happens only through Regenerate, with a reason.',
        ],
      },
    ],
    related: ['regenerate', 'amc-contracts', 'contract-360'],
  },
  {
    id: 'regenerate',
    title: 'Regenerate a schedule',
    group: 'Getting started',
    access: { kind: 'nav', path: '/amc/contracts' },
    pages: [],
    guideChapter: 'Billing Basis, Regenerate and Paid status',
    summary: 'Regenerate recalculates the existing services of one contract from its Billing Basis. It is the only way existing amounts change.',
    sections: [
      {
        heading: 'Before you start',
        bullets: [
          'The contract must be Active and have a Billing Basis.',
          'You need Edit on AMC Contracts.',
          'Regenerate is on the contract page (Contract 360). It shows a preview first and asks for a reason; nothing changes until you confirm.',
        ],
      },
      {
        heading: 'What is kept unchanged',
        bullets: [
          'Completed, historical and cancelled services.',
          'Paid services (a manual Invoice No. is entered).',
          'Services with an active Zoho invoice in Invoice Tracking.',
          'Amounts that were set by hand on a service.',
        ],
      },
      {
        heading: 'What changes',
        bullets: [
          'Every other service takes the calculated amount.',
          'Missing services inside the contract dates are added; untouched services outside them are removed, as when generating.',
          'The reason, the basis, the annual amount and every old and new amount are written to the Audit Log.',
        ],
      },
    ],
    related: ['billing-basis', 'contract-360'],
  },
  {
    id: 'paid-vs-zoho',
    title: 'Paid status and Zoho invoices',
    group: 'Getting started',
    access: { kind: 'everyone' },
    pages: [],
    guideChapter: 'Billing Basis, Regenerate and Paid status',
    summary:
      'There are two separate invoice records. The manual Invoice No. on a service gives the Paid / Unpaid reference status. Invoice Tracking holds the Zoho invoice details. Neither proves that money was received.',
    sections: [
      {
        heading: 'Manual Invoice No. (Paid / Unpaid)',
        bullets: [
          'Entered on a completed service in Accounts, AMC Schedule or the contract page. Entering a number makes the service Paid; clearing it makes it Unpaid.',
          'A number can be entered or changed only after the service is Completed ("Complete the service before entering an invoice number."). Clearing is allowed at any time.',
          'No invoice is generated, no VAT is calculated, and no date or amount is asked for.',
          'Paid is a reference status. It does not verify that money was received: STS-ELV AMC has no bank or receipt records.',
          'Accounts, Master AMC Status, the Calendar, the Dashboard payment figures and Reports use this number for Paid / Unpaid.',
        ],
      },
      {
        heading: 'Invoice Tracking (Zoho)',
        bullets: [
          'Official invoices are still created in Zoho. Their number, date, amounts and status are recorded in Invoice Tracking and allocated to the visits or projects they bill.',
          'A Zoho record does not make a service Paid. Accounts and Master AMC Status show it beneath the Invoice No. as "Zoho: …".',
          'Ready for Invoice, Invoiced, Pending Billing and the Calendar billing filter follow Invoice Tracking.',
          'Confirming that money was actually received is done in Zoho / the bank, not in STS-ELV AMC.',
        ],
      },
    ],
    related: ['accounts', 'invoice-tracking', 'service-status'],
  },
]

const MASTER_DATA: HelpTopic[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    group: 'Getting started',
    access: { kind: 'nav', path: '/dashboard' },
    // AMC Management shows the same Dashboard (2026-11-09), so it opens this topic too.
    pages: ['/dashboard', '/amc/management'],
    guideChapter: 'Dashboard',
    summary: 'The AMC Operations Dashboard: contracts, this month’s services, invoice numbers and renewals at a glance. Each figure is shown only if your role can view its module.',
    sections: [
      {
        heading: 'Key figures (three rows)',
        terms: [
          { term: 'AMC Portfolio', meaning: 'Active AMCs, Annual AMC Value (Ex VAT), Final Credit (Ex VAT) and Expiring ≤45 Days, over Active contracts.' },
          { term: 'Current Month', meaning: 'Services This Month, Services Pending, Invoices Generated and Invoices Not Generated for services scheduled this month.' },
          { term: 'Overall', meaning: 'The same service and invoice figures across all service records, earlier years and visits ahead.' },
        ],
      },
      {
        heading: 'Reading the invoice figures',
        text: [
          '"Invoices Generated" means a manual Invoice No. was entered on the service (Paid in Accounts). It is a reference status, not verified payment. Amounts exclude VAT.',
        ],
      },
      {
        heading: 'Panels',
        bullets: [
          'AMC Maintenance Calendar: Today and Next 7 days. Click a service to see its details (needs AMC Schedule view).',
          'Upcoming Service Workload: planned, completed and open services for six months; switch between graph and table.',
          'Payment Trend: value of services marked Paid over the last six months.',
          'Refresh reloads the figures; the footer shows when they were taken.',
        ],
      },
    ],
    related: ['paid-vs-zoho', 'amc-management'],
  },
  {
    id: 'master-data-center',
    title: 'Master Data Center',
    group: 'Master Data Center',
    // The same rule as the page's route guard (App.tsx).
    access: { kind: 'anyModule', modules: ['CLIENTS', 'SALES_ENGINEERS', 'SYSTEM_TYPES', 'MAINTENANCE_FREQUENCIES', 'DEPARTMENTS'] },
    pages: ['/master-data'],
    guideChapter: 'Master Data Center',
    summary:
      'The reference lists used across AMC contracts: Clients, Sales Engineers, System Types, Maintenance Frequencies and Departments. Records are deactivated, never deleted, so history stays intact.',
    sections: [
      {
        heading: 'Common rules',
        bullets: [
          'Each card shows the number of active records and opens its list. You see only the cards your role can view.',
          'Only Active records are offered for new contracts. Disabling a record never changes the contracts that already use it.',
          'Status colours: Active (green), Disabled (grey); frequencies can also be Archived (amber).',
          'Export (Excel or PDF) covers the current filters and needs the Export permission.',
          'Moving a record to the Recycle Bin is reserved to Super Admin.',
        ],
      },
    ],
    related: ['clients', 'sales-engineers', 'system-types', 'maintenance-frequencies', 'departments'],
  },
  {
    id: 'clients',
    title: 'Clients and Client 360',
    group: 'Master Data Center',
    access: { kind: 'nav', path: '/clients' },
    pages: ['/clients', '/clients/:id'],
    guideChapter: 'Master Data Center',
    summary: 'The client master. Client 360 shows one client’s contracts, upcoming visits, Zoho invoices, renewals and history.',
    sections: [
      {
        heading: 'Add or edit a client',
        steps: [
          'Click Add Client (needs Create on Clients).',
          'Enter the Client name (required). Contact person, phone, email, address, VAT number and remarks are optional.',
          'Save. A new client is saved as a Company; the type can be changed to Individual when editing.',
        ],
      },
      {
        heading: 'Filters and columns',
        bullets: [
          'Search by name, code, VAT, phone, email or contact. Status filter defaults to Active.',
          'Columns: Code, Client name (opens Client 360), Type, VAT number, Contact person, Phone, Status.',
          'Use Columns to hide columns; hidden columns are left out of exports.',
        ],
      },
      {
        heading: 'Deactivate instead of delete',
        text: ['Deactivate (needs Delete on Clients) stops the client being offered for new contracts. Existing contracts, invoices and history are kept. Reactivate brings it back.'],
      },
      {
        heading: 'Common errors',
        bullets: ['"Client name is required."', '"Enter a valid email address."', '"An inactive client cannot be selected. Reactivate the client first." (on a contract)'],
      },
    ],
    related: ['master-data-center', 'amc-contracts'],
  },
  {
    id: 'sales-engineers',
    title: 'Sales Engineers',
    group: 'Master Data Center',
    access: { kind: 'nav', path: '/master-data/sales-engineers' },
    pages: ['/master-data/sales-engineers', '/master-data/sales-engineers/:id'],
    guideChapter: 'Master Data Center',
    summary: 'Engineers assigned to AMC contracts and renewals. Engineer 360 shows each engineer’s contracts, upcoming work and history.',
    sections: [
      {
        heading: 'Fields',
        terms: [
          { term: 'Engineer code *', meaning: 'Unique (ignoring capitals), up to 20 characters, e.g. SE-0001. A deleted engineer’s code cannot be reused.' },
          { term: 'Engineer name *', meaning: 'Up to 150 characters.' },
          { term: 'Department, Email, Phone, Employee no.', meaning: 'Optional.' },
          { term: 'User account', meaning: 'Optional link to the engineer’s sign-in account.' },
        ],
      },
      {
        heading: 'Good to know',
        bullets: [
          'Every new contract and every renewal needs an active sales engineer.',
          'Disable (needs Edit) instead of deleting: contracts keep the engineer. A warning lists assignments first.',
        ],
      },
    ],
    related: ['departments', 'amc-renewal'],
  },
  {
    id: 'system-types',
    title: 'System Types',
    group: 'Master Data Center',
    access: { kind: 'nav', path: '/master-data/system-types' },
    pages: ['/master-data/system-types'],
    guideChapter: 'Master Data Center',
    summary: 'The kinds of system covered by contracts (for example fire alarm or CCTV).',
    sections: [
      {
        heading: 'Fields and actions',
        bullets: [
          'Code * (short, e.g. FA or CCTV), Name *, Sort order (lower first), Description.',
          'Linked AMC contracts shows how many contracts use the type; click it to list them.',
          'Deactivate: no longer offered for new contracts; contracts that use it keep it.',
          'Delete is possible only for a type no contract uses, and only for Super Admin.',
        ],
      },
    ],
    related: ['master-data-center'],
  },
  {
    id: 'maintenance-frequencies',
    title: 'Maintenance Frequencies',
    group: 'Master Data Center',
    access: { kind: 'nav', path: '/master-data/maintenance-frequencies' },
    pages: ['/master-data/maintenance-frequencies'],
    guideChapter: 'Master Data Center',
    summary: 'The frequency rules that schedule generation follows, such as Monthly, Quarterly or a custom choice of months.',
    sections: [
      {
        heading: 'Scheduling rule',
        terms: [
          { term: 'Fixed interval', meaning: 'One service every N months (1, 2, 3, 4, 6 or 12). Services per year = 12 ÷ interval.' },
          { term: 'Custom months', meaning: 'The months are chosen on each contract (1 to 11 months).' },
          { term: 'Service code prefix', meaning: '1–4 letters used in service labels, e.g. Q3 = third quarterly service.' },
        ],
      },
      {
        heading: 'Rule lock',
        text: [
          'Once any contract uses a frequency, its code, rule, services per year, interval and prefix are locked; only the name and sort order can change. For a different rule, add a new frequency.',
        ],
      },
      {
        heading: 'Disable or archive',
        text: ['Contracts that use it keep it, and no scheduled or completed visit changes. It is no longer offered for new contracts or renewals.'],
      },
      {
        heading: 'Common errors',
        bullets: ['"With a 3-month interval, services per year must be 4."', '"Use 1-4 letters (for example Q or BM)."'],
      },
    ],
    related: ['schedule-engine'],
  },
  {
    id: 'departments',
    title: 'Departments',
    group: 'Master Data Center',
    access: { kind: 'nav', path: '/master-data/departments' },
    pages: ['/master-data/departments'],
    guideChapter: 'Master Data Center',
    summary: 'Business departments that sales engineers belong to. Not the same as user roles, which are managed in Roles & Permissions.',
    sections: [
      {
        heading: 'Fields and actions',
        bullets: [
          'Department code * (short and permanent, e.g. AMC or FIN), Department name *, Description.',
          'Linked engineers shows how many engineers are in the department.',
          'Departments can be disabled (needs Edit); there is no delete.',
        ],
      },
    ],
    related: ['sales-engineers'],
  },
]

const CONTRACTS: HelpTopic[] = [
  {
    id: 'amc-management',
    title: 'AMC Management',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/management' },
    pages: [],
    guideChapter: 'AMC Management',
    summary: 'AMC Management shows the Dashboard: exactly the same cards, figures, calendar and charts as the Dashboard page (client decision, 2026-11-09).',
    sections: [
      {
        heading: 'One shared Dashboard',
        bullets: [
          'AMC Management and Dashboard open the same page, with the same twelve cards in the same order, the same values and the same sections. See the Dashboard topic.',
          'It needs the same permission as the Dashboard (Dashboard: View). Each card and panel is shown only if your role can view its module, on both.',
          'Expiring contracts and renewals are followed on AMC Contracts (Validity filter) and AMC Renewal.',
        ],
      },
    ],
    related: ['dashboard', 'amc-contracts', 'amc-renewal'],
  },
  {
    id: 'amc-contracts',
    title: 'AMC Contracts',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/contracts' },
    pages: ['/amc/contracts'],
    guideChapter: 'AMC Contracts',
    summary: 'The contract register: every AMC contract with its client, system, validity, frequency, value and service progress.',
    sections: [
      {
        heading: 'Add a contract',
        steps: [
          'Click Add Contract (needs Create on AMC Contracts).',
          'Enter the AMC Reference Number (typed by you, unique, e.g. AMC-2026-001).',
          'Choose the Client, System, Sales engineer and Maintenance frequency (active records only).',
          'Enter Valid from and Valid to, or pick a Contract duration of 1–6 years.',
          'Enter AMC Value / Year and Final credit (0 when there is none); optionally a Default visit amount and a Billing basis.',
          'Attach the contract document (PDF or Word, up to 12 MB) and save. The contract is added as Active and its services are generated.',
        ],
      },
      {
        heading: 'Columns and colours',
        terms: [
          { term: 'Validity', meaning: 'Progress bar with days remaining.' },
          { term: 'Visits', meaning: 'Completed services out of the total.' },
          { term: 'Status', meaning: 'Draft (amber), Active (green), Expired (grey), Cancelled (red). "Validity ended" (amber) marks an Active contract past its end date.' },
        ],
      },
      {
        heading: 'Filters and export',
        bullets: [
          'Search by reference, client, system or engineer; filter by Client, System, Year, Sales engineer, Frequency, Validity and Status. Reset filters clears them.',
          'Validity → Due: Active contracts ending today or within 45 days (the AMC Renewal window).',
          'Validity → Expired: status Expired, or Active with its Valid To date passed. This is the same rule as the Expired figure, so the list and the figure always agree. A renewed contract still shows; its renewal never hides it.',
          'The Status filter uses the stored status only: an Active contract past its end date is listed under Validity → Expired, not under Status → Expired, until its status changes.',
          'Hide Columns can also hide the Contract column (the Upload Contract link). Your choice is remembered in this browser.',
          'Export (Excel or PDF) covers every filtered row and leaves out hidden columns.',
          'The footer shows the Filtered Total.',
        ],
      },
      {
        heading: 'Common errors',
        bullets: [
          '"AMC Reference Number already exists. Please enter a different number."',
          '"AMC Reference Number was used before by another contract and cannot be reused."',
          '"Valid to must be on or after Valid from." · "The validity period cannot be longer than 10 years."',
          '"Attach the contract document." · "Contract documents can be at most 12 MB."',
        ],
      },
    ],
    related: ['contract-360', 'billing-basis', 'schedule-engine'],
  },
  {
    id: 'contract-360',
    title: 'Contract 360',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/contracts' },
    pages: ['/amc/contracts/:id'],
    guideChapter: 'Contract 360',
    summary: 'Everything about one contract: figures, service schedule, invoices, renewals, documents and history, with the contract actions.',
    sections: [
      {
        heading: 'Contract actions (need Edit on AMC Contracts)',
        terms: [
          { term: 'Activate', meaning: 'Draft → Active. Generates the services; existing services are kept, missing ones added.' },
          { term: 'Mark as expired', meaning: 'Active → Expired. Optionally also cancels open services (never those with an Invoice No.).' },
          { term: 'Cancel contract', meaning: 'Needs Delete as well, and a reason. Nothing is deleted.' },
          { term: 'Reactivate', meaning: 'Expired or Cancelled → Active.' },
          { term: 'Edit', meaning: 'Changing dates or frequency of an Active contract shows a "Confirm schedule change" step listing services added, removed and kept.' },
        ],
      },
      {
        heading: 'Service schedule tab',
        bullets: [
          'The Calculation rule panel shows the Billing basis, visit amount, frequency and validity.',
          'Regenerate (Active contracts with a Billing Basis) recalculates amounts after a preview and a reason.',
          'Invoice No. can be entered on completed services (needs Edit on Invoice Tracking). Colour can be set by hand (needs Edit on AMC Schedule).',
          'Schedule history lists each generation with its reason and counts.',
        ],
      },
      {
        heading: 'Other tabs',
        bullets: [
          'Invoices: the Zoho invoices recorded against this contract’s services.',
          'Renewals: what this contract renews and what renews it; Create renewal.',
          'Documents: the contract document and other files.',
          'Contract history: every change, with who and when.',
          'Details: description, notes, duration and linked master records.',
        ],
      },
      {
        heading: 'Figures',
        text: [
          '"Expected for the term less visits" compares the term’s annual amounts with the sum of the service amounts. A difference is information, not an error: hand-set or preserved amounts cause one. Without a Billing Basis it shows "Not compared".',
        ],
      },
    ],
    related: ['regenerate', 'billing-basis', 'amc-renewal'],
  },
  {
    id: 'schedule-engine',
    title: 'Schedule Engine',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/contracts' },
    pages: [],
    guideChapter: 'Schedule Engine',
    summary: 'How services are generated from a contract’s validity and maintenance frequency. There is no background job: generation happens when a contract is saved, activated or regenerated.',
    sections: [
      {
        heading: 'How services are planned',
        bullets: [
          'Fixed interval: one service every N months counted from Valid from (31 Jan → 28/29 Feb → 31 Mar, no drift). The service date is the first day of its period.',
          'Custom months: one service in each selected month of every contract year, on the start date’s day of the month.',
          'Nothing is planned after Valid to; a short final period still gets a service.',
          'Each service is labelled by contract year and number, e.g. "Year 2 · Q3".',
        ],
      },
      {
        heading: 'When the schedule changes',
        bullets: [
          'On adding an Active contract, on Activate, and on editing the dates or frequency of an Active contract.',
          'Services already worked on are always kept: started or completed, rescheduled, with an amount set by hand, an Invoice No., a service report or quotation number, a colour or notes.',
          'Untouched services that no longer fit the terms are removed; missing ones are added.',
        ],
      },
      {
        heading: 'Common errors',
        bullets: [
          '"A schedule is generated only for an active contract. Activate the contract first."',
          '"Valid from cannot be changed: N visit(s) have already been worked on, edited or rescheduled. Record a new contract for different terms."',
          '"The validity period and frequency of an Expired contract cannot be changed. Reactivate the contract first."',
        ],
      },
    ],
    related: ['maintenance-frequencies', 'regenerate', 'amc-schedule'],
  },
]

const PAID_NOTE = 'Paid means a manual Invoice No. is entered on the service. It is a reference status and does not verify that money was received.'

const OPERATIONS: HelpTopic[] = [
  {
    id: 'amc-schedule',
    title: 'AMC Schedule',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/schedule' },
    pages: ['/amc/schedule'],
    guideChapter: 'AMC Schedule',
    summary: 'Every maintenance visit generated from the contracts, by scheduled date. Two views: All Visits and Monthly by AMC.',
    sections: [
      {
        heading: 'Filters',
        bullets: [
          'Month picker with ‹ › arrows, or All dates. Search by AMC reference, client, system or assigned person.',
          'Client, Status, System, Invoicing (Zoho) and Paid / Unpaid.',
          'The summary tiles (Due this month, Overdue, Completed this month, Ready for invoice) cover all clients and ignore the filters.',
        ],
      },
      {
        heading: 'Row actions',
        terms: [
          { term: 'View', meaning: 'Visit details, read only.' },
          { term: 'Edit', meaning: 'Visit amount, Scheduled date, Assigned to and Planning notes (needs Edit on AMC Schedule). Completed or cancelled visits cannot be rescheduled.' },
          { term: 'Visit actions', meaning: 'Update visit: start, complete, postpone or cancel (needs Edit on AMC Execution). Completing needs the Service Report uploaded on Service Status.' },
          { term: 'Invoice No. + OK', meaning: 'Enter the manual Invoice No. on a completed service to mark it Paid; clear it to return it to Unpaid. No invoice is generated.' },
        ],
      },
      {
        heading: 'Colours',
        terms: [
          { term: 'Visit status', meaning: 'Scheduled (blue), In progress (amber), Completed (green), Postponed (grey), Cancelled (red), Historical (grey). A red Overdue pill marks a late visit.' },
          { term: 'Service colour', meaning: 'Priority: Manual → Cancelled (grey) → Invoice Pending (amber) → First Service (light blue) → Normal (green). A manual colour wins over everything and changes the colour only.' },
        ],
      },
      {
        heading: 'Common errors',
        bullets: [
          '"Complete the service before entering an invoice number."',
          '"This visit cannot be given another amount: it is Paid with Invoice No. … Clear the Invoice No. first."',
          '"This service was changed by someone else after the page was loaded. Reload to see the latest values, then save again."',
        ],
      },
      { heading: 'Paid', text: [PAID_NOTE] },
    ],
    related: ['service-status', 'paid-vs-zoho', 'schedule-engine'],
  },
  {
    id: 'monthly-calendar',
    title: 'Monthly Calendar',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/calendar' },
    pages: ['/amc/calendar'],
    guideChapter: 'Monthly Calendar',
    summary: 'Scheduled services by year and by month, with values and Paid / Unpaid at a glance, and renewal warnings.',
    sections: [
      {
        heading: 'Views',
        bullets: [
          'Year view: Services in year, Scheduled value, Paid and Unpaid, then a card per month with values, Zoho invoiced figures and completed / open / overdue / cancelled counts. Each month can be downloaded in Excel or PDF (needs Export on Monthly Calendar).',
          'Month view, By service (default): one card per visit. Card colour = service status; the small square = Paid (green, Invoice No. entered) or Unpaid (blue). A red dot = overdue.',
          'Month view, By contract: the same services and filters, one entry per AMC contract with its services, state and Services / Paid / Unpaid counts. The switch is only in Month view.',
          'Clicking a visit opens its details, with Edit if your role allows.',
        ],
      },
      {
        heading: 'Filters',
        text: ['Search, Client, Sales engineer, System, Frequency, Visit status, Paid / Unpaid, and Billing status (Zoho): Invoiced, Not yet invoiced, No invoice required, Not completed, Cancelled.'],
      },
      {
        heading: 'Renewal warnings',
        text: ['The banner lists contracts ending within 45 days, or past validity and still marked Active, with a link to each.'],
      },
    ],
    related: ['amc-schedule', 'amc-renewal'],
  },
  {
    id: 'service-status',
    title: 'Service Status (completing a service)',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/service-status' },
    pages: ['/amc/service-status'],
    guideChapter: 'Service Status',
    summary: 'One row per scheduled service: completion, Service Report and report number. This is where services are completed.',
    sections: [
      {
        heading: 'Complete a service',
        steps: [
          'Filter to the month and find the service.',
          'Click Upload Report and choose the signed service report (PDF, DOC or DOCX).',
          'Set the status to Completed. Optionally type the Service Report No.',
          'Click Save in the row. Today’s date is recorded as the completion date.',
        ],
      },
      {
        heading: 'Completion is final',
        bullets: [
          'Without a report, choosing Completed shows "Please upload service report." and nothing is saved.',
          'Once saved as Completed, the status, completion date and report are locked for every user, Admin included. There is no reopen.',
          'Before completion the report can be replaced (the earlier version is kept) or removed.',
          'The Service Report No. and work notes can still be saved after completion.',
        ],
      },
      {
        heading: 'Service Report No. after Paid',
        bullets: [
          'Approved rule, switched on at the approved release: once the service is Paid (Invoice No. entered), its Service Report No. is locked.',
          'Super Admin and Admin can still change it by giving a reason; every change is recorded in the Audit Log. Clearing the Invoice No. unlocks it.',
          'Until the release the number stays editable as before.',
        ],
      },
      {
        heading: 'Statuses',
        terms: [
          { term: 'Completed (green)', meaning: 'The service is completed and locked.' },
          { term: 'Not Completed (blue)', meaning: 'Scheduled, in progress or postponed.' },
          { term: 'Waiting for Renewal (red)', meaning: 'The contract has expired or passed its validity and has no open renewal.' },
        ],
      },
      {
        heading: 'Filters and permissions',
        bullets: [
          'Defaults to the current month and year; Reset Filters clears them. Hide Columns chooses the columns shown.',
          'Saving, uploading and Actions need Edit on AMC Execution. Export needs Export on Service Status.',
        ],
      },
      {
        heading: 'AMC Value and Sales Engineer Name',
        bullets: [
          'AMC Value (OMR): the AMC Value / Year of the service’s contract, excluding VAT, to plan manpower and days. Shown only to users who may view AMC Contracts; it is the contract’s value repeated on each service, so it is not added up.',
          'Sales Engineer Name: typed by hand beside the Service Report No. and saved with the row’s Save (up to 120 characters). It is separate from the Sales Engineer column, which comes from the contract’s Sales Engineer master record.',
          'Changing the Sales Engineer Name needs Edit on AMC Execution and is recorded in the Audit Log. It is not locked by the Paid rule.',
        ],
      },
    ],
    related: ['amc-schedule', 'accounts', 'service-sales'],
  },
  {
    id: 'master-amc-status',
    title: 'Master AMC Status',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/master-status' },
    pages: ['/amc/master-status'],
    guideChapter: 'Master AMC Status',
    summary: 'Every scheduled service with its completion, invoice and quotation status, colour-coded. Read only.',
    sections: [
      {
        heading: 'Row colours (first rule that applies)',
        terms: [
          { term: 'Red', meaning: 'Not completed.' },
          { term: 'Yellow', meaning: 'Completed, invoice pending (Unpaid: no manual Invoice No.).' },
          { term: 'Blue', meaning: 'Paid, quote pending (no quotation number).' },
          { term: 'Green', meaning: 'Paid and quoted.' },
        ],
      },
      {
        heading: 'Filters',
        text: ['Search, Client, Sales Engineer, Scheduled month and year, Service Status, Paid / Unpaid, Quotation Status and Row Colour. Press Apply; Reset clears them.'],
      },
      {
        heading: 'Good to know',
        bullets: [
          'Zoho invoice numbers appear under the Invoice No. as "Zoho: …" and do not change the colour.',
          'The export adds Zoho Invoices (Tracking) and, separately, Zoho References (Tracking): each reference beside its invoice, "—" where none was recorded. Hiding Invoice No. hides both.',
          'Details opens every field of a row.',
          PAID_NOTE,
        ],
      },
      {
        heading: 'Values',
        bullets: [
          'The Value cell shows the service amount, the Zoho invoice amount allocated to it (Zoho:) and, for users who may view AMC Contracts, the contract’s AMC Value / Year.',
          'The Total Filtered row adds up every matching service on every page: service value, Paid (Invoice No.) value and Zoho Invoice Value. Services without a value are counted and left out of the sum.',
        ],
      },
    ],
    related: ['accounts', 'service-sales'],
  },
  {
    id: 'amc-renewal',
    title: 'AMC Renewal',
    group: 'AMC Operations',
    access: { kind: 'nav', path: '/amc/renewal' },
    pages: ['/amc/renewal'],
    guideChapter: 'AMC Renewal',
    summary: 'The renewal queue and renewal history. A renewal is a new contract; the contract it renews is never changed.',
    sections: [
      {
        heading: 'Renew a contract',
        steps: [
          'On Renewal Queue, find the contract (ending within 45 days or already ended) and click Start Renewal. On a contract page, Start Renewal opens the same form.',
          'The form is the Add AMC Contract form, filled from the contract being renewed (client, system, frequency, values). The contract being renewed is shown at the top.',
          'The AMC Reference Number is kept: the renewal shows the same contract number and is saved as its next version (Version 2, 3, …). Check the dates, value and active sales engineer, and add renewal notes.',
          'Attach the updated renewal contract document (PDF or Word, up to 12 MB). It is required; the old contract’s document is never reused.',
          'Click Create renewal. It is saved as a draft, Under Client Approval, with no schedule yet.',
          'When the client approves, click Approve: the renewal becomes Active and its services are generated.',
        ],
      },
      {
        heading: 'Renewal statuses',
        terms: [
          { term: 'Due / Expired (amber)', meaning: 'No renewal yet.' },
          { term: 'Under Client Approval (light blue)', meaning: 'A draft renewal exists.' },
          { term: 'Renewed (green)', meaning: 'The renewal is Active (or later Expired).' },
          { term: 'Cancelled (grey)', meaning: 'Every renewal made was cancelled; Restart Renewal starts a new one.' },
        ],
      },
      {
        heading: 'Permissions',
        bullets: ['Start Renewal: Create on AMC Renewal.', 'Approve: Edit on AMC Contracts.', 'Cancel: Edit and Delete on AMC Contracts, with a reason.', 'Export: Export on AMC Renewal.'],
      },
      {
        heading: 'Contract expiry',
        bullets: [
          'Approved rule, switched on at the approved release: an Active contract becomes Expired on the day after its Valid To date, by Oman time.',
          'Its services keep their status and values. An open renewal does not stop the old contract from expiring, and the renewal is not changed.',
          'Until the release, contracts past validity stay Active and are shown as past validity.',
        ],
      },
      {
        heading: 'One contract number, several versions',
        bullets: [
          'The original contract and all its renewals show the same contract number (approved 2026-11-09). Each renewal is its own contract period with its own version: STS-AMC-001 is version 1, its first renewal version 2, and so on.',
          'Lists, reports and exports show a renewal as "STS-AMC-001 (V2)", so every service, invoice and document stays with the right period. The contract page shows "Version 2".',
          'A version number is never reused: a cancelled renewal keeps its version and the next renewal takes the next one.',
          'The number still belongs to this contract only: no other contract can use it. Changing the number on any version changes it on every version.',
        ],
      },
    ],
    related: ['contract-360', 'sales-engineers'],
  },
]

const FINANCE: HelpTopic[] = [
  {
    id: 'accounts',
    title: 'Accounts (Invoice No. entry)',
    group: 'Finance',
    access: { kind: 'nav', path: '/finance/accounts' },
    pages: ['/finance/accounts'],
    guideChapter: 'Accounts',
    summary: 'Billing reconciliation of every scheduled service: completion, service report and Invoice No. Amounts are OMR excluding VAT.',
    sections: [
      {
        heading: 'Mark a service Paid',
        steps: [
          'Raise the invoice in Zoho as usual.',
          'In Accounts, filter to the month and find the completed (blue) service.',
          'Type the Zoho invoice number in Invoice No. and click OK. The row turns green (Paid).',
          'To undo, clear the box and click OK: the service returns to Unpaid.',
        ],
      },
      {
        heading: 'Row colours',
        terms: [
          { term: 'Red', meaning: 'Service not completed.' },
          { term: 'Blue', meaning: 'Completed, Unpaid.' },
          { term: 'Green', meaning: 'Completed, Paid (Invoice No. entered).' },
        ],
      },
      {
        heading: 'Filters and figures',
        bullets: [
          'Search, Client, Sales Engineer, AMC Contract, Scheduled month and year, Paid / Unpaid and Service Status. Press Apply.',
          'Figures: Rows, Completed, Not Completed, Invoice No. Filled, Total Value (Ex VAT).',
          'Entering a number needs Edit on Invoice Tracking; export needs Export on Accounts.',
        ],
      },
      { heading: 'Paid is a reference status', text: [PAID_NOTE, 'A Zoho record alone (shown as "Zoho: …") never makes a row green.'] },
      {
        heading: 'View Service Report',
        bullets: [
          'View Service Report (under the Service Report No.) opens the report uploaded on Service Status in a read-only viewer. Download is inside the viewer.',
          'A Word report cannot be previewed in the browser: the viewer offers Download. "No report uploaded" means none is on file yet.',
          'Viewing needs only View on Accounts. The file is fetched with your sign-in; there is no public link.',
        ],
      },
      {
        heading: 'Filtered totals and invoice values',
        bullets: [
          'The Total Filtered row adds up every service that matches the filters, on every page, not only the rows shown.',
          'Total Filtered Service Value (OMR): the scheduled service amounts, excluding VAT. Paid (Invoice No.) is the part with an Invoice No. entered: a reference status, not proof of payment.',
          'Total Filtered Invoice Value (OMR): the Zoho invoice amounts allocated to those services in Invoice Tracking. Cancelled invoices are left out. It is not the contract value.',
          'An empty Value with "No Billing Basis or Cost per Visit on the contract" means the contract gives no amount; no value is invented. Set a Billing Basis or Cost per Visit on the contract and Regenerate.',
        ],
      },
    ],
    related: ['paid-vs-zoho', 'invoice-tracking', 'invoice-acknowledgements'],
  },
  {
    id: 'invoice-acknowledgements',
    title: 'Invoice Acknowledgements',
    group: 'Finance',
    access: { kind: 'nav', path: '/finance/invoice-acknowledgements' },
    pages: ['/finance/invoice-acknowledgements'],
    guideChapter: 'Invoice Acknowledgements',
    summary:
      "The client's signed or stamped acknowledgement of each invoice: one row and one acknowledgement per invoice, even when it covers several services. Pending until a document is attached and confirmed, then Acknowledged in green.",
    sections: [
      {
        heading: 'One acknowledgement per invoice',
        bullets: [
          'Each row is one invoice. Linked Services (the count in the row) lists every service it covers; one document and one confirmation acknowledge them all.',
          'When Invoice Tracking holds a record of the invoice, that record decides its services. Otherwise each service’s Invoice No. starts as its own invoice.',
          'Equal Invoice Nos. are never merged automatically: they show Needs reconciliation until someone with Edit uses Reconcile to link them as one invoice or confirm they are separate.',
          'If two acknowledgements exist for one invoice (for example from the earlier per-service release), both are kept and none is chosen automatically: Reconcile → Make current.',
        ],
      },
      {
        heading: 'Acknowledge an invoice',
        steps: [
          'Find the invoice (filter Acknowledgement = Pending).',
          'Click Attach Acknowledgement, then Choose document: a PDF, PNG or JPEG of at most 12 MB. It is checked and saved to private storage, and its name is shown under Selected document. The invoice is still Pending.',
          'Check the name. Choose a different file or Remove it if it is wrong.',
          'Click OK / Confirm. The status turns green, Acknowledged, with the date and time (Oman) and your name.',
          'If an upload or the confirmation fails, the message is shown and the invoice stays Pending.',
        ],
      },
      {
        heading: 'Statuses',
        terms: [
          { term: 'Pending (amber)', meaning: 'No confirmed acknowledgement. "Document attached, awaiting OK / Confirm" means a document is waiting for confirmation.' },
          { term: 'Acknowledged (green)', meaning: 'The document was confirmed. Green appears only after the server has saved the confirmation.' },
        ],
      },
      {
        heading: 'View, download and replace',
        bullets: [
          'View Document opens the document in a viewer; Download is inside the viewer. The file is fetched with your sign-in: there is no public link. Earlier versions are listed under it.',
          'Replace Document (acknowledged invoices only) uploads a new version with a reason. The original acknowledged date and user stay; the earlier document is kept and the reason is in the Audit Log. Documents are never deleted.',
        ],
      },
      {
        heading: 'Who can do what',
        terms: [
          { term: 'View', meaning: 'Open the page, filter, view and download documents.' },
          { term: 'Create', meaning: 'Attach a document, remove it before confirming, and OK / Confirm.' },
          { term: 'Edit', meaning: 'Replace the document of an acknowledged invoice, with a reason; Reconcile invoices, with a reason.' },
          { term: 'Export', meaning: 'Excel or PDF of the filtered list.' },
          { term: 'Amounts', meaning: 'Service and invoice values are shown only to users who may also view Accounts.' },
          { term: 'Starting access', meaning: 'Super Admin and Admin: View, Create, Edit, Export. Finance Executive: View, Create, Export. Viewer and other roles: none.' },
        ],
      },
      {
        heading: 'Acknowledged is not payment',
        text: [
          'An acknowledgement only records that the client received the invoice. It does not change the Invoice No., the Paid / Unpaid reference status, any amount, the service status or anything in Zoho, and it does not mean money was received.',
          'Invoice Date and Invoice Value come from the invoice’s Invoice Tracking record, counted once per invoice, where one is recorded. Otherwise they show "—": nothing is invented.',
        ],
      },
    ],
    related: ['accounts', 'paid-vs-zoho'],
  },
  {
    id: 'invoice-tracking',
    title: 'Invoice Tracking (Zoho)',
    group: 'Finance',
    access: { kind: 'nav', path: '/invoices' },
    pages: ['/invoices'],
    guideChapter: 'Invoice Tracking',
    summary: 'Invoices raised in Zoho, recorded against the completed visits and projects they cover. STS-ELV AMC does not create invoices.',
    sections: [
      {
        heading: 'Record a Zoho invoice',
        steps: [
          'Under "Waiting for an invoice", find the completed work, or click Record Invoice.',
          'Choose the Client and enter the Invoice number and Invoice date exactly as on the Zoho invoice.',
          'Enter the Amount excluding VAT and the VAT amount (0 if none).',
          'Tick the visits or projects the invoice covers and enter an amount for each. The allocations must add up to the amount excluding VAT.',
          'Save. The work moves from Ready for invoice to Invoiced.',
        ],
      },
      {
        heading: 'Cancel an invoice record',
        text: ['Cancel (needs Edit) asks for a reason. The record is kept but left out of every total, and the work becomes ready for invoice again. It cannot be undone and does not cancel anything in Zoho.'],
      },
      {
        heading: 'Common errors',
        bullets: [
          '"Invoice … is already recorded. Cancel that record first if it was entered by mistake."',
          '"The allocations add up to X, but the invoice amount excluding VAT is Y. They must be equal."',
          '"Tick at least one visit or project that this invoice covers."',
        ],
      },
      { heading: 'Not the Paid status', text: ['Recording a Zoho invoice here does not mark a service Paid. Paid comes only from the manual Invoice No. in Accounts.'] },
    ],
    related: ['paid-vs-zoho', 'accounts'],
  },
  {
    id: 'service-sales',
    title: 'Service Sales (quotation numbers)',
    group: 'Finance',
    access: { kind: 'nav', path: '/amc/service-sales' },
    pages: ['/amc/service-sales'],
    guideChapter: 'Service Sales',
    summary: 'Track completed services and record the quotation number of any follow-up sale.',
    sections: [
      {
        heading: 'Record a quotation number',
        steps: ['Find the completed service (light blue, Completed / Quote Pending).', 'Type the Quote No. and click Save (needs Edit on Service Sales).', 'The row turns green; who saved it and when is shown.'],
      },
      {
        heading: 'Rules',
        bullets: [
          'Quote No. can be recorded only on completed services; elsewhere the cell shows N/A.',
          'Leave the field empty when there is no quotation; "N/A" is not accepted as a number.',
          'Up to 50 characters, no line breaks.',
        ],
      },
      {
        heading: 'Row colours',
        terms: [
          { term: 'Rose', meaning: 'Not Completed.' },
          { term: 'Light blue', meaning: 'Completed / Quote Pending.' },
          { term: 'Green', meaning: 'Completed with Quote No.' },
        ],
      },
      {
        heading: 'Totals',
        bullets: [
          'AMC Value (OMR) shows the AMC Value / Year of each service’s contract period (a renewal has its own). It is shown only to users who may view AMC Contracts, and can be hidden with Hide Columns.',
          'Total AMC Value of matching contracts adds up every contract period that has a matching service, on every page, counting each period once however many of its services match. It is not an invoice value or a payment.',
        ],
      },
    ],
    related: ['service-status', 'master-amc-status'],
  },
  {
    id: 'reports',
    title: 'Reports',
    group: 'Reporting',
    access: { kind: 'nav', path: '/reports' },
    pages: ['/reports'],
    guideChapter: 'Reports',
    summary: 'Reports from the live records, with the same figures as the source pages. Excel and PDF.',
    sections: [
      {
        heading: 'Run a report',
        steps: ['Choose a report in the Report list.', 'Set the filters it offers (From, To, Client, Sales Engineer, System, Status…).', 'Read the results on screen, or export to Excel or PDF (needs Export on Reports). Exports include the filters and a total line.'],
      },
      {
        heading: 'Who sees which report',
        bullets: [
          'Each report also needs View of its source page; exporting it also needs Export of that page. The list shows only the reports you may open.',
          'AMC Contracts: AMC Contract Summary, Contract Value Review. AMC Renewal: AMC Renewal, Expiry & Renewal Due, Renewal History.',
          'Accounts: Billing Schedule, Completed Services, Pending Services, Monthly Maintenance, Accounts / Paid and Unpaid Summary, Client-wise and Sales Engineer-wise Summary.',
        ],
      },
      {
        heading: 'Available reports',
        bullets: [
          'AMC Contract Summary · Billing Schedule (with Paid / Unpaid) · Completed Services · Pending Services · Monthly Maintenance',
          'AMC Renewal · Expiry & Renewal Due (active contracts ending within 90 days or past validity) · Renewal History',
          'Accounts / Paid and Unpaid Summary · Client-wise Summary · Sales Engineer-wise Summary',
          'Contract Value Review: flags multi-year contracts whose value may be whole-term rather than annual. It changes nothing.',
        ],
      },
      { heading: 'Paid in reports', text: [PAID_NOTE] },
      {
        heading: 'Monthly invoice values',
        bullets: [
          'Monthly Maintenance (and the client and sales engineer summaries) show, per scheduled month: Value, Unpaid Value, Paid Value (Invoice No. entered), Zoho Invoice Value (Invoice Tracking) and Services Without Value.',
          'They use the same services as Accounts, so for the same filters and period the totals match Accounts. An Invoice No. is a reference status, not proof that money was received.',
          'A report opens only with View on Reports and View on its source page (Accounts for these reports); exporting also needs Export on both.',
        ],
      },
    ],
    related: ['billing-basis', 'accounts'],
  },
]

const ADMINISTRATION: HelpTopic[] = [
  {
    id: 'users-and-roles',
    title: 'Users & Access',
    group: 'Administration',
    access: { kind: 'nav', path: '/admin/users' },
    pages: ['/admin/users'],
    guideChapter: 'Users and Roles',
    summary: 'Who can sign in, and with which role. Each user has one role.',
    sections: [
      {
        heading: 'Approve a sign-up',
        steps: [
          'A banner shows sign-up requests waiting for approval; filter Status = Pending.',
          'Assign a role (Change role), then Approve (needs Approve on Users). A pending account cannot sign in.',
          'Or Reject: the person must submit a new request to try again.',
        ],
      },
      {
        heading: 'Forgotten password',
        steps: [
          'Click Generate temporary password on the user’s row (Super Admin or Admin).',
          'Tick that you verified the person asking is the account owner.',
          'Pass on the password shown (once only). It works for 15 minutes and one sign-in, signs the user out everywhere, and must be changed at sign-in.',
        ],
      },
      {
        heading: 'Rules',
        bullets: [
          'Only Super Admin manages Super Admin and Admin accounts and assigns those roles.',
          'Super Admin and Admin may assign a custom role; Admin only one whose every permission Admin holds.',
          'You cannot change your own role or deactivate yourself.',
          'The last active Super Admin cannot lose the role.',
          'Changes apply on the user’s next request. Deactivation or a temporary password signs the user out everywhere; Security Center lists and ends open sessions.',
          'Statuses: Active, Inactive, Pending approval (amber), Rejected (grey); a temporary password shows its expiry.',
        ],
      },
    ],
    related: ['roles-permissions', 'login-history'],
  },
  {
    id: 'roles-permissions',
    title: 'Roles & Permissions',
    group: 'Administration',
    access: { kind: 'nav', path: '/admin/roles' },
    pages: ['/admin/roles'],
    guideChapter: 'Users and Roles',
    summary: 'What each role may do, module by module. Super Admin changes every role; Admin changes custom roles within its own permissions.',
    sections: [
      {
        heading: 'Built-in roles',
        terms: [
          { term: 'Super Admin', meaning: 'Fixed full access; cannot be edited or deactivated.' },
          { term: 'Admin', meaning: 'Operational and administrative access as configured by Super Admin.' },
          { term: 'Finance Executive', meaning: 'Starts with Invoice Tracking and Accounts.' },
          { term: 'Master Data Executive', meaning: 'Starts with the Master Data Center.' },
          { term: 'AMC Operations Executive', meaning: 'Starts with the AMC Operations pages and Service Sales.' },
          { term: 'Viewer', meaning: 'Starts with View only, and submitting suggestions.' },
        ],
      },
      {
        heading: 'How permissions work',
        bullets: [
          'Actions: View, Create, Edit, Delete, Approve, Export and Data read. Every action needs View; cancelling a contract also needs Edit.',
          'Data read shows a module’s data inside another page (for example client names in the contract form) without opening that module’s pages.',
          'Starting grants are only a starting point; Super Admin may change them. Users permissions never go to the four operational roles.',
          'Saved permissions apply immediately. If someone else saved first, nothing is overwritten.',
          'Fixed access (Audit Log, Recycle Bin, Security Center, Backup) cannot be changed here.',
        ],
      },
      {
        heading: 'Custom roles: who may change what',
        bullets: [
          'Add custom roles in Settings → Organization → Role list; set their permissions here.',
          'Super Admin: every role, except Super Admin’s own permissions; may give a role Users & Access.',
          'Admin (needs Edit on Users & Access): adds custom roles and changes those whose every permission Admin holds. Never a built-in role, never its own role, never Super Admin or Admin, and never gives a role Users & Access (may remove it).',
          'Nobody grants, removes or assigns a permission they do not hold. The server enforces every rule; a role you may not change shows why.',
        ],
      },
    ],
    related: ['users-and-roles'],
  },
  {
    id: 'login-history',
    title: 'Login History',
    group: 'Administration',
    access: { kind: 'nav', path: '/admin/login-history' },
    pages: ['/admin/login-history'],
    guideChapter: 'Login History',
    summary: 'Every sign-in, successful or not, newest first. Read only.',
    sections: [
      {
        heading: 'Columns and filters',
        bullets: [
          'User, Outcome (Successful green / Failed amber), Network address, Browser / device.',
          'Failure reasons: No account with this email, Wrong password, Account inactive or awaiting approval, Temporary password expired.',
          'Filter by name/email/address, Outcome and dates. Export is for administrators.',
        ],
      },
      {
        heading: 'Typical use',
        text: ['Repeated failed sign-ins for one email may mean a forgotten password or an attempt to guess it. After 5 failures in 15 minutes from one address the sign-in is refused for a while.'],
      },
    ],
    related: ['security-center', 'audit-log'],
  },
  {
    id: 'audit-log',
    title: 'Audit Log',
    group: 'Administration',
    access: { kind: 'nav', path: '/admin/audit-log' },
    pages: ['/admin/audit-log'],
    guideChapter: 'Audit Log',
    summary: 'What was changed, by whom and when, across every module. Read only; Super Admin and Admin.',
    sections: [
      {
        heading: 'Reading the timeline',
        terms: [
          { term: 'Red dot', meaning: 'Removed or blocked (delete, cancel, deactivate, reject, failed).' },
          { term: 'Green dot', meaning: 'Created or enabled (create, approve, activate, restore, import, issue).' },
          { term: 'Blue dot', meaning: 'Changed (update, edit, assign, complete, status).' },
          { term: 'Grey dot', meaning: 'Other activity.' },
        ],
      },
      {
        heading: 'Filters',
        text: ['Quick ranges (Today, Last 7 days, Last 30 days), search, Module, Record type, User and dates. Optional columns show the changes, reason and network address. Export to Excel or PDF.'],
      },
    ],
    related: ['recycle-bin', 'regenerate'],
  },
  {
    id: 'recycle-bin',
    title: 'Recycle Bin',
    group: 'Administration',
    access: { kind: 'nav', path: '/admin/deletion-log' },
    pages: ['/admin/deletion-log'],
    guideChapter: 'Recycle Bin',
    summary: 'Records moved out of use, and the history of deletions, cancellations and restores.',
    sections: [
      {
        heading: 'Who sees what',
        bullets: ['Super Admin: Recycle Bin and Deletion History tabs.', 'Admin: Deletion History only.'],
      },
      {
        heading: 'Recycle Bin (Super Admin)',
        bullets: [
          'Holds AMC contracts, clients, system types and sales engineers moved there. Items stay until restored; nothing expires automatically.',
          'Restore brings a record back with the same code and links; the dialog lists anything that blocks it.',
          'Delete permanently: only clients, system types and sales engineers that were never used, after typing the record’s code. AMC contracts are never deleted permanently.',
          'A record still in use cannot be moved to the bin: deactivate it instead. Deactivated records are not in the bin.',
        ],
      },
      {
        heading: 'Deletion History',
        text: ['When, action (Deleted red, Cancelled amber, Deactivated grey, Restored green), record, its status now, user and details. Exportable.'],
      },
    ],
    related: ['audit-log'],
  },
  {
    id: 'security-center',
    title: 'Security Center',
    group: 'Administration',
    access: { kind: 'nav', path: '/settings/security' },
    pages: ['/settings/security', '/admin/security'],
    guideChapter: 'Security Center',
    summary: 'Access, sign-in activity, open sessions and the security settings in force. Super Admin and Admin.',
    sections: [
      {
        heading: 'Health checks',
        text: [
          'API, Database, Database updates, Last verified backup, Allowed web origins, Sign-in limits, Failed sign-ins (24 hours), Node runtime, HTTPS, Run mode, Security headers and Document storage. Each is OK (green), Attention (amber) or Not available (grey).',
          '"Backups are not available from this application here" is expected while in-app backups are not configured; backups are then taken outside the application.',
        ],
      },
      {
        heading: 'Also on this page',
        bullets: [
          'User access tiles: active, inactive, administrators, awaiting approval, must change password, active without a role.',
          'Settings in force: sign-in duration, password hashing, request limits, allowed web addresses, document storage.',
          'Security events of the last 30 days, filtered by type.',
          'Deactivating a user or changing a role takes effect on their next request.',
        ],
      },
      {
        heading: 'Active sessions',
        bullets: [
          'Every open session: user, device, address, when it signed in and when it was last used.',
          'Sign out ends that session at once; the person must sign in again. Sessions also end after 30 minutes without use.',
          'Before the release with migration 0108 the panel says server-side sessions are not enabled.',
        ],
      },
    ],
    related: ['backup-status', 'login-history'],
  },
  {
    id: 'backup-status',
    title: 'Backup & Restore',
    group: 'Administration',
    access: { kind: 'nav', path: '/settings/backups' },
    pages: ['/settings/backups', '/admin/backups'],
    guideChapter: 'Backup status',
    summary: 'The status of manual database backups. Super Admin and Admin see it; only Super Admin runs or downloads a backup.',
    sections: [
      {
        heading: 'When backups are not configured',
        text: [
          '"Manual backups are not available here" with the reason (no backup storage, or storage not declared durable). This is the current state of the hosted copy: backups are taken by the system owner outside the application.',
        ],
      },
      {
        heading: 'When configured',
        bullets: [
          'Back up now (Super Admin) runs a backup and verifies it. History shows Running (blue), Verified (green) or Failed (red), size, tables and checksum.',
          'Only verified backups whose checksum still matches can be downloaded. A backup holds every record, including password hashes: store it securely.',
          'There are no automatic backups, no automatic expiry and no restore from this screen. Restoring is a manual procedure into a new database.',
        ],
      },
      {
        heading: 'Scheduled off-site backups (prepared, not active)',
        text: [
          'Encrypted daily backups of the database and the private documents, with retention, verification, alerts and restore drills into an isolated copy, are prepared for the Hostinger server. They are not switched on and have not been run against production; switching them on needs the owner’s approval.',
        ],
      },
    ],
    related: ['security-center'],
  },
  {
    id: 'settings',
    title: 'Settings',
    group: 'Administration',
    access: { kind: 'nav', path: '/settings' },
    pages: ['/settings'],
    guideChapter: 'Settings',
    summary: 'Your preferences and password, organisation details, public holidays and system status.',
    sections: [
      {
        heading: 'Sections',
        bullets: [
          'My settings: profile (read only), theme, colour palette and sidebar style (kept in this browser), change password, sign out.',
          'Organization: company profile, Holidays (add the official Oman list or a single holiday), tax setup (read only).',
          'System: API and database status; Security Center and Backup & Restore for administrators.',
        ],
      },
    ],
    related: ['security-center', 'backup-status'],
  },
  {
    id: 'suggestions',
    title: 'Suggestions',
    group: 'Administration',
    access: { kind: 'module', module: 'SUGGESTIONS' },
    pages: ['/suggestions', '/suggestions/:id'],
    guideChapter: 'Suggestions',
    summary: 'Send an improvement idea, a bug report or a feature request, and follow the responses.',
    sections: [
      {
        heading: 'Send a suggestion',
        steps: [
          'Click the light-bulb button in the header (any page; the page is recorded with it).',
          'Choose Improvement, Bug or Feature; enter a subject (3–150 characters) and a description (10–4000).',
          'Submit. You get a reference number; follow it under My Suggestions in the account menu.',
        ],
      },
      {
        heading: 'Statuses',
        terms: [
          { term: 'Submitted (light blue)', meaning: 'Received, not yet reviewed.' },
          { term: 'Under Review (violet) / In Progress (amber)', meaning: 'Being looked at or worked on.' },
          { term: 'Resolved (green)', meaning: 'Done, with resolution notes. You may reopen it if it is not.' },
          { term: 'Closed (grey) / Reopened (rose)', meaning: 'Finished, or opened again.' },
        ],
      },
    ],
    related: ['suggestions-review'],
  },
  {
    id: 'suggestions-review',
    title: 'Suggestions Review',
    group: 'Administration',
    access: { kind: 'nav', path: '/admin/suggestions' },
    pages: ['/admin/suggestions'],
    guideChapter: 'Suggestions',
    summary: 'Suggestions and issues from every user: review, assign, respond and resolve. Nothing is ever deleted.',
    sections: [
      {
        heading: 'Working a suggestion',
        bullets: [
          'Open ones are listed first. Filter by status, type, submitter, assignee and date.',
          'Change status and assignment (needs Edit on Suggestions Review). Resolving needs resolution notes; reopening, or closing one that was not resolved, needs a reason.',
          'Internal notes are not shown to the submitter.',
        ],
      },
    ],
    related: ['suggestions'],
  },
]

export const HELP_TOPICS: HelpTopic[] = [...GENERAL, ...MASTER_DATA, ...CONTRACTS, ...OPERATIONS, ...FINANCE, ...ADMINISTRATION]
