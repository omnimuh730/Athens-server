const MAX_RESUME_TEXT = 8000;
const MAX_JOB_DESCRIPTION = 6000;
const MAX_SKILL_LINES = 30;

function formatSkillProfile(skillProfile = []) {
	const lines = [];
	for (const item of skillProfile.slice(0, MAX_SKILL_LINES)) {
		const name = String(item?.name ?? item?.skill ?? '').trim();
		if (!name) continue;
		let strength = Number(item?.strength ?? item?.score ?? 0);
		if (!Number.isFinite(strength)) strength = 5;
		strength = Math.max(0, Math.min(10, strength));
		if (strength <= 0) continue;
		lines.push(`${name} (${strength}/10)`);
	}
	return lines.join(', ');
}

export function buildResumeEmbeddingText(resumeDoc) {
	const techStack = String(resumeDoc?.techStack ?? '').trim();
	const skillLine = formatSkillProfile(resumeDoc?.skillProfile);
	const text = String(resumeDoc?.extractedText ?? '').trim();
	const truncatedText = text.length > MAX_RESUME_TEXT
		? `${text.slice(0, MAX_RESUME_TEXT)}\n[truncated]`
		: text;

	const parts = [];
	if (techStack) parts.push(`Tech stack: ${techStack}`);
	if (skillLine) parts.push(`Skills: ${skillLine}`);
	if (truncatedText) parts.push(truncatedText);
	return parts.join('\n\n').trim();
}

export function buildJobEmbeddingText(jobDoc) {
	const title = String(jobDoc?.title ?? '').trim();
	const skills = Array.isArray(jobDoc?.skills)
		? jobDoc.skills.map((s) => String(s).trim()).filter(Boolean)
		: [];
	const description = String(jobDoc?.description ?? '').trim();
	const truncatedDesc = description.length > MAX_JOB_DESCRIPTION
		? `${description.slice(0, MAX_JOB_DESCRIPTION)}\n[truncated]`
		: description;

	const parts = [];
	if (title) parts.push(title);
	if (skills.length) parts.push(`Required skills: ${skills.join(', ')}`);
	if (truncatedDesc) parts.push(truncatedDesc);
	return parts.join('\n\n').trim();
}
