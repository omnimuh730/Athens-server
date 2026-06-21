const ALL_MAIL_PATH = '[Gmail]/All Mail';

/** Gmail IMAP mailbox paths per Athens folder. */
export const FOLDER_MAILBOX = {
	inbox: 'INBOX',
	sent: '[Gmail]/Sent Mail',
	drafts: '[Gmail]/Drafts',
	trash: '[Gmail]/Trash',
	spam: '[Gmail]/Spam',
};

export function folderToMailbox(folder) {
	return FOLDER_MAILBOX[folder] || ALL_MAIL_PATH;
}

/** Gmail system labels — excluded from custom label display/filter. */
const SYSTEM_LABELS = new Set([
	'inbox',
	'sent',
	'drafts',
	'trash',
	'spam',
	'starred',
	'important',
	'unread',
	'chat',
	'all mail',
	'all',
	'archive',
]);

function normalizeLabel(raw) {
	return String(raw ?? '')
		.toLowerCase()
		.replace(/^\\+/, '')
		.trim();
}

function displayLabelName(raw) {
	return String(raw ?? '')
		.replace(/^\\+/, '')
		.trim();
}

function isSystemLabel(raw) {
	const n = normalizeLabel(raw);
	if (SYSTEM_LABELS.has(n)) return true;
	if (n.startsWith('category_')) return true;
	if (n.startsWith('[gmail]')) return true;
	if (n.startsWith('[google]')) return true;
	return false;
}

/** User-created Gmail labels on a message (e.g. Application, Notify/Decline). */
export function extractCustomLabels(gmailLabels) {
	if (!Array.isArray(gmailLabels)) return [];
	const seen = new Set();
	const result = [];
	for (const raw of gmailLabels) {
		const name = displayLabelName(raw);
		if (!name || isSystemLabel(name)) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(name);
	}
	return result;
}

/** IMAP label token for Gmail X-GM-LABELS (leading backslash). */
export function toImapLabelToken(labelName) {
	const name = displayLabelName(labelName);
	if (!name) return null;
	return name.startsWith('\\') ? name : `\\${name}`;
}

function hasLabel(labels, target) {
	if (!labels || labels.size === 0) return false;
	const normalized = [...labels].map(normalizeLabel);
	const t = normalizeLabel(target);
	return normalized.some((l) => l === t || l.endsWith(`/${t}`));
}

/**
 * Map Gmail labels to Athens folder id.
 * Priority: trash > spam > drafts > sent > inbox > archive
 */
export function mapGmailLabelsToFolder(labels) {
	if (!labels || labels.size === 0) return 'archive';
	if (hasLabel(labels, '\\trash') || hasLabel(labels, 'trash')) return 'trash';
	if (hasLabel(labels, '\\junk') || hasLabel(labels, 'spam')) return 'spam';
	if (hasLabel(labels, '\\drafts') || hasLabel(labels, 'drafts')) return 'drafts';
	if (hasLabel(labels, '\\sent') || hasLabel(labels, 'sent')) return 'sent';
	if (hasLabel(labels, '\\inbox') || hasLabel(labels, 'inbox')) return 'inbox';
	return 'archive';
}

export function gmailLabelsToArray(labels) {
	if (!labels || labels.size === 0) return [];
	return [...labels].map((l) => displayLabelName(l));
}

export function envelopeFrom(message) {
	const from = message.envelope?.from?.[0];
	return {
		name: from?.name || from?.address || 'Unknown',
		email: from?.address || '',
	};
}

export function envelopeToArray(envelopeField) {
	if (!Array.isArray(envelopeField)) return [];
	return envelopeField.map((addr) => ({
		name: addr?.name || addr?.address || '',
		email: addr?.address || '',
	}));
}

export function messageToDoc(message, applierName, mailbox = ALL_MAIL_PATH) {
	const from = envelopeFrom(message);
	const gmailLabels = gmailLabelsToArray(message.labels);
	const customLabels = extractCustomLabels(gmailLabels);
	const folder = mapGmailLabelsToFolder(message.labels);
	const subject = message.envelope?.subject || '(No subject)';
	const date = message.envelope?.date ?? new Date();
	const seen = message.flags?.has('\\Seen') ?? false;
	const flagged = message.flags?.has('\\Flagged') ?? false;

	return {
		applierName,
		mailbox,
		uid: message.uid,
		messageId: message.envelope?.messageId || null,
		from,
		to: envelopeToArray(message.envelope?.to),
		cc: envelopeToArray(message.envelope?.cc),
		subject,
		preview: subject.slice(0, 120),
		bodyText: '',
		bodyHtml: null,
		date,
		flags: { seen, flagged },
		gmailLabels,
		folder,
		labels: customLabels,
		hasBody: false,
		syncedAt: new Date(),
	};
}

export function labelsMatchFilter(gmailLabels, filterLabel) {
	if (!filterLabel) return true;
	const target = normalizeLabel(filterLabel);
	return (gmailLabels || []).some((raw) => {
		const name = normalizeLabel(raw);
		return name === target || name.endsWith(`/${target}`) || name.includes(target);
	});
}

export { ALL_MAIL_PATH, hasLabel, normalizeLabel, displayLabelName, isSystemLabel };
