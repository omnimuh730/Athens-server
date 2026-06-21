/** Trim and collapse internal whitespace. */
export function normalizeSurfaceForm(raw) {
	if (!raw || typeof raw !== 'string') return '';
	return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Normalization key for lookup — lowercase, strip non-alphanumerics except + # .
 * Matches Athens client-side normalizeSkillKey.
 */
export function normalizeSkillKey(raw) {
	return normalizeSurfaceForm(raw).toLowerCase().replace(/[^a-z0-9+#.]/g, '');
}

/** Stable slug id from a label or key. */
export function slugifySkillId(raw) {
	const key = normalizeSkillKey(raw);
	if (!key) return '';
	return key.replace(/\.+/g, '.').slice(0, 64);
}

export function toComparable(value) {
	return normalizeSkillKey(value);
}

/** Levenshtein distance for fuzzy matching. */
export function levenshtein(a, b) {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = i;
		for (let j = 1; j <= b.length; j++) {
			const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], row[j], prev) + 1;
			row[j - 1] = prev;
			prev = val;
		}
		row[b.length] = prev;
	}
	return row[b.length];
}

/** Similarity score in [0, 1] from normalized keys. */
export function stringSimilarity(a, b) {
	const ka = normalizeSkillKey(a);
	const kb = normalizeSkillKey(b);
	if (!ka || !kb) return 0;
	if (ka === kb) return 1;
	if (ka.includes(kb) || kb.includes(ka)) {
		const shorter = Math.min(ka.length, kb.length);
		const longer = Math.max(ka.length, kb.length);
		return 0.85 + (shorter / longer) * 0.14;
	}
	const maxLen = Math.max(ka.length, kb.length);
	const dist = levenshtein(ka, kb);
	return Math.max(0, 1 - dist / maxLen);
}
