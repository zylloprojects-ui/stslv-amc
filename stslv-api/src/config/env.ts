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

export const env = {
  isTest,
  jwtSecret: readJwtSecret(),
  jwtExpirySeconds: readJwtExpirySeconds(),
  bcryptRounds: readBcryptRounds(),
  corsOrigins: readCorsOrigins(),
};
