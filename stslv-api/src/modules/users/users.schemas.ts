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

export const resetPasswordSchema = z.strictObject({ password: newPasswordSchema });

export type CreateUserInput = z.infer<typeof createUserSchema>;
