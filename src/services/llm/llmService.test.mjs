import test from "node:test";
import assert from "node:assert/strict";

import { summarizeUsage } from "./llmService.js";

test("summarizeUsage matches codex pricing for DeepSeek cache hit/miss", () => {
  const raw = {
    prompt_cache_hit_tokens: 16_545_664,
    prompt_cache_miss_tokens: 206_801,
    completion_tokens: 102_043,
    total_tokens: 16_854_508,
  };
  const u = summarizeUsage(raw, "deepseek-v4-flash");
  assert.equal(u.inputTokens, 206_801);
  assert.equal(u.cachedTokens, 16_545_664);
  assert.ok(u.cost != null && u.cost > 0);
  assert.ok(Math.abs(u.cost - 0.104) < 0.002);
  assert.ok(u.savings != null && u.savings > 0);
});

test("summarizeUsage OpenAI cached input still works", () => {
  const u = summarizeUsage(
    {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens: 200,
      total_tokens: 1200,
    },
    "gpt-4o-mini",
  );
  assert.equal(u.inputTokens, 600);
  assert.equal(u.cachedTokens, 400);
  assert.ok(u.priced);
});
