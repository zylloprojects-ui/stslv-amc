import { defineConfig } from "vitest/config";

// The tests run against the database named in .env, but inside a separate
// PostgreSQL schema (stslv_test), so development data in "public" is never touched.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // All test files share one schema, so they must not run at the same time.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      DB_SCHEMA: "stslv_test",
      BCRYPT_ROUNDS: "4",
      JWT_SECRET: "test-only-secret-not-used-anywhere-else-0123456789",
      JWT_EXPIRES_IN: "1h",
    },
  },
});
