// The Historical Data Review: every record of the client's earlier Excel
// registers, as the controlled import staged it. Read-only.

export const RECORD_KINDS = ['CLIENT', 'AMC_CONTRACT', 'AMC_VISIT', 'PROJECT'] as const

export type RecordKind = (typeof RECORD_KINDS)[number]

/** IMPORTED: the record is in the normal application. PROVISIONAL: it is held, and exists only in this review. */
export type ReviewStatus = 'IMPORTED' | 'PROVISIONAL'

export interface HoldReason {
  code: string
  message: string
}

export interface InvoiceReference {
  rawCell: string | null
  numbers: string[]
  classification: string
  notes: string[]
}

export interface ReviewLink {
  type: 'client' | 'contract' | 'visit' | 'project'
  id: string
  label: string
}

export interface ReviewRow {
  id: string
  batchId: string
  kind: RecordKind
  status: ReviewStatus
  source: { workbook: string; sheet: string; row: number; cell: string }
  identifier: string
  /** Every source value by column heading, exactly as read. Null is an empty cell. */
  rawValues: Record<string, string | null>
  /** The headings of rawValues in the order of the sheet. */
  sourceColumns: string[]
  /** What the import proposes to store. A value the source does not give is null. */
  proposedValues: Record<string, unknown>
  holdReasons: HoldReason[]
  warnings: string[]
  invoiceReference: InvoiceReference | null
  link: ReviewLink | null
}

export interface ReviewSummary {
  batches: { id: string; label: string; cutoverDate: string; sourceFiles: { name: string; sheet?: string; sha256: string }[]; createdAt: string; rows: number }[]
  totals: { records: number; imported: number; provisional: number }
  byKind: {
    kind: RecordKind
    total: number
    imported: number
    provisional: number
    /** Decimal strings. Null for client names, which carry no amount. */
    importedAmount: string | null
    provisionalAmount: string | null
    withoutAmount: number
  }[]
  clientNames: { distinct: number; clients: number }
  holdReasons: { kind: RecordKind; code: string; count: number }[]
  invoiceReferences: { byClassification: { kind: RecordKind; classification: string; count: number }[]; numbersMentioned: number; distinctNumbers: number }
}

export const KIND_LABELS: Record<RecordKind, string> = {
  CLIENT: 'Client name',
  AMC_CONTRACT: 'AMC contract',
  AMC_VISIT: 'AMC visit period',
  PROJECT: 'Project / job',
}

export const KIND_PLURALS: Record<RecordKind, string> = {
  CLIENT: 'Client names',
  AMC_CONTRACT: 'AMC contracts',
  AMC_VISIT: 'AMC visit periods',
  PROJECT: 'Projects / jobs',
}

/** What the amount of each kind is, as its register calls it. */
export const AMOUNT_LABELS: Record<RecordKind, string | null> = {
  CLIENT: null,
  AMC_CONTRACT: 'Contract value',
  AMC_VISIT: 'Period value',
  PROJECT: 'Job value',
}

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  IMPORTED: 'Imported',
  PROVISIONAL: 'Provisional',
}

const sentence = (code: string): string => {
  const words = code.replace(/_/g, ' ').toLowerCase()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

// A short name for each reason a record is provisional. The full explanation,
// with the rows concerned, comes with the record itself.
const REASON_LABELS: Record<string, string> = {
  CLIENT_ALIAS_NOT_APPROVED: 'Client name is a likely alias, not yet confirmed',
  CLIENT_IDENTITY_UNCONFIRMED: 'Client identity not confirmed',
  CLIENT_MISSING: 'Client is empty',
  NO_IMPORTABLE_RECORD_YET: 'Client waits for its first accepted record',
  MAINTENANCE_FREQUENCY_UNRESOLVED: 'Maintenance frequency not established',
  CONTRACT_HELD: 'Its contract is provisional',
  POSSIBLE_RENEWAL: 'Possible renewal, after the contract validity',
  NOT_HISTORY_AT_CUTOVER: 'Not history yet: starts on or after the cutover date',
  BEFORE_CONTRACT_START: 'Before the contract start',
  OFF_PERIOD_GRID: 'Not on the contract period grid',
  DUPLICATE_PERIOD: 'Period listed more than once',
  NO_MATCHING_CONTRACT: 'No matching contract',
  SCHEDULE_LABEL_NOT_UNDERSTOOD: 'Schedule label not understood',
  DUPLICATE_JOB_NUMBER: 'Job number used on more than one row',
  JOB_NUMBER_ALREADY_IN_DATABASE: 'Job number already in use',
  JOB_NUMBER_MISSING: 'Job number is empty',
  JOB_VALUE_BLANK: 'Job value is empty',
  JOB_VALUE_INVALID: 'Job value is not an amount',
  VAT_NOT_CONFIRMED: 'VAT rate not confirmed by the register',
  CONTRACT_VALUE_BLANK: 'Contract value is empty',
}

export const reasonLabel = (code: string): string => REASON_LABELS[code] ?? sentence(code)

const INVOICE_LABELS: Record<string, string> = {
  NO_INVOICE_REFERENCE: 'No invoice reference',
  ONE_JOB_ONE_INVOICE: 'One invoice',
  AMC_PERIOD_ONE_INVOICE: 'One invoice',
  JOB_HAS_MULTIPLE_INVOICES: 'Several invoices on one job',
  INVOICE_ON_MULTIPLE_JOBS_SAME_CLIENT: 'Invoice shared by jobs of one client',
  INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT: 'Invoice shared by jobs of different clients',
  JOB_HAS_MULTIPLE_INVOICES_AND_SHARED: 'Several invoices, at least one shared',
  NON_NUMERIC_MARKER: 'A word, not an invoice number',
}

export const invoiceLabel = (classification: string): string => INVOICE_LABELS[classification] ?? sentence(classification)

const CLASSIFICATION_LABELS: Record<string, string> = {
  KEEP_SEPARATE: 'Used as written',
  SAFE_NORMALIZATION: 'Spaces or letter case only',
  PROPOSED_ALIAS: 'Proposed alias',
  CLIENT_CONFIRMATION_REQUIRED: 'Needs confirmation',
}

const OUTCOME_LABELS: Record<string, string> = {
  EXISTING_CLIENT: 'Uses a client already in the application',
  PROPOSED_NEW_CLIENT: 'Client record',
  ALIAS_OF_PROPOSED_CLIENT: 'Confirmed alias of the client',
  HELD_ALIAS_NOT_APPROVED: 'Alias not yet confirmed',
  HELD_IDENTITY_UNCONFIRMED: 'Identity not confirmed',
}

const FREQUENCY_LABELS: Record<string, string> = {
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half-yearly',
  ANNUALLY: 'Annually',
}

/** The values the import proposes, in the order and wording they are shown. Keys not listed are not shown. */
export const PROPOSED_FIELDS: Record<RecordKind, { key: string; label: string; format?: 'money' | 'rate' | 'date' | 'month' | 'occurrences' | 'lookup' }[]> = {
  CLIENT: [
    { key: 'masterName', label: 'Client record' },
    { key: 'normalizedName', label: 'Name without extra spaces' },
    { key: 'classification', label: 'Mapping', format: 'lookup' },
    { key: 'outcome', label: 'Result', format: 'lookup' },
    { key: 'mappingReason', label: 'Why' },
    { key: 'occurrences', label: 'Used in', format: 'occurrences' },
  ],
  AMC_CONTRACT: [
    { key: 'clientName', label: 'Client' },
    { key: 'systemDescription', label: 'System' },
    { key: 'responsibleEngineer', label: 'Engineer' },
    { key: 'validFrom', label: 'Valid from', format: 'date' },
    { key: 'validTo', label: 'Valid to', format: 'date' },
    { key: 'contractValue', label: 'Contract value', format: 'money' },
    { key: 'finalCredit', label: 'Final credit (as written)', format: 'money' },
    { key: 'maintenanceFrequency', label: 'Maintenance frequency', format: 'lookup' },
    { key: 'sourceFrequency', label: 'Frequency in the source' },
    { key: 'defaultVisitAmount', label: 'Amount per visit', format: 'money' },
    { key: 'status', label: 'Status in the application', format: 'lookup' },
    { key: 'sourceVisitCount', label: 'Schedule rows in the source' },
    { key: 'historicalVisitCount', label: 'Of which historical visits' },
  ],
  AMC_VISIT: [
    { key: 'clientName', label: 'Client' },
    { key: 'systemDescription', label: 'System' },
    { key: 'sourceLabel', label: 'Period label in the source' },
    { key: 'sequenceNo', label: 'Period of the contract' },
    { key: 'periodStart', label: 'Period start', format: 'date' },
    { key: 'periodEnd', label: 'Period end', format: 'date' },
    { key: 'visitAmount', label: 'Period value', format: 'money' },
    { key: 'status', label: 'Status in the application', format: 'lookup' },
  ],
  PROJECT: [
    { key: 'jobNumber', label: 'Job number' },
    { key: 'clientName', label: 'Client' },
    { key: 'description', label: 'Description' },
    { key: 'sourceJobDate', label: 'Month in the source' },
    { key: 'legacyStatus', label: 'Status in the source' },
    { key: 'jobValue', label: 'Job value', format: 'money' },
    { key: 'vatRate', label: 'VAT rate', format: 'rate' },
    { key: 'vatAmount', label: 'VAT', format: 'money' },
    { key: 'grandValue', label: 'Grand value', format: 'money' },
    { key: 'legacyProfit', label: 'Profit in the source (not the job margin)', format: 'money' },
    { key: 'status', label: 'Status in the application', format: 'lookup' },
  ],
}

const VALUE_LABELS: Record<string, string> = {
  ...CLASSIFICATION_LABELS,
  ...OUTCOME_LABELS,
  ...FREQUENCY_LABELS,
  DRAFT: 'Draft',
  HISTORICAL: 'Historical',
}

export const valueLabel = (value: string): string => VALUE_LABELS[value] ?? value

/** "Jobs.xlsx · Register · row 10", with the cell where one sheet row holds several records. */
export function sourceReference(source: ReviewRow['source']): string {
  return `${source.workbook} · ${source.sheet} · row ${source.row}${source.cell ? ` (cell ${source.cell})` : ''}`
}

/** The amount a record carries in its source, or null when it gives none. Never a number: a decimal string. */
export function sourceAmount(row: ReviewRow): string | null {
  const key = { CLIENT: null, AMC_CONTRACT: 'contractValue', AMC_VISIT: 'visitAmount', PROJECT: 'jobValue' }[row.kind]
  const value = key === null ? null : row.proposedValues[key]

  return typeof value === 'string' ? value : null
}
