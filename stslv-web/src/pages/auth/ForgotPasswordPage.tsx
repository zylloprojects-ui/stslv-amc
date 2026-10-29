import { usePageTitle } from '../../components/hooks'
import { AuthNotice, AuthSecondaryLink, LockIcon } from './authUi'

/**
 * Passwords are recovered by an administrator, who issues a temporary password
 * in Users & Access after checking who is asking. Nothing is sent by email.
 */
export function ForgotPasswordPage() {
  usePageTitle('Forgot password')

  return (
    <div className="login-rise space-y-4">
      <AuthNotice icon={<LockIcon />} title="Contact your administrator">
        <p>Forgot your password? Please contact your system administrator to receive a temporary password.</p>
        <p>Sign in with it here, and you will be asked to choose a new password straight away.</p>
      </AuthNotice>
      <AuthSecondaryLink to="/login">← Back to sign in</AuthSecondaryLink>
    </div>
  )
}
