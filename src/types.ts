import type MagicString from 'magic-string';
import type { ImportManager, Node } from './ast.js';
import type { DeviceProfile } from './profiles.js';

export type Severity = 'error' | 'warning' | 'info';

export type Category = 'rendering' | 'geometry' | 'materials' | 'runtime' | 'loading';

export type FixFn = (s: MagicString, imports: ImportManager) => void;

export interface Finding {
  ruleId: string;
  severity: Severity;
  category: Category;
  message: string;
  file: string;
  line: number;
  column: number;
  fixable: boolean;
  suggestion?: string;
}

/** Finding plus the code edit that resolves it (internal). */
export interface FindingWithFix extends Finding {
  start: number;
  fix?: FixFn;
}

export interface ReportInput {
  message: string;
  severity?: Severity;
  suggestion?: string;
  fix?: FixFn;
}

export interface RuleContext {
  file: string;
  code: string;
  ast: Node;
  profile: DeviceProfile;
  report(node: Node, input: ReportInput): void;
}

export interface Rule {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  description: string;
  check(ctx: RuleContext): void;
}
