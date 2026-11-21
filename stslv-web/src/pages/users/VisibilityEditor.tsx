import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import type { Action, Module, Role, VisibilitySection } from '../../lib/types'

/**
 * Page visibility of one role (owner request 2026-11-21): inside a page the role may open, untick a Dashboard row or
 * panel, an Invoices column or an action to hide it from everyone holding the role. Ticked = shown (the default).
 * Opening the page itself stays with the permissions above. The API enforces every rule and refuses a stale save.
 */

const KIND_LABELS = { row: 'Row', panel: 'Panel', column: 'Column', action: 'Action' } as const

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((key) => b.has(key))

interface VisibilityEditorProps {
  role: Role
  catalogue: VisibilitySection[]
  canEdit: boolean
  onDirtyChange: (dirty: boolean) => void
}

export function VisibilityEditor({ role, catalogue, canEdit, onDirtyChange }: VisibilityEditorProps) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [base, setBase] = useState<Role>(role)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(role.hiddenItems ?? []))
  const [saved, setSaved] = useState(false)
  const [stale, setStale] = useState(false)
  // Like the permission sections: every page starts collapsed; find one, or open them all.
  const [query, setQuery] = useState('')
  const [expand, setExpand] = useState({ all: false, version: 0 })
  const shownSections = catalogue.filter((section) => query.trim() === '' || section.title.toLowerCase().includes(query.trim().toLowerCase()))

  const original = new Set(base.hiddenItems ?? [])
  const dirty = !sameSet(hidden, original)

  // A newer saved set arrived and nothing is being edited: show it.
  if ((role.visibilityVersion ?? '') !== (base.visibilityVersion ?? '') && !dirty) {
    setBase(role)
    setHidden(new Set(role.hiddenItems ?? []))
    setStale(false)
  }

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const editable = canEdit && role.permissionsEditable && role.isActive
  const roleHolds = (key: string) => role.permissions.some((permission) => `${permission.module}:${permission.action}` === key)
  // Admin changes only what Admin can open itself; the API checks the same.
  const mayChange = (section: VisibilitySection) => {
    const [module, action] = section.requires.split(':') as [Module, Action]
    return editable && auth.can(module, action)
  }

  const save = useMutation({
    mutationFn: () => api.put<Role>(`/roles/${role.id}/visibility`, { hidden: [...hidden].sort(), expectedVersion: base.visibilityVersion }),
    onSuccess: async (updated) => {
      setBase(updated)
      setHidden(new Set(updated.hiddenItems ?? []))
      setSaved(true)
      setStale(false)
      // The signed-in user's own pages may have changed.
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['roles'] }), queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })])
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setStale(true)
        void queryClient.invalidateQueries({ queryKey: ['roles'] })
      }
    },
  })

  const toggle = (key: string, show: boolean) => {
    setSaved(false)
    setHidden((current) => {
      const next = new Set(current)
      if (show) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const setSection = (section: VisibilitySection, show: boolean) => {
    setSaved(false)
    setHidden((current) => {
      const next = new Set(current)
      for (const item of section.groups.flatMap((group) => group.items)) {
        if (show) next.delete(item.key)
        else next.add(item.key)
      }
      return next
    })
  }

  const loadLatest = () => {
    setBase(role)
    setHidden(new Set(role.hiddenItems ?? []))
    setStale(false)
    setSaved(false)
    save.reset()
  }

  return (
    <section aria-labelledby={`visibility-${role.id}`} className="border-t border-slate-200 p-4" data-testid="page-visibility">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`visibility-${role.id}`} className="text-base font-bold text-[#0b3b66]">
            Page visibility
          </h3>
          <p className="mt-0.5 max-w-3xl text-sm text-slate-600">
            Choose what {role.name} sees inside the pages it can open. Untick a row, panel, column or action to hide it from everyone with this role; everything
            else stays as it is. Hidden data is not sent to their browser and is left out of their downloads.
          </p>
        </div>
        {editable && (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={!dirty || save.isPending} onClick={() => setHidden(new Set(original))}>
              Cancel
            </Button>
            <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save visibility
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-3" aria-live="polite">
        {!role.permissionsEditable && <Alert tone="info">{role.lockedReason ?? 'This role always sees everything.'}</Alert>}
        {editable && dirty && <Alert tone="info">You have unsaved visibility changes. Save them, or Cancel to go back.</Alert>}
        {stale && (
          <Alert>
            <span className="block">Not saved: someone else changed this role's visibility since you opened it. Nothing was overwritten.</span>
            <button type="button" onClick={loadLatest} className="mt-1 font-semibold underline">
              Load the latest settings
            </button>
          </Alert>
        )}
        {save.isError && !stale && <Alert>{errorMessage(save.error)}</Alert>}
        {saved && !dirty && <Alert tone="success">Visibility saved. It applies the next time their page loads.</Alert>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-xs">
          <svg viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3.5 3.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a page"
            aria-label="Find a page"
            className="block w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm shadow-sm placeholder:text-slate-400 focus:border-[#1479BD] focus:outline-none focus:ring-2 focus:ring-sky-100"
          />
        </div>
        <span className="ml-auto flex gap-2">
          <button type="button" onClick={() => setExpand((value) => ({ all: true, version: value.version + 1 }))} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-[#1479BD] hover:text-[#0b3b66]">
            Expand all
          </button>
          <button type="button" onClick={() => setExpand((value) => ({ all: false, version: value.version + 1 }))} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-[#1479BD] hover:text-[#0b3b66]">
            Collapse all
          </button>
        </span>
      </div>

      <div className="mt-3 space-y-3">
        {shownSections.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">No page matches.</p>}
        {shownSections.map((section) => {
          const items = section.groups.flatMap((group) => group.items)
          const shownCount = items.filter((item) => !hidden.has(item.key)).length
          const opens = roleHolds(section.requires)
          const changeable = mayChange(section)

          return (
            // Collapsed by default, like the permission sections above: click a page to open it.
            <details key={`${section.id}-${expand.version}`} open={expand.all || query.trim() !== ''} className="group frame-hover overflow-hidden rounded-xl border bg-white shadow-sm">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 hover:bg-sky-50/60 [&::-webkit-details-marker]:hidden">
                <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-[#1479BD] transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                  <path d="m7 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="min-w-0 flex-1 text-sm font-bold text-[#0b3b66]">{section.title}</span>
                {!opens && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900 ring-1 ring-inset ring-amber-200">
                    This role cannot open {section.page.label}
                  </span>
                )}
                <span
                  className={cx(
                    'whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
                    changeable ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-slate-100 text-slate-600 ring-slate-300',
                  )}
                >
                  {changeable ? 'Editable' : 'Read only'}
                </span>
                <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-slate-200 sm:block" aria-hidden="true">
                  <span className="block h-full rounded-full bg-gradient-to-r from-[#1479BD] to-[#00A6C8]" style={{ width: `${items.length === 0 ? 0 : Math.round((shownCount / items.length) * 100)}%` }} />
                </span>
                <span className="whitespace-nowrap text-xs font-semibold text-slate-500">
                  {shownCount}/{items.length} shown
                </span>
              </summary>
              {changeable && (
                <div className="flex justify-end gap-3 border-t border-slate-200 px-4 pt-3 text-xs font-semibold">
                  <button type="button" className="text-[#1479BD] hover:underline disabled:opacity-50" disabled={save.isPending} onClick={() => setSection(section, true)} aria-label={`Show all of ${section.title}`}>
                    Show all
                  </button>
                  <button type="button" className="text-[#1479BD] hover:underline disabled:opacity-50" disabled={save.isPending} onClick={() => setSection(section, false)} aria-label={`Hide all of ${section.title}`}>
                    Hide all
                  </button>
                </div>
              )}
              <div className={cx('grid gap-4 p-4 md:grid-cols-2', !changeable && 'border-t border-slate-200')}>
                {section.groups.map((group) => (
                  <fieldset key={group.title} className="min-w-0">
                    <legend className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{group.title}</legend>
                    <ul className="space-y-1.5">
                      {group.items.map((item) => {
                        const on = !hidden.has(item.key)

                        return (
                          <li key={item.key}>
                            <label className={cx('flex items-start gap-2 rounded-md px-2 py-1.5 text-sm', changeable ? 'cursor-pointer hover:bg-sky-50/70' : 'opacity-80')}>
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-[#1479BD] disabled:cursor-not-allowed"
                                aria-label={`${section.title}: ${item.label}`}
                                checked={on}
                                disabled={!changeable || save.isPending}
                                onChange={(event) => toggle(item.key, event.target.checked)}
                              />
                              <span className="min-w-0">
                                <span className={cx('font-medium', on ? 'text-slate-900' : 'text-slate-500 line-through')}>{item.label}</span>
                                <span className="ml-1.5 rounded bg-slate-100 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-slate-500">{KIND_LABELS[item.kind]}</span>
                                {item.description && <span className="block text-xs text-slate-500">{item.description}</span>}
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  </fieldset>
                ))}
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}
