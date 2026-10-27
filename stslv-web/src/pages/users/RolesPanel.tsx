import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, TableScroll } from '../../components/ui'
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
      {editable && (
        <div className="flex flex-wrap justify-end gap-2 px-4 pt-4">
          <Button variant="secondary" size="sm" disabled={!dirty || save.isPending} onClick={() => setSelected(new Set(keysOf(role)))}>
            Discard changes
          </Button>
          <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Save permissions
          </Button>
        </div>
      )}

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

  return (
    <div className="space-y-4">
      <ul aria-label="Roles" className="flex flex-wrap gap-2">
        {catalogue.roles.map((candidate) => {
          const on = candidate.id === selectedId

          return (
            <li key={candidate.id}>
              <button
                type="button"
                aria-current={on ? 'true' : undefined}
                onClick={() => setSelectedId(candidate.id)}
                className={cx(
                  'rounded-full px-4 py-1.5 text-sm font-semibold ring-1 ring-inset transition-colors',
                  on ? 'bg-[#1479BD] text-white ring-[#1479BD]' : 'bg-white text-slate-700 ring-slate-300 hover:bg-sky-50 hover:text-[#0b3b66]',
                )}
              >
                {candidate.name}
                {!candidate.isActive && <span className="ml-1.5 text-xs font-normal opacity-80">(inactive)</span>}
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
  )
}
