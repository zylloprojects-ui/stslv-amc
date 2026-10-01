import { Card, PageHeader } from '../components/ui'

/** Shown for modules that are planned but not built. It offers no functionality and no data. */
export function ModulePlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <div className="px-6 py-16 text-center">
          <p className="text-base font-semibold text-slate-900">Module implementation in progress</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            {title} is part of Phase 1 and has not been built yet. Nothing can be viewed or recorded here for now.
          </p>
        </div>
      </Card>
    </>
  )
}
