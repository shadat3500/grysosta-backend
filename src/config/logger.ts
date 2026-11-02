import pino from "pino";
import { env, isProd, isTest } from "./env";

export const logger = pino({
  level: isTest ? "silent" : isProd ? "info" : "debug",
  redact: ["req.headers.authorization", "req.headers.cookie", "password", "*.password"],
  transport: isProd || isTest ? undefined : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  base: { service: "grysosta-api", env: env.NODE_ENV },
});
