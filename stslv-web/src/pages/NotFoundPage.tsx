import { Link } from 'react-router-dom'
import { usePageTitle } from '../components/hooks'
import { Card } from '../components/ui'

export function NotFoundPage() {
  usePageTitle('Page not found')

  return (
    <Card className="mx-auto mt-12 max-w-md overflow-hidden text-center sm:mt-16">
      <div className="bg-gradient-to-b from-sky-50 to-transparent px-8 pb-2 pt-10">
        <p className="bg-gradient-to-br from-[#0b3b66] to-[#1b8ad3] bg-clip-text text-6xl font-extrabold tracking-tight text-transparent" aria-hidden="true">
          404
        </p>
      </div>
      <div className="px-8 pb-9 pt-3">
        <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">The page you asked for does not exist.</p>
        <Link
          to="/dashboard"
          className="mt-5 inline-flex items-center justify-center rounded-lg bg-gradient-to-b from-[#1a7fc4] to-[#0f62a3] px-4 py-2 text-sm font-medium text-white shadow-sm shadow-blue-900/25 transition-all hover:from-[#1673b3] hover:to-[#0c5590] active:translate-y-px"
        >
          Go to the dashboard
        </Link>
      </div>
    </Card>
  )
}
