import { useState } from 'react'
import { Button, Modal } from '../../components/ui'
import { DEFAULT_KPI_LABELS, KPI_IDS, KPI_LABEL_MAX, type KpiId } from './serviceStatusPreferences'

interface KpiCustomizeDialogProps {
  order: KpiId[]
  labelOf: (id: KpiId) => string
  onSave: (labels: Partial<Record<KpiId, string>>, order: KpiId[]) => void
  onResetLabels: () => void
  onResetOrder: () => void
  onClose: () => void
}

/**
 * Renames and reorders the four cards. Only how they are shown changes: each
 * card always counts its own business status, whatever it is called.
 */
export function KpiCustomizeDialog({ order, labelOf, onSave, onResetLabels, onResetOrder, onClose }: KpiCustomizeDialogProps) {
  const [labels, setLabels] = useState<Record<KpiId, string>>(() => Object.fromEntries(KPI_IDS.map((id) => [id, labelOf(id)])) as Record<KpiId, string>)
  const [draftOrder, setDraftOrder] = useState<KpiId[]>(order)
  const invalid = KPI_IDS.filter((id) => labels[id].trim() === '' || labels[id].trim().length > KPI_LABEL_MAX)

  const move = (index: number, by: -1 | 1) => {
    const next = [...draftOrder]
    const target = index + by
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target] as KpiId, next[index] as KpiId]
    setDraftOrder(next)
  }

  return (
    <Modal
      title="Customize KPI cards"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={invalid.length > 0} onClick={() => onSave(labels, draftOrder)}>
            Save cards
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-600">
        Names and order are remembered in this browser for you only. Each card keeps counting the same status.
      </p>
      <ol className="space-y-3" aria-label="KPI cards in display order">
        {draftOrder.map((id, index) => {
          const error = invalid.includes(id) ? `Enter a name of 1 to ${KPI_LABEL_MAX} characters.` : null

          return (
            <li key={id} className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3">
              <label className="min-w-0 flex-1 text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">Counts: {DEFAULT_KPI_LABELS[id]}</span>
                <input
                  value={labels[id]}
                  maxLength={KPI_LABEL_MAX + 10}
                  aria-invalid={error ? true : undefined}
                  aria-label={`Name of the ${DEFAULT_KPI_LABELS[id]} card`}
                  onChange={(event) => setLabels({ ...labels, [id]: event.target.value })}
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm"
                />
                {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
              </label>
              <div className="flex gap-1">
                <Button variant="secondary" size="sm" disabled={index === 0} aria-label={`Move ${labels[id] || DEFAULT_KPI_LABELS[id]} up`} onClick={() => move(index, -1)}>
                  ↑
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={index === draftOrder.length - 1}
                  aria-label={`Move ${labels[id] || DEFAULT_KPI_LABELS[id]} down`}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onResetLabels()
            setLabels({ ...DEFAULT_KPI_LABELS })
          }}
        >
          Reset KPI Names
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onResetOrder()
            setDraftOrder([...KPI_IDS])
          }}
        >
          Reset KPI Order
        </Button>
      </div>
    </Modal>
  )
}

interface HideColumnsDialogProps<K extends string> {
  options: { key: K; label: string }[]
  hidden: ReadonlySet<K>
  onChange: (hidden: Set<K>) => void
  onClose: () => void
}

/** Shows or hides the optional columns. The AMC Reference always stays, so every row is identified. */
export function HideColumnsDialog<K extends string>({ options, hidden, onChange, onClose }: HideColumnsDialogProps<K>) {
  const toggle = (key: K) => {
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  return (
    <Modal
      title="Hide columns"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={() => onChange(new Set())}>
            Show all
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-2 text-sm text-slate-600">Choose the columns to show. AMC Reference is always shown.</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {options.map((option) => (
            <label key={option.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-sky-50">
              <input type="checkbox" checked={!hidden.has(option.key)} onChange={() => toggle(option.key)} className="h-4 w-4 rounded border-slate-300 accent-[#1479BD]" />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    </Modal>
  )
}
