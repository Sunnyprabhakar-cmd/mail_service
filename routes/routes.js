import { Router } from "express";
import { uploadCsv } from "../middlewares/upload.js";
import { requireCampaignAccess } from "../middlewares/campaignAuth.js";
import {
	campaignEvents,
	campaignProgress,
	campaignStatus,
	sendCampaign,
	uploadCampaignCsv
} from "../controllers/campaignController.js";
import { handleMailgunWebhook } from "../controllers/webhookController.js";

const router = Router();

router.get("/health", (_req, res) => {
	res.status(200).json({ status: "ok" });
});

router.post("/campaigns/upload", uploadCsv.single("file"), uploadCampaignCsv);
router.post("/campaigns/:id/send", requireCampaignAccess, sendCampaign);
router.get("/campaigns/:id/status", requireCampaignAccess, campaignStatus);
router.get("/campaigns/:id/progress", requireCampaignAccess, campaignProgress);
router.get("/campaigns/:id/events", requireCampaignAccess, campaignEvents);
router.post("/webhooks/mailgun", handleMailgunWebhook);

export default router;