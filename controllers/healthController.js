import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { redisConnection } from "../queue/redis.js";
import { readWorkerHeartbeat } from "../services/workerHeartbeat.js";

export async function getHealth(_req, res) {
  const payload = {
    status: "ok",
    mode: {
      worker: env.runWorkerInApi ? "embedded" : "external"
    },
    database: {
      status: "ok"
    },
    redis: {
      status: "ok"
    },
    worker: {
      status: "unknown"
    }
  };

  try {
    await pool.query("SELECT 1");
  } catch {
    payload.database.status = "unreachable";
    payload.status = "degraded";
  }

  try {
    await redisConnection.ping();
  } catch {
    payload.redis.status = "unreachable";
    payload.status = "degraded";
  }

  payload.worker = await readWorkerHeartbeat(redisConnection);
  if (payload.worker.status !== "online") {
    payload.status = "degraded";
  }

  return res.status(200).json(payload);
}
