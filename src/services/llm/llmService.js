// Thin client for unified-ai-server — all LLM traffic goes through the gateway.

import {
  costFromUsage,
  findPricing,
  formatUsd as formatCostUsd,
} from '@nextoffer/shared/pricing';
import { DEEPSEEK_MODELS, isDeepSeekModel, listOpenAiModels } from '@nextoffer/shared/models';

const AI_BASE = (process.env.UNIFIED_AI_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');

export const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyField: 'openaiApiKey',
    models: null,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    keyField: 'deepseekApiKey',
    models: DEEPSEEK_MODELS,
  },
};

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.openai;
}

export function getPricing(model) {
  const row = findPricing(model);
  if (!row) return null;
  return { input: row.input, cached: row.cachedInput ?? row.input, output: row.output };
}

export function summarizeUsage(usage, model) {
  const u = costFromUsage(model, usage);
  const pricing = findPricing(model);
  const totalInput = u.inputTokens + u.cachedTokens;
  const costNoCache = pricing
    ? (totalInput / 1_000_000) * pricing.input + (u.outputTokens / 1_000_000) * pricing.output
    : null;
  const savings = costNoCache != null ? Math.max(0, costNoCache - u.costUsd) : null;
  return {
    model,
    inputTokens: u.inputTokens,
    cachedTokens: u.cachedTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    cost: u.costUsd,
    savings,
    priced: u.priced,
  };
}

export const EMPTY_USAGE = () => ({
  model: null,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cost: 0,
  savings: 0,
});

export function addUsage(a, b) {
  if (!b) return a;
  return {
    model: b.model ?? a.model,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost == null || b.cost == null ? null : a.cost + b.cost,
    savings: a.savings == null || b.savings == null ? null : a.savings + b.savings,
  };
}

export { formatCostUsd };

export function formatUsageSummary(usage) {
  if (!usage) return '';
  const cost = formatCostUsd(usage.cost);
  const parts = [
    `${usage.inputTokens?.toLocaleString() ?? 0} in`,
    `${usage.outputTokens?.toLocaleString() ?? 0} out`,
  ];
  if (usage.cachedTokens > 0) parts.push(`${usage.cachedTokens.toLocaleString()} cached`);
  if (cost) parts.push(cost);
  return parts.join(' · ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, init, { timeoutMs = 120000, retries = 4, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt >= retries) return response;
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
    await sleep(Math.min(delay, 15000));
  }
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const isReasoningModel = (model) => /^(gpt-5|o1|o3|o4)/i.test(String(model));

export async function chatCompletion({
  provider,
  apiKey,
  model,
  messages,
  jsonMode = false,
  cacheKey,
  reasoningEffort,
  timeoutMs = 120000,
  runId,
  feature = 'resume-analysis',
}) {
  const p = getProvider(provider);
  if (!apiKey) {
    throw new Error(`No API key configured for ${p.label}. Add it under Settings → Profile.`);
  }

  const body = { model, messages };
  if (jsonMode && (p.id === 'openai' || p.id === 'deepseek')) {
    body.response_format = { type: 'json_object' };
  }
  if (cacheKey) body.prompt_cache_key = cacheKey;
  if (p.id === 'openai' && isReasoningModel(model) && reasoningEffort && reasoningEffort !== 'default') {
    body.reasoning_effort = reasoningEffort;
  }

  const response = await fetchRetry(
    `${AI_BASE}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(runId ? { 'x-run-id': runId } : {}),
        'x-feature': feature,
      },
      body: JSON.stringify(body),
    },
    { timeoutMs },
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `${p.label} request failed (${response.status})`);
    err.status = response.status;
    err.provider = p.id;
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (content == null) throw new Error(`${p.label} returned an empty response.`);
  return { content, usage: summarizeUsage(data?.usage, model) };
}

const modelCache = new Map();
const MODEL_TTL_MS = 5 * 60 * 1000;

export async function verifyKey({ provider, apiKey }) {
  const p = getProvider(provider);
  if (!apiKey) return { ok: false, status: 400, message: `No ${p.label} API key provided.` };
  try {
    if (Array.isArray(p.models)) {
      const response = await fetchRetry(
        `${AI_BASE}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: p.models[0], messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        },
        { timeoutMs: 15000, retries: 1 },
      );
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { ok: true, status: 200, message: `${p.label} key is valid.` };
      return { ok: false, status: response.status, message: data?.error?.message || `${p.label} rejected the key.` };
    }
    const response = await fetchRetry(`${AI_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, { timeoutMs: 15000, retries: 1 });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      const count = Array.isArray(data?.data) ? data.data.length : 0;
      return { ok: true, status: 200, message: `${p.label} key is valid (${count} models).` };
    }
    return { ok: false, status: response.status, message: data?.error?.message || `${p.label} rejected the key.` };
  } catch (err) {
    return { ok: false, status: 0, message: `Could not reach AI gateway: ${err.message}` };
  }
}

export async function listModels({ provider, apiKey, force = false }) {
  const p = getProvider(provider);
  if (Array.isArray(p.models)) return p.models;
  const cached = modelCache.get(p.id);
  if (!force && cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.models;
  if (!apiKey) throw new Error(`No API key configured for ${p.label}.`);

  const response = await fetchRetry(
    `${AI_BASE}/v1/models`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { timeoutMs: 20000, retries: 2 },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `${p.label} model list failed`);
    err.status = response.status;
    throw err;
  }
  const ids = Array.isArray(data?.data) ? data.data.map((m) => String(m?.id || '')).filter(Boolean) : [];
  const models = ids
    .filter((id) => /(gpt|claude|o1|o3|o4)/i.test(id))
    .filter((id) => !/(embedding|whisper|tts|audio|image|moderation|realtime|search|transcribe)/i.test(id))
    .sort();
  modelCache.set(p.id, { at: Date.now(), models });
  return models;
}

export { isDeepSeekModel, listOpenAiModels };
