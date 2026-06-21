import {
	mailMessagesCollection,
	mailSyncStateCollection,
} from '../../db/mongo.js';
import { ALL_MAIL_PATH, extractCustomLabels } from './folderMapper.js';

function getInitialSyncSize() {
	return Number.parseInt(process.env.MAIL_INITIAL_SYNC_SIZE || '250', 10) || 250;
}

function getOlderBatchSize() {
	return Number.parseInt(process.env.MAIL_OLDER_BATCH_SIZE || '50', 10) || 50;
}

function getSyncMinIntervalMs() {
	return Number.parseInt(process.env.MAIL_SYNC_MIN_INTERVAL_MS || '45000', 10) || 45000;
}

export { getInitialSyncSize, getOlderBatchSize, getSyncMinIntervalMs };

export async function getSyncState(applierName) {
	if (!mailSyncStateCollection) return null;
	const doc = await mailSyncStateCollection.findOne({ applierName });
	return (
		doc || {
			applierName,
			highestUid: 0,
			oldestCachedUid: 0,
			initialSyncComplete: false,
			lastImapSyncAt: null,
			syncInProgress: false,
			lastError: null,
		}
	);
}

export async function upsertSyncState(applierName, patch) {
	if (!mailSyncStateCollection) return;
	await mailSyncStateCollection.updateOne(
		{ applierName },
		{
			$set: { ...patch, updatedAt: new Date() },
			$setOnInsert: { applierName },
		},
		{ upsert: true },
	);
}

export async function acquireSyncLock(applierName) {
	if (!mailSyncStateCollection) return false;
	const result = await mailSyncStateCollection.findOneAndUpdate(
		{
			applierName,
			$or: [{ syncInProgress: { $exists: false } }, { syncInProgress: { $ne: true } }],
		},
		{
			$set: { syncInProgress: true, updatedAt: new Date() },
			$setOnInsert: {
				applierName,
				highestUid: 0,
				oldestCachedUid: 0,
				initialSyncComplete: false,
			},
		},
		{ returnDocument: 'after', upsert: true },
	);
	return Boolean(result && result.syncInProgress);
}

export async function releaseSyncLock(applierName, patch = {}) {
	await upsertSyncState(applierName, { syncInProgress: false, ...patch });
}

export async function canSync(applierName, force = false) {
	if (force) return true;
	const state = await getSyncState(applierName);
	if (state.syncInProgress) return false;
	if (!state.lastImapSyncAt) return true;
	const elapsed = Date.now() - new Date(state.lastImapSyncAt).getTime();
	return elapsed >= getSyncMinIntervalMs();
}

export async function upsertMessages(messages) {
	if (!mailMessagesCollection || !messages.length) return { upserted: 0 };
	const ops = messages.map((msg) => {
		const mailbox = msg.mailbox || ALL_MAIL_PATH;
		const setFields = { ...msg, mailbox, syncedAt: new Date() };
		// Preserve cached bodies when refreshing envelopes/flags only
		if (!msg.hasBody) {
			delete setFields.hasBody;
			delete setFields.bodyText;
			delete setFields.bodyHtml;
		}
		return {
			updateOne: {
				filter: { applierName: msg.applierName, mailbox, uid: msg.uid },
				update: {
					$set: setFields,
					$setOnInsert: { hasBody: false, bodyText: '', bodyHtml: null },
				},
				upsert: true,
			},
		};
	});
	const result = await mailMessagesCollection.bulkWrite(ops, { ordered: false });
	return { upserted: result.upsertedCount + result.modifiedCount };
}

function messageFilter(applierName, uid, mailbox) {
	const filter = { applierName, uid: Number(uid) };
	if (mailbox) filter.mailbox = mailbox;
	return filter;
}

export async function updateMessageFlags(applierName, uid, patch, mailbox = ALL_MAIL_PATH) {
	if (!mailMessagesCollection) return null;
	const result = await mailMessagesCollection.findOneAndUpdate(
		messageFilter(applierName, uid, mailbox),
		{ $set: { ...patch, syncedAt: new Date() } },
		{ returnDocument: 'after' },
	);
	return result;
}

export async function updateMessageBody(applierName, uid, bodyPatch, mailbox = ALL_MAIL_PATH) {
	if (!mailMessagesCollection) return null;
	return mailMessagesCollection.findOneAndUpdate(
		messageFilter(applierName, uid, mailbox),
		{
			$set: {
				...bodyPatch,
				mailbox,
				hasBody: true,
				syncedAt: new Date(),
			},
		},
		{ returnDocument: 'after' },
	);
}

export async function clearMessageBody(applierName, uid, mailbox = ALL_MAIL_PATH) {
	if (!mailMessagesCollection) return null;
	return mailMessagesCollection.findOneAndUpdate(
		messageFilter(applierName, uid, mailbox),
		{
			$set: {
				hasBody: false,
				bodyText: '',
				bodyHtml: null,
				syncedAt: new Date(),
			},
		},
		{ returnDocument: 'after' },
	);
}

export async function getMessage(applierName, uid, mailbox) {
	if (!mailMessagesCollection) return null;
	if (mailbox) {
		let doc = await mailMessagesCollection.findOne(messageFilter(applierName, uid, mailbox));
		if (!doc) {
			// Legacy rows keyed only by uid (pre-mailbox migration)
			doc = await mailMessagesCollection.findOne({
				applierName,
				uid: Number(uid),
				$or: [{ mailbox: { $exists: false } }, { mailbox: null }, { mailbox: '' }],
			});
		}
		return doc;
	}
	// Legacy fallback: prefer INBOX over All Mail when ambiguous
	const docs = await mailMessagesCollection
		.find({ applierName, uid: Number(uid) })
		.sort({ syncedAt: -1 })
		.limit(5)
		.toArray();
	if (docs.length === 1) return docs[0];
	const inbox = docs.find((d) => d.mailbox === 'INBOX');
	return inbox || docs[0] || null;
}

export async function listMessages(
	applierName,
	{ folder, label, search, page = 1, pageSize = 25, limit, beforeDate, mailbox } = {},
) {
	if (!mailMessagesCollection) return [];

	const filter = buildMessageFilter(applierName, { folder, label, search, beforeDate, mailbox });
	const size = Math.min(Math.max(limit ?? pageSize, 1), 100);
	const skip = limit ? 0 : (Math.max(page, 1) - 1) * size;

	return mailMessagesCollection.find(filter).sort({ date: -1 }).skip(skip).limit(size).toArray();
}

export async function countMessages(applierName, { folder, label, search, beforeDate, mailbox } = {}) {
	if (!mailMessagesCollection) return 0;
	const filter = buildMessageFilter(applierName, { folder, label, search, beforeDate, mailbox });
	return mailMessagesCollection.countDocuments(filter);
}

function buildMessageFilter(applierName, { folder, label, search, beforeDate, mailbox } = {}) {
	const filter = { applierName };
	if (mailbox) filter.mailbox = mailbox;
	if (folder) filter.folder = folder;
	if (label) {
		const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		filter.gmailLabels = { $regex: escaped, $options: 'i' };
	}
	if (beforeDate) filter.date = { $lt: new Date(beforeDate) };
	if (search?.trim()) {
		const q = search.trim();
		filter.$or = [
			{ subject: { $regex: q, $options: 'i' } },
			{ 'from.name': { $regex: q, $options: 'i' } },
			{ 'from.email': { $regex: q, $options: 'i' } },
			{ preview: { $regex: q, $options: 'i' } },
			{ bodyText: { $regex: q, $options: 'i' } },
		];
	}
	return filter;
}

export async function getCachedMessageCount(applierName, uids, mailbox = ALL_MAIL_PATH) {
	if (!mailMessagesCollection || !uids.length) return 0;
	return mailMessagesCollection.countDocuments({
		applierName,
		mailbox,
		uid: { $in: uids },
	});
}

/** Load cached body flags (and content) for a page of IMAP envelopes. */
export async function getMessagesByUids(applierName, uids, mailbox = ALL_MAIL_PATH) {
	if (!mailMessagesCollection || !uids.length) return [];
	return mailMessagesCollection
		.find({ applierName, mailbox, uid: { $in: uids } })
		.project({
			uid: 1,
			hasBody: 1,
			bodyHtml: 1,
			bodyText: 1,
			preview: 1,
			messageId: 1,
		})
		.toArray();
}

export function enrichMessagesFromCache(messages, cachedDocs) {
	if (!cachedDocs.length) return messages;
	const byUid = new Map(cachedDocs.map((d) => [d.uid, d]));
	return messages.map((msg) => {
		const cached = byUid.get(msg.uid);
		if (!cached?.hasBody) return msg;
		return {
			...msg,
			hasBody: true,
			bodyHtml: cached.bodyHtml ?? msg.bodyHtml,
			bodyText: cached.bodyText || msg.bodyText,
			preview: cached.preview || msg.preview,
			messageId: cached.messageId || msg.messageId,
		};
	});
}

export async function getRecentUidsForFlagRefresh(applierName, days = 7) {
	if (!mailMessagesCollection) return [];
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const docs = await mailMessagesCollection
		.find({ applierName, date: { $gte: since } })
		.project({ uid: 1 })
		.toArray();
	return docs.map((d) => d.uid);
}

export async function getUserLabels(_applierName) {
	// Deprecated — labels come from Gmail via IMAP in mailController
	return [];
}

export async function saveUserLabels(_applierName, labels) {
	return labels;
}

export function messageToThread(doc, { includeBody = true } = {}) {
	const date = doc.date instanceof Date ? doc.date : new Date(doc.date);
	const customLabels = doc.gmailLabels?.length
		? extractCustomLabels(doc.gmailLabels)
		: (doc.labels || []).filter((l) => l !== 'starred' && l !== 'Starred');

	return {
		id: String(doc.uid),
		uid: doc.uid,
		mailbox: doc.mailbox || ALL_MAIL_PATH,
		from: doc.from?.name
			? doc.from.email
				? doc.from.name
				: doc.from.name
			: doc.from?.email || 'Unknown',
		fromEmail: doc.from?.email || '',
		subj: doc.subject || '(No subject)',
		prev: doc.preview || '',
		body: includeBody ? doc.bodyText || doc.preview || '' : doc.preview || '',
		bodyHtml: includeBody ? doc.bodyHtml || null : null,
		time: formatMailTime(date),
		date: date.toISOString(),
		unread: !doc.flags?.seen,
		starred: Boolean(doc.flags?.flagged),
		tag: customLabels[0] || '',
		folder: doc.folder || 'inbox',
		labels: customLabels,
		gmailLabels: doc.gmailLabels || [],
		hasBody: Boolean(doc.hasBody),
	};
}

/** Today → "3:17 PM"; previous days → "Jun 19" (single line) */
function formatMailTime(date) {
	const now = new Date();
	const isToday =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();

	if (isToday) {
		return date.toLocaleTimeString(undefined, {
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
		});
	}
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${months[date.getMonth()]} ${date.getDate()}`;
}
