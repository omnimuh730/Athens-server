import { ObjectId } from 'mongodb';
import { jobsCollection } from '../../db/mongo.js';
import { isRedisReady } from '../../db/redis.js';
import { JOB_LIST_PROJECTION } from '../jobListQuery.js';
import { loadProfileSkillSet, invalidateProfileSkillCache } from './profileSkills.js';
import {
  findCandidateJobIds,
  getJobSkillsFromRedis,
  normalizeJobSkills,
} from './skillIndex.js';
import { computeCoverageScore, composeJobScores, applyScoreFilters } from './coverageScore.js';
import { normalizeSkillSet } from '../../../../packages/shared/src/skill-normalize.js';

const MAX_CANDIDATES = 50000;

/**
 * Score and rank jobs for an applier using asymmetric skill containment.
 * Falls back to Mongo-only scan when Redis unavailable or profile has no skills.
 */
export async function matchJobsForApplier({
  applierName,
  mongoQuery,
  scoreFilters,
  skip = 0,
  limit = 25,
}) {
  const name = String(applierName || '').trim();
  if (!name) {
    return { docs: [], total: 0, recommendationFallback: true, reason: 'no_applier' };
  }

  const profileSkills = await loadProfileSkillSet(name);
  if (!profileSkills.size) {
    return { docs: [], total: 0, recommendationFallback: true, reason: 'no_analyzed_resumes' };
  }

  if (!jobsCollection) {
    return { docs: [], total: 0, recommendationFallback: true, reason: 'db_not_ready' };
  }

  const catalogTotal = await jobsCollection.countDocuments(mongoQuery || {});
  const hasScoreFilter = !!(scoreFilters && Object.keys(scoreFilters).length);

  let scoredRows = [];

  if (isRedisReady()) {
    const candidateIds = await findCandidateJobIds(profileSkills);
    if (candidateIds?.size) {
      const idList = [...candidateIds].slice(0, MAX_CANDIDATES);
      const objectIds = idList.map((id) => {
        try { return new ObjectId(id); } catch { return null; }
      }).filter(Boolean);

      const jobs = await jobsCollection
        .find({ $and: [mongoQuery || {}, { _id: { $in: objectIds } }] })
        .project({ ...JOB_LIST_PROJECTION, skillsNormalized: 1, skills: 1 })
        .toArray();

      for (const job of jobs) {
        const jobSkills = job.skillsNormalized?.length
          ? job.skillsNormalized
          : normalizeJobSkills(job.skills || []);
        const coverage = computeCoverageScore(jobSkills, profileSkills);
        if (coverage.required === 0) continue;
        scoredRows.push({
          job,
          coverage,
          matchScore: coverage.matchScore,
        });
      }
    }
  } else {
    scoredRows = await scoreViaMongoScan({
      mongoQuery: mongoQuery || {},
      profileSkills,
      maxScan: MAX_CANDIDATES,
    });
  }

  scoredRows.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    const aDate = new Date(a.job.postedAt || a.job._createdAt || 0).getTime();
    const bDate = new Date(b.job.postedAt || b.job._createdAt || 0).getTime();
    return bDate - aDate;
  });

  let docs = scoredRows.map((row) => ({
    ...row.job,
    ...composeJobScores(row.job, row.coverage),
  }));

  if (hasScoreFilter) {
    docs = applyScoreFilters(docs, scoreFilters);
  }

  const pageScored = docs.slice(skip, skip + limit);
  let pageDocs = pageScored;

  if (!hasScoreFilter && pageScored.length < limit && catalogTotal > skip + pageScored.length) {
    const rankedIds = docs.map((d) => d._id);
    const needed = limit - pageScored.length;
    const dateSkip = Math.max(0, skip - docs.length);
    const dateDocs = await jobsCollection
      .find(
        { $and: [mongoQuery || {}, { _id: { $nin: rankedIds } }] },
        { projection: JOB_LIST_PROJECTION },
      )
      .sort({ postedAt: -1, _id: -1 })
      .skip(dateSkip)
      .limit(needed)
      .toArray();
    pageDocs = [
      ...pageScored,
      ...dateDocs.map((j) => ({
        ...j,
        ...composeJobScores(j, { matchScore: 0, covered: [], missing: [], required: 0 }),
        recommendationRanked: false,
      })),
    ];
  }

  return {
    docs: pageDocs,
    total: catalogTotal,
    catalogTotal,
    recommendationFallback: false,
  };
}

async function scoreViaMongoScan({ mongoQuery, profileSkills, maxScan }) {
  const rows = [];
  const cursor = jobsCollection
    .find({
      $and: [
        mongoQuery,
        {
          $or: [
            { skillsNormalized: { $in: [...profileSkills] } },
            { skills: { $exists: true, $ne: [] } },
          ],
        },
      ],
    })
    .project({ ...JOB_LIST_PROJECTION, skillsNormalized: 1, skills: 1 })
    .sort({ postedAt: -1 })
    .limit(maxScan);

  for await (const job of cursor) {
    const jobSkills = job.skillsNormalized?.length
      ? job.skillsNormalized
      : normalizeJobSkills(job.skills || []);
    const coverage = computeCoverageScore(jobSkills, profileSkills);
    if (coverage.required === 0 || coverage.matchScore === 0) continue;
    rows.push({ job, coverage, matchScore: coverage.matchScore });
  }
  return rows;
}

/** Score a single job against a profile (radar / detail views). */
export async function scoreJobAgainstProfile(job, profileSkills) {
  const jobSkills = job.skillsNormalized?.length
    ? job.skillsNormalized
    : normalizeJobSkills(job.skills || []);
  return computeCoverageScore(jobSkills, profileSkills);
}

export function invalidateRecommendationCache(applierName) {
  return invalidateProfileSkillCache(applierName);
}

export { normalizeSkillSet, normalizeJobSkills };
