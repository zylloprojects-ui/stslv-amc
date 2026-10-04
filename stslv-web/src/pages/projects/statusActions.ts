import type { ProjectStatus } from '../../lib/projectTypes'

/** The wording of the button that moves a project from one status to another. */
export function statusActionLabel(from: ProjectStatus, to: ProjectStatus): string {
  if (to === 'COMPLETED') {
    return 'Mark completed'
  }
  if (to === 'CANCELLED') {
    return 'Cancel project'
  }
  if (to === 'IN_PROGRESS' && from === 'NEW') {
    return 'Start work'
  }

  return 'Reopen project'
}
