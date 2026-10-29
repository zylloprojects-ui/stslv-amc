import type { Action, Module } from './types'

// Dependencies between the permissions of one module. The API enforces the same rules
// (stslv-api/src/shared/role-model.ts, requiredActions): every action needs View, and
// cancelling a contract (AMC Contracts: Delete) also needs Edit. Data-only Read stands alone.

export function requiredActions(module: Module, action: Action): Action[] {
  if (action === 'VIEW' || action === 'READ') return []
  if (module === 'AMC_CONTRACTS' && action === 'DELETE') return ['VIEW', 'EDIT']
  return ['VIEW']
}

/** The actions of the module that depend on this one, directly or through another. */
export function dependentActions(module: Module, action: Action, actions: readonly Action[]): Action[] {
  const found = new Set<Action>()
  const visit = (current: Action) => {
    for (const candidate of actions) {
      if (!found.has(candidate) && requiredActions(module, candidate).includes(current)) {
        found.add(candidate)
        visit(candidate)
      }
    }
  }

  visit(action)
  return [...found]
}

/** Plain words for the dependencies of one action, for the action descriptions. */
export function dependencyNote(module: Module, action: Action, labels: Record<Action, string>): string | null {
  const needed = requiredActions(module, action)
  return needed.length === 0 ? null : `Needs ${needed.map((item) => labels[item]).join(' and ')}.`
}
