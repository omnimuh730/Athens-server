import { resolveMailCredentials, findAccountByApplierName } from '../services/mail/credentials.js';
import {
	archiveMessage,
	setMessageFlagged,
	setMessageSeen,
	trashMessage,
	moveToInbox,
	fetchGmailLabelList,
	createGmailLabel,
	deleteGmailLabel,
	addLabelsToMessage,
	removeLabelsFromMessage,
} from '../services/mail/imapClient.js';
import { sendMail } from '../services/mail/smtpClient.js';
import {
	getMessage,
	messageToThread,
	updateMessageFlags,
} from '../services/mail/mailStore.js';
import { mailMessagesCollection } from '../db/mongo.js';
import {
	ensureMessageBody,
	runIncrementalSync,
	loadFolderPage,
	loadCachedFolderPage,
	loadLabelOrSearchPage,
	getFolderCounts,
	prefetchMessageBodies,
	folderToMailbox,
} from '../services/mail/mailSyncService.js';
import { ALL_MAIL_PATH } from '../services/mail/folderMapper.js';

function parsePageQuery(req) {
	const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
	const pageSize = Math.min(
		100,
		Math.max(1, Number.parseInt(String(req.query.pageSize || '25'), 10) || 25),
	);
	return { page, pageSize };
}

export async function getMailThreads(req, res) {
	try {
		if (!mailMessagesCollection) {
			return res.status(503).json({ success: false, error: 'Database not ready' });
		}
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const folder = req.query.folder ? String(req.query.folder) : 'inbox';
		const label = req.query.label ? String(req.query.label) : undefined;
		const search = req.query.search ? String(req.query.search) : undefined;
		const { page, pageSize } = parsePageQuery(req);
		const cacheOnly = req.query.cacheOnly === 'true' || req.query.cacheOnly === '1';

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		let result;
		if (cacheOnly) {
			if (label || search) {
				result = await loadLabelOrSearchPage(applierName, { folder, label, search, page, pageSize });
				result.fromCache = true;
			} else {
				result = await loadCachedFolderPage(applierName, folder, page, pageSize);
			}
		} else if (label || search) {
			result = await loadLabelOrSearchPage(applierName, { folder, label, search, page, pageSize });
		} else {
			result = await loadFolderPage(applierName, folder, page, pageSize);
		}

		if (!result.ok) {
			return res.status(500).json({ success: false, error: result.error });
		}

		if (!cacheOnly) {
			const uids = result.threads.map((t) => Number(t.uid)).filter(Boolean);
			const mailbox = folderToMailbox(folder);
			void prefetchMessageBodies(applierName, uids, mailbox);
		}

		return res.json({
			success: true,
			threads: result.threads,
			total: result.total,
			page: result.page,
			pageSize: result.pageSize,
			fromCache: result.fromCache ?? false,
		});
	} catch (err) {
		console.error('GET /api/mail/threads error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
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

		const folder = req.query.folder ? String(req.query.folder) : 'inbox';
		const mailbox = folderToMailbox(folder);

		let doc = await getMessage(applierName, uid, mailbox);
		if (!doc) {
			return res.status(404).json({ success: false, error: 'Message not found' });
		}

		const bodyResult = await ensureMessageBody(applierName, uid, doc.mailbox || mailbox);
		if (bodyResult.ok && bodyResult.message) {
			doc = bodyResult.message;
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

		const folder = req.body?.folder ? String(req.body.folder) : 'inbox';
		const page = Math.max(1, Number(req.body?.page) || 1);
		const pageSize = Math.min(100, Math.max(1, Number(req.body?.pageSize) || 25));

		const result = await loadFolderPage(applierName, folder, page, pageSize);
		if (!result.ok) {
			return res.status(500).json({ success: false, error: result.error });
		}
		return res.json({
			success: true,
			threads: result.threads,
			total: result.total,
			page: result.page,
			pageSize: result.pageSize,
		});
	} catch (err) {
		console.error('POST /api/mail/sync/initial error', err);
		return res.status(500).json({ success: false, error: err.message });
	}
}

export async function syncMailOlder(req, res) {
	return res.json({ success: true, newCount: 0, hasMore: false, message: 'Use page navigation instead' });
}

export async function getMailFolderCounts(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const result = await getFolderCounts(applierName);
		if (!result.ok) {
			return res.status(500).json({ success: false, error: result.error });
		}
		return res.json({ success: true, counts: result.counts, cached: result.cached ?? false });
	} catch (err) {
		console.error('GET /api/mail/folder-counts error', err);
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
			const replyFolder = req.body?.sourceFolder ? String(req.body.sourceFolder) : 'inbox';
			const original = await getMessage(
				applierName,
				Number(replyToUid),
				folderToMailbox(replyFolder),
			);
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

		const { seen, flagged, folder, addLabels, removeLabels, sourceFolder } = req.body || {};
		const lookupFolder = sourceFolder ? String(sourceFolder) : folder ? String(folder) : 'inbox';
		let doc = await getMessage(applierName, uid, folderToMailbox(lookupFolder));
		if (!doc) {
			return res.status(404).json({ success: false, error: 'Message not found' });
		}

		const mailbox = doc.mailbox || ALL_MAIL_PATH;
		const patch = {};

		if (seen !== undefined) {
			await setMessageSeen(creds.email, creds.password, uid, Boolean(seen), mailbox);
			patch.flags = { ...doc.flags, seen: Boolean(seen) };
		}

		if (flagged !== undefined) {
			await setMessageFlagged(creds.email, creds.password, uid, Boolean(flagged), mailbox);
			patch.flags = { ...(patch.flags || doc.flags), flagged: Boolean(flagged) };
		}

		if (addLabels?.length || removeLabels?.length) {
			if (addLabels?.length) {
				await addLabelsToMessage(creds.email, creds.password, uid, addLabels, mailbox);
			}
			if (removeLabels?.length) {
				await removeLabelsFromMessage(creds.email, creds.password, uid, removeLabels, mailbox);
			}
			const { fetchFlagsForUids } = await import('../services/mail/imapClient.js');
			const refreshed = await fetchFlagsForUids(creds.email, creds.password, [uid], applierName, mailbox);
			if (refreshed[0]) {
				patch.gmailLabels = refreshed[0].gmailLabels;
				patch.labels = refreshed[0].labels;
				patch.folder = refreshed[0].folder;
				patch.flags = refreshed[0].flags;
			}
		}

		if (folder !== undefined) {
			if (folder === 'archive') {
				await archiveMessage(creds.email, creds.password, uid, mailbox);
				patch.folder = 'archive';
			} else if (folder === 'trash') {
				await trashMessage(creds.email, creds.password, uid, mailbox);
				patch.folder = 'trash';
			} else if (folder === 'inbox') {
				await moveToInbox(creds.email, creds.password, uid, mailbox);
				patch.folder = 'inbox';
			} else {
				patch.folder = folder;
			}
		}

		const updated = await updateMessageFlags(applierName, uid, patch, mailbox);
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

export async function deleteMailLabel(req, res) {
	try {
		const applierName = await requireApplier(req, res);
		if (!applierName) return;

		const creds = await resolveMailCredentials(applierName);
		if (!creds.ok) {
			return res.status(400).json({ success: false, error: creds.error, credentialsMissing: true });
		}

		const labelId = String(req.params.labelId || '').trim();
		if (!labelId) {
			return res.status(400).json({ success: false, error: 'Label id required' });
		}

		const labels = await fetchGmailLabelList(creds.email, creds.password);
		const label = labels.find((l) => l.id === labelId);
		if (!label) {
			return res.status(404).json({ success: false, error: 'Label not found' });
		}

		await deleteGmailLabel(creds.email, creds.password, label.path || label.name);
		return res.json({ success: true, deleted: label.path || label.name });
	} catch (err) {
		console.error('DELETE /api/mail/labels/:labelId error', err);
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
