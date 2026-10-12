export type ProfileId = 'low' | 'mid' | 'high';

export interface DeviceProfile {
  id: ProfileId;
  title: string;
  description: string;
  /** Upper bound for the renderer pixel ratio. */
  maxDpr: number;
  antialias: boolean;
  shadows: boolean;
  maxShadowMapSize: number;
  /** Max segments for procedural geometry (sphere, torus, plane, ...). */
  maxSegments: number;
  postprocessing: boolean;
  /** EffectComposer multisampling; null means "leave as is". */
  postprocessingMultisampling: number | null;
  /** MeshPhysicalMaterial / transmission materials allowed. */
  physicalMaterials: boolean;
  maxTextureSize: number;
  /** Triangle budget for a single glTF asset. */
  maxTrianglesPerAsset: number;
  /** Target ratio for mesh simplification (1 = no simplification). */
  simplifyRatio: number;
  /** Target frame rate the profile is tuned for. */
  targetFps: number;
}

export const PROFILES: Record<ProfileId, DeviceProfile> = {
  low: {
    id: 'low',
    title: 'Low-end',
    description:
      'Budget phones and tablets, integrated GPUs older than ~2018, devices with <= 4 GB RAM.',
    maxDpr: 1,
    antialias: false,
    shadows: false,
    maxShadowMapSize: 512,
    maxSegments: 16,
    postprocessing: false,
    postprocessingMultisampling: 0,
    physicalMaterials: false,
    maxTextureSize: 1024,
    maxTrianglesPerAsset: 50_000,
    simplifyRatio: 0.5,
    targetFps: 30,
  },
  mid: {
    id: 'mid',
    title: 'Mid-range',
    description: 'Modern mid-range phones, laptops with integrated GPUs.',
    maxDpr: 1.5,
    antialias: true,
    shadows: true,
    maxShadowMapSize: 1024,
    maxSegments: 32,
    postprocessing: true,
    postprocessingMultisampling: 2,
    physicalMaterials: false,
    maxTextureSize: 2048,
    maxTrianglesPerAsset: 200_000,
    simplifyRatio: 0.75,
    targetFps: 60,
  },
  high: {
    id: 'high',
    title: 'High-end',
    description: 'Desktops and laptops with discrete GPUs, flagship phones.',
    maxDpr: 2,
    antialias: true,
    shadows: true,
    maxShadowMapSize: 2048,
    maxSegments: 64,
    postprocessing: true,
    postprocessingMultisampling: null,
    physicalMaterials: true,
    maxTextureSize: 4096,
    maxTrianglesPerAsset: 1_000_000,
    simplifyRatio: 1,
    targetFps: 60,
  },
};

export const PROFILE_IDS = Object.keys(PROFILES) as ProfileId[];

export function getProfile(id: string | undefined): DeviceProfile {
  const profile = PROFILES[(id ?? 'low') as ProfileId];
  if (!profile) throw new Error(`Unknown profile "${id}". Use one of: ${PROFILE_IDS.join(', ')}`);
  return profile;
}
