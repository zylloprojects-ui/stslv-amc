import type { Request, RequestHandler } from "express";
import { AppError } from "../shared/errors";

export interface RateLimitOptions {
  windowMs: number;
  /** Allowed per window. A function is read on every request, so the limit can come from configuration. */
  max: number | (() => number);
  /** What the count is kept per. Defaults to the caller's network address. */
  key?: (req: Request) => string;
  /**
   * When given, only finished responses whose status this accepts are counted (for
   * example failed sign-ins), instead of every request. The check still happens
   * before the request is handled, so a caller over the limit is refused at once.
   */
  countWhen?: (status: number) => boolean;
  /** With countWhen: a finished response whose status this accepts clears the count (for example a successful sign-in). */
  clearWhen?: (status: number) => boolean;
}

/**
 * Limits how often one network address may call a route. Used on the public
 * sign-up, password-recovery and sign-in routes, which anyone can reach without signing in.
 *
 * Counts are kept in this process's memory: they reset on restart and are not
 * shared between several API processes. Behind a reverse proxy, Express must be
 * told to trust it ("trust proxy") or every caller appears as the proxy.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const limit = () => (typeof options.max === "function" ? options.max() : options.max);
  const keyOf = options.key ?? ((req: Request) => req.ip ?? "unknown");

  const forgetExpired = (now: number) => {
    // Forget keys whose window has passed, so the map cannot grow without limit.
    if (hits.size > 10_000) {
      for (const [key, entry] of hits) {
        if (entry.resetAt <= now) {
          hits.delete(key);
        }
      }
    }
  };

  const tooMany = () =>
    new AppError(429, "TOO_MANY_REQUESTS", "Too many attempts. Please wait a few minutes and try again.");

  const { countWhen, clearWhen } = options;

  if (countWhen) {
    return (req, res, next) => {
      const now = Date.now();
      const key = keyOf(req);

      forgetExpired(now);

      const entry = hits.get(key);

      if (entry && entry.resetAt > now && entry.count >= limit()) {
        throw tooMany();
      }

      res.on("finish", () => {
        const finishedAt = Date.now();
        const current = hits.get(key);

        if (countWhen(res.statusCode)) {
          if (!current || current.resetAt <= finishedAt) {
            hits.set(key, { count: 1, resetAt: finishedAt + options.windowMs });
          } else {
            current.count += 1;
          }
        } else if (clearWhen?.(res.statusCode)) {
          hits.delete(key);
        }
      });

      next();
    };
  }

  return (req, _res, next) => {
    const now = Date.now();
    const key = keyOf(req);

    forgetExpired(now);

    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    entry.count += 1;

    if (entry.count > limit()) {
      throw tooMany();
    }

    next();
  };
}
