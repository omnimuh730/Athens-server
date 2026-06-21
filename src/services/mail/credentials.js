import { accountInfoCollection } from '../../db/mongo.js';

async function findAccountByApplierName(nameRaw) {
	const trimmed = String(nameRaw ?? '').trim();
	if (!trimmed || !accountInfoCollection) return null;
	let acc = await accountInfoCollection.findOne(
		{ name: trimmed },
		{ projection: { name: 1, autoBidProfile: 1 } },
	);
	if (acc) return acc;
	const esc = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	acc = await accountInfoCollection.findOne(
		{ name: { $regex: new RegExp(`^${esc}$`, 'i') } },
		{ projection: { name: 1, autoBidProfile: 1 } },
	);
	return acc || null;
}

export async function resolveMailCredentials(applierName) {
	const acc = await findAccountByApplierName(applierName);
	if (!acc) {
		return { ok: false, error: `No account named "${applierName}".` };
	}
	const profile = acc.autoBidProfile || {};
	const email = String(profile.email ?? '').trim();
	const password = String(profile.gmailAppPassword ?? '').replace(/\s/g, '');
	if (!email || !password) {
		return {
			ok: false,
			error: 'Configure Gmail email and app password in Settings → Profile.',
		};
	}
	return { ok: true, email, password, applierName: acc.name };
}

export { findAccountByApplierName };
