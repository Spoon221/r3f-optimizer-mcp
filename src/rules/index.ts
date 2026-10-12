import type { Rule } from '../types.js';
import { adaptivePerformance, antialias, pixelRatio, postprocessing, shadows } from './rendering.js';
import { allocInFrameLoop, assetPreload, setStateInFrameLoop } from './runtime.js';
import { geometrySegments, instancingCandidate, physicalMaterial } from './scene.js';

export const RULES: Rule[] = [
  pixelRatio,
  antialias,
  shadows,
  postprocessing,
  geometrySegments,
  physicalMaterial,
  instancingCandidate,
  allocInFrameLoop,
  setStateInFrameLoop,
  assetPreload,
  adaptivePerformance,
];

export function selectRules(ids?: string[]): Rule[] {
  if (!ids || ids.length === 0) return RULES;
  const unknown = ids.filter((id) => !RULES.some((r) => r.id === id));
  if (unknown.length) {
    throw new Error(`Unknown rule(s): ${unknown.join(', ')}. Available: ${RULES.map((r) => r.id).join(', ')}`);
  }
  return RULES.filter((r) => ids.includes(r.id));
}
