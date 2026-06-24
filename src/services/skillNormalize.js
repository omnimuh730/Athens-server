import { toCanonical } from '../../../../packages/shared/src/skill-normalize.js';

export function normalizeSkillKey(name) {
  return toCanonical(name);
}

export function normalizeSurfaceForm(name) {
  return String(name ?? '').trim();
}
