/**
 * Backfill jobs.skillsNormalized and rebuild Redis skill inverted index.
 * Usage: node src/scripts/backfillJobSkills.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { initMongo, jobsCollection, closeMongo } from '../db/mongo.js';
import { initRedis, closeRedis, isRedisReady } from '../db/redis.js';
import { normalizeJobSkills, indexJobInRedis } from '../services/matching/skillIndex.js';

async function main() {
  await initMongo();
  await initRedis();

  if (!jobsCollection) throw new Error('MongoDB not ready');

  const cursor = jobsCollection.find({}, { projection: { skills: 1, skillsNormalized: 1 } });
  let updated = 0;
  let indexed = 0;

  for await (const doc of cursor) {
    const skills = Array.isArray(doc.skills) ? doc.skills : [];
    const skillsNormalized = normalizeJobSkills(skills);
    const prev = JSON.stringify(doc.skillsNormalized || []);
    const next = JSON.stringify(skillsNormalized);
    if (prev !== next) {
      await jobsCollection.updateOne(
        { _id: doc._id },
        { $set: { skillsNormalized } },
      );
      updated += 1;
    }
    if (isRedisReady() && skillsNormalized.length) {
      await indexJobInRedis(String(doc._id), skillsNormalized);
      indexed += 1;
    }
  }

  console.log(`[backfill-job-skills] updated=${updated} redis-indexed=${indexed}`);
  await closeRedis();
  await closeMongo?.();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
