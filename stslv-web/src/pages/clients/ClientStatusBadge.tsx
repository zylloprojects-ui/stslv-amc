import { Badge } from '../../components/ui'
import { CLIENT_STATUS_LABELS } from '../../lib/types'

/** A client's status. The stored flag is active or not; an inactive client is shown as Disabled. */
export function ClientStatusBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'green' : 'slate'}>{CLIENT_STATUS_LABELS[active ? 'active' : 'inactive']}</Badge>
}
