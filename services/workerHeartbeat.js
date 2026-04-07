import os from "os";

const WORKER_HEARTBEAT_KEY = "mailgun:worker:heartbeat";
const WORKER_HEARTBEAT_INTERVAL_MS = 5000;
const WORKER_HEARTBEAT_TTL_SECONDS = 20;
const WORKER_HEARTBEAT_STALE_MS = WORKER_HEARTBEAT_TTL_SECONDS * 1000;

function buildPayload(source) {
  return {
    source,
    pid: process.pid,
    hostname: os.hostname(),
    updatedAt: new Date().toISOString()
  };
}

export async function publishWorkerHeartbeat(redis, source = "worker") {
  const payload = JSON.stringify(buildPayload(source));
  await redis.set(WORKER_HEARTBEAT_KEY, payload, "EX", WORKER_HEARTBEAT_TTL_SECONDS);
}

export function startWorkerHeartbeat(redis, { source = "worker", logger } = {}) {
  const tick = async () => {
    try {
      await publishWorkerHeartbeat(redis, source);
    } catch (error) {
      logger?.warn?.("Worker heartbeat publish failed", { error: error.message });
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}

export async function readWorkerHeartbeat(redis) {
  try {
    const raw = await redis.get(WORKER_HEARTBEAT_KEY);
    if (!raw) {
      return { status: "offline" };
    }

    const payload = JSON.parse(raw);
    const timestamp = Date.parse(String(payload.updatedAt || ""));
    if (!Number.isFinite(timestamp)) {
      return { status: "unknown" };
    }

    const ageMs = Math.max(0, Date.now() - timestamp);
    const status = ageMs <= WORKER_HEARTBEAT_STALE_MS ? "online" : "stale";

    return {
      status,
      source: typeof payload.source === "string" ? payload.source : "worker",
      pid: Number(payload.pid || 0) || undefined,
      hostname: typeof payload.hostname === "string" ? payload.hostname : undefined,
      lastSeenAt: new Date(timestamp).toISOString(),
      ageMs
    };
  } catch (error) {
    return {
      status: "unknown",
      error: error.message
    };
  }
}
