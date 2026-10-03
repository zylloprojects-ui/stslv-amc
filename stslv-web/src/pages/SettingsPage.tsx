import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { Badge, Card, PageHeader } from '../components/ui'
import { apiUrl } from '../lib/api'

interface HealthResponse {
  success: boolean
  database?: string
}

// The two health routes predate the { success, data } response format, so they are read directly.
async function fetchHealth(path: string): Promise<HealthResponse> {
  const response = await fetch(apiUrl(path), { headers: { Accept: 'application/json' } })
  const body = (await response.json().catch(() => null)) as HealthResponse | null

  if (!response.ok || !body?.success) {
    throw new Error('Unavailable')
  }

  return body
}

function StatusLine({ label, state, detail }: { label: string; state: 'checking' | 'ok' | 'down'; detail?: string | undefined }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium text-slate-900">{label}</p>
        {detail && <p className="text-xs text-slate-500">{detail}</p>}
      </div>
      {state === 'checking' && <Badge>Checking…</Badge>}
      {state === 'ok' && <Badge tone="green">Connected</Badge>}
      {state === 'down' && <Badge tone="amber">Unavailable</Badge>}
    </div>
  )
}

const stateOf = (query: { isPending: boolean; isError: boolean }) => (query.isPending ? 'checking' : query.isError ? 'down' : 'ok')

export function SettingsPage() {
  const auth = useAuth()
  const apiHealth = useQuery({ queryKey: ['health', 'api'], queryFn: () => fetchHealth('/api/health'), retry: false })
  const dbHealth = useQuery({ queryKey: ['health', 'database'], queryFn: () => fetchHealth('/api/health/database'), retry: false })

  return (
    <>
      <PageHeader title="Settings" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="self-start p-6">
          <h2 className="text-base font-semibold text-slate-900">System status</h2>
          <div className="mt-2 divide-y divide-slate-100">
            <StatusLine label="API" state={stateOf(apiHealth)} />
            <StatusLine
              label="Database"
              state={stateOf(dbHealth)}
              detail={dbHealth.data?.database ? `PostgreSQL database: ${dbHealth.data.database}` : undefined}
            />
          </div>
        </Card>

        <Card className="self-start p-6">
          <h2 className="text-base font-semibold text-slate-900">Business settings</h2>
          <p className="mt-2 text-sm text-slate-600">
            No business settings are configurable yet. They will be added here as the related modules are built and the
            business rules are confirmed.
          </p>
          {auth.can('USERS', 'VIEW') && (
            <p className="mt-4 text-sm text-slate-600">
              Roles and permissions are managed under{' '}
              <Link to="/admin/users" className="font-medium text-blue-700 hover:underline">
                Users & Access
              </Link>
              .
            </p>
          )}
        </Card>
      </div>
    </>
  )
}
