import { useMemo } from 'react'
import { useAuth } from '../auth/context'
import { isAdmin } from '../auth/roles'
import { helpTopicVisible, type HelpTopic } from './helpModel'
import { HELP_TOPICS } from './helpTopics'

/** The help topics the signed-in user may read: the same pages the sidebar offers them, plus the general topics. */
export function useHelpTopics(): HelpTopic[] {
  const auth = useAuth()
  const admin = isAdmin(auth.user)

  return useMemo(
    () => HELP_TOPICS.filter((topic) => helpTopicVisible(topic, { can: auth.can, canRead: auth.canRead, isAdmin: admin })),
    [auth.can, auth.canRead, admin],
  )
}
