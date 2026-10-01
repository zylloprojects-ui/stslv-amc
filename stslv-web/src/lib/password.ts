import { z } from 'zod'

// The same limits the API enforces (bcrypt uses at most 72 bytes).
export const passwordRule = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .refine((value) => new TextEncoder().encode(value).length <= 72, 'Password must be at most 72 bytes.')
