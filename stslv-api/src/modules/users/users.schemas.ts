import { z } from "zod";
import { emailSchema, idSchema, newPasswordSchema, requiredText } from "../../shared/validation";

const roleIds = z
  .array(idSchema, { error: "Roles must be a list of role ids." })
  .max(50)
  .transform((ids) => [...new Set(ids)]);

export const createUserSchema = z.strictObject({
  email: emailSchema,
  fullName: requiredText("Full name", 200),
  password: newPasswordSchema,
  roleIds: roleIds.default([]),
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
