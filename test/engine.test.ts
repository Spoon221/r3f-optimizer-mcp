import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSource, fixSource } from '../src/engine.js';
import { PROFILES } from '../src/profiles.js';

const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const ids = (findings: { ruleId: string }[]) => [...new Set(findings.map((f) => f.ruleId))].sort();

describe('R3F scene', () => {
  const code = fixture('Scene.jsx');

  it('reports every expected problem for the low profile', () => {
    const findings = analyzeSource(code, 'Scene.jsx', PROFILES.low);
    expect(ids(findings)).toEqual([
      'adaptive-performance',
      'alloc-in-frame-loop',
      'antialias',
      'asset-preload',
      'geometry-segments',
      'instancing-candidate',
      'physical-material',
      'pixel-ratio',
      'postprocessing',
      'setstate-in-frame-loop',
      'shadows',
    ]);
  });

  it('is less strict for the high profile', () => {
    const findings = analyzeSource(code, 'Scene.jsx', PROFILES.high);
    const rules = ids(findings);
    expect(rules).not.toContain('antialias');
    expect(rules).not.toContain('physical-material');
    expect(rules).not.toContain('postprocessing');
    // 128 segments are still above the high limit (64)
    expect(rules).toContain('geometry-segments');
  });

  it('applies fixes for the low profile and produces valid code', () => {
    const result = fixSource(code, 'Scene.jsx', PROFILES.low);
    expect(result.changed).toBe(true);
    expect(result.skipped).toEqual([]);
    const out = result.code;
    expect(out).toContain(`<Canvas dpr={[1, 1]} gl={{ antialias: false, powerPreference: 'high-performance' }} camera=`);
    expect(out).not.toMatch(/<Canvas[^>]*\bshadows\b/);
    expect(out).toContain('shadow-mapSize={[512, 512]}');
    expect(out).toContain('<sphereGeometry args={[1, 16, 16]} />');
    expect(out).toContain('<meshStandardMaterial transmission={1} roughness={0} />');
    expect(out).toContain('<EffectComposer enabled={false}>');
    expect(out).toContain('<AdaptiveDpr pixelated />');
    expect(out).toContain("import { OrbitControls, useGLTF, AdaptiveDpr, AdaptiveEvents } from '@react-three/drei';");
    expect(out).toContain('useGLTF.preload("/models/robot.glb");');
    // Fixed code parses and has no remaining fixable findings
    const again = analyzeSource(out, 'Scene.jsx', PROFILES.low);
    expect(again.filter((f) => f.fixable)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = fixSource(code, 'Scene.jsx', PROFILES.low).code;
    expect(fixSource(once, 'Scene.jsx', PROFILES.low).changed).toBe(false);
  });

  it('caps EffectComposer multisampling on mid', () => {
    const out = fixSource(code, 'Scene.jsx', PROFILES.mid).code;
    expect(out).toContain('<EffectComposer multisampling={2}>');
    expect(out).toContain('shadows');
  });
});

describe('vanilla three.js', () => {
  const code = fixture('vanilla.js');

  it('fixes renderer settings, shadow maps, geometry and materials', () => {
    const result = fixSource(code, 'vanilla.js', PROFILES.low);
    const out = result.code;
    expect(out).toContain('new THREE.WebGLRenderer({ antialias: false })');
    expect(out).toContain('renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1))');
    expect(out).toContain('renderer.shadowMap.enabled = false');
    expect(out).toContain('light.shadow.mapSize.width = 512');
    expect(out).toContain('new THREE.TorusKnotGeometry(1, 0.3, 16, 16)');
    expect(out).toContain('new THREE.MeshStandardMaterial({ clearcoat: 1 })');
  });

  it('detects allocations in a requestAnimationFrame loop', () => {
    const findings = analyzeSource(code, 'vanilla.js', PROFILES.low).filter((f) => f.ruleId === 'alloc-in-frame-loop');
    expect(findings.map((f) => f.severity)).toEqual(['warning', 'error']);
  });
});

describe('TypeScript', () => {
  it('parses TSX with type annotations', () => {
    const code = `import { Canvas } from '@react-three/fiber';
export const App = (): JSX.Element => <Canvas dpr={window.devicePixelRatio as number}><mesh /></Canvas>;`;
    const result = fixSource(code, 'App.tsx', PROFILES.mid);
    expect(result.code).toContain('dpr={[1, 1.5]}');
  });
});

describe('setstate-in-frame-loop', () => {
  it('downgrades conditional setters to info', () => {
    const code = `useFrame(() => { if (hovered.current) setHover(null); setCount(1); });`;
    const findings = analyzeSource(code, 'a.jsx', PROFILES.low).filter((f) => f.ruleId === 'setstate-in-frame-loop');
    expect(findings.map((f) => f.severity)).toEqual(['info', 'error']);
  });
});
