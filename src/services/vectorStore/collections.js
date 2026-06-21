export const JOB_VECTORS_COLLECTION = 'job_vectors';
export const RESUME_VECTORS_COLLECTION = 'resume_vectors';

export function getVectorDimensions() {
	return Number(process.env.EMBEDDING_DIMENSIONS) || 1536;
}

export function getVectorTopK() {
	return Number(process.env.RECOMMENDATION_VECTOR_TOP_K) || 200;
}

export function getCandidatePoolSize() {
	return Number(process.env.RECOMMENDATION_CANDIDATE_POOL) || 500;
}
