import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      MONGODB_URI: process.env.MONGODB_URI_TEST || "mongodb://localhost:27017/grysosta_test",
      HASH_SALT: "test-salt-123456",
      ADMIN_EMAIL: "admin@grysosta.com",
      ADMIN_PASSWORD: "grysosta2026",
      ADMIN_NAME: "Georgino Perez",
      BREVO_API_KEY: "",
      TURNSTILE_SECRET: "",
      JOBS_ENABLED: "false",
      SITE_URL: "https://grysosta.com",
      API_URL: "http://localhost:4000",
    },
  },
});
