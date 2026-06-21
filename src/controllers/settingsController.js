import bcrypt from "bcrypt";
import { accountInfoCollection } from "../db/mongo.js";

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findAccountByName(name) {
	const trimmed = String(name ?? "").trim();
	if (!trimmed) return null;
	let acc = await accountInfoCollection.findOne({ name: trimmed });
	if (acc) return acc;
	return accountInfoCollection.findOne({
		name: { $regex: new RegExp(`^${escapeRegExp(trimmed)}$`, "i") },
	});
}

const DEFAULT_NOTIFICATION_PREFS = {
	applications: true,
	interviews: true,
	jobs: true,
	agents: true,
	mail: true,
};

export async function getNotificationPrefs(req, res) {
	try {
		if (!accountInfoCollection) return res.status(503).json({ success: false, error: "Database not ready" });
		const name = String(req.query?.applierName || "").trim();
		if (!name) return res.status(400).json({ success: false, error: "applierName query required" });

		const acc = await findAccountByName(name);
		if (!acc) {
			return res.json({ success: true, accountExists: false, prefs: DEFAULT_NOTIFICATION_PREFS });
		}

		const prefs = { ...DEFAULT_NOTIFICATION_PREFS, ...(acc.notificationPrefs || {}) };
		return res.json({ success: true, accountExists: true, prefs });
	} catch (err) {
		console.error("GET /api/settings/notifications error", err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function updateNotificationPrefs(req, res) {
	try {
		if (!accountInfoCollection) return res.status(503).json({ success: false, error: "Database not ready" });
		const body = req.body || {};
		const name = String(body.applierName || "").trim();
		if (!name) return res.status(400).json({ success: false, error: "applierName required in body" });

		const acc = await findAccountByName(name);
		if (!acc) {
			return res.status(404).json({ success: false, error: `No account named "${name}".` });
		}

		const prefs = {
			applications: body.applications !== false,
			interviews: body.interviews !== false,
			jobs: body.jobs !== false,
			agents: body.agents !== false,
			mail: body.mail !== false,
		};

		await accountInfoCollection.updateOne({ _id: acc._id }, { $set: { notificationPrefs: prefs } });
		return res.json({ success: true, prefs });
	} catch (err) {
		console.error("PUT /api/settings/notifications error", err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function changePassword(req, res) {
	try {
		if (!accountInfoCollection) return res.status(503).json({ success: false, message: "Database not ready" });
		const { name, currentPassword, newPassword } = req.body || {};
		const trimmed = String(name ?? "").trim();

		if (!trimmed || !currentPassword || !newPassword) {
			return res.status(400).json({ success: false, message: "Name, current password, and new password are required" });
		}
		if (String(newPassword).length < 8) {
			return res.status(400).json({ success: false, message: "New password must be at least 8 characters" });
		}

		const user = await findAccountByName(trimmed);
		if (!user) {
			return res.status(404).json({ success: false, message: "Account not found" });
		}

		let valid = false;
		if (!user.password) {
			valid = String(currentPassword) === "12345678";
		} else {
			valid = await bcrypt.compare(String(currentPassword), user.password);
		}
		if (!valid) {
			return res.status(401).json({ success: false, message: "Current password is incorrect" });
		}

		const hashedPassword = await bcrypt.hash(String(newPassword), 10);
		await accountInfoCollection.updateOne({ _id: user._id }, { $set: { password: hashedPassword } });

		return res.json({ success: true, message: "Password updated successfully" });
	} catch (err) {
		console.error("POST /api/auth/change-password error", err);
		return res.status(500).json({ success: false, message: err.message });
	}
}
