import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { emailSchema, newPasswordSchema } from "../../shared/validation";
import { toSessionUser } from "./access";
import { changeOwnPassword, login } from "./auth.service";

const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ error: "Password is required." }).min(1, "Password is required.").max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string({ error: "Current password is required." }).min(1, "Current password is required.").max(200),
  newPassword: newPasswordSchema,
});

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  res.json({ success: true, data: await login(email, password) });
});

authRouter.get("/me", authenticate, (req, res) => {
  res.json({ success: true, data: { user: toSessionUser(requireAuth(req)) } });
});

authRouter.post("/change-password", authenticate, async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  res.json({ success: true, data: await changeOwnPassword(requireAuth(req), currentPassword, newPassword) });
});
