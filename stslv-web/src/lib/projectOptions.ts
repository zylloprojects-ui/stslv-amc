import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { ProjectOption } from './projectTypes'

export const projectLabel = (project: { jobNumber: string; clientName: string; description: string }) =>
  `${project.jobNumber} — ${project.clientName} — ${project.description}`

/** Every project, for choosing one on a form or filter. Carries no financial information. */
export function useProjectOptions() {
  return useQuery({ queryKey: ['projects', 'options'], queryFn: () => api.get<ProjectOption[]>('/projects/options') })
}
