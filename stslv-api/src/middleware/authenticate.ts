import type { RequestHandler } from "express";
import { pool } from "../config/database";
import { loadUserPermissions, loadUserRoles, type AuthContext } from "../modules/auth/access";
import { verifyToken } from "../modules/auth/token";
import { unauthorized } from "../shared/errors";

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware on every protected route. */
      auth?: AuthContext;
    }
  }
}

/**
 * Requires a valid "Authorization: Bearer <token>" header. The user, roles and
 * permissions are loaded from the database on every request, so deactivating a
 * user or changing a role takes effect at once.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
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
  }>(
    `SELECT id, email, full_name, is_active,
            floor(extract(epoch FROM password_changed_at)) AS password_changed_epoch
     FROM users WHERE id = $1`,
    [claims.userId]
  );
  const user = result.rows[0];

  // Unknown or deactivated user, or a token issued before the last password change.
  if (!user || !user.is_active || claims.issuedAt < Number(user.password_changed_epoch)) {
    throw unauthorized("Your session is no longer valid. Please sign in again.");
  }

  const [roles, permissions] = await Promise.all([
    loadUserRoles(pool, user.id),
    loadUserPermissions(pool, user.id),
  ]);

  req.auth = {
    user: { id: user.id, email: user.email, fullName: user.full_name },
    roles,
    permissions,
  };

  next();
};

/** The authenticated context of a request that has passed the authenticate middleware. */
export function requireAuth(req: Express.Request): AuthContext {
  if (!req.auth) {
    throw unauthorized();
  }

  return req.auth;
}
