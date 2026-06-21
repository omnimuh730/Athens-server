import { chatCompletion } from "./llm/llmService.js";
import { GENERATED_RESUME_SKILL_ANALYSIS_PROMPT } from "../config/generatedResumeSkillAnalysisPrompt.js";
import { sectionsToText } from "./generatedResumeText.js";
import {
	finalizeLlmSkillProfile,
	parseGeneratedSkillAnalysis,
	resolveTechStackLabel,
} from "./resumeSkillProfile.js";

const SKILL_ANALYSIS_STEP = {
	name: "Skill proficiency analysis",
	purpose: "skill-analysis",
	kind: "final",
};

function cleanString(v) {
	return String(v ?? "").trim();
}

/**
 * After resume sections are generated, run one structured LLM pass to extract
 * canonical skill names with differentiated 0–10 strength scores and a short
 * techStack filing label (e.g. "Go + Node(GIS)").
 */
export async function analyzeGeneratedResumeSkills({
	sections,
	identity,
	jobDescription,
	catalog,
	providerId,
	apiKey,
	model,
	onProgress,
}) {
	if (onProgress) {
		onProgress({
			phase: "step-start",
			name: SKILL_ANALYSIS_STEP.name,
			purpose: SKILL_ANALYSIS_STEP.purpose,
			kind: SKILL_ANALYSIS_STEP.kind,
		});
	}

	const text = sectionsToText(sections, identity);
	if (!text.trim()) {
		throw new Error("Generated resume has no text for skill analysis");
	}

	const jd = cleanString(jobDescription);
	const truncated = text.length > 12000 ? `${text.slice(0, 12000)}\n\n[truncated]` : text;
	const userParts = [];
	if (jd) userParts.push(`Target job description (for domain context):\n${jd}`);
	userParts.push(`Generated resume text:\n\n${truncated}`);

	const result = await chatCompletion({
		provider: providerId,
		apiKey,
		model,
		messages: [
			{ role: "system", content: GENERATED_RESUME_SKILL_ANALYSIS_PROMPT },
			{ role: "user", content: userParts.join("\n\n") },
		],
	});

	const parsed = parseGeneratedSkillAnalysis(result?.content);
	const skillProfile = finalizeLlmSkillProfile(parsed.skills);
	const techStack = resolveTechStackLabel({
		llmLabel: parsed.techStack,
		skillProfile,
		catalog,
		jobDescription: jd,
	});

	const stepResult = {
		name: SKILL_ANALYSIS_STEP.name,
		purpose: SKILL_ANALYSIS_STEP.purpose,
		kind: SKILL_ANALYSIS_STEP.kind,
		usage: result?.usage || null,
		output: { skillCount: skillProfile.length, techStack },
	};

	if (onProgress) {
		onProgress({ phase: "step-done", ...stepResult });
	}

	return {
		skillProfile,
		techStack,
		usage: result?.usage || null,
		perStep: stepResult,
	};
}

export { SKILL_ANALYSIS_STEP };
