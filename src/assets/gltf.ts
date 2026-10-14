import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Document, ImageUtils, NodeIO, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import type { DeviceProfile } from '../profiles.js';

const require = createRequire(import.meta.url);

let ioPromise: Promise<NodeIO> | null = null;

async function getIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    const draco3d = require('draco3dgltf');
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    // simplify() из gltf-transform сам не ждёт WASM упрощателя: без этого падает Assertion failed.
    await MeshoptSimplifier.ready;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
  })();
  return ioPromise;
}

async function loadSharp(): Promise<unknown | null> {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

export interface TextureInfo {
  name: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

export interface AssetStats {
  file: string;
  fileBytes: number;
  meshes: number;
  primitives: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: TextureInfo[];
  textureBytes: number;
  animations: number;
  extensions: string[];
  compression: { draco: boolean; meshopt: boolean; ktx2: boolean; webp: boolean };
}

export interface AssetIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
}

function triangleCount(prim: Primitive): number {
  const mode = prim.getMode();
  const indices = prim.getIndices();
  const count = indices ? indices.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
  if (mode === 4) return Math.floor(count / 3); // TRIANGLES
  if (mode === 5 || mode === 6) return Math.max(0, count - 2); // STRIP / FAN
  return 0;
}

export function documentStats(doc: Document, file: string, fileBytes: number): AssetStats {
  const root = doc.getRoot();
  let primitives = 0;
  let triangles = 0;
  let vertices = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      primitives++;
      triangles += triangleCount(prim);
      vertices += prim.getAttribute('POSITION')?.getCount() ?? 0;
    }
  }
  const textures = root.listTextures().map((t, i) => {
    const image = t.getImage();
    const size = image ? ImageUtils.getSize(image, t.getMimeType()) : null;
    return {
      name: t.getName() || t.getURI() || `texture_${i}`,
      mimeType: t.getMimeType(),
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
      bytes: image?.byteLength ?? 0,
    };
  });
  const extensions = root.listExtensionsUsed().map((e) => e.extensionName);
  return {
    file,
    fileBytes,
    meshes: root.listMeshes().length,
    primitives,
    triangles,
    vertices,
    materials: root.listMaterials().length,
    textures,
    textureBytes: textures.reduce((sum, t) => sum + t.bytes, 0),
    animations: root.listAnimations().length,
    extensions,
    compression: {
      draco: extensions.includes('KHR_draco_mesh_compression'),
      meshopt: extensions.includes('EXT_meshopt_compression'),
      ktx2: extensions.includes('KHR_texture_basisu'),
      webp: extensions.includes('EXT_texture_webp'),
    },
  };
}

export function assetIssues(stats: AssetStats, profile: DeviceProfile): AssetIssue[] {
  const issues: AssetIssue[] = [];
  if (stats.triangles > profile.maxTrianglesPerAsset) {
    issues.push({
      severity: 'error',
      message: `${stats.triangles.toLocaleString('en')} triangles exceed the ${profile.id} budget of ${profile.maxTrianglesPerAsset.toLocaleString('en')}.`,
    });
  }
  for (const t of stats.textures) {
    const side = Math.max(t.width ?? 0, t.height ?? 0);
    if (side > profile.maxTextureSize) {
      issues.push({
        severity: 'warning',
        message: `Texture "${t.name}" is ${t.width}x${t.height}; the ${profile.id} profile allows ${profile.maxTextureSize}px.`,
      });
    }
  }
  if (!stats.compression.draco && !stats.compression.meshopt && stats.vertices > 5_000) {
    issues.push({ severity: 'warning', message: 'Geometry is not compressed (no Draco / Meshopt).' });
  }
  if (stats.textures.length && !stats.compression.ktx2 && !stats.compression.webp) {
    issues.push({
      severity: 'info',
      message: 'Textures are PNG/JPEG; WebP or KTX2 reduce download size, KTX2 also reduces GPU memory.',
    });
  }
  if (stats.primitives > 100) {
    issues.push({
      severity: 'warning',
      message: `${stats.primitives} primitives = at least ${stats.primitives} draw calls; consider merging (gltf-transform join).`,
    });
  }
  return issues;
}

export async function analyzeAsset(file: string, profile: DeviceProfile) {
  const io = await getIO();
  const doc = await io.read(file);
  const stats = documentStats(doc, file, (await stat(file)).size);
  return { stats, issues: assetIssues(stats, profile) };
}

export interface OptimizeAssetResult {
  input: string;
  output: string;
  profile: string;
  steps: string[];
  before: AssetStats;
  after: AssetStats;
  reduction: { fileBytes: string; triangles: string };
  warnings: string[];
}

function percent(before: number, after: number): string {
  if (!before) return '0%';
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}

export async function optimizeAsset(
  input: string,
  output: string,
  profile: DeviceProfile,
): Promise<OptimizeAssetResult> {
  const io = await getIO();
  const doc = await io.read(input);
  const before = documentStats(doc, input, (await stat(input)).size);
  const steps: string[] = [];
  const warnings: string[] = [];

  await doc.transform(dedup(), prune(), weld());
  steps.push('dedup', 'prune', 'weld');

  if (profile.simplifyRatio < 1) {
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: profile.simplifyRatio, error: 0.001 }));
    steps.push(`simplify(ratio=${profile.simplifyRatio})`);
  }

  if (doc.getRoot().listTextures().length) {
    const sharp = await loadSharp();
    if (sharp) {
      await doc.transform(
        textureCompress({
          encoder: sharp,
          targetFormat: 'webp',
          resize: [profile.maxTextureSize, profile.maxTextureSize],
        }),
      );
      steps.push(`textureCompress(webp, max ${profile.maxTextureSize}px)`);
    } else {
      warnings.push('sharp is not installed: textures were not resized or converted.');
    }
  }

  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  steps.push('meshopt(medium)');

  await io.write(output, doc);
  const after = documentStats(doc, output, (await stat(output)).size);

  return {
    input,
    output,
    profile: profile.id,
    steps,
    before,
    after,
    reduction: {
      fileBytes: percent(before.fileBytes, after.fileBytes),
      triangles: percent(before.triangles, after.triangles),
    },
    warnings,
  };
}

/** model.glb -> model.low.glb */
export function profileOutputPath(input: string, profileId: string, outDir?: string): string {
  const ext = path.extname(input);
  const base = path.basename(input, ext);
  return path.join(outDir ?? path.dirname(input), `${base}.${profileId}.glb`);
}
