import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner, StatusBadge, TableScroll } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import type { RolesResponse, User } from '../../lib/types'
import { RolesPanel } from './RolesPanel'
import { CreateUserModal, EditRolesModal, ResetPasswordModal } from './UserDialogs'

type Tab = 'users' | 'roles'

/** Requested from the Sign up page and still waiting for an administrator. */
const isPending = (user: User) => user.approvalStatus === 'PENDING'

const toggleLabel = (user: User) => (user.isActive ? 'Deactivate' : isPending(user) ? 'Approve' : 'Activate')

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'roles'; user: User }
  | { kind: 'password'; user: User }
  | { kind: 'toggle'; user: User }

export function UsersPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('users')
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') })
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') })

  const toggle = useMutation({
    mutationFn: (user: User) => api.post<User>(`/users/${user.id}/${user.isActive ? 'deactivate' : 'activate'}`),
    onSuccess: async (updated, before) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      setNotice(
        isPending(before)
          ? `The sign-up request of ${updated.fullName} was approved. They can now sign in.`
          : `${updated.fullName} was ${updated.isActive ? 'activated' : 'deactivated'}.`,
      )
      setDialog({ kind: 'none' })
    },
  })

  const closeDialog = () => {
    toggle.reset()
    setDialog({ kind: 'none' })
  }

  const canCreate = auth.can('USERS', 'CREATE')
  const canEdit = auth.can('USERS', 'EDIT')
  const roleList = roles.data?.roles ?? []
  const pendingCount = users.data?.filter(isPending).length ?? 0

  const tabButton = (value: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`users-tab-${value}`}
      aria-selected={tab === value}
      aria-controls="users-tabpanel"
      onClick={() => {
        setTab(value)
        setNotice(null)
      }}
      className={cx(
        '-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium',
        tab === value ? 'border-blue-700 text-blue-800' : 'border-transparent text-slate-600 hover:text-slate-900',
      )}
    >
      {label}
    </button>
  )

  return (
    <>
      <PageHeader
        title="Users & Access"
        description="Who can sign in, and what each role is allowed to do."
        actions={
          canCreate &&
          tab === 'users' && (
            <Button onClick={() => setDialog({ kind: 'create' })} disabled={!roles.data}>
              Create User
            </Button>
          )
        }
      />

      <div role="tablist" aria-label="Users and access" className="mb-4 flex overflow-x-auto border-b border-slate-200">
        {tabButton('users', 'Users')}
        {tabButton('roles', 'Roles & Permissions')}
      </div>

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}

      <div role="tabpanel" id="users-tabpanel" aria-labelledby={`users-tab-${tab}`}>
        {tab === 'users' && pendingCount > 0 && (
          <div className="mb-4">
            <Alert tone="info">
              {pendingCount === 1 ? '1 sign-up request is' : `${pendingCount} sign-up requests are`} waiting for approval. A pending account cannot
              sign in.{canEdit && ' Assign a role, then approve it.'}
            </Alert>
          </div>
        )}
        {tab === 'users' && (
          <Card>
            {users.isPending && <Spinner label="Loading users" />}
            {users.isError && (
              <div className="p-4">
                <Alert>{errorMessage(users.error)}</Alert>
              </div>
            )}
            {users.data && users.data.length === 0 && <EmptyState title="No users yet" />}
            {users.data && users.data.length > 0 && (
              <TableScroll label="Users">
                <table className={TABLE.table}>
                  <caption className="sr-only">Users</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TABLE.th}>
                        Name
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Email
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Roles
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Status
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Last sign-in
                      </th>
                      {canEdit && (
                        <th scope="col" className={cx(TABLE.th, 'text-right')}>
                          Actions
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {users.data.map((user) => {
                      const isSelf = user.id === auth.user?.id

                      return (
                        <tr key={user.id} className={TABLE.row}>
                          <td className={cx(TABLE.td, TABLE.text, 'font-medium text-slate-900')}>
                            {user.fullName}
                            {isSelf && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}
                          </td>
                          <td className={cx(TABLE.td, TABLE.unbroken)}>{user.email}</td>
                          <td className={TABLE.td}>
                            <div className="flex flex-wrap gap-1">
                              {user.roles.length === 0 && <span className="text-slate-500">No role</span>}
                              {user.roles.map((role) => (
                                <Badge key={role.id} tone="blue">
                                  {role.name}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className={TABLE.td}>
                            {isPending(user) ? <Badge tone="amber">Pending approval</Badge> : <StatusBadge active={user.isActive} />}
                          </td>
                          <td className={cx(TABLE.td, 'whitespace-nowrap')}>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}</td>
                          {canEdit && (
                            <td className={cx(TABLE.td, 'whitespace-nowrap text-right')}>
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isSelf || !roles.data}
                                  title={isSelf ? 'You cannot change your own roles.' : undefined}
                                  aria-label={`Change roles of ${user.fullName}`}
                                  onClick={() => setDialog({ kind: 'roles', user })}
                                >
                                  Roles
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Reset password of ${user.fullName}`}
                                  onClick={() => setDialog({ kind: 'password', user })}
                                >
                                  Reset password
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isSelf}
                                  title={isSelf ? 'You cannot deactivate your own account.' : undefined}
                                  className={user.isActive && !isSelf ? 'text-red-700 hover:bg-red-50' : undefined}
                                  aria-label={`${toggleLabel(user)} ${user.fullName}`}
                                  onClick={() => setDialog({ kind: 'toggle', user })}
                                >
                                  {toggleLabel(user)}
                                </Button>
                              </div>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Card>
        )}

        {tab === 'roles' && (
          <>
            {roles.isPending && <Spinner label="Loading roles" />}
            {roles.isError && <Alert>{errorMessage(roles.error)}</Alert>}
            {roles.data && <RolesPanel catalogue={roles.data} canEdit={canEdit} />}
          </>
        )}
      </div>

      {dialog.kind === 'create' && (
        <CreateUserModal
          roles={roleList}
          onClose={closeDialog}
          onSaved={(user) => {
            setNotice(`${user.fullName} was created.`)
            setDialog({ kind: 'none' })
          }}
        />
      )}

      {dialog.kind === 'roles' && (
        <EditRolesModal
          user={dialog.user}
          roles={roleList}
          onClose={closeDialog}
          onSaved={(user) => {
            setNotice(`Roles updated for ${user.fullName}.`)
            setDialog({ kind: 'none' })
          }}
        />
      )}

      {dialog.kind === 'password' && (
        <ResetPasswordModal
          user={dialog.user}
          onClose={closeDialog}
          onSaved={() => {
            setNotice(`Password reset for ${dialog.user.fullName}.`)
            setDialog({ kind: 'none' })
          }}
        />
      )}

      {dialog.kind === 'toggle' && (
        <ConfirmDialog
          title={dialog.user.isActive ? 'Deactivate user' : isPending(dialog.user) ? 'Approve sign-up request' : 'Activate user'}
          message={
            dialog.user.isActive ? (
              <>
                Deactivate <strong>{dialog.user.fullName}</strong>? They are signed out immediately and cannot sign in until
                activated again. Their records and history are kept.
              </>
            ) : isPending(dialog.user) ? (
              <>
                <p>
                  Approve the sign-up request of <strong>{dialog.user.fullName}</strong> ({dialog.user.email})? The account is activated and
                  they can sign in with the password they chose.
                </p>
                <p className="mt-3">
                  {dialog.user.roles.length === 0
                    ? 'No role is assigned yet, so they will be able to sign in but will not see any module. Use Roles first to give them access.'
                    : `They will have the access of: ${dialog.user.roles.map((role) => role.name).join(', ')}.`}
                </p>
              </>
            ) : (
              <>
                Activate <strong>{dialog.user.fullName}</strong>? They will be able to sign in again.
              </>
            )
          }
          confirmLabel={toggleLabel(dialog.user)}
          danger={dialog.user.isActive}
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(dialog.user)}
          onCancel={closeDialog}
        />
      )}
    </>
  )
}
