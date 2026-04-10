import { Router } from "express";
import { uploadCampaignForm } from "../middlewares/upload.js";
import { requireCampaignAccess } from "../middlewares/campaignAuth.js";
import { getHealth } from "../controllers/healthController.js";
import {
	campaignEvents,
	getCampaigns,
	campaignProgress,
	campaignStatus,
	sendCampaignTest,
	sendCampaign,
	uploadCampaignCsv
} from "../controllers/campaignController.js";
import { handleMailgunWebhook } from "../controllers/webhookController.js";

const router = Router();

router.get("/health", getHealth);

router.get("/campaigns", getCampaigns);
router.post("/campaigns/upload", uploadCampaignForm, uploadCampaignCsv);
router.post("/campaigns/:id/send", requireCampaignAccess, sendCampaign);
router.post("/campaigns/:id/send-test", sendCampaignTest);
router.post("/campaigns/send-test", sendCampaignTest);
router.get("/campaigns/:id/status", campaignStatus);
router.get("/campaigns/:id/progress", campaignProgress);
router.get("/campaigns/:id/events", campaignEvents);
router.post("/webhooks/mailgun", handleMailgunWebhook);

export default router;