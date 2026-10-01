import type { RequestHandler } from "express";
import { AppError } from "../shared/errors";

/**
 * Limits how often one network address may call a route. Used on the public
 * sign-up and password-recovery routes, which anyone can reach without signing in.
 *
 * Counts are kept in this process's memory: they reset on restart and are not
 * shared between several API processes. Behind a reverse proxy, Express must be
 * told to trust it ("trust proxy") or every caller appears as the proxy.
 */
export function rateLimit(options: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";

    // Forget addresses whose window has passed, so the map cannot grow without limit.
    if (hits.size > 10_000) {
      for (const [address, entry] of hits) {
        if (entry.resetAt <= now) {
          hits.delete(address);
        }
      }
    }

    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    entry.count += 1;

    if (entry.count > options.max) {
      throw new AppError(429, "TOO_MANY_REQUESTS", "Too many attempts. Please wait a few minutes and try again.");
    }

    next();
  };
}
