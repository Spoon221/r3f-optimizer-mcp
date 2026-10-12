import { attrExpression, baseName, getJsxAttr, nameOf, numberValue, walk, type Node } from '../ast.js';
import type { Rule } from '../types.js';

/** Indexes of the "segments" arguments for built-in geometries. */
const SEGMENT_ARGS: Record<string, number[]> = {
  SphereGeometry: [1, 2],
  BoxGeometry: [3, 4, 5],
  PlaneGeometry: [2, 3],
  CylinderGeometry: [3, 4],
  ConeGeometry: [2, 3],
  TorusGeometry: [2, 3],
  TorusKnotGeometry: [2, 3],
  CircleGeometry: [1],
  RingGeometry: [2, 3],
  CapsuleGeometry: [2, 3],
};

/** <sphereGeometry>, drei <Sphere>, THREE.SphereGeometry -> "SphereGeometry". */
function geometryClass(name: string | null): string | null {
  const base = baseName(name);
  if (!base) return null;
  const pascal = base[0].toUpperCase() + base.slice(1);
  if (SEGMENT_ARGS[pascal]) return pascal;
  if (SEGMENT_ARGS[`${pascal}Geometry`]) return `${pascal}Geometry`;
  return null;
}

export const geometrySegments: Rule = {
  id: 'geometry-segments',
  title: 'Procedural geometry detail',
  category: 'geometry',
  severity: 'warning',
  description:
    'Triangle count of procedural geometry grows with the product of its segments (64x64 sphere = 8k triangles). ' +
    'Segment arguments are clamped to the device profile.',
  check(ctx) {
    const max = ctx.profile.maxSegments;

    const inspect = (cls: string, args: Node[], at: Node) => {
      for (const index of SEGMENT_ARGS[cls]) {
        const arg = args[index];
        const value = numberValue(arg);
        if (value !== null && value > max) {
          ctx.report(arg ?? at, {
            message: `${cls} uses ${value} segments (argument #${index + 1}); the ${ctx.profile.id} profile allows ${max}.`,
            fix: (s) => s.overwrite(arg.start, arg.end, String(max)),
          });
        }
      }
    };

    walk(ctx.ast, (node) => {
      if (node.type === 'JSXOpeningElement') {
        const cls = geometryClass(nameOf(node.name));
        const expr = attrExpression(getJsxAttr(node, 'args'));
        if (cls && expr?.type === 'ArrayExpression') inspect(cls, expr.elements, node);
      } else if (node.type === 'NewExpression') {
        const cls = geometryClass(nameOf(node.callee));
        if (cls && /Geometry$/.test(baseName(nameOf(node.callee)) ?? '')) inspect(cls, node.arguments, node);
      }
    });
  },
};

const PHYSICAL_JSX = new Set(['meshPhysicalMaterial', 'MeshTransmissionMaterial', 'MeshRefractionMaterial']);

export const physicalMaterial: Rule = {
  id: 'physical-material',
  title: 'Heavy PBR materials',
  category: 'materials',
  severity: 'warning',
  description:
    'MeshPhysicalMaterial (clearcoat, transmission, sheen) and transmission materials from drei render the scene ' +
    'an extra time or run much longer shaders. Where the profile does not allow them they are replaced with ' +
    'MeshStandardMaterial.',
  check(ctx) {
    if (ctx.profile.physicalMaterials) return;

    walk(ctx.ast, (node) => {
      if (node.type === 'JSXElement') {
        const name = nameOf(node.openingElement.name);
        if (!name || !PHYSICAL_JSX.has(name)) return;
        const { openingElement: opening, closingElement: closing } = node;
        ctx.report(opening, {
          message: `<${name}> is too expensive for the ${ctx.profile.id} profile.`,
          suggestion: 'Use meshStandardMaterial; fake glass with envMap + opacity if needed.',
          fix: (s) => {
            s.overwrite(opening.name.start, opening.name.end, 'meshStandardMaterial');
            if (closing) s.overwrite(closing.name.start, closing.name.end, 'meshStandardMaterial');
          },
        });
      } else if (node.type === 'NewExpression' && baseName(nameOf(node.callee)) === 'MeshPhysicalMaterial') {
        const callee = node.callee;
        ctx.report(node, {
          message: `MeshPhysicalMaterial is too expensive for the ${ctx.profile.id} profile.`,
          fix: (s, imports) => {
            if (callee.type === 'MemberExpression') {
              s.overwrite(callee.property.start, callee.property.end, 'MeshStandardMaterial');
            } else {
              imports.ensure('three', 'MeshStandardMaterial');
              s.overwrite(callee.start, callee.end, 'MeshStandardMaterial');
            }
          },
        });
      }
    });
  },
};

export const instancingCandidate: Rule = {
  id: 'instancing-candidate',
  title: 'Draw-call batching',
  category: 'geometry',
  severity: 'info',
  description:
    'Rendering a list of meshes with .map() produces one draw call per item. Draw calls are the main CPU cost on ' +
    'mobile; <Instances>/<instancedMesh> render all of them in one call.',
  check(ctx) {
    walk(ctx.ast, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
      if (nameOf(node.callee.property) !== 'map') return;
      const cb = node.arguments[0];
      if (!cb || !/Function/.test(cb.type)) return;
      const returned = returnedJsx(cb);
      if (returned && nameOf(returned.openingElement.name) === 'mesh') {
        ctx.report(node, {
          message: 'A list of <mesh> elements is rendered with .map(): one draw call per element.',
          suggestion:
            'If the meshes share geometry and material, use <Instances>/<Instance> from @react-three/drei or <instancedMesh>.',
        });
      }
    });
  },
};

function returnedJsx(fn: Node): Node | null {
  const unwrap = (n: Node | null): Node | null =>
    n?.type === 'ParenthesizedExpression' ? unwrap(n.expression) : n?.type === 'JSXElement' ? n : null;
  if (fn.body.type !== 'BlockStatement') return unwrap(fn.body);
  const ret = fn.body.body.find((st: Node) => st.type === 'ReturnStatement');
  return ret ? unwrap(ret.argument) : null;
}
