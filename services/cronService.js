import cron from "node-cron";
import { env } from "../config/env.js";
import { deleteOldCampaigns } from "../db/queries.js";
import { logger } from "./logger.js";

export function startCleanupCron() {
  cron.schedule("0 3 * * *", async () => {
    try {
      const deletedCount = await deleteOldCampaigns(env.cronDeleteAfterDays);
      logger.info("Old campaigns cleanup complete", {
        retentionDays: env.cronDeleteAfterDays,
        deletedCount
      });
    } catch (error) {
      logger.error("Old campaigns cleanup failed", { message: error.message });
    }
  });
}
