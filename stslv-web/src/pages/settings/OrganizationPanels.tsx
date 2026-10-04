import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { Badge, Card } from '../../components/ui'
import { api } from '../../lib/api'
import { DepartmentsPanel } from './DepartmentsPanel'
import { HolidaysPanel } from './HolidaysPanel'

export type OrganizationSection = 'company' | 'divisions' | 'departments' | 'holidays' | 'tax'

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <Card className="p-5 sm:p-7">
      <h2 className="text-xl font-bold tracking-tight text-[#0b3b66]">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      <div className="mt-6">{children}</div>
    </Card>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <div className="mt-1.5 break-words text-[15px] font-semibold text-slate-900">{children}</div>
    </div>
  )
}

/** Shown for a setting the system does not store yet. It says so plainly and invents no values. */
function NotSetUp({ what, why }: { what: string; why: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-sky-300 bg-sky-50/50 p-6 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-[#1479BD] shadow-sm ring-1 ring-sky-100" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <p className="mt-3 flex items-center justify-center gap-2 text-sm font-semibold text-[#0b3b66]">
        {what} <Badge tone="amber">Not set up yet</Badge>
      </p>
      <p className="mx-auto mt-1.5 max-w-lg text-sm text-slate-600">{why}</p>
    </div>
  )
}

function VatRate() {
  const auth = useAuth()
  const allowed = auth.can('PROJECTS', 'VIEW')
  const defaults = useQuery({ queryKey: ['projects', 'defaults'], queryFn: () => api.get<{ defaultVatRate: string }>('/projects/defaults'), enabled: allowed })

  if (!allowed) {
    return <span className="text-slate-500">Visible to people who may view Projects</span>
  }
  if (defaults.isPending) {
    return <span className="text-slate-500">Loading…</span>
  }
  if (defaults.isError) {
    return <span className="text-slate-500">Not available</span>
  }

  return <>{Number(defaults.data.defaultVatRate)}%</>
}

export function OrganizationPanel({ section }: { section: OrganizationSection }) {
  if (section === 'company') {
    return (
      <Panel title="Company profile" subtitle="The business that uses this system.">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <span className="flex h-24 w-24 shrink-0 items-center justify-center rounded-2xl bg-white shadow-lg ring-1 ring-sky-100">
            <img src="/stslv-logo.png" alt="" className="h-16 w-16 object-contain" />
          </span>
          <div>
            <p className="text-2xl font-bold tracking-tight text-[#0b3b66]">Smart Technical Service LLC</p>
            <p className="mt-0.5 text-sm text-slate-500">STSLEV AMC · Operations Suite</p>
          </div>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Fact label="Company">Smart Technical Service LLC</Fact>
          <Fact label="System">STSLEV AMC · Operations Suite</Fact>
        </div>
        <p className="mt-6 border-t border-slate-200 pt-5 text-xs text-slate-500">
          Address, registration and contact details are not stored by the system yet, so they cannot be edited here.
        </p>
      </Panel>
    )
  }

  if (section === 'divisions') {
    return (
      <Panel title="Divisions" subtitle="The parts of the business that work is grouped under.">
        <NotSetUp what="Divisions" why="The system does not record divisions yet. They will be added once the business confirms how its divisions are structured, so nothing is guessed here." />
      </Panel>
    )
  }

  if (section === 'departments') {
    return (
      <Panel title="Departments" subtitle="The departments of the business: add, edit or delete them. They are the same as the roles in Users & Access.">
        <DepartmentsPanel />
      </Panel>
    )
  }

  if (section === 'holidays') {
    return (
      <Panel title="Holidays" subtitle="Days the business or its customers are closed, by country. Listed year by year, January to December, with the official Oman holidays included.">
        <HolidaysPanel />
      </Panel>
    )
  }

  return (
    <Panel title="Tax setup" subtitle="How VAT is applied to project values.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Fact label="Default VAT rate on new projects">
          <VatRate />
        </Fact>
        <Fact label="Applied to">Project job value. Each project keeps its own rate.</Fact>
      </div>
      <p className="mt-6 border-t border-slate-200 pt-5 text-xs text-slate-500">
        The rate is shown as stored. Changing it, and any other tax rules, will be possible once the business confirms how VAT is configured.
      </p>
    </Panel>
  )
}
