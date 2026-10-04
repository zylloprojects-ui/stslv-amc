import { useState } from 'react'
import { BrandLoader, Button, Card, PageHeader } from '../components/ui'

/**
 * A page that holds the loader still so it can be looked at. The real loader only shows while something is
 * loading, which is usually too short to judge. Open it at /loader-preview.
 */
export function LoaderPreviewPage() {
  // Changing the key starts the loaders afresh, which replays their entrance.
  const [run, setRun] = useState(0)

  return (
    <>
      <PageHeader
        title="Loader preview"
        description="The loader the system shows while it loads. It is held on screen here so you can review it in light and dark mode."
        actions={
          <Button variant="secondary" onClick={() => setRun((value) => value + 1)}>
            Replay
          </Button>
        }
      />

      <div key={run} className="grid gap-5 lg:grid-cols-3">
        <Card className="p-2 lg:col-span-2">
          <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Page content (while a list loads)</p>
          <BrandLoader label="Loading clients" announce={false} />
        </Card>
        <Card className="p-2">
          <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Inside a dialog or card</p>
          <BrandLoader size="sm" label="Loading client" announce={false} />
        </Card>
        <Card className="p-2 lg:col-span-3">
          <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Whole page (checking your session)</p>
          <BrandLoader size="lg" label="Loading STSLEV AMC" announce={false} />
        </Card>
      </div>
    </>
  )
}
