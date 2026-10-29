import jwt from "jsonwebtoken";
import { env } from "../../config/env";

const ALGORITHM = "HS256";

export interface TokenClaims {
  userId: string;
  /** Issued-at, in seconds since the epoch. */
  issuedAt: number;
  /** Issued by signing in with a temporary password: only good for choosing a new one. */
  passwordChange: boolean;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

// The token carries only the user id, plus "pc" when it was issued for a
// temporary password. Roles and permissions are read from the database on
// every request, so changes take effect immediately.
export function issueToken(userId: string, options: { passwordChange?: boolean } = {}): IssuedToken {
  const token = jwt.sign(options.passwordChange ? { pc: true } : {}, env.jwtSecret, {
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

    return { userId: payload.sub, issuedAt: payload.iat, passwordChange: payload.pc === true };
  } catch {
    return null;
  }
}
