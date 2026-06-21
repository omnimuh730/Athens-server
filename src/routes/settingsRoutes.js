import express from "express";
import {
	changePassword,
	getNotificationPrefs,
	updateNotificationPrefs,
} from "../controllers/settingsController.js";

const router = express.Router();

router.get("/settings/notifications", getNotificationPrefs);
router.put("/settings/notifications", updateNotificationPrefs);
router.post("/auth/change-password", changePassword);

export default router;
