import { RESUME_SKILL_ANALYSIS_PROMPT } from "./resumeSkillAnalysisPrompt.js";

export const GENERATED_RESUME_SKILL_ANALYSIS_PROMPT = `${RESUME_SKILL_ANALYSIS_PROMPT}

---

## techStack label (required)

Also produce a **techStack** — a very short filing label for this resume, like uploaded resume folders.

### techStack rules
- **Max 48 characters.** Keep it compact.
- **1–3 core technologies** joined with \` + \` (e.g. \`Go + NodeJS\`, \`Python + React\`, \`C# + Angular\`).
- Use the candidate's **highest-strength** languages/frameworks — not category headings.
- Optional **domain qualifier** in parentheses on the last segment when the resume clearly targets a niche: \`Go + Node(GIS)\`, \`Python + React(Healthcare)\`.
- Use familiar names: \`Go\`, \`NodeJS\`, \`TypeScript\`, \`React\`, \`AWS\` — not "Languages" or "Frameworks & Libraries".
- **Never** use job titles, employer names, dates, or section labels.

### Output format (object, not array)

{
  "techStack": "Go + Node(GIS)",
  "skills": [
    { "name": "Golang", "strength": 9.5 },
    { "name": "Node.js", "strength": 8.0 }
  ]
}
`;
