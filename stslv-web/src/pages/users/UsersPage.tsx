import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { ActionButton, ActionGroup } from '../../components/IconActions'
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner, StatusBadge, TableScroll } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import type { RolesResponse, User } from '../../lib/types'
import { RolesPanel } from './RolesPanel'
import { isAdmin } from '../../auth/roles'
import { CreateUserModal, EditRolesModal, TemporaryPasswordModal } from './UserDialogs'

type Tab = 'users' | 'roles'

/** Requested from the Sign up page and still waiting for an administrator. */
const isPending = (user: User) => user.approvalStatus === 'PENDING'

/** A sign-up request an administrator refused. Nothing can be done with it until the person signs up again. */
const isRejected = (user: User) => user.approvalStatus === 'REJECTED'

const toggleLabel = (user: User) => (user.isActive ? 'Deactivate' : isPending(user) ? 'Approve' : 'Activate')

/** An approval must give access, so a pending request needs a role first. The API enforces the same rule. */
const needsRoleToApprove = (user: User) => isPending(user) && user.roles.length === 0
/** Several roles, assigned before the one-role rule: an administrator chooses one before approving. */
const hasSeveralRoles = (user: User) => user.roles.length > 1
const ONE_ROLE_TO_APPROVE = 'This user has more than one role. Choose one role before approving.'

const ROLE_REQUIRED_TO_APPROVE = 'Assign a role before approving this user.'

/** Why an administrator cannot issue a temporary password to this user, if they cannot. The API enforces the same. */
function temporaryPasswordBlock(user: User, isSelf: boolean): string | undefined {
  if (isSelf) return 'You cannot issue a temporary password for your own account. Change your password under My account.'
  if (!user.isActive) return 'Only an active account can be issued a temporary password.'
  return undefined
}

/** Shown while a temporary password is outstanding: not yet replaced by the user's own. After the time it no longer signs in. */
function TemporaryPasswordBadge({ expiresAt }: { expiresAt: string }) {
  return <Badge tone="amber">Temporary password · expires {formatDateTime(expiresAt)}</Badge>
}

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'roles'; user: User }
  | { kind: 'temporary-password'; user: User }
  | { kind: 'toggle'; user: User }
  | { kind: 'reject'; user: User }

export function UsersPage({ initialTab = 'users' }: { initialTab?: Tab }) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>(initialTab)
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

  const reject = useMutation({
    mutationFn: (user: User) => api.post<User>(`/users/${user.id}/reject`),
    onSuccess: async (updated) => {
      // The roles tab counts the users of each role, and a rejection removes any role given while pending.
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['users'] }), queryClient.invalidateQueries({ queryKey: ['roles'] })])
      setNotice(`The sign-up request of ${updated.fullName} was rejected. They cannot sign in.`)
      setDialog({ kind: 'none' })
    },
  })

  const closeDialog = () => {
    toggle.reset()
    reject.reset()
    setDialog({ kind: 'none' })
  }

  const canCreate = auth.can('USERS', 'CREATE')
  const canEdit = auth.can('USERS', 'EDIT')
  // Approving and rejecting sign-up requests (USERS:APPROVE); the API checks the same.
  const canApprove = auth.can('USERS', 'APPROVE')
  // Issuing temporary passwords is reserved to the Admin role, on top of user editing.
  const canIssueTemporaryPassword = canEdit && isAdmin(auth.user)
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
        title={initialTab === 'roles' ? 'Roles & Permissions' : 'Users & Access'}
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
              sign in.{canApprove && (canEdit ? ' Assign a role, then approve it.' : ' Approve it once it has a role.')}
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
                      <th scope="col" className={TABLE.snHead}>
                        #
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Name
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Email
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Role
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Status
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Last sign-in
                      </th>
                      {(canEdit || canApprove) && (
                        <th scope="col" className={cx(TABLE.th, 'text-right')}>
                          Actions
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {users.data.map((user, index) => {
                      const isSelf = user.id === auth.user?.id

                      return (
                        <tr key={user.id} className={TABLE.row}>
                          <td className={TABLE.sn}>{0 + index + 1}</td>
                          <td className={cx(TABLE.td, TABLE.text, 'font-medium text-slate-900')}>
                            {user.fullName}
                            {isSelf && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}
                          </td>
                          <td className={cx(TABLE.td, TABLE.unbroken)}>{user.email}</td>
                          <td className={TABLE.td}>
                            <div className="flex flex-wrap gap-1">
                              {user.roles.length === 0 && <span className="text-slate-500">No role</span>}
                              {hasSeveralRoles(user) && <Badge tone="amber">Several roles: choose one</Badge>}
                              {user.roles.map((role) => (
                                <Badge key={role.id} tone="blue">
                                  {role.name}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className={TABLE.td}>
                            {isPending(user) ? (
                              <Badge tone="amber">Pending approval</Badge>
                            ) : isRejected(user) ? (
                              <Badge>Rejected</Badge>
                            ) : (
                              <StatusBadge active={user.isActive} />
                            )}
                            {user.temporaryCredentialExpiresAt && (
                              <div className="mt-1">
                                <TemporaryPasswordBadge expiresAt={user.temporaryCredentialExpiresAt} />
                              </div>
                            )}
                          </td>
                          <td className={cx(TABLE.td, 'whitespace-nowrap')}>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}</td>
                          {(canEdit || canApprove) && (
                            <td className={cx(TABLE.td, 'whitespace-nowrap text-right')}>
                              {isRejected(user) ? (
                                <span className="text-xs text-slate-500">No actions</span>
                              ) : (
                              <ActionGroup>
                                {canEdit && (
                                  <ActionButton
                                    label={`Change role of ${user.fullName}`}
                                    icon="roles"
                                    disabled={isSelf || !roles.data}
                                    hint={isSelf ? 'You cannot change your own role.' : undefined}
                                    onClick={() => setDialog({ kind: 'roles', user })}
                                  />
                                )}
                                {canIssueTemporaryPassword && (
                                  <ActionButton
                                    label={`Generate temporary password for ${user.fullName}`}
                                    icon="key"
                                    disabled={temporaryPasswordBlock(user, isSelf) !== undefined}
                                    hint={temporaryPasswordBlock(user, isSelf)}
                                    onClick={() => setDialog({ kind: 'temporary-password', user })}
                                  />
                                )}
                                {(isPending(user) ? canApprove : canEdit) && (
                                <ActionButton
                                  danger={user.isActive && !isSelf}
                                  label={`${toggleLabel(user)} ${user.fullName}`}
                                  icon={user.isActive ? 'deactivate' : isPending(user) ? 'approve' : 'reactivate'}
                                  disabled={isSelf || needsRoleToApprove(user) || (isPending(user) && hasSeveralRoles(user))}
                                  hint={
                                    isSelf
                                      ? 'You cannot deactivate your own account.'
                                      : needsRoleToApprove(user)
                                        ? ROLE_REQUIRED_TO_APPROVE
                                        : isPending(user) && hasSeveralRoles(user)
                                          ? ONE_ROLE_TO_APPROVE
                                          : undefined
                                  }
                                  onClick={() => setDialog({ kind: 'toggle', user })}
                                />
                                )}
                                {isPending(user) && canApprove && <ActionButton danger label={`Reject ${user.fullName}`} icon="reject" onClick={() => setDialog({ kind: 'reject', user })} />}
                              </ActionGroup>
                              )}
                              {needsRoleToApprove(user) && canApprove && <p className="mt-1 text-xs text-amber-800">{ROLE_REQUIRED_TO_APPROVE}</p>}
                              {isPending(user) && hasSeveralRoles(user) && canApprove && <p className="mt-1 text-xs text-amber-800">{ONE_ROLE_TO_APPROVE}</p>}
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

      {dialog.kind === 'temporary-password' && (
        <TemporaryPasswordModal
          user={dialog.user}
          onClose={closeDialog}
          onIssued={() =>
            setNotice(`A temporary password was issued for ${dialog.user.fullName}. They have been signed out and must change it at sign-in.`)
          }
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
                <p className="mt-3">They will have the access of: {dialog.user.roles.map((role) => role.name).join(', ')}.</p>
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

      {dialog.kind === 'reject' && (
        <ConfirmDialog
          title="Reject registration?"
          message={
            <>
              <p>
                <strong>{dialog.user.fullName}</strong>
                <span className="block break-all">{dialog.user.email}</span>
              </p>
              <p className="mt-3">This registration request will be rejected and the user will not receive access to STSLEV AMC.</p>
              {dialog.user.roles.length > 0 && (
                <p className="mt-3">The role given while it was pending ({dialog.user.roles.map((role) => role.name).join(', ')}) is removed.</p>
              )}
            </>
          }
          confirmLabel="Reject"
          danger
          loading={reject.isPending}
          error={reject.isError ? errorMessage(reject.error) : null}
          onConfirm={() => reject.mutate(dialog.user)}
          onCancel={closeDialog}
        />
      )}
    </>
  )
}
