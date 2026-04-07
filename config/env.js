import dotenv from "dotenv";

dotenv.config();

const requiredEnv = [
  "DATABASE_URL",
  "REDIS_URL",
  "MAILGUN_API_KEY",
  "MAILGUN_DOMAIN",
  "MAILGUN_FROM",
  "CAMPAIGN_TOKEN_SECRET"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  runWorkerInApi: String(process.env.RUN_WORKER_IN_API || "false").toLowerCase() === "true",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  mailgunApiKey: process.env.MAILGUN_API_KEY,
  mailgunDomain: process.env.MAILGUN_DOMAIN,
  mailgunFrom: process.env.MAILGUN_FROM,
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  cronDeleteAfterDays: Number(process.env.CRON_DELETE_AFTER_DAYS || 30),
  campaignTokenSecret: process.env.CAMPAIGN_TOKEN_SECRET,
  campaignTokenExpiresIn: process.env.CAMPAIGN_TOKEN_EXPIRES_IN || "7d",
  emailWorkerConcurrency: Number(process.env.EMAIL_WORKER_CONCURRENCY || 40),
  emailRateLimitMax: Number(process.env.EMAIL_RATE_LIMIT_MAX || 120),
  emailRateLimitDurationMs: Number(process.env.EMAIL_RATE_LIMIT_DURATION_MS || 1000)
};
