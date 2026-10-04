import { useState } from 'react'
import { Button, Modal } from '../../components/ui'
import { ChangePasswordForm } from './ChangePasswordForm'

const FORM_ID = 'change-password-dialog-form'

/** The change-password form in a pop-up, opened from Settings so nobody has to leave the page. */
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [pending, setPending] = useState(false)
  const [changed, setChanged] = useState(false)

  return (
    <Modal
      title="Change password"
      onClose={onClose}
      footer={
        changed ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} loading={pending}>
              Change password
            </Button>
          </>
        )
      }
    >
      <p className="mb-4 text-sm text-slate-600">Choose a new password for your account. Your other devices are signed out when you change it.</p>
      <ChangePasswordForm id={FORM_ID} onPending={setPending} onChanged={() => setChanged(true)} />
    </Modal>
  )
}
