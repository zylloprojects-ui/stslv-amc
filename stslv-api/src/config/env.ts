import "dotenv/config";

const isTest = process.env.NODE_ENV === "test";

function readJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim() ?? "";

  if (secret.length < 32) {
    throw new Error(
      "JWT_SECRET is missing or shorter than 32 characters. " +
        "Set a long random value in stslv-api/.env (see .env.example)."
    );
  }

  return secret;
}

// Accepts values such as 30m, 8h or 1d and returns seconds.
function readJwtExpirySeconds(): number {
  const raw = process.env.JWT_EXPIRES_IN?.trim() || "8h";
  const match = /^(\d+)([smhd])$/.exec(raw);

  if (!match) {
    throw new Error("Invalid JWT_EXPIRES_IN. Use a number followed by s, m, h or d, for example 8h.");
  }

  const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
  const seconds = Number(match[1]) * unitSeconds;

  if (seconds < 60 || seconds > 7 * 86400) {
    throw new Error("Invalid JWT_EXPIRES_IN. It must be between 1 minute and 7 days.");
  }

  return seconds;
}

function readBcryptRounds(): number {
  const raw = process.env.BCRYPT_ROUNDS?.trim();

  if (!raw) {
    return 12;
  }

  const rounds = Number(raw);
  // A low cost is only acceptable for automated tests.
  const minimum = isTest ? 4 : 10;

  if (!Number.isInteger(rounds) || rounds < minimum || rounds > 15) {
    throw new Error(`Invalid BCRYPT_ROUNDS. It must be a whole number between ${minimum} and 15.`);
  }

  return rounds;
}

function readCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN?.trim() || "http://localhost:5173";

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}

export const MAIL_TRANSPORTS = ["none", "log", "memory"] as const;

export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

/**
 * How outgoing email is handled.
 *   none    nothing is sent and nothing about the message is printed (the default).
 *   log     the whole message, including any reset link, is printed to the API
 *           console. For local development only: refused when NODE_ENV=production.
 *   memory  messages are kept in memory for the automated tests: refused outside them.
 * A real provider (SMTP or an email API) is not configured yet; see docs/AUTH_SIGNUP_AND_RECOVERY.md.
 */
export function resolveMailTransport(raw: string | undefined, nodeEnv: string | undefined): MailTransport {
  const value = raw?.trim().toLowerCase() || (nodeEnv === "test" ? "memory" : "none");

  if (!(MAIL_TRANSPORTS as readonly string[]).includes(value)) {
    throw new Error(`Invalid MAIL_TRANSPORT. Use one of: ${MAIL_TRANSPORTS.join(", ")}.`);
  }
  if (value === "log" && nodeEnv === "production") {
    throw new Error("MAIL_TRANSPORT=log prints password reset links to the console and is not allowed in production.");
  }
  if (value === "memory" && nodeEnv !== "test") {
    throw new Error("MAIL_TRANSPORT=memory is only for the automated tests.");
  }

  return value as MailTransport;
}

// The address of the web application, used to build links sent by email.
function readAppUrl(corsOrigins: string[]): string {
  const raw = process.env.APP_URL?.trim() || corsOrigins[0] || "http://localhost:5173";

  if (!/^https?:\/\/[^\s/]+/.test(raw)) {
    throw new Error("Invalid APP_URL. It must be the web address of the application, for example http://localhost:5173.");
  }

  return raw.replace(/\/+$/, "");
}

function readWholeNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${name}. It must be a whole number between ${minimum} and ${maximum}.`);
  }

  return value;
}

const corsOrigins = readCorsOrigins();

export const env = {
  isTest,
  jwtSecret: readJwtSecret(),
  jwtExpirySeconds: readJwtExpirySeconds(),
  bcryptRounds: readBcryptRounds(),
  corsOrigins,
  appUrl: readAppUrl(corsOrigins),
  mailTransport: resolveMailTransport(process.env.MAIL_TRANSPORT, process.env.NODE_ENV),
  // How long a password reset link stays usable.
  passwordResetMinutes: readWholeNumber("PASSWORD_RESET_EXPIRES_MINUTES", 30, 5, 1440),
  // Requests one address may make to the public sign-up and password-recovery routes per 15 minutes.
  publicAuthRateLimit: readWholeNumber("PUBLIC_AUTH_RATE_LIMIT", 10, 1, 100_000),
  // How many reverse proxies stand between the internet and this API. 0 (the default)
  // means none: forwarded-address headers are ignored, which is right for local
  // development. A hosting platform's load balancer counts as one.
  trustProxyHops: readWholeNumber("TRUST_PROXY", 0, 0, 10),
};
