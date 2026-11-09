import jwt from "jsonwebtoken";
import { env } from "../../config/env";

const ALGORITHM = "HS256";

export interface TokenClaims {
  userId: string;
  /** Issued-at, in seconds since the epoch. */
  issuedAt: number;
  /** Issued by signing in with a temporary password: only good for choosing a new one. */
  passwordChange: boolean;
  /** The server-side session (migration 0108), or null for a token issued without one. */
  sessionId: string | null;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

// The token carries only the user id, "pc" when it was issued for a temporary
// password, and "sid", the server-side session it belongs to. Roles and
// permissions are read from the database on every request, so changes take
// effect immediately; the session row decides whether the token still counts.
export function issueToken(userId: string, options: { passwordChange?: boolean; sessionId?: string | null } = {}): IssuedToken {
  const claims = { ...(options.passwordChange ? { pc: true } : {}), ...(options.sessionId ? { sid: options.sessionId } : {}) };
  const token = jwt.sign(claims, env.jwtSecret, {
    algorithm: ALGORITHM,
    subject: userId,
    expiresIn: env.jwtExpirySeconds,
  });

  return {
    token,
    expiresAt: new Date(Date.now() + env.jwtExpirySeconds * 1000).toISOString(),
  };
}

/** Returns the claims, or null when the token is missing, malformed, tampered with or expired. */
export function verifyToken(token: string): TokenClaims | null {
  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: [ALGORITHM] });

    if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.iat !== "number") {
      return null;
    }

    return {
      userId: payload.sub,
      issuedAt: payload.iat,
      passwordChange: payload.pc === true,
      sessionId: typeof payload.sid === "string" ? payload.sid : null,
    };
  } catch {
    return null;
  }
}
