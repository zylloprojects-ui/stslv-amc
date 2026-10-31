import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'

interface ContractLinkProps {
  id: string
  className?: string
  'aria-label'?: string
  /** Without access: show nothing (an "Open contract" action), instead of the plain text (a contract reference). */
  hideWithoutAccess?: boolean
  children: ReactNode
}

/** A link to a contract's page, for a user who may open it. A role may see visits or renewals without AMC Contracts. */
export function ContractLink({ id, className, hideWithoutAccess, children, 'aria-label': label }: ContractLinkProps) {
  const auth = useAuth()

  if (!auth.can('AMC_CONTRACTS', 'VIEW')) {
    return hideWithoutAccess ? null : <span>{children}</span>
  }

  return (
    <Link to={`/amc/contracts/${id}`} className={className} aria-label={label}>
      {children}
    </Link>
  )
}
