import { Link } from 'react-router-dom'
import { usePageTitle } from '../components/hooks'
import { Card } from '../components/ui'

export function NotFoundPage() {
  usePageTitle('Page not found')

  return (
    <Card className="mx-auto mt-16 max-w-md p-8 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600">The page you asked for does not exist.</p>
      <Link to="/dashboard" className="mt-4 inline-block text-sm font-medium text-blue-700 hover:underline">
        Go to the dashboard
      </Link>
    </Card>
  )
}
