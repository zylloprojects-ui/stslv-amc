import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Badge, Button, Card, TableScroll } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import { ACTION_LABELS, MODULE_LABELS, type Action, type Module, type Role, type RolesResponse } from '../../lib/types'

const keyOf = (module: Module, action: Action) => `${module}:${action}`
const keysOf = (role: Role) => role.permissions.map((permission) => keyOf(permission.module, permission.action))

function PermissionMatrix({ role, catalogue, canEdit }: { role: Role; catalogue: RolesResponse; canEdit: boolean }) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(keysOf(role)))
  const [saved, setSaved] = useState(false)

  const original = new Set(keysOf(role))
  const dirty = selected.size !== original.size || [...selected].some((key) => !original.has(key))
  const editable = canEdit && role.permissionsEditable

  const save = useMutation({
    mutationFn: () =>
      api.put<Role>(`/roles/${role.id}/permissions`, {
        permissions: [...selected].map((key) => {
          const [module, action] = key.split(':')
          return { module, action }
        }),
      }),
    onSuccess: async () => {
      setSaved(true)
      // The signed-in user's own access may have changed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['roles'] }),
        queryClient.invalidateQueries({ queryKey: ['auth', 'me'] }),
      ])
    },
  })

  const toggle = (key: string, checked: boolean) => {
    setSaved(false)
    setSelected((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold text-slate-900">{role.name}</h3>
          {role.description && <p className="mt-0.5 text-sm text-slate-600">{role.description}</p>}
          <p className="mt-1 text-xs text-slate-500">
            {role.userCount} {role.userCount === 1 ? 'user' : 'users'} with this role
          </p>
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={!dirty || save.isPending} onClick={() => setSelected(new Set(keysOf(role)))}>
              Discard changes
            </Button>
            <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save permissions
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-3 p-4 pb-0">
        {!role.permissionsEditable && (
          <Alert tone="info">The Admin role always has full access. Its permissions cannot be changed.</Alert>
        )}
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        {saved && !dirty && <Alert tone="success">Permissions saved. They apply immediately.</Alert>}
      </div>

      <TableScroll label={`${role.name} permissions`} className="m-4">
        <table className={cx(TABLE.table, 'border border-slate-200')}>
          <caption className="sr-only">Permissions of the {role.name} role</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                Module
              </th>
              {catalogue.actions.map((action) => (
                <th key={action} scope="col" className={cx(TABLE.th, 'text-center')}>
                  {ACTION_LABELS[action]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {catalogue.modules.map((module) => (
              <tr key={module} className={TABLE.row}>
                <th scope="row" className={cx(TABLE.td, 'whitespace-nowrap text-left font-medium text-slate-900')}>
                  {MODULE_LABELS[module]}
                </th>
                {catalogue.actions.map((action) => {
                  const key = keyOf(module, action)
                  // Nobody can grant or revoke a permission they do not hold; the API enforces this too.
                  const allowed = editable && auth.can(module, action)

                  return (
                    <td key={action} className={cx(TABLE.td, 'text-center')}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 disabled:opacity-60"
                        aria-label={`${MODULE_LABELS[module]}: ${ACTION_LABELS[action]}`}
                        checked={selected.has(key)}
                        disabled={!allowed || save.isPending}
                        onChange={(event) => toggle(key, event.target.checked)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  )
}

export function RolesPanel({ catalogue, canEdit }: { catalogue: RolesResponse; canEdit: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(catalogue.roles[0]?.id ?? null)
  const role = catalogue.roles.find((candidate) => candidate.id === selectedId) ?? null

  return (
    <div className="space-y-4">
      <Alert tone="info">
        The permissions of the Accountant, Procurement, Execution and Invoicing roles are a provisional starting point and have
        not yet been approved by the business. Modules that are not built yet have no effect until they exist.
      </Alert>

      {/* minmax(0, …) lets the permission table scroll inside its card instead of widening the page. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Card className="self-start overflow-hidden">
          <ul aria-label="Roles" className="divide-y divide-slate-100">
            {catalogue.roles.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-current={candidate.id === selectedId ? 'true' : undefined}
                  onClick={() => setSelectedId(candidate.id)}
                  className={cx(
                    'flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm',
                    candidate.id === selectedId ? 'bg-blue-50 font-semibold text-blue-900' : 'text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <span className="min-w-0 break-words">{candidate.name}</span>
                  {!candidate.isActive && <Badge>Inactive</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="min-w-0">
          {/* key: reset the unsaved selection when another role is chosen or the saved data changes. */}
          {role && <PermissionMatrix key={`${role.id}:${keysOf(role).join(',')}`} role={role} catalogue={catalogue} canEdit={canEdit} />}
        </Card>
      </div>
    </div>
  )
}
