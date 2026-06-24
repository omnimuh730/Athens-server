import { userResumesCollection } from '../../db/mongo.js';
import { getRedis, isRedisReady } from '../../db/redis.js';
import { normalizeSkillSet } from '../../../../packages/shared/src/skill-normalize.js';

const PROFILE_CACHE_TTL_SEC = 180;
const profileKey = (applierName) => `profile:skills:${String(applierName || '').trim()}`;

/**
 * Load union of canonical skills across all analyzed resumes for an applier.
 */
export async function loadProfileSkillSet(applierName) {
  const name = String(applierName || '').trim();
  if (!name) return new Set();

  if (isRedisReady()) {
    const redis = getRedis();
    const cached = await redis.get(profileKey(name));
    if (cached) {
      try {
        return new Set(JSON.parse(cached));
      } catch {
        /* rebuild */
      }
    }
  }

  if (!userResumesCollection) return new Set();

  const resumes = await userResumesCollection
    .find({ ownerName: name, analyzed: true })
    .project({ skillProfile: 1, skills: 1 })
    .toArray();

  const rawSkills = [];
  for (const doc of resumes) {
    if (Array.isArray(doc.skillProfile)) {
      for (const item of doc.skillProfile) {
        const n = item?.name || item?.skill;
        if (n) rawSkills.push(String(n));
      }
    }
    if (Array.isArray(doc.skills)) {
      for (const s of doc.skills) rawSkills.push(String(s));
    }
  }

  const skillSet = normalizeSkillSet(rawSkills);

  if (isRedisReady() && skillSet.size) {
    const redis = getRedis();
    await redis.setex(profileKey(name), PROFILE_CACHE_TTL_SEC, JSON.stringify([...skillSet]));
  }

  return skillSet;
}

export async function invalidateProfileSkillCache(applierName) {
  const name = String(applierName || '').trim();
  if (!name || !isRedisReady()) return;
  await getRedis().del(profileKey(name));
}
