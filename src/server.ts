import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fg from 'fast-glob';
import { z } from 'zod';
import { analyzeAsset, optimizeAsset, profileOutputPath } from './assets/gltf.js';
import { IGNORE, analyzeProject, analyzeSource, fixProject, fixSource, strip } from './engine.js';
import { PROFILES, PROFILE_IDS, getProfile } from './profiles.js';
import { RULES } from './rules/index.js';
import { scaffoldRuntime } from './scaffold.js';
import { VERSION } from './version.js';

const profileSchema = z.enum(PROFILE_IDS as [string, ...string[]]).default('low').describe('Target device profile');
const rulesSchema = z.array(z.string()).optional().describe('Limit to these rule ids (see list_rules). Default: all');

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function resolvePath(p: string): string {
  const abs = path.resolve(p);
  if (!existsSync(abs)) throw new Error(`Path does not exist: ${abs}`);
  return abs;
}

/** Wraps a tool handler so thrown errors become MCP tool errors instead of protocol errors. */
function safe<A>(handler: (args: A) => Promise<ReturnType<typeof json>>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'r3f-optimizer-mcp', version: VERSION },
    {
      instructions:
        'Tools for analyzing and optimizing three.js and React Three Fiber projects for low-, mid- and high-end devices. ' +
        'Typical flow: list_profiles -> analyze_project -> optimize_code (dryRun first, review the diff, then apply) -> ' +
        'analyze_asset / generate_asset_variants for .glb models -> scaffold_adaptive_runtime to pick the tier in the browser. ' +
        'Always pass absolute paths.',
    },
  );

  server.registerTool(
    'list_profiles',
    {
      title: 'List device profiles',
      description: 'Returns device profiles (low, mid, high) with the limits each optimization uses.',
      annotations: { readOnlyHint: true },
    },
    async () => json(PROFILES),
  );

  server.registerTool(
    'list_rules',
    {
      title: 'List analysis rules',
      description: 'Returns every rule the analyzer checks, with its category, severity and rationale.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      json(RULES.map(({ id, title, category, severity, description }) => ({ id, title, category, severity, description }))),
  );

  server.registerTool(
    'analyze_project',
    {
      title: 'Analyze a three.js / R3F project',
      description:
        'Scans all JS/TS/JSX/TSX files of a project and reports performance problems for the target device profile: ' +
        'pixel ratio, antialiasing, shadows, post-processing, geometry detail, heavy materials, allocations and ' +
        'setState in the render loop, missing asset preloading, missing runtime adaptation. Also lists .glb/.gltf assets.',
      inputSchema: {
        root: z.string().describe('Absolute path to the project root'),
        profile: profileSchema,
        rules: rulesSchema,
        include: z.array(z.string()).optional().describe('Glob patterns relative to root, e.g. ["src/**/*.jsx"]'),
        maxFindings: z.number().int().positive().default(200),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ root, profile, rules, include, maxFindings }) => {
      const abs = resolvePath(root);
      const result = await analyzeProject(abs, getProfile(profile), { rules, include });
      const assets = await fg('**/*.{glb,gltf}', { cwd: abs, ignore: IGNORE });
      return json({
        ...result,
        findings: result.findings.slice(0, maxFindings),
        truncated: result.findings.length > maxFindings,
        assets,
        next: assets.length
          ? 'Run analyze_asset on the listed models; generate_asset_variants creates low/mid/high versions.'
          : undefined,
      });
    }),
  );

  server.registerTool(
    'analyze_file',
    {
      title: 'Analyze one file',
      description: 'Same checks as analyze_project for a single source file.',
      inputSchema: { file: z.string().describe('Absolute path to the file'), profile: profileSchema, rules: rulesSchema },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ file, profile, rules }) => {
      const abs = resolvePath(file);
      const code = await readFile(abs, 'utf8');
      return json(analyzeSource(code, abs, getProfile(profile), rules).map(strip));
    }),
  );

  server.registerTool(
    'optimize_code',
    {
      title: 'Apply code optimizations',
      description:
        'Applies the auto-fixes of the analyzer to a file or a whole project for the target profile and returns a ' +
        'unified diff. Fixes are deterministic AST-based edits that keep the original formatting. ' +
        'dryRun defaults to true: review the diff, then call again with dryRun=false to write files.',
      inputSchema: {
        path: z.string().describe('Absolute path to a file or a project directory'),
        profile: profileSchema,
        rules: rulesSchema,
        include: z.array(z.string()).optional().describe('Glob patterns (directory mode only)'),
        dryRun: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    safe(async ({ path: target, profile, rules, include, dryRun }) => {
      const abs = resolvePath(target);
      const prof = getProfile(profile);
      let results;
      if (abs.endsWith('.js') || abs.endsWith('.jsx') || abs.endsWith('.ts') || abs.endsWith('.tsx') || abs.endsWith('.mjs')) {
        const code = await readFile(abs, 'utf8');
        const result = fixSource(code, abs, prof, rules);
        if (result.changed && !dryRun) await writeFile(abs, result.code);
        results = [result];
      } else {
        results = await fixProject(abs, prof, { rules, include, dryRun });
      }
      return json({
        profile: prof.id,
        dryRun,
        filesChanged: results.filter((r) => r.changed).length,
        fixesApplied: results.reduce((n, r) => n + r.applied.length, 0),
        files: results.map(({ code: _code, ...r }) => r),
        note: dryRun ? 'Nothing was written. Call again with dryRun=false to apply.' : 'Files were updated.',
      });
    }),
  );

  server.registerTool(
    'analyze_asset',
    {
      title: 'Analyze a glTF/GLB model',
      description:
        'Reports triangles, vertices, draw calls (primitives), materials, texture sizes and compression of a glTF ' +
        'asset, and lists problems for the target profile.',
      inputSchema: { file: z.string().describe('Absolute path to .glb/.gltf'), profile: profileSchema },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ file, profile }) => json(await analyzeAsset(resolvePath(file), getProfile(profile)))),
  );

  server.registerTool(
    'optimize_asset',
    {
      title: 'Optimize a glTF/GLB model',
      description:
        'Writes an optimized copy of a model for the profile: dedup, prune, weld, mesh simplification ' +
        '(meshoptimizer), texture resize + WebP, Meshopt compression. Returns before/after statistics.',
      inputSchema: {
        input: z.string().describe('Absolute path to .glb/.gltf'),
        output: z.string().optional().describe('Output .glb path. Default: <name>.<profile>.glb next to the input'),
        profile: profileSchema,
      },
      annotations: { destructiveHint: false },
    },
    safe(async ({ input, output, profile }) => {
      const abs = resolvePath(input);
      return json(await optimizeAsset(abs, output ? path.resolve(output) : profileOutputPath(abs, profile), getProfile(profile)));
    }),
  );

  server.registerTool(
    'generate_asset_variants',
    {
      title: 'Generate per-device model variants',
      description:
        'Creates <name>.low.glb, <name>.mid.glb and <name>.high.glb from one model so the app can load the ' +
        'variant that matches the device tier (see scaffold_adaptive_runtime -> modelUrl()).',
      inputSchema: {
        input: z.string().describe('Absolute path to .glb/.gltf'),
        outDir: z.string().optional().describe('Output directory. Default: next to the input'),
        profiles: z.array(z.enum(PROFILE_IDS as [string, ...string[]])).default([...PROFILE_IDS]),
      },
    },
    safe(async ({ input, outDir, profiles }) => {
      const abs = resolvePath(input);
      const results = [];
      for (const id of profiles) {
        const r = await optimizeAsset(abs, profileOutputPath(abs, id, outDir && path.resolve(outDir)), getProfile(id));
        results.push({
          profile: id,
          output: r.output,
          fileBytes: r.after.fileBytes,
          triangles: r.after.triangles,
          reduction: r.reduction,
          warnings: r.warnings,
        });
      }
      return json({ input: abs, variants: results });
    }),
  );

  server.registerTool(
    'scaffold_adaptive_runtime',
    {
      title: 'Add runtime device-tier detection',
      description:
        'Writes deviceTier + QualityProvider modules into the project: detects the device tier in the browser ' +
        '(GPU, CPU cores, memory, screen), exposes useQuality() with per-tier settings and lowers the tier ' +
        'automatically when FPS drops (drei PerformanceMonitor). Returns a usage example.',
      inputSchema: {
        root: z.string().describe('Absolute path to the project root'),
        dir: z.string().default('src/perf').describe('Directory relative to root'),
        typescript: z.boolean().optional().describe('Default: true when tsconfig.json exists'),
        overwrite: z.boolean().default(false),
      },
    },
    safe(async (args) => json(await scaffoldRuntime({ ...args, root: resolvePath(args.root) }))),
  );

  server.registerPrompt(
    'optimize-project',
    {
      title: 'Optimize a 3D web project for devices',
      description: 'Step-by-step workflow for optimizing a three.js / R3F project with this server.',
      argsSchema: {
        root: z.string().describe('Absolute path to the project'),
        profile: z.string().optional().describe('low | mid | high (default low)'),
      },
    },
    ({ root, profile }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Optimize the three.js / React Three Fiber project at ${root} for the "${profile ?? 'low'}" device profile.`,
              '1. Call analyze_project and summarize the findings by category and severity.',
              '2. Call optimize_code with dryRun=true, show me the diff and explain each change.',
              '3. After my confirmation call optimize_code with dryRun=false.',
              '4. For every model listed in "assets" call analyze_asset; offer generate_asset_variants for heavy ones.',
              '5. Offer scaffold_adaptive_runtime so the app selects quality at runtime.',
              '6. Findings without auto-fix (allocations in the render loop, setState in useFrame, instancing) must be ',
              '   fixed manually: propose concrete code changes for each.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
