import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeAsset, optimizeAsset } from '../src/assets/gltf.js';
import { PROFILES } from '../src/profiles.js';

const tmp = path.join(__dirname, '.tmp');
const input = path.join(tmp, 'grid.glb');

/** Builds a dense grid mesh (n x n quads) without indices sharing — enough to test weld + simplify. */
async function createGrid(n: number) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.push(x / n, Math.sin(x / 3) * 0.05, y / n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * (n + 1) + x;
      indices.push(i, i + n + 1, i + 1, i + 1, i + n + 1, i + n + 2);
    }
  }
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
  const index = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(index).setMaterial(doc.createMaterial());
  const mesh = doc.createMesh('grid').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('grid').setMesh(mesh));
  await new NodeIO().write(input, doc);
}

describe('glTF assets', () => {
  beforeAll(async () => {
    mkdirSync(tmp, { recursive: true });
    await createGrid(300); // 180k triangles
  });

  it('reports triangle budget and missing compression', async () => {
    const { stats, issues } = await analyzeAsset(input, PROFILES.low);
    expect(stats.triangles).toBe(180_000);
    expect(issues.some((i) => i.message.includes('budget'))).toBe(true);
    expect(issues.some((i) => i.message.includes('not compressed'))).toBe(true);
  });

  it('simplifies and compresses for the low profile', async () => {
    const result = await optimizeAsset(input, path.join(tmp, 'grid.low.glb'), PROFILES.low);
    expect(result.after.triangles).toBeLessThan(result.before.triangles);
    expect(result.after.compression.meshopt).toBe(true);
    expect(result.after.fileBytes).toBeLessThan(result.before.fileBytes);
  });
});
