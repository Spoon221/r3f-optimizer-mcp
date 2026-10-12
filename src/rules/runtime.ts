import { baseName, isFunction, nameOf, stringValue, walk, type Node } from '../ast.js';
import type { Rule, RuleContext } from '../types.js';

const LOOP_CALLEES = new Set(['useFrame', 'setAnimationLoop', 'requestAnimationFrame']);

const ALLOCATED_CLASS =
  /^(Vector[234]|Quaternion|Euler|Matrix[34]|Color|Box[23]|Sphere|Ray|Raycaster|Plane|Object3D|Mesh|Group|Clock|\w+Geometry|\w+Material|\w+Texture)$/;

/**
 * Collects names of functions that are passed to requestAnimationFrame / setAnimationLoop by reference,
 * e.g. `function animate() { ...; requestAnimationFrame(animate) }`.
 */
function loopFunctionNames(ctx: RuleContext): Set<string> {
  const names = new Set<string>();
  walk(ctx.ast, (node) => {
    if (node.type !== 'CallExpression') return;
    if (!LOOP_CALLEES.has(baseName(nameOf(node.callee)) ?? '')) return;
    const arg = node.arguments[0];
    if (arg?.type === 'Identifier') names.add(arg.name);
  });
  return names;
}

/** Calls `fn` for every node located inside a per-frame callback. */
function forEachInFrameLoop(ctx: RuleContext, fn: (node: Node, loop: string, ancestors: Node[]) => void): void {
  const named = loopFunctionNames(ctx);
  walk(ctx.ast, (node, ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      const parent = ancestors[i - 1];
      if (isFunction(a) && parent?.type === 'CallExpression' && parent.arguments[0] === a) {
        const callee = baseName(nameOf(parent.callee)) ?? '';
        if (LOOP_CALLEES.has(callee)) return fn(node, callee, ancestors.slice(i));
      }
      if (a.type === 'FunctionDeclaration' && a.id && named.has(a.id.name)) return fn(node, a.id.name, ancestors.slice(i));
      if (isFunction(a) && parent?.type === 'VariableDeclarator' && named.has(parent.id?.name)) {
        return fn(node, parent.id.name, ancestors.slice(i));
      }
    }
  });
}

export const allocInFrameLoop: Rule = {
  id: 'alloc-in-frame-loop',
  title: 'Allocations inside the render loop',
  category: 'runtime',
  severity: 'warning',
  description:
    'Creating vectors, matrices, geometries or materials every frame produces garbage at 60 objects/s per call ' +
    'site; garbage collection pauses cause visible stutter on phones. Objects should be created once and reused.',
  check(ctx) {
    forEachInFrameLoop(ctx, (node, loop) => {
      if (node.type !== 'NewExpression') return;
      const cls = baseName(nameOf(node.callee));
      if (!cls || !ALLOCATED_CLASS.test(cls)) return;
      const heavy = /(Geometry|Material|Texture)$/.test(cls);
      ctx.report(node, {
        severity: heavy ? 'error' : 'warning',
        message: `new ${cls}() is called inside ${loop}() on every frame.`,
        suggestion: heavy
          ? `Create the ${cls} once (useMemo / module scope) and dispose it on unmount.`
          : `Hoist a reusable instance (e.g. const tmp = new ${cls}() outside the loop) and use .set()/.copy().`,
      });
    });
  },
};

export const setStateInFrameLoop: Rule = {
  id: 'setstate-in-frame-loop',
  title: 'React state updates in useFrame',
  category: 'runtime',
  severity: 'error',
  description:
    'Calling a React state setter from useFrame re-renders the component tree up to 60 times per second. ' +
    'Per-frame changes should mutate refs (ref.current.position.x = ...) instead.',
  check(ctx) {
    forEachInFrameLoop(ctx, (node, loop, ancestors) => {
      if (loop !== 'useFrame' || node.type !== 'CallExpression') return;
      if (node.callee.type !== 'Identifier' || !/^set[A-Z]/.test(node.callee.name)) return;
      // A setter behind a condition usually fires only on transitions (hover start/end), not every frame.
      const guarded = ancestors.some((a) => CONDITIONAL.has(a.type));
      ctx.report(node, {
        severity: guarded ? 'info' : 'error',
        message: guarded
          ? `${node.callee.name}() is called conditionally inside useFrame(); make sure the condition is not true every frame.`
          : `${node.callee.name}() inside useFrame() re-renders React every frame.`,
        suggestion: 'Mutate a ref instead, or only call the setter when the value actually changes.',
      });
    });
  },
};

const CONDITIONAL = new Set(['IfStatement', 'ConditionalExpression', 'LogicalExpression']);

const PRELOADABLE = new Set(['useGLTF', 'useTexture', 'useFBX', 'useKTX2']);

export const assetPreload: Rule = {
  id: 'asset-preload',
  title: 'Preload assets',
  category: 'loading',
  severity: 'info',
  description:
    'Without .preload() loading starts only when the component mounts, which creates a waterfall and a visible ' +
    'pop-in. Calling useGLTF.preload(url) at module level starts the download as soon as the module is imported.',
  check(ctx) {
    const used = new Map<string, { hook: string; node: Node }>();
    const preloaded = new Set<string>();

    walk(ctx.ast, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = nameOf(node.callee) ?? '';
      const url = stringValue(node.arguments[0]);
      if (!url) return;
      const [hook, method] = callee.split('.');
      if (!PRELOADABLE.has(hook)) return;
      if (method === 'preload') preloaded.add(`${hook}:${url}`);
      else if (!method && !used.has(`${hook}:${url}`)) used.set(`${hook}:${url}`, { hook, node });
    });

    for (const [key, { hook, node }] of used) {
      if (preloaded.has(key)) continue;
      const url = key.slice(hook.length + 1);
      ctx.report(node, {
        message: `${hook}('${url}') is not preloaded.`,
        suggestion: `Add ${hook}.preload('${url}') at module level.`,
        fix: (s) => s.append(`\n${hook}.preload(${JSON.stringify(url)});\n`),
      });
    }
  },
};
