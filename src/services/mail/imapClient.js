import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
	ALL_MAIL_PATH,
	FOLDER_MAILBOX,
	envelopeFrom,
	envelopeToArray,
	extractCustomLabels,
	folderToMailbox,
	gmailLabelsToArray,
	mapGmailLabelsToFolder,
	messageToDoc,
	toImapLabelToken,
	displayLabelName,
	isSystemLabel,
} from './folderMapper.js';

function stripHtml(html) {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractHtmlBody(parsed) {
	if (parsed.html?.trim()) return parsed.html.trim();
	if (typeof parsed.textAsHtml === 'string' && parsed.textAsHtml.trim()) {
		return parsed.textAsHtml.trim();
	}
	if (Array.isArray(parsed.alternatives)) {
		const htmlAlt = parsed.alternatives.find((part) =>
			String(part.contentType ?? '').toLowerCase().includes('text/html'),
		);
		if (htmlAlt?.content) {
			const content = htmlAlt.content;
			return typeof content === 'string' ? content.trim() : content.toString().trim();
		}
	}
	return null;
}

async function createClient(email, password) {
	const client = new ImapFlow({
		host: 'imap.gmail.com',
		port: 993,
		secure: true,
		auth: { user: email, pass: password },
		logger: false,
	});
	await client.connect();
	return client;
}

export async function verifyImapCredentials(email, password) {
	const normalizedEmail = String(email ?? '').trim();
	const normalizedPassword = String(password ?? '').replace(/\s/g, '');
	if (!normalizedEmail || !normalizedPassword) {
		return { ok: false, error: 'Email and Gmail app password are required.' };
	}
	let client;
	try {
		client = await createClient(normalizedEmail, normalizedPassword);
		await client.logout();
		return { ok: true, email: normalizedEmail };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'IMAP connection failed';
		return { ok: false, error: message, email: normalizedEmail };
	}
}

function inlineCidImages(html, attachments) {
	if (!html || !attachments?.length) return html;
	let result = html;
	for (const att of attachments) {
		const cid = att.cid || att.contentId;
		if (!cid || !att.content) continue;
		const cleanCid = String(cid).replace(/^<|>$/g, '');
		const mime = att.contentType || 'image/png';
		const content = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content);
		const dataUri = `data:${mime};base64,${content.toString('base64')}`;
		const escaped = cleanCid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(new RegExp(`cid:${escaped}`, 'gi'), dataUri);
	}
	return result;
}

async function withMailboxPath(email, password, mailboxPath, fn) {
	const client = await createClient(email, password);
	const lock = await client.getMailboxLock(mailboxPath);
	try {
		return await fn(client);
	} finally {
		lock.release();
		await client.logout();
	}
}

async function withMailbox(email, password, fn) {
	return withMailboxPath(email, password, ALL_MAIL_PATH, fn);
}

/**
 * Fetch the most recent `count` messages by sequence number (envelope only).
 */
export async function fetchRecentEnvelopes(email, password, count, applierName) {
	return withMailbox(email, password, async (client) => {
		const total = client.mailbox.exists ?? 0;
		if (total === 0) return { messages: [], highestUid: 0, lowestUid: 0 };

		const start = Math.max(1, total - count + 1);
		const range = `${start}:${total}`;
		const messages = [];

		for await (const message of client.fetch(range, {
			envelope: true,
			flags: true,
			uid: true,
			labels: true,
		})) {
			messages.push(messageToDoc(message, applierName));
		}

		messages.reverse();
		const uids = messages.map((m) => m.uid);
		return {
			messages,
			highestUid: uids.length ? Math.max(...uids) : 0,
			lowestUid: uids.length ? Math.min(...uids) : 0,
		};
	});
}

/**
 * Fetch messages with UID less than `beforeUid` (older mail).
 */
export async function fetchOlderEnvelopes(email, password, beforeUid, batchSize, applierName) {
	return withMailbox(email, password, async (client) => {
		const searchResult = await client.search({ uid: `1:${beforeUid - 1}` }, { uid: true });
		if (!searchResult || searchResult.length === 0) {
			return { messages: [], hasMore: false, lowestUid: beforeUid };
		}

		const uids = searchResult.sort((a, b) => b - a).slice(0, batchSize);
		const messages = [];

		for await (const message of client.fetch(uids, {
			envelope: true,
			flags: true,
			uid: true,
			labels: true,
		})) {
			messages.push(messageToDoc(message, applierName));
		}

		messages.sort((a, b) => b.uid - a.uid);
		const lowestUid = messages.length ? Math.min(...messages.map((m) => m.uid)) : beforeUid;
		return {
			messages,
			hasMore: searchResult.length > batchSize,
			lowestUid,
		};
	});
}

/**
 * Incremental sync: fetch UIDs above highestUid.
 */
export async function fetchNewEnvelopes(email, password, highestUid, applierName) {
	return withMailbox(email, password, async (client) => {
		const searchResult = await client.search({ uid: `${highestUid + 1}:*` }, { uid: true });
		if (!searchResult || searchResult.length === 0) {
			return { messages: [], highestUid };
		}

		const messages = [];
		for await (const message of client.fetch(searchResult, {
			envelope: true,
			flags: true,
			uid: true,
			labels: true,
		})) {
			messages.push(messageToDoc(message, applierName));
		}

		messages.sort((a, b) => b.uid - a.uid);
		const newHighest = Math.max(highestUid, ...messages.map((m) => m.uid));
		return { messages, highestUid: newHighest };
	});
}

/**
 * Re-fetch flags/labels for given UIDs (recent messages).
 */
export async function fetchFlagsForUids(email, password, uids, applierName) {
	if (!uids.length) return [];
	return withMailbox(email, password, async (client) => {
		const updates = [];
		for await (const message of client.fetch(uids, {
			flags: true,
			uid: true,
			labels: true,
			envelope: true,
		})) {
			const seen = message.flags?.has('\\Seen') ?? false;
			const flagged = message.flags?.has('\\Flagged') ?? false;
			const gmailLabels = gmailLabelsToArray(message.labels);
			const folder = mapGmailLabelsToFolder(message.labels);
			const customLabels = extractCustomLabels(gmailLabels);
			updates.push({
				applierName,
				uid: message.uid,
				flags: { seen, flagged },
				gmailLabels,
				folder,
				labels: customLabels,
				syncedAt: new Date(),
			});
		}
		return updates;
	});
}

export async function fetchMessageBody(email, password, uid) {
	return withMailbox(email, password, async (client) => {
		const message = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
		if (!message?.source) {
			throw new Error('Message not found');
		}

		const parsed = await simpleParser(message.source);
		const from = parsed.from?.value?.[0];
		let htmlBody = extractHtmlBody(parsed);
		if (htmlBody && parsed.attachments?.length) {
			htmlBody = inlineCidImages(htmlBody, parsed.attachments);
		}
		const textBody = parsed.text?.trim() || stripHtml(parsed.html ?? '');
		const previewSource = textBody || stripHtml(parsed.html ?? '') || parsed.subject || '';

		const seen = message.flags?.has('\\Seen') ?? false;
		const flagged = message.flags?.has('\\Flagged') ?? false;

		return {
			uid,
			from: {
				name: from?.name || from?.address || parsed.from?.text || 'Unknown',
				email: from?.address || '',
			},
			to: envelopeToArray(parsed.to?.value),
			cc: envelopeToArray(parsed.cc?.value),
			subject: parsed.subject || '(No subject)',
			preview: previewSource.slice(0, 120).replace(/\s+/g, ' '),
			bodyText: textBody || '(No text content)',
			bodyHtml: htmlBody,
			date: parsed.date ?? new Date(),
			flags: { seen, flagged },
			hasBody: true,
		};
	});
}

export async function setMessageSeen(email, password, uid, seen) {
	return withMailbox(email, password, async (client) => {
		if (seen) {
			await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
		} else {
			await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
		}
	});
}

export async function setMessageFlagged(email, password, uid, flagged) {
	return withMailbox(email, password, async (client) => {
		if (flagged) {
			await client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
		} else {
			await client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
		}
	});
}

export async function archiveMessage(email, password, uid) {
	return withMailbox(email, password, async (client) => {
		await client.messageLabelsRemove(String(uid), ['\\Inbox'], { uid: true });
	});
}

export async function trashMessage(email, password, uid) {
	return withMailbox(email, password, async (client) => {
		await client.messageLabelsAdd(String(uid), ['\\Trash'], { uid: true });
		await client.messageLabelsRemove(String(uid), ['\\Inbox'], { uid: true });
	});
}

export async function moveToInbox(email, password, uid) {
	return withMailbox(email, password, async (client) => {
		await client.messageLabelsAdd(String(uid), ['\\Inbox'], { uid: true });
		await client.messageLabelsRemove(String(uid), ['\\Trash'], { uid: true });
	});
}

async function withClient(email, password, fn) {
	const client = await createClient(email, password);
	try {
		return await fn(client);
	} finally {
		await client.logout();
	}
}

/**
 * List user-created Gmail labels from IMAP mailboxes.
 */
export async function fetchGmailLabelList(email, password) {
	return withClient(email, password, async (client) => {
		const mailboxes = await client.list();
		const labels = [];

		for (const box of mailboxes) {
			const path = displayLabelName(box.path);
			if (!path || path.startsWith('[Gmail]') || path.startsWith('[Google]')) continue;
			if (isSystemLabel(path)) continue;

			const parts = path.split('/');
			const name = parts[parts.length - 1];
			const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : undefined;
			const parentId = parentPath ? parentPath.toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined;

			labels.push({
				id: path.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
				name: path,
				shortName: name,
				path,
				parentId,
			});
		}

		labels.sort((a, b) => a.name.localeCompare(b.name));
		return labels;
	});
}

/**
 * Create a Gmail label (optionally nested under parent).
 */
export async function createGmailLabel(email, password, name, parentPath) {
	const trimmed = String(name ?? '').trim();
	if (!trimmed) throw new Error('Label name required');
	const fullPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;

	return withClient(email, password, async (client) => {
		await client.mailboxCreate(fullPath);
		const parts = fullPath.split('/');
		return {
			id: fullPath.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
			name: fullPath,
			shortName: parts[parts.length - 1],
			path: fullPath,
			parentId: parentPath
				? parentPath.toLowerCase().replace(/[^a-z0-9]+/g, '-')
				: undefined,
		};
	});
}

export async function addLabelsToMessage(email, password, uid, labelNames) {
	const tokens = (labelNames || []).map(toImapLabelToken).filter(Boolean);
	if (!tokens.length) return;
	return withMailbox(email, password, async (client) => {
		await client.messageLabelsAdd(String(uid), tokens, { uid: true });
	});
}

export async function removeLabelsFromMessage(email, password, uid, labelNames) {
	const tokens = (labelNames || []).map(toImapLabelToken).filter(Boolean);
	if (!tokens.length) return;
	return withMailbox(email, password, async (client) => {
		await client.messageLabelsRemove(String(uid), tokens, { uid: true });
	});
}

/**
 * Fetch one page of messages from a folder-specific Gmail mailbox.
 */
export async function fetchMailboxPage(email, password, folder, page, pageSize, applierName) {
	const mailboxPath = folderToMailbox(folder);
	return withMailboxPath(email, password, mailboxPath, async (client) => {
		const total = client.mailbox.exists ?? 0;
		if (total === 0) return { messages: [], total: 0 };

		const size = Math.min(Math.max(pageSize, 1), 100);
		const end = total - (page - 1) * size;
		const start = Math.max(1, end - size + 1);
		if (end < 1) return { messages: [], total };

		const messages = [];
		for await (const message of client.fetch(`${start}:${end}`, {
			envelope: true,
			flags: true,
			uid: true,
			labels: true,
		})) {
			const doc = messageToDoc(message, applierName);
			doc.folder = folder;
			messages.push(doc);
		}
		messages.reverse();
		return { messages, total };
	});
}

/**
 * Live folder totals from Gmail (total + unread for inbox).
 */
export async function fetchFolderCounts(email, password) {
	const client = await createClient(email, password);
	const counts = {};
	try {
		for (const [folder, path] of Object.entries(FOLDER_MAILBOX)) {
			const lock = await client.getMailboxLock(path);
			try {
				const total = client.mailbox.exists ?? 0;
				let unread = 0;
				if (folder === 'inbox') {
					const unseen = await client.search({ unseen: true });
					unread = Array.isArray(unseen) ? unseen.length : 0;
				}
				counts[folder] = {
					total,
					unread,
					badge: folder === 'inbox' ? unread : total,
				};
			} finally {
				lock.release();
			}
		}
	} finally {
		await client.logout();
	}
	return counts;
}
