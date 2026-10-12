#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { analyzeAsset, optimizeAsset, profileOutputPath } from './assets/gltf.js';
import { analyzeProject, fixProject, fixSource } from './engine.js';
import { PROFILES, PROFILE_IDS, getProfile } from './profiles.js';
import { RULES } from './rules/index.js';
import { scaffoldRuntime } from './scaffold.js';
import type { Finding } from './types.js';

const HELP = `r3f-optimizer — three.js / React Three Fiber optimization for different devices

Usage:
  r3f-optimizer analyze <project> [--profile low|mid|high] [--json] [--rules a,b]
  r3f-optimizer fix <file|project> [--profile low] [--write] [--rules a,b]
  r3f-optimizer asset <model.glb> [--profile low] [--json]
  r3f-optimizer variants <model.glb> [--out <dir>]
  r3f-optimizer scaffold <project> [--dir src/perf] [--ts]
  r3f-optimizer rules | profiles

"analyze" exits with code 1 when errors are found (useful in CI).
"fix" only prints the diff unless --write is passed.`;

const argv = process.argv.slice(2);
const [command, target] = argv;

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const profile = getProfile(option('profile') ?? 'low');
const rules = option('rules')?.split(',').map((r) => r.trim());

const ICON: Record<Finding['severity'], string> = { error: '✖', warning: '▲', info: '•' };

function printFindings(findings: Finding[]) {
  let current = '';
  for (const f of findings) {
    if (f.file !== current) {
      current = f.file;
      console.log(`\n${f.file}`);
    }
    console.log(`  ${f.line}:${f.column}  ${ICON[f.severity]} ${f.severity.padEnd(7)} ${f.message}  [${f.ruleId}${f.fixable ? ', fixable' : ''}]`);
    if (f.suggestion) console.log(`             ↳ ${f.suggestion}`);
  }
}

function kb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  switch (command) {
    case 'analyze': {
      if (!target) throw new Error('Usage: r3f-optimizer analyze <project>');
      const result = await analyzeProject(path.resolve(target), profile, { rules });
      if (flag('json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printFindings(result.findings);
        const t = result.totals;
        console.log(
          `\nProfile "${profile.id}": ${t.error} errors, ${t.warning} warnings, ${t.info} info ` +
            `(${t.fixable} auto-fixable) in ${result.filesWithFindings}/${result.filesScanned} files.`,
        );
      }
      process.exitCode = result.totals.error > 0 ? 1 : 0;
      break;
    }
    case 'fix': {
      if (!target) throw new Error('Usage: r3f-optimizer fix <file|project>');
      const abs = path.resolve(target);
      const write = flag('write');
      const results = statSync(abs).isFile()
        ? [fixSource(await readFile(abs, 'utf8'), abs, profile, rules)]
        : await fixProject(abs, profile, { rules, dryRun: !write });
      if (statSync(abs).isFile() && write && results[0].changed) await writeFile(abs, results[0].code);
      for (const r of results) if (r.diff) console.log(r.diff);
      const applied = results.reduce((n, r) => n + r.applied.length, 0);
      const manual = results.flatMap((r) => r.remaining);
      console.log(`${applied} fixes ${write ? 'applied' : 'available (run with --write to apply)'}; ${manual.length} findings need manual changes.`);
      if (manual.length) printFindings(manual);
      break;
    }
    case 'asset': {
      if (!target) throw new Error('Usage: r3f-optimizer asset <model.glb>');
      const { stats, issues } = await analyzeAsset(path.resolve(target), profile);
      if (flag('json')) {
        console.log(JSON.stringify({ stats, issues }, null, 2));
        break;
      }
      console.log(`${target}: ${kb(stats.fileBytes)}, ${stats.triangles} triangles, ${stats.primitives} primitives, ${stats.textures.length} textures (${kb(stats.textureBytes)})`);
      for (const i of issues) console.log(`  ${ICON[i.severity]} ${i.message}`);
      break;
    }
    case 'variants': {
      if (!target) throw new Error('Usage: r3f-optimizer variants <model.glb>');
      const abs = path.resolve(target);
      const out = option('out') && path.resolve(option('out')!);
      for (const id of PROFILE_IDS) {
        const r = await optimizeAsset(abs, profileOutputPath(abs, id, out), PROFILES[id]);
        console.log(`${id.padEnd(4)} → ${r.output}: ${kb(r.after.fileBytes)} (-${r.reduction.fileBytes}), ${r.after.triangles} tris (-${r.reduction.triangles})`);
        for (const w of r.warnings) console.log(`     ${w}`);
      }
      break;
    }
    case 'scaffold': {
      if (!target) throw new Error('Usage: r3f-optimizer scaffold <project>');
      const r = await scaffoldRuntime({ root: path.resolve(target), dir: option('dir'), typescript: flag('ts') || undefined });
      for (const f of r.written) console.log(`created ${f}`);
      for (const f of r.skipped) console.log(`skipped ${f} (exists, use the MCP tool with overwrite=true)`);
      console.log(`\n${r.usage}`);
      break;
    }
    case 'rules':
      for (const r of RULES) console.log(`${r.id.padEnd(24)} ${r.category.padEnd(10)} ${r.title}`);
      break;
    case 'profiles':
      console.log(JSON.stringify(PROFILES, null, 2));
      break;
    default:
      console.log(HELP);
      process.exitCode = command && command !== 'help' && command !== '--help' ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
