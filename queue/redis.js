import IORedis from "ioredis";
import { env } from "../config/env.js";

export const redisConnection = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true
});
