import jwt from "jsonwebtoken";
import { env } from "../../config/env";

const ALGORITHM = "HS256";

export interface TokenClaims {
  userId: string;
  /** Issued-at, in seconds since the epoch. */
  issuedAt: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

// The token carries only the user id. Roles and permissions are read from the
// database on every request, so changes take effect immediately.
export function issueToken(userId: string): IssuedToken {
  const token = jwt.sign({}, env.jwtSecret, {
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

    return { userId: payload.sub, issuedAt: payload.iat };
  } catch {
    return null;
  }
}
