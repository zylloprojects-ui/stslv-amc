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
  const total = catalogue.modules.length * catalogue.actions.length
  const share = total > 0 ? Math.round((selected.size / total) * 100) : 0

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

  // Grants or clears a whole module row. Nobody can grant or revoke a permission they do not hold; the API enforces this too.
  const setModule = (module: Module, on: boolean) => {
    setSaved(false)
    setSelected((current) => {
      const next = new Set(current)
      for (const action of catalogue.actions) {
        if (auth.can(module, action)) {
          if (on) {
            next.add(keyOf(module, action))
          } else {
            next.delete(keyOf(module, action))
          }
        }
      }
      return next
    })
  }

  return (
    <div>
      <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-lg font-bold text-[#0b3b66]">{role.name}</h3>
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="h-2 min-w-32 flex-1 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
            <span className="block h-full rounded-full bg-gradient-to-r from-[#1479BD] to-[#4aa3df] transition-all duration-500" style={{ width: `${share}%` }} />
          </span>
          <span className="text-xs font-semibold text-slate-600">
            <span className="text-base font-bold tabular-nums text-[#0b3b66]">{selected.size}</span> of {total} permissions · {share}%
          </span>
          {dirty && <Badge tone="amber">Unsaved changes</Badge>}
        </div>
      </div>

      <div className="space-y-3 p-4 pb-0">
        {!role.permissionsEditable && <Alert tone="info">The Admin role always has full access. Its permissions cannot be changed.</Alert>}
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
              <th scope="col" className={cx(TABLE.th, 'text-right')}>
                Access
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {catalogue.modules.map((module) => {
              const count = catalogue.actions.filter((action) => selected.has(keyOf(module, action))).length
              const full = count === catalogue.actions.length
              const level = count === 0 ? 'None' : full ? 'Full' : 'Partial'
              const open = editable && catalogue.actions.some((action) => auth.can(module, action))

              return (
                <tr key={module} className={TABLE.row}>
                  <th scope="row" className={cx(TABLE.td, 'whitespace-nowrap text-left font-semibold text-slate-900')}>
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
                          className="h-[18px] w-[18px] cursor-pointer rounded border-slate-300 accent-[#1479BD] disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`${MODULE_LABELS[module]}: ${ACTION_LABELS[action]}`}
                          checked={selected.has(key)}
                          disabled={!allowed || save.isPending}
                          onChange={(event) => toggle(key, event.target.checked)}
                        />
                      </td>
                    )
                  })}
                  <td className={cx(TABLE.td, 'whitespace-nowrap text-right')}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={cx(
                          'rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
                          full ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : count === 0 ? 'bg-slate-100 text-slate-500 ring-slate-200' : 'bg-sky-50 text-[#0b3b66] ring-sky-200',
                        )}
                      >
                        {level}
                      </span>
                      {open && (
                        <button
                          type="button"
                          disabled={save.isPending}
                          onClick={() => setModule(module, !full)}
                          className="text-xs font-semibold text-[#1479BD] hover:underline disabled:opacity-50"
                          aria-label={`${full ? 'Clear all permissions for' : 'Grant all permissions for'} ${MODULE_LABELS[module]}`}
                        >
                          {full ? 'Clear' : 'All'}
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableScroll>
    </div>
  )
}

export function RolesPanel({ catalogue, canEdit }: { catalogue: RolesResponse; canEdit: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(catalogue.roles[0]?.id ?? null)
  const role = catalogue.roles.find((candidate) => candidate.id === selectedId) ?? null
  const total = catalogue.modules.length * catalogue.actions.length

  return (
    <div className="space-y-4">
      <Alert tone="info">
        The permissions of the Accountant, Procurement, Execution and Invoicing roles are a provisional starting point and have
        not yet been approved by the business. Modules that are not built yet have no effect until they exist.
      </Alert>

      {/* minmax(0, …) lets the permission table scroll inside its card instead of widening the page. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <ul aria-label="Roles" className="space-y-3 self-start">
          {catalogue.roles.map((candidate) => {
            const on = candidate.id === selectedId
            const count = candidate.permissions.length
            const share = total > 0 ? Math.round((count / total) * 100) : 0

            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-label={candidate.name}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => setSelectedId(candidate.id)}
                  className={cx('surface relative block w-full overflow-hidden rounded-xl p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg', on && 'ring-2 ring-[#1479BD] ring-offset-1')}
                >
                  <span className={cx('absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b', on ? 'from-[#1479BD] to-[#0b3b66]' : 'from-[#4aa3df] to-[#1479BD]')} aria-hidden="true" />
                  <span className="flex items-start justify-between gap-2 pl-2" aria-hidden="true">
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-bold text-[#0b3b66]">{candidate.name}</span>
                      <span className="block text-xs text-slate-500">
                        {candidate.userCount} {candidate.userCount === 1 ? 'user' : 'users'}
                      </span>
                    </span>
                    {!candidate.isActive ? <Badge>Inactive</Badge> : !candidate.permissionsEditable ? <Badge tone="blue">Full access</Badge> : null}
                  </span>
                  <span className="mt-3 block pl-2" aria-hidden="true">
                    <span className="flex items-baseline justify-between text-xs text-slate-500">
                      <span>
                        <span className="text-base font-bold tabular-nums text-slate-900">{count}</span> of {total}
                      </span>
                      <span className="font-semibold">{share}%</span>
                    </span>
                    <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-200">
                      <span className="block h-full rounded-full bg-gradient-to-r from-[#1479BD] to-[#4aa3df]" style={{ width: `${share}%` }} />
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <Card className="min-w-0">
          {/* key: reset the unsaved selection when another role is chosen or the saved data changes. */}
          {role && <PermissionMatrix key={`${role.id}:${keysOf(role).join(',')}`} role={role} catalogue={catalogue} canEdit={canEdit} />}
        </Card>
      </div>
    </div>
  )
}
