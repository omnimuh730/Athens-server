import { JobSourceTitles } from '../../config/jobSources.js';

/**
 * Build a Qdrant filter from list request body facets we store on job vector payloads.
 * Complex filters (title regex, status tab) are applied via Mongo on hydrated page IDs.
 */
export function buildQdrantFilterFromBody(body = {}) {
	const must = [];

	const jobSources = body.jobSources !== undefined
		? String(body.jobSources).split(',').map((s) => s.trim()).filter(Boolean)
		: JobSourceTitles;
	const knownSources = JobSourceTitles.filter((s) => s !== 'Other');
	const allSourcesSelected =
		jobSources.includes('Other') && knownSources.every((s) => jobSources.includes(s));

	if (!allSourcesSelected && jobSources.length) {
		must.push({
			key: 'source',
			match: { any: jobSources },
		});
	}

	if (body.postedAtFrom || body.postedAtTo) {
		const range = {};
		if (body.postedAtFrom) range.gte = String(body.postedAtFrom);
		if (body.postedAtTo) {
			const toDate = new Date(body.postedAtTo);
			toDate.setDate(toDate.getDate() + 1);
			range.lt = toDate.toISOString().split('T')[0];
		}
		if (Object.keys(range).length) {
			must.push({ key: 'postedAt', range });
		}
	}

	if (!must.length) return undefined;
	return { must };
}
