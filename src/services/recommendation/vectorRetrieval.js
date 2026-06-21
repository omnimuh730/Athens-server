import { getVectorTopK } from '../vectorStore/collections.js';
import { getResumeVector, searchJobVectors } from '../vectorStore/qdrantClient.js';

/**
 * Multi-vector retrieval: search jobs for each resume vector, merge with MAX (no averaging).
 * @param {Array<{ resumeId: string, techStack?: string, vector?: number[] }>} resumeVectors
 * @returns {Map<string, { vectorScore: number, bestResumeId: string, bestResumeTechStack: string }>}
 */
export async function retrieveJobCandidates(resumeVectors = []) {
	const topK = getVectorTopK();
	const merged = new Map();

	for (const resume of resumeVectors) {
		let vector = resume.vector;
		if (!vector?.length) {
			const stored = await getResumeVector(resume.resumeId);
			vector = stored?.vector;
		}
		if (!vector?.length) continue;

		const hits = await searchJobVectors(vector, topK);
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
