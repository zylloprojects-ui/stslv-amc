import { useState } from 'react'
import { Button, Modal } from '../../components/ui'
import { COLUMN_IDS, COLUMN_LABELS, DEFAULT_KPI_LABELS, KPI_IDS, KPI_LABEL_MAX, type ColumnId, type KpiId } from './servicesSalesPreferences'

interface CustomizeKpisProps {
  labels: Record<KpiId, string>
  order: KpiId[]
  onSave: (labels: Record<KpiId, string>, order: KpiId[]) => void
  onResetLabels: () => void
  onResetOrder: () => void
  onClose: () => void
}

/** Rename and reorder the cards. Only what they are called and where they sit changes, never what they count. */
export function CustomizeKpisDialog({ labels, order, onSave, onResetLabels, onResetOrder, onClose }: CustomizeKpisProps) {
  const [draft, setDraft] = useState<Record<KpiId, string>>({ ...labels })
  const [sequence, setSequence] = useState<KpiId[]>([...order])
  const blank = KPI_IDS.filter((id) => draft[id].trim() === '')

  const move = (index: number, by: -1 | 1) => {
    const next = [...sequence]
    const [item] = next.splice(index, 1)
    next.splice(index + by, 0, item as KpiId)
    setSequence(next)
  }

  return (
    <Modal
      title="Customize KPI cards"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDraft({ ...DEFAULT_KPI_LABELS })
                onResetLabels()
              }}
            >
              Reset KPI Names
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setSequence([...KPI_IDS])
                onResetOrder()
              }}
            >
              Reset KPI Order
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={blank.length > 0} onClick={() => onSave(draft, sequence)}>
              Save
            </Button>
          </div>
        </div>
      }
    >
      <p className="mb-4 text-sm text-slate-600">Names and order are remembered in this browser for you. The figures and what each card counts do not change.</p>
      <ol className="space-y-3">
        {sequence.map((id, index) => (
          <li key={id} className="flex items-end gap-2">
            <label className="flex-1 text-sm font-medium text-slate-700">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                Card {index + 1} · counts “{DEFAULT_KPI_LABELS[id]}”
              </span>
              <input
                value={draft[id]}
                maxLength={KPI_LABEL_MAX}
                onChange={(event) => setDraft({ ...draft, [id]: event.target.value })}
                aria-invalid={draft[id].trim() === ''}
                className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm"
              />
            </label>
            <Button variant="secondary" size="sm" disabled={index === 0} aria-label={`Move ${draft[id] || DEFAULT_KPI_LABELS[id]} earlier`} onClick={() => move(index, -1)}>
              ↑
            </Button>
            <Button variant="secondary" size="sm" disabled={index === sequence.length - 1} aria-label={`Move ${draft[id] || DEFAULT_KPI_LABELS[id]} later`} onClick={() => move(index, 1)}>
              ↓
            </Button>
          </li>
        ))}
      </ol>
      {blank.length > 0 && <p className="mt-3 text-sm text-red-700">Every card needs a name.</p>}
    </Modal>
  )
}

interface HideColumnsProps {
  hidden: ReadonlySet<ColumnId>
  onSave: (hidden: ReadonlySet<ColumnId>) => void
  onClose: () => void
}

/** Show or hide table columns. AMC Reference always stays, so every row is identified; exports always hold every column. */
export function HideColumnsDialog({ hidden, onSave, onClose }: HideColumnsProps) {
  const [draft, setDraft] = useState<Set<ColumnId>>(new Set(hidden))
  const toggle = (id: ColumnId) => {
    const next = new Set(draft)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setDraft(next)
  }

  return (
    <Modal
      title="Hide columns"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="secondary" onClick={() => setDraft(new Set())}>
            Show all
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => onSave(draft)}>Apply</Button>
          </div>
        </div>
      }
    >
      <p className="mb-3 text-sm text-slate-600">AMC Reference is always shown. Downloads always include every column.</p>
      <fieldset>
        <legend className="sr-only">Columns to show</legend>
        <ul className="grid gap-1 sm:grid-cols-2">
          {COLUMN_IDS.map((id) => (
            <li key={id}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-sky-50">
                <input type="checkbox" checked={!draft.has(id)} onChange={() => toggle(id)} className="h-4 w-4 rounded border-slate-300 accent-[#1479BD]" />
                {COLUMN_LABELS[id]}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </Modal>
  )
}
