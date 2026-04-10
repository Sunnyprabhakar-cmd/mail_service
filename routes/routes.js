import { Router } from "express";
import { uploadCampaignForm } from "../middlewares/upload.js";
import { requireCampaignAccess } from "../middlewares/campaignAuth.js";
import { getHealth } from "../controllers/healthController.js";
import {
	campaignEvents,
	campaignEventsList,
	getCampaigns,
	campaignProgress,
	campaignStatus,
	retryPendingCampaignRecipients,
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
router.post("/campaigns/:id/retry-pending", requireCampaignAccess, retryPendingCampaignRecipients);
router.post("/campaigns/:id/send-test", requireCampaignAccess, sendCampaignTest);
router.get("/campaigns/:id/status", campaignStatus);
router.get("/campaigns/:id/progress", campaignProgress);
router.get("/campaigns/:id/events", campaignEvents);
router.get("/campaigns/:id/events/list", campaignEventsList);
router.post("/webhooks/mailgun", handleMailgunWebhook);

export default router;