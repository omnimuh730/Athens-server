function cleanString(v) {
	return String(v ?? "").trim();
}

/** Flatten generated resume sections into plain text for skill analysis / storage. */
export function sectionsToText(sections, identity) {
	const parts = [];
	const summary = sections?.summary?.summary ?? sections?.summary;
	if (typeof summary === "string" && summary.trim()) parts.push(`Summary\n${summary.trim()}`);

	const groups = sections?.skills?.skills;
	if (Array.isArray(groups)) {
		const skillLines = groups
			.map((g) => {
				const items = Array.isArray(g?.items) ? g.items.map(String).filter(Boolean) : [];
				if (!items.length) return "";
				const cat = cleanString(g?.category);
				return cat ? `${cat}: ${items.join(", ")}` : items.join(", ");
			})
			.filter(Boolean);
		if (skillLines.length) parts.push(`Skills\n${skillLines.join("\n")}`);
	}

	const exps = sections?.experience?.experiences ?? sections?.experience?.experience;
	if (Array.isArray(exps)) {
		const expLines = exps.map((e) => {
			const title = cleanString(e?.title);
			const company = cleanString(e?.company);
			const period = cleanString(e?.period);
			const bullets = Array.isArray(e?.bullets) ? e.bullets.map(String).filter(Boolean) : [];
			return [title, company, period, ...bullets.map((b) => `- ${b}`)].filter(Boolean).join("\n");
		});
		if (expLines.length) parts.push(`Experience\n${expLines.join("\n\n")}`);
	}

	const edus = sections?.education?.education ?? sections?.education?.educations;
	if (Array.isArray(edus)) {
		const eduLines = edus.map((e) => {
			const school = cleanString(e?.school);
			const degree = cleanString(e?.degree);
			const period = cleanString(e?.period);
			return [school, degree, period].filter(Boolean).join(" · ");
		});
		if (eduLines.length) parts.push(`Education\n${eduLines.join("\n")}`);
	}

	if (identity?.fullName) parts.unshift(identity.fullName);
	return parts.join("\n\n");
}
