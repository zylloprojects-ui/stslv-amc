// The exit that is not a navigation (signing out) asks the page holding unsaved changes first.
// UnsavedChangesGuard (lib/unsavedChanges.tsx) registers itself here while it has changes.

let activeGuard: (() => Promise<boolean>) | null = null

export function setLeaveGuard(guard: (() => Promise<boolean>) | null): void {
  activeGuard = guard
}

/** Resolves true when nothing is unsaved or the user chooses to discard it. */
export function confirmLeave(): Promise<boolean> {
  return activeGuard ? activeGuard() : Promise.resolve(true)
}

/** Signs out after asking about unsaved changes, if there are any. */
export async function signOutSafely(logout: () => void): Promise<void> {
  if (await confirmLeave()) {
    logout()
  }
}
