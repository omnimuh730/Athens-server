import { resolveMailCredentials } from './credentials.js';
import {
	fetchFlagsForUids,
	fetchMessageBody,
	fetchNewEnvelopes,
	fetchOlderEnvelopes,
	fetchRecentEnvelopes,
} from './imapClient.js';
import {
	acquireSyncLock,
	canSync,
	getInitialSyncSize,
	getOlderBatchSize,
	getRecentUidsForFlagRefresh,
	getSyncState,
	releaseSyncLock,
	upsertMessages,
	upsertSyncState,
} from './mailStore.js';

export async function runInitialSync(applierName, { force = false } = {}) {
	const creds = await resolveMailCredentials(applierName);
	if (!creds.ok) return { ok: false, error: creds.error };

	const state = await getSyncState(applierName);
	if (state.initialSyncComplete && !force) {
		return { ok: true, skipped: true, message: 'Initial sync already complete' };
	}

	if (!(await canSync(applierName, force))) {
		return { ok: true, skipped: true, message: 'Sync throttled' };
	}

	if (!(await acquireSyncLock(applierName))) {
		return { ok: true, skipped: true, message: 'Sync already in progress' };
	}

	try {
		const count = getInitialSyncSize();
		const { messages, highestUid, lowestUid } = await fetchRecentEnvelopes(
			creds.email,
			creds.password,
			count,
			applierName,
		);

		const { upserted } = await upsertMessages(messages);

		await releaseSyncLock(applierName, {
			highestUid: Math.max(state.highestUid, highestUid),
			oldestCachedUid: lowestUid || state.oldestCachedUid,
			initialSyncComplete: true,
			lastImapSyncAt: new Date(),
			lastError: null,
		});

		return { ok: true, newCount: upserted, highestUid, lowestUid };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await releaseSyncLock(applierName, { lastError: message });
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

		if (!state.initialSyncComplete) {
			await releaseSyncLock(applierName);
			return runInitialSync(applierName, { force });
		}

		let newCount = 0;
		let updatedCount = 0;

		const { messages, highestUid } = await fetchNewEnvelopes(
			creds.email,
			creds.password,
			state.highestUid,
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
			);
			if (flagUpdates.length) {
				const result = await upsertMessages(flagUpdates);
				updatedCount = result.upserted;
			}
		}

		await releaseSyncLock(applierName, {
			highestUid: Math.max(state.highestUid, highestUid),
			lastImapSyncAt: new Date(),
			lastError: null,
		});

		return { ok: true, newCount, updatedCount };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await releaseSyncLock(applierName, { lastError: message });
		return { ok: false, error: message };
	}
}

export async function runOlderSync(applierName, batchSize) {
	const creds = await resolveMailCredentials(applierName);
	if (!creds.ok) return { ok: false, error: creds.error };

	const state = await getSyncState(applierName);
	if (!state.initialSyncComplete) {
		return runInitialSync(applierName);
	}

	const beforeUid = state.oldestCachedUid;
	if (!beforeUid || beforeUid <= 1) {
		return { ok: true, newCount: 0, hasMore: false };
	}

	if (!(await acquireSyncLock(applierName))) {
		return { ok: true, skipped: true, newCount: 0 };
	}

	try {
		const size = batchSize || getOlderBatchSize();
		const { messages, hasMore, lowestUid } = await fetchOlderEnvelopes(
			creds.email,
			creds.password,
			beforeUid,
			size,
			applierName,
		);

		const { upserted } = await upsertMessages(messages);

		await releaseSyncLock(applierName, {
			oldestCachedUid: lowestUid < beforeUid ? lowestUid : state.oldestCachedUid,
			lastImapSyncAt: new Date(),
			lastError: null,
		});

		return { ok: true, newCount: upserted, hasMore };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await releaseSyncLock(applierName, { lastError: message });
		return { ok: false, error: message };
	}
}

export async function ensureMessageBody(applierName, uid) {
	const creds = await resolveMailCredentials(applierName);
	if (!creds.ok) return { ok: false, error: creds.error };

	const { getMessage, updateMessageBody } = await import('./mailStore.js');
	const existing = await getMessage(applierName, uid);
	if (existing?.hasBody && existing.bodyText) {
		return { ok: true, message: existing };
	}

	try {
		const body = await fetchMessageBody(creds.email, creds.password, uid);
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
		});
		return { ok: true, message: updated };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}
