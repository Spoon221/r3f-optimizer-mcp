import {
  attrExpression,
  baseName,
  getJsxAttr,
  hasSpreadAttrs,
  isTruthyAttr,
  nameOf,
  numberValue,
  objectProperty,
  walk,
  type Node,
} from '../ast.js';
import type { Rule, RuleContext } from '../types.js';

function forEachCanvas(ctx: RuleContext, fn: (opening: Node) => void): void {
  walk(ctx.ast, (node) => {
    if (node.type === 'JSXOpeningElement' && nameOf(node.name) === 'Canvas') fn(node);
  });
}

/** Removes a JSX attribute together with the whitespace before it. */
function removeAttr(ctx: RuleContext, attr: Node) {
  let start = attr.start;
  while (start > 0 && /\s/.test(ctx.code[start - 1])) start--;
  return (s: import('magic-string').default) => s.remove(start, attr.end);
}

export const pixelRatio: Rule = {
  id: 'pixel-ratio',
  title: 'Cap device pixel ratio',
  category: 'rendering',
  severity: 'warning',
  description:
    'Rendering at the full devicePixelRatio (3x on many phones) multiplies the fragment shader cost by up to 9x. ' +
    'The pixel ratio is capped according to the device profile.',
  check(ctx) {
    const max = ctx.profile.maxDpr;
    const dprText = `[1, ${max}]`;

    forEachCanvas(ctx, (opening) => {
      const attr = getJsxAttr(opening, 'dpr');
      if (!attr) {
        if (hasSpreadAttrs(opening)) return;
        ctx.report(opening, {
          message: `<Canvas> has no "dpr" prop, so it renders at the device pixel ratio (up to 3x on phones).`,
          suggestion: `Add dpr={${dprText}}.`,
          fix: (s) => s.appendLeft(opening.name.end, ` dpr={${dprText}}`),
        });
        return;
      }
      const expr = attrExpression(attr);
      if (!expr) return;
      const single = numberValue(expr);
      if (single !== null && single > max) {
        ctx.report(attr, {
          message: `dpr={${single}} exceeds the ${ctx.profile.id} profile limit (${max}).`,
          fix: (s) => s.overwrite(expr.start, expr.end, String(max)),
        });
      } else if (expr.type === 'ArrayExpression' && expr.elements.length === 2) {
        const upper = numberValue(expr.elements[1]);
        if (upper !== null && upper > max) {
          ctx.report(attr, {
            message: `dpr upper bound ${upper} exceeds the ${ctx.profile.id} profile limit (${max}).`,
            fix: (s) => s.overwrite(expr.elements[1].start, expr.elements[1].end, String(max)),
          });
        }
      } else if (ctx.code.slice(expr.start, expr.end).includes('devicePixelRatio')) {
        ctx.report(attr, {
          message: `dpr is bound to window.devicePixelRatio without an upper limit.`,
          fix: (s) => s.overwrite(expr.start, expr.end, dprText),
        });
      }
    });

    // Vanilla three.js: renderer.setPixelRatio(window.devicePixelRatio)
    walk(ctx.ast, (node) => {
      if (node.type !== 'CallExpression' || baseName(nameOf(node.callee)) !== 'setPixelRatio') return;
      const arg = node.arguments[0];
      if (!arg) return;
      const value = numberValue(arg);
      const src = ctx.code.slice(arg.start, arg.end);
      if (value !== null && value > max) {
        ctx.report(node, {
          message: `setPixelRatio(${value}) exceeds the ${ctx.profile.id} profile limit (${max}).`,
          fix: (s) => s.overwrite(arg.start, arg.end, String(max)),
        });
      } else if (src.includes('devicePixelRatio') && !src.includes('Math.min')) {
        ctx.report(node, {
          message: `setPixelRatio() uses devicePixelRatio without an upper limit.`,
          suggestion: `Use Math.min(${src}, ${max}).`,
          fix: (s) => s.overwrite(arg.start, arg.end, `Math.min(${src}, ${max})`),
        });
      }
    });
  },
};

export const antialias: Rule = {
  id: 'antialias',
  title: 'Disable MSAA on weak GPUs',
  category: 'rendering',
  severity: 'warning',
  description:
    'Hardware multisampling is expensive on mobile tile-based GPUs. For low-end devices it is disabled ' +
    'and the renderer is asked for the high-performance GPU.',
  check(ctx) {
    if (ctx.profile.antialias) return;

    const handleOptions = (obj: Node, owner: string) => {
      const prop = objectProperty(obj, 'antialias');
      if (!prop) {
        ctx.report(obj, {
          message: `${owner} does not set antialias (R3F enables it by default).`,
          fix: (s) => s.appendLeft(obj.start + 1, ' antialias: false,'),
        });
      } else if (prop.value.type === 'BooleanLiteral' && prop.value.value) {
        ctx.report(prop, {
          message: `${owner} enables antialias, which is too expensive for the ${ctx.profile.id} profile.`,
          fix: (s) => s.overwrite(prop.value.start, prop.value.end, 'false'),
        });
      }
    };

    forEachCanvas(ctx, (opening) => {
      const attr = getJsxAttr(opening, 'gl');
      if (!attr) {
        if (hasSpreadAttrs(opening)) return;
        ctx.report(opening, {
          message: `<Canvas> uses default WebGL settings (antialias: true).`,
          suggestion: `Add gl={{ antialias: false, powerPreference: 'high-performance' }}.`,
          fix: (s) =>
            s.appendLeft(opening.name.end, ` gl={{ antialias: false, powerPreference: 'high-performance' }}`),
        });
        return;
      }
      const expr = attrExpression(attr);
      if (expr?.type === 'ObjectExpression') handleOptions(expr, '<Canvas gl>');
    });

    walk(ctx.ast, (node) => {
      if (node.type !== 'NewExpression' || baseName(nameOf(node.callee)) !== 'WebGLRenderer') return;
      const options = node.arguments[0];
      if (options?.type === 'ObjectExpression') handleOptions(options, 'new WebGLRenderer()');
    });
  },
};

export const shadows: Rule = {
  id: 'shadows',
  title: 'Shadow maps per device',
  category: 'rendering',
  severity: 'warning',
  description:
    'Every shadow-casting light renders the scene once more into a depth texture. Low-end profiles turn ' +
    'shadow maps off; other profiles clamp the shadow map resolution.',
  check(ctx) {
    const { shadows: allowed, maxShadowMapSize: maxSize } = ctx.profile;

    if (!allowed) {
      forEachCanvas(ctx, (opening) => {
        const attr = getJsxAttr(opening, 'shadows');
        if (isTruthyAttr(attr)) {
          ctx.report(attr!, {
            message: `Shadow maps are enabled on <Canvas>, which is too expensive for the ${ctx.profile.id} profile.`,
            suggestion: 'Remove the shadows prop or bake shadows into textures / use <ContactShadows frames={1}>.',
            fix: removeAttr(ctx, attr!),
          });
        }
      });
      walk(ctx.ast, (node) => {
        if (
          node.type === 'AssignmentExpression' &&
          /(^|\.)shadowMap\.enabled$/.test(nameOf(node.left) ?? '') &&
          node.right.type === 'BooleanLiteral' &&
          node.right.value
        ) {
          ctx.report(node, {
            message: `renderer.shadowMap.enabled = true is too expensive for the ${ctx.profile.id} profile.`,
            fix: (s) => s.overwrite(node.right.start, node.right.end, 'false'),
          });
        }
      });
    }

    const clamp = (valueNode: Node, label: string) => {
      const value = numberValue(valueNode);
      if (value !== null && value > maxSize) {
        ctx.report(valueNode, {
          message: `${label} ${value} exceeds the ${ctx.profile.id} profile limit (${maxSize}).`,
          fix: (s) => s.overwrite(valueNode.start, valueNode.end, String(maxSize)),
        });
      }
    };

    walk(ctx.ast, (node) => {
      if (node.type === 'JSXAttribute') {
        const name = nameOf(node.name) ?? '';
        if (!/^shadow-mapSize(-width|-height)?$/.test(name)) return;
        const expr = attrExpression(node);
        if (!expr) return;
        if (expr.type === 'ArrayExpression') expr.elements.forEach((el: Node) => el && clamp(el, 'Shadow map size'));
        else clamp(expr, 'Shadow map size');
      } else if (node.type === 'AssignmentExpression') {
        if (/shadow\.mapSize\.(width|height)$/.test(nameOf(node.left) ?? '')) clamp(node.right, 'Shadow map size');
      } else if (node.type === 'CallExpression') {
        if (/shadow\.mapSize\.set$/.test(nameOf(node.callee) ?? '')) {
          node.arguments.forEach((arg: Node) => clamp(arg, 'Shadow map size'));
        }
      }
    });
  },
};

export const postprocessing: Rule = {
  id: 'postprocessing',
  title: 'Post-processing budget',
  category: 'rendering',
  severity: 'warning',
  description:
    'Each post-processing pass is a full-screen draw at the canvas resolution. Low-end profiles disable the ' +
    'EffectComposer, mid-range profiles reduce its multisampling.',
  check(ctx) {
    walk(ctx.ast, (node) => {
      if (node.type !== 'JSXOpeningElement' || nameOf(node.name) !== 'EffectComposer') return;
      if (!ctx.profile.postprocessing) {
        if (getJsxAttr(node, 'enabled')) return;
        ctx.report(node, {
          message: `<EffectComposer> runs full-screen passes on the ${ctx.profile.id} profile.`,
          suggestion: 'Disable post-processing for weak devices (enabled={false}) or render it conditionally.',
          fix: (s) => s.appendLeft(node.name.end, ' enabled={false}'),
        });
        return;
      }
      const target = ctx.profile.postprocessingMultisampling;
      if (target === null) return;
      const attr = getJsxAttr(node, 'multisampling');
      if (!attr) {
        ctx.report(node, {
          message: `<EffectComposer> uses the default multisampling (8 samples).`,
          fix: (s) => s.appendLeft(node.name.end, ` multisampling={${target}}`),
        });
        return;
      }
      const expr = attrExpression(attr);
      const value = numberValue(expr);
      if (expr && value !== null && value > target) {
        ctx.report(attr, {
          message: `multisampling={${value}} exceeds the ${ctx.profile.id} profile limit (${target}).`,
          fix: (s) => s.overwrite(expr.start, expr.end, String(target)),
        });
      }
    });
  },
};

const ADAPTIVE_COMPONENTS = ['PerformanceMonitor', 'AdaptiveDpr', 'AdaptiveEvents'];

export const adaptivePerformance: Rule = {
  id: 'adaptive-performance',
  title: 'Runtime performance adaptation',
  category: 'runtime',
  severity: 'info',
  description:
    'Static settings cannot cover every device. drei <AdaptiveDpr> lowers the resolution and <AdaptiveEvents> ' +
    'pauses raycasting while the frame rate drops, restoring them afterwards.',
  check(ctx) {
    let hasAdaptive = false;
    walk(ctx.ast, (node) => {
      if (node.type === 'JSXOpeningElement' && ADAPTIVE_COMPONENTS.includes(nameOf(node.name) ?? '')) hasAdaptive = true;
    });
    if (hasAdaptive) return;

    walk(ctx.ast, (node) => {
      if (node.type !== 'JSXElement' || nameOf(node.openingElement.name) !== 'Canvas' || !node.closingElement) return;
      const opening = node.openingElement;
      const lineStart = ctx.code.lastIndexOf('\n', opening.start) + 1;
      const indent = (ctx.code.slice(lineStart, opening.start).match(/^\s*/)?.[0] ?? '') + '  ';
      ctx.report(opening, {
        message: '<Canvas> has no runtime adaptation to frame-rate drops.',
        suggestion: 'Add <AdaptiveDpr pixelated /> and <AdaptiveEvents /> from @react-three/drei.',
        fix: (s, imports) => {
          imports.ensure('@react-three/drei', 'AdaptiveDpr');
          imports.ensure('@react-three/drei', 'AdaptiveEvents');
          s.appendLeft(opening.end, `\n${indent}<AdaptiveDpr pixelated />\n${indent}<AdaptiveEvents />`);
        },
      });
    });
  },
};
