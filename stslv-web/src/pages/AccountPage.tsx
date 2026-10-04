import { useState } from 'react'
import { useAuth } from '../auth/context'
import { Badge, Button, Card, PageHeader } from '../components/ui'
import { ChangePasswordForm } from './account/ChangePasswordForm'

export function AccountPage() {
  const auth = useAuth()
  const [pending, setPending] = useState(false)

  return (
    <>
      <PageHeader title="My Account" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="self-start p-6">
          <h2 className="text-base font-semibold text-slate-900">Account information</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="font-bold text-slate-800">Name</dt>
              <dd className="mt-0.5 break-words text-slate-900">{auth.user?.fullName}</dd>
            </div>
            <div>
              <dt className="font-bold text-slate-800">Email</dt>
              <dd className="mt-0.5 break-all text-slate-900">{auth.user?.email}</dd>
            </div>
            <div>
              <dt className="font-bold text-slate-800">Roles</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {auth.user?.roles.length === 0 && <span className="text-slate-500">No role assigned</span>}
                {auth.user?.roles.map((role) => (
                  <Badge key={role.id} tone="blue">
                    {role.name}
                  </Badge>
                ))}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-slate-500">Your name and roles are managed by an administrator.</p>
        </Card>

        <Card className="p-6">
          <h2 className="text-base font-semibold text-slate-900">Change password</h2>
          <div className="mt-4">
            <ChangePasswordForm id="change-password-form" onPending={setPending} />
            <Button type="submit" form="change-password-form" loading={pending} className="mt-4">
              Change password
            </Button>
          </div>
        </Card>
      </div>
    </>
  )
}
