import { resolveMailCredentials } from './credentials.js';
import {
	fetchFlagsForUids,
	fetchMessageBody,
	fetchEnvelopeForUid,
	fetchMailboxPage,
	fetchNewEnvelopes,
	fetchFolderCounts,
} from './imapClient.js';
import {
	acquireSyncLock,
	canSync,
	countMessages,
	getRecentUidsForFlagRefresh,
	getSyncState,
	listMessages,
	releaseSyncLock,
	upsertMessages,
	upsertSyncState,
	messageToThread,
	clearMessageBody,
} from './mailStore.js';
import { ALL_MAIL_PATH, folderToMailbox } from './folderMapper.js';

/**
 * Read one folder page from MongoDB cache only (instant).
 */
export async function loadCachedFolderPage(applierName, folder, page, pageSize) {
	const mailbox = folderToMailbox(folder);
	const state = await getSyncState(applierName);
	const cachedTotal = state?.[`folderTotal_${folder}`];
	const mongoCount = await countMessages(applierName, { folder, mailbox });
	const total =
		typeof cachedTotal === 'number' && cachedTotal > 0 ? cachedTotal : mongoCount;

	const docs = await listMessages(applierName, { folder, mailbox, page, pageSize });
	return {
		ok: true,
		threads: docs.map(messageToThread),
		total,
		page,
		pageSize,
		fromCache: true,
	};
}

/**
 * Fetch one folder page from Gmail if not fully cached; returns threads + total.
 */
export async function loadFolderPage(applierName, folder, page, pageSize) {
	const creds = await resolveMailCredentials(applierName);
	if (!creds.ok) return { ok: false, error: creds.error };

	try {
		const { messages, total } = await fetchMailboxPage(
			creds.email,
			creds.password,
			folder,
			page,
			pageSize,
			applierName,
		);

		if (messages.length) {
			await upsertMessages(messages);
		}

		await upsertSyncState(applierName, {
			[`folderTotal_${folder}`]: total,
			folderCountsUpdatedAt: new Date(),
		});

		return {
			ok: true,
			threads: messages.map(messageToThread),
			total,
			page,
			pageSize,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

export async function loadLabelOrSearchPage(applierName, { folder, label, search, page, pageSize }) {
	const total = await countMessages(applierName, { folder, label, search });
	const docs = await listMessages(applierName, { folder, label, search, page, pageSize });
	return {
		ok: true,
		threads: docs.map(messageToThread),
		total,
		page,
		pageSize,
	};
}

export async function getFolderCounts(applierName) {
	const creds = await resolveMailCredentials(applierName);
	if (!creds.ok) return { ok: false, error: creds.error };

	try {
		const counts = await fetchFolderCounts(creds.email, creds.password);
		await upsertSyncState(applierName, { folderCounts: counts, folderCountsUpdatedAt: new Date() });
		return { ok: true, counts };
	} catch (err) {
		const state = await getSyncState(applierName);
		if (state.folderCounts) {
			return { ok: true, counts: state.folderCounts, cached: true };
		}
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

export async function runIncrementalSync(applierName, { force = false } = {}) {
	const creds = await resolveMailCredentials(applierName);
	if (!creds.ok) return { ok: false, error: creds.error };

	if (!(await canSync(applierName, force))) {
		return { ok: true, skipped: true, newCount: 0, updatedCount: 0 };
	}

	if (!(await acquireSyncLock(applierName))) {
		return { ok: true, skipped: true, newCount: 0, updatedCount: 0 };
	}

	try {
		const state = await getSyncState(applierName);
		let newCount = 0;
		let updatedCount = 0;

		const { messages, highestUid } = await fetchNewEnvelopes(
			creds.email,
			creds.password,
			state.highestUid || 0,
			applierName,
		);
		if (messages.length) {
			const result = await upsertMessages(messages);
			newCount = result.upserted;
		}

		const recentUids = await getRecentUidsForFlagRefresh(applierName);
		if (recentUids.length) {
			const flagUpdates = await fetchFlagsForUids(
				creds.email,
				creds.password,
				recentUids,
				applierName,
				ALL_MAIL_PATH,
			);
			if (flagUpdates.length) {
				const result = await upsertMessages(flagUpdates);
				updatedCount = result.upserted;
			}
		}

		await releaseSyncLock(applierName, {
			highestUid: Math.max(state.highestUid || 0, highestUid),
			lastImapSyncAt: new Date(),
			lastError: null,
			initialSyncComplete: true,
		});

		return { ok: true, newCount, updatedCount };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await releaseSyncLock(applierName, { lastError: message });
		return { ok: false, error: message };
	}
}

/** @deprecated Use loadFolderPage instead */
export async function runInitialSync(applierName, opts = {}) {
	return loadFolderPage(applierName, 'inbox', 1, 25);
}

/** @deprecated Use loadFolderPage instead */
export async function runOlderSync(applierName, batchSize) {
	return { ok: true, newCount: 0, hasMore: false };
}

export async function ensureMessageBody(applierName, uid, mailbox) {
	const creds = await resolveMailCredentials(applierName);
	if (!creds.ok) return { ok: false, error: creds.error };

	const { getMessage, updateMessageBody } = await import('./mailStore.js');
	const mailboxPath = mailbox || ALL_MAIL_PATH;
	let existing = await getMessage(applierName, uid, mailboxPath);

	if (existing?.hasBody && existing.bodyHtml) {
		try {
			const freshEnvelope = await fetchEnvelopeForUid(
				creds.email,
				creds.password,
				uid,
				applierName,
				mailboxPath,
			);
			if (
				freshEnvelope?.messageId &&
				existing.messageId &&
				freshEnvelope.messageId === existing.messageId
			) {
				return { ok: true, message: existing };
			}
		} catch {
			// Re-fetch body below
		}
		await clearMessageBody(applierName, uid, mailboxPath);
		existing = await getMessage(applierName, uid, mailboxPath);
	}

	try {
		const body = await fetchMessageBody(creds.email, creds.password, uid, mailboxPath);
		const updated = await updateMessageBody(applierName, uid, {
			bodyText: body.bodyText,
			bodyHtml: body.bodyHtml,
			preview: body.preview,
			from: body.from,
			to: body.to,
			cc: body.cc,
			subject: body.subject,
			date: body.date,
			flags: body.flags,
			messageId: body.messageId || existing?.messageId || null,
		}, mailboxPath);
		return { ok: true, message: updated };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

/** Prefetch bodies for visible page (background). */
export async function prefetchMessageBodies(applierName, uids, mailbox = ALL_MAIL_PATH) {
	const creds = await resolveMailCredentials(applierName);
	if (!creds.ok) return;

	const { getMessage } = await import('./mailStore.js');
	for (const uid of uids.slice(0, 10)) {
		const existing = await getMessage(applierName, uid, mailbox);
		if (existing?.hasBody) continue;
		try {
			await ensureMessageBody(applierName, uid, mailbox);
		} catch {
			// best effort
		}
	}
}

export { folderToMailbox };
