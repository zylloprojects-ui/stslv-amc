// Date, month and time fields normally open their picker only from the small calendar icon.
// Opening it from a click anywhere on the field is easier to hit and matches what people expect.
const PICKER_TYPES = new Set(['date', 'month', 'week', 'time', 'datetime-local'])

export function openPickerOnFieldClick(): void {
  document.addEventListener('click', (event) => {
    const target = event.target

    if (!(target instanceof HTMLInputElement) || !PICKER_TYPES.has(target.type) || target.disabled || target.readOnly) {
      return
    }

    try {
      target.showPicker?.()
    } catch {
      // The browser refused (for example the picker is already open); the field still works by typing.
    }
  })
}
