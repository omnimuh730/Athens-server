import { jobsCollection } from '../../db/mongo.js';
import { getRedis, isRedisReady } from '../../db/redis.js';
import { normalizeSkillSet, toCanonical } from '../../../../packages/shared/src/skill-normalize.js';

const SKILL_INDEX_PREFIX = 'skill:';
const JOB_SKILLS_PREFIX = 'job:skills:';
const JOB_COUNT_PREFIX = 'job:skillcount:';

export function normalizeJobSkills(skills = []) {
  return [...normalizeSkillSet(skills)];
}

/** Persist skillsNormalized on a job document fields object. */
export function attachNormalizedSkills(job) {
  const skills = Array.isArray(job.skills) ? job.skills : [];
  const skillsNormalized = normalizeJobSkills(skills);
  return { ...job, skills, skillsNormalized };
}

/**
 * Index one job in Redis inverted index.
 */
export async function indexJobInRedis(jobId, skillsNormalized = []) {
  if (!isRedisReady() || !jobId) return;
  const redis = getRedis();
  const id = String(jobId);
  const skills = skillsNormalized.length ? skillsNormalized : [];

  const prevRaw = await redis.get(`${JOB_SKILLS_PREFIX}${id}`);
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw);
      for (const s of prev) {
        await redis.sRem(`${SKILL_INDEX_PREFIX}${s}`, id);
      }
    } catch { /* ignore */ }
  }

  if (!skills.length) {
    await redis.del(`${JOB_SKILLS_PREFIX}${id}`, `${JOB_COUNT_PREFIX}${id}`);
    return;
  }

  await redis.set(`${JOB_SKILLS_PREFIX}${id}`, JSON.stringify(skills));
  await redis.set(`${JOB_COUNT_PREFIX}${id}`, String(skills.length));
  for (const skill of skills) {
    await redis.sAdd(`${SKILL_INDEX_PREFIX}${skill}`, id);
  }
}

export async function removeJobFromRedisIndex(jobId) {
  if (!isRedisReady() || !jobId) return;
  const redis = getRedis();
  const id = String(jobId);
  const prevRaw = await redis.get(`${JOB_SKILLS_PREFIX}${id}`);
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw);
      for (const s of prev) {
        await redis.sRem(`${SKILL_INDEX_PREFIX}${s}`, id);
      }
    } catch { /* ignore */ }
  }
  await redis.del(`${JOB_SKILLS_PREFIX}${id}`, `${JOB_COUNT_PREFIX}${id}`);
}

/**
 * Collect candidate job IDs that share at least one skill with the profile.
 */
export async function findCandidateJobIds(profileSkills) {
  if (!isRedisReady() || !profileSkills?.size) return null;
  const redis = getRedis();
  const candidates = new Set();
  for (const skill of profileSkills) {
    const ids = await redis.sMembers(`${SKILL_INDEX_PREFIX}${skill}`);
    for (const id of ids) candidates.add(id);
  }
  return candidates;
}

/**
 * Get normalized skills for a job from Redis or null.
 */
export async function getJobSkillsFromRedis(jobId) {
  if (!isRedisReady()) return null;
  const raw = await getRedis().get(`${JOB_SKILLS_PREFIX}${String(jobId)}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Full rebuild of Redis index from Mongo (maintenance script).
 */
export async function rebuildSkillIndex({ batchSize = 500 } = {}) {
  if (!jobsCollection) throw new Error('MongoDB not ready');
  if (!isRedisReady()) throw new Error('Redis not ready');

  const redis = getRedis();
  const keys = await redis.keys(`${SKILL_INDEX_PREFIX}*`);
  if (keys.length) await redis.del(keys);
  const jobKeys = await redis.keys(`${JOB_SKILLS_PREFIX}*`);
  if (jobKeys.length) await redis.del(jobKeys);
  const countKeys = await redis.keys(`${JOB_COUNT_PREFIX}*`);
  if (countKeys.length) await redis.del(countKeys);

  let processed = 0;
  const cursor = jobsCollection.find(
    { skillsNormalized: { $exists: true, $ne: [] } },
    { projection: { skillsNormalized: 1 } },
  );

  let batch = [];
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= batchSize) {
      for (const job of batch) {
        await indexJobInRedis(String(job._id), job.skillsNormalized || []);
      }
      processed += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    for (const job of batch) {
      await indexJobInRedis(String(job._id), job.skillsNormalized || []);
    }
    processed += batch.length;
  }
  return { processed };
}

export { toCanonical, normalizeSkillSet };
