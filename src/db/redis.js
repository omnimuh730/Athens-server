import { createClient } from 'redis';

let client = null;
let ready = false;

export function isRedisReady() {
  return ready && client?.isOpen;
}

export function getRedis() {
  if (!client) throw new Error('Redis not initialized');
  return client;
}

export async function initRedis() {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  if (process.env.REDIS_ENABLED === 'false') {
    console.warn('[redis] disabled (REDIS_ENABLED=false) — skill matching uses Mongo fallback');
    return;
  }
  try {
    client = createClient({ url });
    client.on('error', (err) => console.error('[redis] error:', err.message));
    await client.connect();
    ready = true;
    console.log(`[redis] connected → ${url}`);
  } catch (err) {
    console.warn('[redis] init failed — skill matching uses Mongo fallback:', err.message);
    ready = false;
  }
}

export async function closeRedis() {
  if (client?.isOpen) await client.quit();
  ready = false;
}
