import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { ApiError, errorMessage } from './api'

/**
 * Shows the API's field-level problems on the matching form fields. Returns
 * the message to show above the form, or null when every problem found a field.
 */
export function applyApiErrors<T extends FieldValues>(error: unknown, fields: readonly Path<T>[], setError: UseFormSetError<T>): string | null {
  let shownOnField = false

  if (error instanceof ApiError) {
    for (const detail of error.details) {
      const field = fields.find((name) => name === detail.field)

      if (field) {
        setError(field, { message: detail.message })
        shownOnField = true
      }
    }
  }

  return shownOnField ? null : errorMessage(error)
}
