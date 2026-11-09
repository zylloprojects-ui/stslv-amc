import type { RequestHandler } from "express";
import { pool } from "../config/database";
import { env } from "../config/env";
import { loadUserPermissions, loadUserRoles, type AuthContext } from "../modules/auth/access";
import { checkSession, reportedIdleSeconds, sessionsEnabled } from "../modules/auth/sessions.service";
import { verifyToken } from "../modules/auth/token";
import { AppError, unauthorized } from "../shared/errors";

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware on every protected route. */
      auth?: AuthContext;
    }
  }
}

export const TEMPORARY_PASSWORD_EXPIRED_MESSAGE =
  "Your temporary password has expired. Please contact your system administrator to receive a new temporary password.";

/**
 * Requires a valid "Authorization: Bearer <token>" header. The user, roles and
 * permissions are loaded from the database on every request, so deactivating a
 * user or changing a role takes effect at once.
 *
 * A user signed in with a temporary password is refused everywhere (403
 * PASSWORD_CHANGE_REQUIRED) except on the routes created with
 * allowPasswordChange, so a new protected route is closed to them by default.
 */
function createAuthenticate(options: { allowPasswordChange: boolean }): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const claims = token ? verifyToken(token) : null;

    if (!claims) {
      throw unauthorized("Your session is missing or has expired. Please sign in again.");
    }

    const result = await pool.query<{
      id: string;
      email: string;
      full_name: string;
      is_active: boolean;
      password_changed_epoch: string;
      must_change_password: boolean;
      temporary_password_expired: boolean;
    }>(
      `SELECT id, email, full_name, is_active,
              floor(extract(epoch FROM password_changed_at)) AS password_changed_epoch,
              must_change_password,
              COALESCE(temporary_password_expires_at <= now(), false) AS temporary_password_expired
       FROM users WHERE id = $1`,
      [claims.userId]
    );
    const user = result.rows[0];

    // Unknown or deactivated user, a token issued before the last password change, or a
    // temporary-password session whose password has since been replaced.
    if (
      !user ||
      !user.is_active ||
      claims.issuedAt < Number(user.password_changed_epoch) ||
      (claims.passwordChange && !user.must_change_password)
    ) {
      throw unauthorized("Your session is no longer valid. Please sign in again.");
    }
    if (user.must_change_password && user.temporary_password_expired) {
      throw new AppError(401, "TEMPORARY_PASSWORD_EXPIRED", TEMPORARY_PASSWORD_EXPIRED_MESSAGE);
    }

    // Server-side session (migration 0108). Once the table exists, a token must name an open session: signing
    // out, an administrator, a password change or inactivity ends it at once. Tokens issued before the table
    // existed name none and are refused, so everyone signs in once after the release.
    let sessionId: string | null = null;

    if (await sessionsEnabled()) {
      const state = claims.sessionId ? await checkSession(claims.sessionId, user.id, reportedIdleSeconds(req.headers["x-idle-seconds"])) : "missing";

      if (state === "idle") {
        throw new AppError(401, "SESSION_IDLE_TIMEOUT", `You were signed out after ${env.sessionIdleTimeoutMinutes} minutes of inactivity. Please sign in again.`);
      }
      if (state === "revoked") {
        throw new AppError(401, "SESSION_REVOKED", "This session has been signed out. Please sign in again.");
      }
      if (state !== "open") {
        throw unauthorized("Your session is no longer valid. Please sign in again.");
      }
      sessionId = claims.sessionId;
    }

    if (user.must_change_password && !options.allowPasswordChange) {
      throw new AppError(403, "PASSWORD_CHANGE_REQUIRED", "Choose a new password before continuing.");
    }

    const [roles, permissions] = await Promise.all([
      loadUserRoles(pool, user.id),
      loadUserPermissions(pool, user.id),
    ]);

    req.auth = {
      user: { id: user.id, email: user.email, fullName: user.full_name },
      roles,
      permissions,
      mustChangePassword: user.must_change_password,
      sessionId,
    };

    next();
  };
}

export const authenticate = createAuthenticate({ allowPasswordChange: false });

/** For the session check and the forced password change only. */
export const authenticateAllowingPasswordChange = createAuthenticate({ allowPasswordChange: true });

/** The authenticated context of a request that has passed the authenticate middleware. */
export function requireAuth(req: Express.Request): AuthContext {
  if (!req.auth) {
    throw unauthorized();
  }

  return req.auth;
}
