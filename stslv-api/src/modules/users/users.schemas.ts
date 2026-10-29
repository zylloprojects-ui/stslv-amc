import { z } from "zod";
import { emailSchema, idSchema, newPasswordSchema, requiredText } from "../../shared/validation";

export const ONE_ROLE_MESSAGE = "Select exactly one role.";

// One role per user (approved 2026-10-29). Still a list, the shape the API has always taken, but of exactly one role id.
const roleIds = z
  .array(idSchema, { error: (issue) => (issue.input === undefined ? ONE_ROLE_MESSAGE : "Roles must be a list of role ids.") })
  .max(50)
  .transform((ids) => [...new Set(ids)])
  .refine((ids) => ids.length === 1, { message: ONE_ROLE_MESSAGE });

export const createUserSchema = z.strictObject({
  email: emailSchema,
  fullName: requiredText("Full name", 200),
  password: newPasswordSchema,
  roleIds,
});

export const updateUserSchema = z.strictObject({
  fullName: requiredText("Full name", 200),
});

export const setUserRolesSchema = z.strictObject({ roleIds });

// The administrator confirms they have verified who is asking before a temporary password is issued.
export const issueTemporaryPasswordSchema = z.strictObject({
  identityVerified: z.literal(true, { error: "Confirm that you have verified the person's identity." }),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
