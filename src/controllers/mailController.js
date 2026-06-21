import { resolveMailCredentials, findAccountByApplierName } from '../services/mail/credentials.js';
import {
	archiveMessage,
	setMessageFlagged,
	setMessageSeen,
	trashMessage,
	moveToInbox,
	fetchGmailLabelList,
	createGmailLabel,
	addLabelsToMessage,
	removeLabelsFromMessage,
} from '../services/mail/imapClient.js';
import { sendMail } from '../services/mail/smtpClient.js';
import {
	getMessage,
	listMessages,
	messageToThread,
	updateMessageFlags,
} from '../services/mail/mailStore.js';
import { mailMessagesCollection } from '../db/mongo.js';
import {
	ensureMessageBody,
	runIncrementalSync,
	runInitialSync,
	runOlderSync,
} from '../services/mail/mailSyncService.js';

function getPageLoadLimit() {
	return Number.parseInt(process.env.MAIL_PAGE_LOAD_LIMIT || '100', 10) || 100;
}

async function requireApplier(req, res) {
	const applierName = String(req.query?.applierName || req.body?.applierName || '').trim();
	if (!applierName) {
		res.status(400).json({ success: false, error: 'applierName required' });
		return null;
	}
	const acc = await findAccountByApplierName(applierName);
	if (!acc) {
		res.status(404).json({ success: false, error: `No account named "${applierName}".` });
		return null;
	}
	return applierName;
}

export async function getMailThreads(req, res) {
	try {
		if (!mailMessagesCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const folder = req.query.folder ? String(req.query.folder) : undefined;
		const label = req.query.label ? String(req.query.label) : undefined;
		const search = req.query.search ? String(req.query.search) : undefined;
		const beforeDate = req.query.beforeDate ? String(req.query.beforeDate) : undefined;
		const limit = req.query.limit ? Number(req.query.limit) : getPageLoadLimit();

		const docs = await listMessages(applierName, { folder, label, search, limit, beforeDate });
		const threads = docs.map(messageToThread);

		return res.json({ success: true, threads, count: threads.length });
	} catch (err) {
		console.error('GET /api/mail/threads error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getMailMessage(req, res) {
	try {
		if (!mailMessagesCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const uid = Number(req.params.uid);
		if (!Number.isFinite(uid)) {
			return res.status(400).json({ success: false, error: 'Invalid message uid' });
		}

		let doc = await getMessage(applierName, uid);
		if (!doc) {
			return res.status(404).json({ success: false, error: 'Message not found' });
		}

		if (!doc.hasBody) {
			const bodyResult = await ensureMessageBody(applierName, uid);
			if (bodyResult.ok && bodyResult.message) {
				doc = bodyResult.message;
			}
		}

		return res.json({ success: true, thread: messageToThread(doc) });
	} catch (err) {
		console.error('GET /api/mail/messages/:uid error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function syncMail(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		const result = await runIncrementalSync(applierName);
		if (!result.ok) {
			return res.status(500).json({ success: false, error: result.error });
		}
		return res.json({
			success: true,
			skipped: result.skipped ?? false,
			newCount: result.newCount ?? 0,
			updatedCount: result.updatedCount ?? 0,
		});
	} catch (err) {
		console.error('POST /api/mail/sync error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function syncMailInitial(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		const force = req.body?.force === true;
		const result = await runInitialSync(applierName, { force });
		if (!result.ok) {
			return res.status(500).json({ success: false, error: result.error });
		}
		return res.json({
			success: true,
			skipped: result.skipped ?? false,
			newCount: result.newCount ?? 0,
		});
	} catch (err) {
		console.error('POST /api/mail/sync/initial error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function syncMailOlder(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		const batchSize = req.body?.batchSize ? Number(req.body.batchSize) : undefined;
		const result = await runOlderSync(applierName, batchSize);
		if (!result.ok) {
			return res.status(500).json({ success: false, error: result.error });
		}
		return res.json({
			success: true,
			skipped: result.skipped ?? false,
			newCount: result.newCount ?? 0,
			hasMore: result.hasMore ?? false,
		});
	} catch (err) {
		console.error('POST /api/mail/sync/older error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function sendMailMessage(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		const { to, subject, body, replyToUid } = req.body || {};
		if (!String(to || '').trim() || !String(subject || '').trim()) {
			return res.status(400).json({ success: false, error: 'to and subject are required' });
		}

		let inReplyTo;
		let references;
		if (replyToUid) {
			const original = await getMessage(applierName, Number(replyToUid));
			if (original?.messageId) {
				inReplyTo = original.messageId;
				references = original.messageId;
			}
		}

		const result = await sendMail({
			email: creds.email,
			password: creds.password,
			to: String(to).trim(),
			subject: String(subject).trim(),
			body: String(body || ''),
			inReplyTo,
			references,
		});

		return res.json({ success: true, messageId: result.messageId });
	} catch (err) {
		console.error('POST /api/mail/send error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function patchMailMessage(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		const uid = Number(req.params.uid);
		if (!Number.isFinite(uid)) {
			return res.status(400).json({ success: false, error: 'Invalid message uid' });
		}

		const { seen, flagged, folder, addLabels, removeLabels } = req.body || {};
		const doc = await getMessage(applierName, uid);
		if (!doc) {
			return res.status(404).json({ success: false, error: 'Message not found' });
		}

		const patch = {};

		if (seen !== undefined) {
			await setMessageSeen(creds.email, creds.password, uid, Boolean(seen));
			patch.flags = { ...doc.flags, seen: Boolean(seen) };
		}

		if (flagged !== undefined) {
			await setMessageFlagged(creds.email, creds.password, uid, Boolean(flagged));
			patch.flags = { ...(patch.flags || doc.flags), flagged: Boolean(flagged) };
		}

		if (addLabels?.length || removeLabels?.length) {
			if (addLabels?.length) {
				await addLabelsToMessage(creds.email, creds.password, uid, addLabels);
			}
			if (removeLabels?.length) {
				await removeLabelsFromMessage(creds.email, creds.password, uid, removeLabels);
			}
			const { fetchFlagsForUids } = await import('../services/mail/imapClient.js');
			const refreshed = await fetchFlagsForUids(creds.email, creds.password, [uid], applierName);
			if (refreshed[0]) {
				patch.gmailLabels = refreshed[0].gmailLabels;
				patch.labels = refreshed[0].labels;
				patch.folder = refreshed[0].folder;
				patch.flags = refreshed[0].flags;
			}
		}

		if (folder !== undefined) {
			if (folder === 'archive') {
				await archiveMessage(creds.email, creds.password, uid);
				patch.folder = 'archive';
			} else if (folder === 'trash') {
				await trashMessage(creds.email, creds.password, uid);
				patch.folder = 'trash';
			} else if (folder === 'inbox') {
				await moveToInbox(creds.email, creds.password, uid);
				patch.folder = 'inbox';
			} else {
				patch.folder = folder;
			}
		}

		const updated = await updateMessageFlags(applierName, uid, patch);
		return res.json({ success: true, thread: messageToThread(updated) });
	} catch (err) {
		console.error('PATCH /api/mail/messages/:uid error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function getMailLabels(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		const labels = await fetchGmailLabelList(creds.email, creds.password);
		return res.json({ success: true, labels });
	} catch (err) {
		console.error('GET /api/mail/labels error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function postMailLabel(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		const name = String(req.body?.name || '').trim();
		if (!name) {
			return res.status(400).json({ success: false, error: 'Label name required' });
		}

		let parentPath;
		if (req.body?.parentId) {
			const existing = await fetchGmailLabelList(creds.email, creds.password);
			const parent = existing.find((l) => l.id === req.body.parentId);
			parentPath = parent?.path || parent?.name;
		}

		const label = await createGmailLabel(creds.email, creds.password, name, parentPath);
		return res.json({ success: true, label });
	} catch (err) {
		console.error('POST /api/mail/labels error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function putMailLabels(req, res) {
	// Legacy — redirect clients to POST /mail/labels for create
	return res.status(400).json({
		success: false,
		error: 'Use POST /api/mail/labels to create a Gmail label.',
	});
}

export async function checkMailCredentials(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.json({ success: true, configured: false, error: creds.error });
		}
		return res.json({ success: true, configured: true, email: creds.email });
	} catch (err) {
		console.error('GET /api/mail/credentials error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}
