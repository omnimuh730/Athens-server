import { getVectorTopK } from '../vectorStore/collections.js';
import { getResumeVector, searchJobVectors } from '../vectorStore/qdrantClient.js';

/**
 * Multi-vector retrieval: search jobs for each resume vector, merge with MAX (no averaging).
 * @param {Array<{ resumeId: string, techStack?: string, vector?: number[] }>} resumeVectors
 * @param {object} [searchOpts] — passed to searchJobVectors (limit, offset, filter)
 * @returns {Map<string, { vectorScore: number, bestResumeId: string, bestResumeTechStack: string }>}
 */
export async function retrieveJobCandidates(resumeVectors = [], searchOpts = {}) {
	const topK = searchOpts.limit ?? getVectorTopK();
	const merged = new Map();

	for (const resume of resumeVectors) {
		let vector = resume.vector;
		if (!vector?.length) {
			const stored = await getResumeVector(resume.resumeId);
			vector = stored?.vector;
		}
		if (!vector?.length) continue;

		const hits = await searchJobVectors(vector, { ...searchOpts, limit: topK });
		for (const hit of hits) {
			const jobId = hit.jobId;
			if (!jobId) continue;
			const vectorScore = Math.round(Math.max(0, Math.min(1, hit.score ?? 0)) * 100);
			const prev = merged.get(jobId);
			if (!prev || vectorScore > prev.vectorScore) {
				merged.set(jobId, {
					vectorScore,
					bestResumeId: resume.resumeId,
					bestResumeTechStack: resume.techStack || '',
				});
			}
		}
	}

	return merged;
}

/**
 * Attach bestResume metadata from primary query vector row.
 */
export function mergeMultiVectorScores(pageRows, resumeVectors) {
	const primary = resumeVectors[0];
	return pageRows.map((row) => ({
		...row,
		bestResumeId: primary?.resumeId || null,
		bestResumeTechStack: primary?.techStack || '',
	}));
}
