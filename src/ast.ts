import { parse } from '@babel/parser';
import type MagicString from 'magic-string';

// Babel AST nodes are handled structurally; a loose type keeps the walker simple.
export type Node = { type: string; start: number; end: number; loc?: any; [key: string]: any };

export function parseCode(code: string, file: string): Node {
  const plugins: any[] = /\.ts$/.test(file)
    ? ['typescript']
    : /\.tsx$/.test(file)
      ? ['typescript', 'jsx']
      : ['jsx'];
  return parse(code, { sourceType: 'module', errorRecovery: true, plugins }) as unknown as Node;
}

export type Visitor = (node: Node, ancestors: Node[]) => void;

/** Depth-first walk over every AST node, passing the chain of ancestors. */
export function walk(root: Node, visit: Visitor): void {
  const ancestors: Node[] = [];
  const visitNode = (node: Node) => {
    visit(node, ancestors);
    ancestors.push(node);
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'comments' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visitNode(child);
      } else if (isNode(value)) {
        visitNode(value);
      }
    }
    ancestors.pop();
  };
  visitNode(root);
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/** "Canvas", "THREE.Mesh", "a.b.c" for JSX names and member expressions. */
export function nameOf(node: Node | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'JSXIdentifier':
    case 'Identifier':
      return node.name;
    case 'JSXMemberExpression':
    case 'MemberExpression': {
      const obj = nameOf(node.object);
      const prop = node.computed ? null : nameOf(node.property);
      return obj && prop ? `${obj}.${prop}` : null;
    }
    case 'JSXNamespacedName':
      return `${node.namespace.name}:${node.name.name}`;
    default:
      return null;
  }
}

/** Last segment of a possibly namespaced name: "THREE.SphereGeometry" -> "SphereGeometry". */
export function baseName(name: string | null): string | null {
  return name ? name.split('.').pop()! : null;
}

export function getJsxAttr(opening: Node, name: string): Node | undefined {
  return opening.attributes.find((a: Node) => a.type === 'JSXAttribute' && nameOf(a.name) === name);
}

export function hasSpreadAttrs(opening: Node): boolean {
  return opening.attributes.some((a: Node) => a.type === 'JSXSpreadAttribute');
}

/** Expression inside a JSX attribute value (`{...}`), or the literal itself. */
export function attrExpression(attr: Node | undefined): Node | null {
  if (!attr || !attr.value) return null;
  if (attr.value.type === 'JSXExpressionContainer') return attr.value.expression;
  return attr.value;
}

/** Numeric value of a literal (supports unary minus). */
export function numberValue(node: Node | null | undefined): number | null {
  if (!node) return null;
  if (node.type === 'NumericLiteral') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') {
    return -node.argument.value;
  }
  return null;
}

export function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/** True when the attribute is present and not explicitly `{false}`. */
export function isTruthyAttr(attr: Node | undefined): boolean {
  if (!attr) return false;
  const expr = attrExpression(attr);
  if (!expr) return true; // boolean shorthand: <Canvas shadows>
  return !(expr.type === 'BooleanLiteral' && expr.value === false);
}

export function objectProperty(obj: Node, key: string): Node | undefined {
  if (obj?.type !== 'ObjectExpression') return undefined;
  return obj.properties.find(
    (p: Node) => p.type === 'ObjectProperty' && !p.computed && (nameOf(p.key) === key || stringValue(p.key) === key),
  );
}

/** Function passed as the callback of a call like useFrame(cb) / setAnimationLoop(cb). */
export function isFunction(node: Node | null | undefined): boolean {
  return !!node && /^(ArrowFunctionExpression|FunctionExpression)$/.test(node.type);
}

/**
 * Adds `import { name } from 'source'` unless it already exists.
 * Tracks pending additions per file so several rules can request the same import.
 */
export class ImportManager {
  private pending = new Map<string, Set<string>>();

  constructor(private ast: Node) {}

  ensure(source: string, name: string): void {
    if (this.isImported(source, name)) return;
    if (!this.pending.has(source)) this.pending.set(source, new Set());
    this.pending.get(source)!.add(name);
  }

  private isImported(source: string, name: string): boolean {
    return this.program().body.some(
      (n: Node) =>
        n.type === 'ImportDeclaration' &&
        n.source.value === source &&
        n.specifiers.some((s: Node) => s.type === 'ImportSpecifier' && s.local.name === name),
    );
  }

  private program(): Node {
    return this.ast.type === 'File' ? this.ast.program : this.ast;
  }

  apply(s: MagicString): void {
    const body: Node[] = this.program().body;
    const imports = body.filter((n) => n.type === 'ImportDeclaration');
    for (const [source, names] of this.pending) {
      const list = [...names];
      const existing = imports.find(
        (n) => n.source.value === source && n.importKind !== 'type' && n.specifiers.some((sp: Node) => sp.type === 'ImportSpecifier'),
      );
      if (existing) {
        const named = existing.specifiers.filter((sp: Node) => sp.type === 'ImportSpecifier');
        s.appendLeft(named[named.length - 1].end, `, ${list.join(', ')}`);
      } else {
        const line = `import { ${list.join(', ')} } from '${source}';\n`;
        const last = imports[imports.length - 1];
        if (last) s.appendLeft(last.end, `\n${line.trimEnd()}`);
        else s.prepend(line);
      }
    }
    this.pending.clear();
  }
}
