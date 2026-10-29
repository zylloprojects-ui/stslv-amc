import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { authenticate, authenticateAllowingPasswordChange, requireAuth } from "../../middleware/authenticate";
import { rateLimit } from "../../middleware/rate-limit";
import { emailSchema, newPasswordSchema, requiredText } from "../../shared/validation";
import { toSessionUser } from "./access";
import { changeOwnPassword, completeRequiredPasswordChange, login } from "./auth.service";
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

const requiredPasswordChangeSchema = z.strictObject({ newPassword: newPasswordSchema });

// The same wording whatever happened, so this route does not reveal which emails have accounts.
const SIGNUP_RECEIVED = "Your registration has been submitted. An administrator will review it before you can sign in.";

// The sign-up route is open to anyone, so each address is limited.
const publicLimit = () => rateLimit({ windowMs: 15 * 60 * 1000, max: env.publicAuthRateLimit });

const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Every sign-in request from one address, so password guessing across many accounts is slowed.
const loginLimit = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: () => env.loginRateLimit });

// Failed sign-ins per address and email. A successful sign-in clears the count. Keyed on
// both, so failures from elsewhere never block the real user. The email is read as typed
// (before validation) and only used as a key in memory.
const loginFailureLimit = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: () => env.loginFailureLimit,
  key: (req) => {
    const email: unknown = req.body?.email;

    return `${req.ip ?? "unknown"}|${typeof email === "string" ? email.trim().toLowerCase() : ""}`;
  },
  countWhen: (status) => status === 401,
  clearWhen: (status) => status >= 200 && status < 300,
});

export const authRouter = Router();

authRouter.post("/login", loginLimit, loginFailureLimit, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  res.json({ success: true, data: await login(email, password, { ip: req.ip ?? null }) });
});

authRouter.post("/signup", publicLimit(), async (req, res) => {
  await registerAccount(signupSchema.parse(req.body));

  res.status(202).json({ success: true, data: { message: SIGNUP_RECEIVED } });
});

// Answers a user who must change their password too, so the web application can send them to that screen.
authRouter.get("/me", authenticateAllowingPasswordChange, (req, res) => {
  res.json({ success: true, data: { user: toSessionUser(requireAuth(req)) } });
});

// The only other route open to a user signed in with a temporary password. Every session ends afterwards.
authRouter.post("/complete-password-change", authenticateAllowingPasswordChange, async (req, res) => {
  const { newPassword } = requiredPasswordChangeSchema.parse(req.body);

  await completeRequiredPasswordChange(requireAuth(req), newPassword);
  res.json({ success: true, data: null });
});

authRouter.post("/change-password", authenticate, async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  res.json({ success: true, data: await changeOwnPassword(requireAuth(req), currentPassword, newPassword) });
});
