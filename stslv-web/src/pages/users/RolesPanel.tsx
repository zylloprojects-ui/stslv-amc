import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, ConfirmDialog, TableScroll } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import { dependencyNote, dependentActions, requiredActions } from '../../lib/permissionRules'
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

type Level = 'Full' | 'Partial' | 'None'

const levelOf = (held: number, total: number): Level => (held === 0 ? 'None' : held === total ? 'Full' : 'Partial')

function LevelBadge({ level }: { level: Level }) {
  return (
    <span
      className={cx(
        'rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        level === 'Full' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : level === 'None' ? 'bg-slate-100 text-slate-500 ring-slate-200' : 'bg-sky-50 text-[#0b3b66] ring-sky-200',
      )}
    >
      {level}
    </span>
  )
}

/**
 * What one role may be given and the signed-in user may change, per permission. Deny by default:
 * only an action the application uses, of a current module, within the role's scope can be newly
 * granted; a grant already held can always be removed. The API enforces every rule here too.
 */
interface Rules {
  /** Shown as a checkbox: grantable to this role, or already held. */
  shown: (entry: PermissionCatalogEntry, retired: boolean, action: Action) => boolean
  /** May be newly granted to this role. */
  available: (entry: PermissionCatalogEntry, retired: boolean, action: Action) => boolean
  /** The signed-in user may tick or untick it. */
  mayChange: (entry: PermissionCatalogEntry, retired: boolean, action: Action) => boolean
}

function useRules(role: Role, editable: boolean, original: Set<string>): Rules {
  const auth = useAuth()
  const scope = role.scope ? new Set(role.scope) : null

  const available = (entry: PermissionCatalogEntry, retired: boolean, action: Action) =>
    !retired && entry.actions[action] !== undefined && (scope === null || scope.has(keyOf(entry.module, action)))
  const shown = (entry: PermissionCatalogEntry, retired: boolean, action: Action) =>
    entry.actions[action] !== undefined && (available(entry, retired, action) || original.has(keyOf(entry.module, action)))
  // Nobody can grant or revoke a permission they do not hold.
  const mayChange = (entry: PermissionCatalogEntry, retired: boolean, action: Action) => editable && auth.can(entry.module, action) && shown(entry, retired, action)

  return { shown, available, mayChange }
}

/** Removes, repeatedly, every grant of a current module whose required actions are not all held. */
function closeDependencies(keys: Set<string>, sections: PermissionSection[]): Set<string> {
  const next = new Set(keys)
  let changed = true

  while (changed) {
    changed = false
    for (const section of sections) {
      if (section.retired) continue
      for (const entry of section.modules) {
        for (const action of Object.keys(entry.actions) as Action[]) {
          const key = keyOf(entry.module, action)
          if (next.has(key) && requiredActions(entry.module, action).some((needed) => !next.has(keyOf(entry.module, needed)))) {
            next.delete(key)
            changed = true
          }
        }
      }
    }
  }

  return next
}

interface ModuleRowProps {
  entry: PermissionCatalogEntry
  retired: boolean
  actions: readonly Action[]
  selected: Set<string>
  rules: Rules
  busy: boolean
  onToggle: (entry: PermissionCatalogEntry, action: Action, on: boolean) => void
  onBulk: (entry: PermissionCatalogEntry, retired: boolean, on: boolean) => void
}

/** One module: the pages it governs, a box for every action the role may hold, and its level of access. */
function ModuleRow({ entry, retired, actions, selected, rules, busy, onToggle, onBulk }: ModuleRowProps) {
  const { module } = entry
  const shown = actions.filter((action) => rules.shown(entry, retired, action))
  const readKey = keyOf(module, 'READ')
  // Data-only Read: offered where the module has it, unless the role already sees the module (View covers it).
  const readShown = rules.shown(entry, retired, 'READ') && (selected.has(readKey) || !selected.has(keyOf(module, 'VIEW')))
  const counted = readShown ? [...shown, 'READ' as const] : shown
  const held = counted.filter((action) => selected.has(keyOf(module, action))).length
  const bulk = counted.filter((action) => rules.available(entry, retired, action) && rules.mayChange(entry, retired, action) && !(action === 'READ' && shown.includes('VIEW')))
  const bulkOn = bulk.length > 0 && bulk.every((action) => selected.has(keyOf(module, action)))

  // Turning an action on also turns on what it needs; that must be possible.
  const canTurnOn = (action: Action): boolean =>
    requiredActions(module, action).every((needed) => selected.has(keyOf(module, needed)) || (rules.mayChange(entry, retired, needed) && rules.available(entry, retired, needed)))
  // Turning it off also turns off what depends on it; that must be possible too.
  const canTurnOff = (action: Action): boolean =>
    dependentActions(module, action, actions).every((dependent) => !selected.has(keyOf(module, dependent)) || rules.mayChange(entry, retired, dependent))

  return (
    <tr className={TABLE.row}>
      <th scope="row" className={cx(TABLE.td, 'text-left align-top font-normal')}>
        <div className="min-w-0 break-words">
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
          {readShown && (
            <label className="mt-2 flex items-start gap-2 rounded-md bg-sky-50/70 px-2 py-1.5 text-xs text-slate-700 ring-1 ring-inset ring-sky-100">
              <input
                type="checkbox"
                className="mt-px h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 accent-[#1479BD] disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`${entry.label}: ${ACTION_LABELS.READ}`}
                checked={selected.has(readKey)}
                disabled={busy || !rules.mayChange(entry, retired, 'READ') || (!selected.has(readKey) && !rules.available(entry, retired, 'READ'))}
                onChange={(event) => onToggle(entry, 'READ', event.target.checked)}
              />
              <span>
                <span className="font-semibold">{ACTION_LABELS.READ}</span>
                <span className="block text-slate-600">{entry.actions.READ?.replace(/^Data only: /, '')}</span>
              </span>
            </label>
          )}
          <details className="mt-1 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold text-[#1479BD]">What each action allows</summary>
            <dl className="mt-1 space-y-0.5">
              {counted.map((action) => {
                const note = retired ? null : dependencyNote(module, action, ACTION_LABELS)

                return (
                  <div key={action} className="flex gap-1.5">
                    <dt className="font-semibold text-slate-700">{ACTION_LABELS[action]}:</dt>
                    <dd>
                      {entry.actions[action]}
                      {note && <span className="text-slate-500"> {note}</span>}
                    </dd>
                  </div>
                )
              })}
            </dl>
          </details>
        </div>
      </th>
      {actions.map((action) => {
        const key = keyOf(module, action)

        // An action the module does not have, or this role may not hold: a plain empty cell.
        if (!shown.includes(action)) {
          return (
            <td key={action} className={cx(TABLE.td, 'bg-slate-50/80')}>
              <span className="sr-only">{`${entry.label}: ${ACTION_LABELS[action]} is not available for this role`}</span>
            </td>
          )
        }

        const on = selected.has(key)
        const blocked = !rules.mayChange(entry, retired, action) || (on ? !canTurnOff(action) : !canTurnOn(action) || !rules.available(entry, retired, action))

        return (
          <td key={action} className={cx(TABLE.td, 'text-center align-top')}>
            <input
              type="checkbox"
              className="h-[18px] w-[18px] cursor-pointer rounded border-slate-300 accent-[#1479BD] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`${entry.label}: ${ACTION_LABELS[action]}`}
              title={entry.actions[action]}
              checked={on}
              disabled={blocked || busy}
              onChange={(event) => onToggle(entry, action, event.target.checked)}
            />
          </td>
        )
      })}
      <td className={cx(TABLE.td, 'whitespace-nowrap text-right align-top')}>
        <span className="inline-flex items-center gap-2">
          <LevelBadge level={levelOf(held, counted.length)} />
          {bulk.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onBulk(entry, retired, !bulkOn)}
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

function SectionTable({ title, role, actions, children }: { title: string; role: Role; actions: readonly Action[]; children: ReactNode }) {
  return (
    <TableScroll label={`${role.name} permissions: ${title}`}>
      {/* Fixed column widths, the same in every section, so the permission columns line up down the page. */}
      <table className={cx(TABLE.table, 'min-w-[52rem] table-fixed border border-slate-200')}>
        <caption className="sr-only">
          {title} permissions of the {role.name} role
        </caption>
        <colgroup>
          <col className="w-[34%]" />
          {actions.map((action) => (
            <col key={action} className="w-[9%]" />
          ))}
          <col className="w-[12%]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={TABLE.th}>
              {title}
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

/** Identifies a saved permission set. An older API sends no version: the set itself is then the identity. */
const versionOf = (role: Role) => role.permissionsVersion ?? [...keysOf(role)].sort().join(',')

interface PermissionMatrixProps {
  /** The role as last loaded. It may be newer than the set an edit started from. */
  role: Role
  catalogue: RolesResponse
  canEdit: boolean
  onDirtyChange: (dirty: boolean) => void
}

function PermissionMatrix({ role, catalogue, canEdit, onDirtyChange }: PermissionMatrixProps) {
  const queryClient = useQueryClient()
  // The saved set the current edit started from. A save sends its version; the API refuses it (409) if the set changed since.
  const [base, setBase] = useState<Role>(role)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(keysOf(role)))
  const [saved, setSaved] = useState(false)
  const [stale, setStale] = useState(false)

  const original = new Set(keysOf(base))
  const dirty = selected.size !== original.size || [...selected].some((key) => !original.has(key))
  // Another administrator saved this role since the edit started.
  const changedElsewhere = versionOf(role) !== versionOf(base)

  // A newer saved set arrived (a refresh, or someone else's save): show it, unless that would discard unsaved changes.
  if (changedElsewhere && !dirty) {
    setBase(role)
    setSelected(new Set(keysOf(role)))
    setStale(false)
  }

  const editable = canEdit && role.permissionsEditable && role.isActive
  const sections = permissionSections(catalogue)
  const actions = catalogue.actions
  // READ (data-only) has no column: it is offered under the module's name.
  const columns = actions.filter((action) => action !== 'READ')
  const rules = useRules(role, editable, original)

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const save = useMutation({
    mutationFn: () =>
      api.put<Role>(`/roles/${role.id}/permissions`, {
        expectedVersion: base.permissionsVersion,
        // Every grant the role holds is sent back, also one no row shows (an action the application no longer uses).
        permissions: [...selected].map((key) => {
          const [module, action] = key.split(':')
          return { module, action }
        }),
      }),
    onSuccess: async (updated) => {
      setBase(updated)
      setSelected(new Set(keysOf(updated)))
      setSaved(true)
      // The signed-in user's own access may have changed.
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['roles'] }), queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })])
    },
    onError: (error) => {
      // Someone else saved this role meanwhile: nothing was overwritten. Offer their version.
      if (error instanceof ApiError && error.status === 409) {
        setStale(true)
        void queryClient.invalidateQueries({ queryKey: ['roles'] })
      }
    },
  })

  /** Drops the unsaved changes and shows the permissions as saved now. */
  const loadLatest = () => {
    setBase(role)
    setSelected(new Set(keysOf(role)))
    setStale(false)
    setSaved(false)
    save.reset()
    void queryClient.invalidateQueries({ queryKey: ['roles'] })
  }

  const toggle = (entry: PermissionCatalogEntry, action: Action, on: boolean) => {
    setSaved(false)
    setSelected((current) => {
      const next = new Set(current)
      if (on) {
        for (const needed of requiredActions(entry.module, action)) next.add(keyOf(entry.module, needed))
        next.add(keyOf(entry.module, action))
      } else {
        next.delete(keyOf(entry.module, action))
        for (const dependent of dependentActions(entry.module, action, actions)) next.delete(keyOf(entry.module, dependent))
      }
      return next
    })
  }

  // What Select all / All may tick: data-only Read only where the role cannot have View (View covers it).
  const changeable = (entry: PermissionCatalogEntry, retired: boolean) =>
    actions.filter(
      (action) =>
        rules.available(entry, retired, action) && rules.mayChange(entry, retired, action) && !(action === 'READ' && rules.shown(entry, retired, 'VIEW')),
    )

  const setKeys = (keys: string[], on: boolean) => {
    setSaved(false)
    setSelected((current) => {
      const next = new Set(current)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return closeDependencies(next, sections)
    })
  }

  const bulk = (entry: PermissionCatalogEntry, retired: boolean, on: boolean) => setKeys(changeable(entry, retired).map((action) => keyOf(entry.module, action)), on)

  const current = sections.filter((section) => !section.retired)
  const everyChangeable = current.flatMap((section) => section.modules.flatMap((entry) => changeable(entry, false).map((action) => keyOf(entry.module, action))))
  const visibleModules = (section: PermissionSection) =>
    section.modules.filter((entry) => actions.some((action) => rules.shown(entry, section.retired === true, action)))

  // The role's overall level, over the permissions it may hold (a Read that View already covers is not counted).
  const totals = current.flatMap(visibleModules).reduce(
    (sum, entry) => {
      const shown = actions.filter(
        (action) =>
          rules.shown(entry, false, action) &&
          !(action === 'READ' && !selected.has(keyOf(entry.module, 'READ')) && selected.has(keyOf(entry.module, 'VIEW'))),
      )
      return { shown: sum.shown + shown.length, held: sum.held + shown.filter((action) => selected.has(keyOf(entry.module, action))).length }
    },
    { shown: 0, held: 0 },
  )

  const rows = (section: PermissionSection) =>
    visibleModules(section).map((entry) => (
      <ModuleRow
        key={entry.module}
        entry={entry}
        retired={section.retired === true}
        actions={columns}
        selected={selected}
        rules={rules}
        busy={save.isPending}
        onToggle={toggle}
        onBulk={bulk}
      />
    ))

  const legacy = sections.filter((section) => section.retired && visibleModules(section).length > 0)

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900">
            {role.name}
            <LevelBadge level={levelOf(totals.held, totals.shown)} />
          </h3>
          {role.description && <p className="mt-0.5 text-sm text-slate-600">{role.description}</p>}
          <p className="mt-0.5 text-xs text-slate-500">
            {totals.held} of {totals.shown} permissions · {role.userCount} {role.userCount === 1 ? 'user' : 'users'}
          </p>
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={save.isPending || everyChangeable.every((key) => selected.has(key))} onClick={() => setKeys(everyChangeable, true)}>
              Select all
            </Button>
            <Button variant="secondary" size="sm" disabled={save.isPending || everyChangeable.every((key) => !selected.has(key))} onClick={() => setKeys(everyChangeable, false)}>
              Clear all
            </Button>
            <Button variant="secondary" size="sm" disabled={!dirty || save.isPending} onClick={() => setSelected(new Set(keysOf(base)))}>
              Cancel
            </Button>
            <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save permissions
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-3 p-4 pb-0" aria-live="polite">
        {!role.permissionsEditable && <Alert tone="info">{role.lockedReason ?? 'This role always has full access. Its permissions cannot be changed.'}</Alert>}
        {!role.isActive && <Alert tone="info">This role is inactive: it cannot be assigned and grants nothing. Its permissions are kept for its history.</Alert>}
        {role.scope && role.isActive && <Alert tone="info">{role.name} is limited to its part of the application. Only the permissions it may hold are shown.</Alert>}
        {editable && dirty && <Alert tone="info">You have unsaved changes. Save them, or Cancel to go back to the saved permissions.</Alert>}
        {(stale || (dirty && changedElsewhere)) && (
          <Alert>
            <span className="block">
              {stale
                ? 'Not saved: someone else changed these permissions since you opened them. Nothing was overwritten.'
                : 'Someone else saved changes to these permissions since you opened them. Saving yours would be refused.'}
            </span>
            <button type="button" onClick={loadLatest} className="mt-1 font-semibold underline">
              Load the latest permissions
            </button>
          </Alert>
        )}
        {save.isError && !stale && <Alert>{errorMessage(save.error)}</Alert>}
        {saved && !dirty && <Alert tone="success">Permissions saved. They apply immediately.</Alert>}
      </div>

      <div className="space-y-4 p-4">
        {current
          .filter((section) => visibleModules(section).length > 0)
          .map((section) => (
            <SectionTable key={section.title} title={section.title} role={role} actions={columns}>
              {rows(section)}
            </SectionTable>
          ))}

        {legacy.map((section) => {
          const held = section.modules.reduce((sum, entry) => sum + actions.filter((action) => rules.shown(entry, true, action) && original.has(keyOf(entry.module, action))).length, 0)

          return (
            <details key={section.title} className="rounded-xl border border-slate-200 bg-slate-50/60">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-800">
                Legacy modules <span className="font-normal text-slate-600">· {held} {held === 1 ? 'grant' : 'grants'} held</span>
              </summary>
              <div className="space-y-3 px-4 pb-4">
                <p className="text-xs text-slate-600">Modules without a page in the current application. Grants held here can be removed.</p>
                <SectionTable title="Legacy modules" role={role} actions={columns}>
                  {rows(section)}
                </SectionTable>
              </div>
            </details>
          )
        })}

        {catalogue.fixedAccess && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-sm text-slate-700">
            <h3 className="font-semibold text-slate-900">Not set by role permissions</h3>
            {catalogue.fixedAccess.superAdminOnly && (
              <p className="mt-1">
                <span className="font-semibold">Super Admin only:</span> {catalogue.fixedAccess.superAdminOnly.map((page) => page.label).join(' · ')}
              </p>
            )}
            <p className="mt-1">
              <span className="font-semibold">Super Admin and Admin only:</span> {catalogue.fixedAccess.adminOnly.map((page) => page.label).join(' · ')}
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

interface RolesPanelProps {
  catalogue: RolesResponse
  canEdit: boolean
  /** Told whether the permissions shown have unsaved changes, so the page can warn before leaving. */
  onDirtyChange?: (dirty: boolean) => void
}

export function RolesPanel({ catalogue, canEdit, onDirtyChange }: RolesPanelProps) {
  const active = catalogue.roles.filter((role) => role.isActive)
  const legacy = catalogue.roles.filter((role) => !role.isActive)
  const [selectedId, setSelectedId] = useState<string | null>(active[0]?.id ?? catalogue.roles[0]?.id ?? null)
  const [dirty, setDirty] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const role = catalogue.roles.find((candidate) => candidate.id === selectedId) ?? null

  // The page is told too, so it can warn before its other tab replaces this panel.
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const choose = (id: string) => {
    if (id === selectedId) return
    if (dirty) {
      setPendingId(id)
    } else {
      setSelectedId(id)
    }
  }

  // Arrow keys, Home and End move between the role tabs.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = active.length - 1
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (target === null) return
    event.preventDefault()
    tabs.current[target]?.focus()
    const next = active[target]
    if (next) choose(next.id)
  }

  const tabClass = (on: boolean) =>
    cx(
      'whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-semibold ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1479BD]',
      on ? 'bg-[#1479BD] text-white ring-[#1479BD]' : 'bg-white text-slate-700 ring-slate-300 hover:bg-sky-50 hover:text-[#0b3b66]',
    )

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Roles" className="flex flex-wrap gap-2">
        {active.map((candidate, index) => {
          const on = candidate.id === selectedId

          return (
            <button
              key={candidate.id}
              ref={(element) => {
                tabs.current[index] = element
              }}
              type="button"
              role="tab"
              id={`role-tab-${candidate.id}`}
              aria-selected={on}
              aria-controls="role-permissions"
              tabIndex={on || (!active.some((item) => item.id === selectedId) && index === 0) ? 0 : -1}
              onClick={() => choose(candidate.id)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={tabClass(on)}
            >
              {candidate.name}
            </button>
          )
        })}
      </div>

      {legacy.length > 0 && (
        <details className="text-sm text-slate-600">
          <summary className="cursor-pointer font-semibold text-slate-700">Inactive roles ({legacy.length})</summary>
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Inactive roles">
            {legacy.map((candidate) => (
              <li key={candidate.id}>
                <button type="button" aria-pressed={candidate.id === selectedId} onClick={() => choose(candidate.id)} className={cx(tabClass(candidate.id === selectedId), 'px-3 py-1 text-xs')}>
                  {candidate.name}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Card className="min-w-0">
        <div id="role-permissions" role="tabpanel" aria-labelledby={role ? `role-tab-${role.id}` : undefined}>
          {/* key: a fresh matrix for another role. A newer save of the same role is merged by the matrix itself. */}
          {role && (
            <PermissionMatrix key={role.id} role={role} catalogue={catalogue} canEdit={canEdit} onDirtyChange={setDirty} />
          )}
        </div>
      </Card>

      {pendingId && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message={<>The permissions of {role?.name} have changes that are not saved. Discard them and open {catalogue.roles.find((item) => item.id === pendingId)?.name}?</>}
          confirmLabel="Discard changes"
          danger
          onConfirm={() => {
            setSelectedId(pendingId)
            setPendingId(null)
          }}
          onCancel={() => setPendingId(null)}
        />
      )}
    </div>
  )
}
