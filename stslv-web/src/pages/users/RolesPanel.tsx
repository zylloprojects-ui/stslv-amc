import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, TableScroll } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import {
  ACTION_LABELS,
  permissionSections,
  type Action,
  type Module,
  type PermissionCatalogEntry,
  type PermissionSection,
  type Role,
  type RolesResponse,
} from '../../lib/types'

const keyOf = (module: Module, action: Action) => `${module}:${action}`
const keysOf = (role: Role) => role.permissions.map((permission) => keyOf(permission.module, permission.action))

interface ModuleRowProps {
  entry: PermissionCatalogEntry
  retired: boolean
  actions: readonly Action[]
  selected: Set<string>
  original: Set<string>
  editable: boolean
  busy: boolean
  onChange: (keys: string[], on: boolean) => void
}

/** One module: the pages it governs, a box for every action the application uses, and the level of access. */
function ModuleRow({ entry, retired, actions, selected, original, editable, busy, onChange }: ModuleRowProps) {
  const auth = useAuth()
  const { module } = entry
  const used = actions.filter((action) => entry.actions[action] !== undefined)
  // Deny by default: only a used action of a current module can be newly granted. The API enforces this too.
  const grantable = retired ? [] : used
  // Nobody can grant or revoke a permission they do not hold; the API enforces this too. A grant already held can always be removed.
  const mayChange = (action: Action) => editable && auth.can(module, action) && (grantable.includes(action) || original.has(keyOf(module, action)))
  const count = used.filter((action) => selected.has(keyOf(module, action))).length
  const full = used.length > 0 && count === used.length
  const level = used.length === 0 ? 'Not used' : count === 0 ? 'None' : full ? 'Full' : 'Partial'
  const bulk = grantable.filter(mayChange).map((action) => keyOf(module, action))
  const bulkOn = bulk.length > 0 && bulk.every((key) => selected.has(key))

  return (
    <tr className={TABLE.row}>
      <th scope="row" className={cx(TABLE.td, 'text-left align-top font-normal')}>
        {/* A set width: a table cell's min-width gives way on a narrow screen. */}
        <div className="w-48 sm:w-64 lg:w-auto lg:min-w-56 lg:max-w-sm">
        <span className="block font-semibold text-slate-900">{entry.label}</span>
        {entry.pages.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {entry.pages.map((page) => (
              <span key={page.path} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
                {page.label}
                {page.alsoRequires && <span title="Also needs view access to the other modules it shows"> +</span>}
              </span>
            ))}
          </span>
        )}
        {entry.description && <span className="mt-1 hidden text-xs text-slate-500 sm:block">{entry.description}</span>}
        {used.length > 0 && (
          <details className="mt-1 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold text-[#1479BD]">What each action allows</summary>
            <dl className="mt-1 space-y-0.5">
              {used.map((action) => (
                <div key={action} className="flex gap-1.5">
                  <dt className="font-semibold text-slate-700">{ACTION_LABELS[action]}:</dt>
                  <dd>{entry.actions[action]}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        </div>
      </th>
      {actions.map((action) => {
        const key = keyOf(module, action)
        const isUsed = entry.actions[action] !== undefined

        // An action nothing checks is not offered, unless the role already holds it.
        if (!isUsed && !original.has(key)) {
          return (
            <td key={action} className={cx(TABLE.td, 'text-center align-top text-slate-300')}>
              <span aria-hidden="true">—</span>
              <span className="sr-only">{`${entry.label}: ${ACTION_LABELS[action]} is not used`}</span>
            </td>
          )
        }

        return (
          <td key={action} className={cx(TABLE.td, 'text-center align-top')}>
            <input
              type="checkbox"
              className="h-[18px] w-[18px] cursor-pointer rounded border-slate-300 accent-[#1479BD] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`${entry.label}: ${ACTION_LABELS[action]}${isUsed ? '' : ' (not used)'}`}
              title={isUsed ? entry.actions[action] : 'Not used by the application: this grant has no effect. It can be removed but not granted again.'}
              checked={selected.has(key)}
              disabled={!mayChange(action) || busy}
              onChange={(event) => onChange([key], event.target.checked)}
            />
            {!isUsed && <span className="mt-0.5 block text-[10px] font-semibold uppercase text-amber-700">No effect</span>}
          </td>
        )
      })}
      <td className={cx(TABLE.td, 'whitespace-nowrap text-right align-top')}>
        <span className="inline-flex items-center gap-2">
          <span
            className={cx(
              'rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
              full ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : count === 0 ? 'bg-slate-100 text-slate-500 ring-slate-200' : 'bg-sky-50 text-[#0b3b66] ring-sky-200',
            )}
          >
            {level}
          </span>
          {bulk.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChange(bulk, !bulkOn)}
              className="text-xs font-semibold text-[#1479BD] hover:underline disabled:opacity-50"
              aria-label={`${bulkOn ? 'Clear all permissions for' : 'Grant all permissions for'} ${entry.label}`}
            >
              {bulkOn ? 'Clear' : 'All'}
            </button>
          )}
        </span>
      </td>
    </tr>
  )
}

function SectionTable({ section, role, actions, children }: { section: PermissionSection; role: Role; actions: readonly Action[]; children: ReactNode }) {
  return (
    <TableScroll label={`${role.name} permissions: ${section.title}`}>
      <table className={cx(TABLE.table, 'border border-slate-200')}>
        <caption className="sr-only">
          {section.title} permissions of the {role.name} role
        </caption>
        <thead>
          <tr>
            <th scope="col" className={TABLE.th}>
              {section.title}
            </th>
            {actions.map((action) => (
              <th key={action} scope="col" className={cx(TABLE.th, 'text-center')}>
                {ACTION_LABELS[action]}
              </th>
            ))}
            <th scope="col" className={cx(TABLE.th, 'text-right')}>
              Access
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </TableScroll>
  )
}

/** Identifies a role with its saved permissions: the matrix is drawn afresh whenever it changes. */
const matrixKey = (role: Role) => `${role.id}:${keysOf(role).join(',')}`

interface PermissionMatrixProps {
  role: Role
  catalogue: RolesResponse
  canEdit: boolean
  /** The permissions shown are the ones just saved. Kept by the panel: saving redraws this matrix. */
  saved: boolean
  onSaved: (role: Role) => void
}

function PermissionMatrix({ role, catalogue, canEdit, saved, onSaved }: PermissionMatrixProps) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(keysOf(role)))

  const original = new Set(keysOf(role))
  const dirty = selected.size !== original.size || [...selected].some((key) => !original.has(key))
  const editable = canEdit && role.permissionsEditable
  const sections = permissionSections(catalogue)

  const save = useMutation({
    mutationFn: () =>
      api.put<Role>(`/roles/${role.id}/permissions`, {
        permissions: [...selected].map((key) => {
          const [module, action] = key.split(':')
          return { module, action }
        }),
      }),
    onSuccess: async (updated) => {
      onSaved(updated)
      // The signed-in user's own access may have changed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['roles'] }),
        queryClient.invalidateQueries({ queryKey: ['auth', 'me'] }),
      ])
    },
  })

  const change = (keys: string[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      for (const key of keys) {
        if (on) {
          next.add(key)
        } else {
          next.delete(key)
        }
      }
      return next
    })
  }

  const rows = (section: PermissionSection) =>
    section.modules.map((entry) => (
      <ModuleRow
        key={entry.module}
        entry={entry}
        retired={section.retired === true}
        actions={catalogue.actions}
        selected={selected}
        original={original}
        editable={editable}
        busy={save.isPending}
        onChange={change}
      />
    ))

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

      <div className="space-y-4 p-4">
        {sections
          .filter((section) => !section.retired)
          .map((section) => (
            <SectionTable key={section.title} section={section} role={role} actions={catalogue.actions}>
              {rows(section)}
            </SectionTable>
          ))}

        {sections
          .filter((section) => section.retired)
          .map((section) => {
            const held = section.modules.reduce((sum, entry) => sum + catalogue.actions.filter((action) => original.has(keyOf(entry.module, action))).length, 0)

            return (
              <details key={section.title} className="rounded-xl border border-amber-200 bg-amber-50/40">
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-800">
                  {section.title}{' '}
                  <span className="font-normal text-slate-600">
                    (no page in the current application; {held === 0 ? 'this role holds none of them' : `this role holds ${held} grant${held === 1 ? '' : 's'}, kept unchanged`})
                  </span>
                </summary>
                <div className="space-y-3 px-4 pb-4">
                  <p className="text-xs text-slate-600">Existing grants are kept and shown here. They can be removed, but nothing new can be granted on a retired module.</p>
                  <SectionTable section={section} role={role} actions={catalogue.actions}>
                    {rows(section)}
                  </SectionTable>
                </div>
              </details>
            )
          })}

        {catalogue.fixedAccess && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-sm text-slate-700">
            <h3 className="font-semibold text-slate-900">Not set by role permissions</h3>
            <p className="mt-1">
              <span className="font-semibold">Admin role only:</span> {catalogue.fixedAccess.adminOnly.map((page) => page.label).join(' · ')}
            </p>
            <p className="mt-1">
              <span className="font-semibold">Every signed-in user:</span> {catalogue.fixedAccess.everyone.map((page) => page.label).join(' · ')}
            </p>
            <p className="mt-1 text-xs text-slate-500">A page marked + also needs view access to the other modules whose data it shows.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function RolesPanel({ catalogue, canEdit }: { catalogue: RolesResponse; canEdit: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(catalogue.roles[0]?.id ?? null)
  // The matrix key of the permissions last saved, so the confirmation survives the redraw that follows a save.
  const [savedKey, setSavedKey] = useState<string | null>(null)
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
        {role && (
          <PermissionMatrix
            key={matrixKey(role)}
            role={role}
            catalogue={catalogue}
            canEdit={canEdit}
            saved={savedKey === matrixKey(role)}
            onSaved={(updated) => setSavedKey(matrixKey(updated))}
          />
        )}
      </Card>
    </div>
  )
}
