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
router.post("/campaigns/:id/send-test", requireCampaignAccess, sendCampaignTest);
router.get("/campaigns/:id/status", requireCampaignAccess, campaignStatus);
router.get("/campaigns/:id/progress", requireCampaignAccess, campaignProgress);
router.get("/campaigns/:id/events", requireCampaignAccess, campaignEvents);
router.post("/webhooks/mailgun", handleMailgunWebhook);

export default router;