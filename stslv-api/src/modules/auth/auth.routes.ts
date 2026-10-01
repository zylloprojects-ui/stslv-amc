import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { rateLimit } from "../../middleware/rate-limit";
import { emailSchema, newPasswordSchema, requiredText } from "../../shared/validation";
import { toSessionUser } from "./access";
import { changeOwnPassword, login } from "./auth.service";
import { checkResetToken, requestPasswordReset, resetPasswordWithToken } from "./password-reset.service";
import { registerAccount } from "./registration.service";

const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ error: "Password is required." }).min(1, "Password is required.").max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string({ error: "Current password is required." }).min(1, "Current password is required.").max(200),
  newPassword: newPasswordSchema,
});

// Strict: a role, a permission or a status sent by the registrant is refused, never applied.
const signupSchema = z.strictObject({
  fullName: requiredText("Full name", 200),
  email: emailSchema,
  password: newPasswordSchema,
});

const forgotPasswordSchema = z.strictObject({ email: emailSchema });

const resetTokenSchema = z.string({ error: "The reset link is incomplete." }).min(1, "The reset link is incomplete.").max(200);

const checkResetTokenSchema = z.strictObject({ token: resetTokenSchema });

const resetPasswordSchema = z.strictObject({ token: resetTokenSchema, password: newPasswordSchema });

// The same wording whatever happened, so these routes do not reveal which emails have accounts.
const SIGNUP_RECEIVED = "Your registration has been submitted. An administrator will review it before you can sign in.";
const RESET_REQUESTED = "If an active account exists for that email, a password reset link has been sent to it.";

// The routes below are open to anyone, so each address is limited.
const publicLimit = () => rateLimit({ windowMs: 15 * 60 * 1000, max: env.publicAuthRateLimit });

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  res.json({ success: true, data: await login(email, password) });
});

authRouter.post("/signup", publicLimit(), async (req, res) => {
  await registerAccount(signupSchema.parse(req.body));

  res.status(202).json({ success: true, data: { message: SIGNUP_RECEIVED } });
});

authRouter.post("/forgot-password", publicLimit(), async (req, res) => {
  await requestPasswordReset(forgotPasswordSchema.parse(req.body).email);

  res.json({ success: true, data: { message: RESET_REQUESTED } });
});

// The token is sent in the body, not the address, so it is not written to access logs.
authRouter.post("/reset-password/check", publicLimit(), async (req, res) => {
  const { token } = checkResetTokenSchema.parse(req.body);

  res.json({ success: true, data: { status: await checkResetToken(token) } });
});

authRouter.post("/reset-password", publicLimit(), async (req, res) => {
  const { token, password } = resetPasswordSchema.parse(req.body);

  await resetPasswordWithToken(token, password);
  res.json({ success: true, data: null });
});

authRouter.get("/me", authenticate, (req, res) => {
  res.json({ success: true, data: { user: toSessionUser(requireAuth(req)) } });
});

authRouter.post("/change-password", authenticate, async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  res.json({ success: true, data: await changeOwnPassword(requireAuth(req), currentPassword, newPassword) });
});
