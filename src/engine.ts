import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import fg from 'fast-glob';
import MagicString from 'magic-string';
import { ImportManager, parseCode } from './ast.js';
import type { DeviceProfile } from './profiles.js';
import { selectRules } from './rules/index.js';
import type { Finding, FindingWithFix, Severity } from './types.js';

export const CODE_GLOB = '**/*.{js,jsx,ts,tsx,mjs}';
export const IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**', '**/*.d.ts', '**/*.min.js'];

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Quick pre-filter: skip files that cannot contain three.js / R3F code. */
export function looksLike3dCode(code: string): boolean {
  return /three|@react-three|<Canvas|useFrame|WebGLRenderer|Geometry|Material|useGLTF|useTexture/.test(code);
}

export function analyzeSource(
  code: string,
  file: string,
  profile: DeviceProfile,
  ruleIds?: string[],
): FindingWithFix[] {
  let ast;
  try {
    ast = parseCode(code, file);
  } catch (err) {
    return [
      {
        ruleId: 'parse-error',
        severity: 'error',
        category: 'runtime',
        message: `Could not parse file: ${(err as Error).message}`,
        file,
        line: 1,
        column: 0,
        fixable: false,
        start: 0,
      },
    ];
  }

  const findings: FindingWithFix[] = [];
  for (const rule of selectRules(ruleIds)) {
    rule.check({
      file,
      code,
      ast,
      profile,
      report(node, input) {
        findings.push({
          ruleId: rule.id,
          severity: input.severity ?? rule.severity,
          category: rule.category,
          message: input.message,
          suggestion: input.suggestion,
          file,
          line: node.loc?.start.line ?? 1,
          column: node.loc?.start.column ?? 0,
          fixable: !!input.fix,
          start: node.start,
          fix: input.fix,
        });
      },
    });
  }
  return findings.sort((a, b) => a.start - b.start || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export interface FixResult {
  file: string;
  code: string;
  changed: boolean;
  applied: Finding[];
  skipped: { finding: Finding; reason: string }[];
  remaining: Finding[];
  diff: string;
}

/** Applies every auto-fixable finding to the source. Conflicting edits are skipped, not forced. */
export function fixSource(code: string, file: string, profile: DeviceProfile, ruleIds?: string[]): FixResult {
  const findings = analyzeSource(code, file, profile, ruleIds);
  const s = new MagicString(code);
  const imports = new ImportManager(parseCode(code, file));
  const applied: Finding[] = [];
  const skipped: FixResult['skipped'] = [];
  const remaining: Finding[] = [];

  for (const finding of findings) {
    if (!finding.fix) {
      remaining.push(strip(finding));
      continue;
    }
    try {
      finding.fix(s, imports);
      applied.push(strip(finding));
    } catch (err) {
      skipped.push({ finding: strip(finding), reason: (err as Error).message });
    }
  }
  imports.apply(s);

  const output = s.toString();
  return {
    file,
    code: output,
    changed: output !== code,
    applied,
    skipped,
    remaining,
    diff: output === code ? '' : createTwoFilesPatch(file, file, code, output, '', '', { context: 2 }),
  };
}

export function strip(finding: FindingWithFix | Finding): Finding {
  const { start: _start, fix: _fix, ...rest } = finding as FindingWithFix;
  return rest;
}

export async function listCodeFiles(root: string, include?: string[]): Promise<string[]> {
  const files = await fg(include?.length ? include : [CODE_GLOB], { cwd: root, ignore: IGNORE, absolute: true });
  return files.sort();
}

export interface ProjectAnalysis {
  root: string;
  profile: string;
  filesScanned: number;
  filesWithFindings: number;
  totals: Record<Severity, number> & { fixable: number };
  byRule: Record<string, number>;
  findings: Finding[];
}

export async function analyzeProject(
  root: string,
  profile: DeviceProfile,
  options: { rules?: string[]; include?: string[] } = {},
): Promise<ProjectAnalysis> {
  const files = await listCodeFiles(root, options.include);
  const findings: Finding[] = [];
  let filesWithFindings = 0;

  for (const abs of files) {
    const code = await readFile(abs, 'utf8');
    if (!looksLike3dCode(code)) continue;
    const rel = path.relative(root, abs);
    const result = analyzeSource(code, rel, profile, options.rules).map(strip);
    if (result.length) filesWithFindings++;
    findings.push(...result);
  }

  const totals = { error: 0, warning: 0, info: 0, fixable: 0 };
  const byRule: Record<string, number> = {};
  for (const f of findings) {
    totals[f.severity]++;
    if (f.fixable) totals.fixable++;
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  }

  return {
    root,
    profile: profile.id,
    filesScanned: files.length,
    filesWithFindings,
    totals,
    byRule,
    findings,
  };
}

export async function fixProject(
  root: string,
  profile: DeviceProfile,
  options: { rules?: string[]; include?: string[]; dryRun?: boolean } = {},
): Promise<FixResult[]> {
  const files = await listCodeFiles(root, options.include);
  const results: FixResult[] = [];
  for (const abs of files) {
    const code = await readFile(abs, 'utf8');
    if (!looksLike3dCode(code)) continue;
    const rel = path.relative(root, abs);
    const result = fixSource(code, rel, profile, options.rules);
    if (!result.changed && result.remaining.length === 0) continue;
    if (result.changed && !options.dryRun) await writeFile(abs, result.code);
    results.push(result);
  }
  return results;
}
