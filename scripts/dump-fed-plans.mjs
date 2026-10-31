import { readFileSync } from 'fs';
import { QueryPlanner } from '@graphql-hive/router-query-planner';
import { getFragmentsFromDocument } from '@graphql-tools/executor';
import { getOperationASTFromDocument } from '@graphql-tools/utils';
import { parse, print } from 'graphql';
import { getStitchedSchemaFromSupergraphSdl } from '../packages/federation/src/supergraph.ts';
import { buildStitchPlan } from '../packages/stitch/src/backbone/buildStitchPlan.ts';

const sdl = readFileSync('/tmp/bench-supergraph.graphql', 'utf8');
// Match createExampleSetup query shape via fragments inlined from prior dumps
const query = `
  query TestQuery {
    users {
      id username name
      reviews {
        id body
        product {
          name price weight upc inStock shippingEstimate
          reviews {
            id body
            author {
              id username name
              reviews {
                id body
                product { name price weight upc inStock shippingEstimate }
              }
            }
          }
        }
      }
    }
    topProducts {
      name price weight upc inStock shippingEstimate
      reviews {
        id body
        author {
          id username name
          reviews {
            id body
            product { name price weight upc inStock shippingEstimate }
          }
        }
      }
    }
  }
`;
const schema = getStitchedSchemaFromSupergraphSdl({ supergraphSdl: sdl });
const doc = parse(query);
const plan = buildStitchPlan(
  schema,
  getOperationASTFromDocument(doc),
  getFragmentsFromDocument(doc),
  {},
);

function countFetches(n, acc = []) {
  if (!n) return acc;
  if (n.kind === 'Fetch' || n.kind === 'BatchFetch') {
    acc.push(n);
    return acc;
  }
  if (n.nodes) for (const c of n.nodes) countFetches(c, acc);
  if (n.continue) countFetches(n.continue, acc);
  return acc;
}
function summarize(n, indent = 0) {
  const pad = '  '.repeat(indent);
  if (n.kind === 'Fetch') {
    const paths = n.flattenPaths ?? (n.flattenPath ? [n.flattenPath] : []);
    const fields = n.selectionSet.selections
      .filter((s) => s.kind === 'Field')
      .map((s) => s.name.value)
      .join(',');
    return `${pad}Fetch ${n.subschema.name} ent=${n.entityTypeName || '-'} root=${n.rootField?.name?.value || '-'} paths=${JSON.stringify(paths)} deps=${JSON.stringify(n.dependsOn || [])} {${fields}}`;
  }
  if (n.kind === 'BatchFetch') {
    const aliases = n.aliases
      .map(
        (a) =>
          `${a.alias}:${a.entityTypeName}@${JSON.stringify(a.flattenPaths)}`,
      )
      .join(' | ');
    return `${pad}BatchFetch ${n.subschema.name} [${aliases}] deps=${JSON.stringify(n.dependsOn || [])} completes=${JSON.stringify(n.completesIds || [])}`;
  }
  if (n.kind === 'Sequence' || n.kind === 'Parallel') {
    return (
      `${pad}${n.kind}(${n.nodes.length})\n` +
      n.nodes.map((c) => summarize(c, indent + 1)).join('\n')
    );
  }
  return `${pad}${n.kind}`;
}

console.log('STITCH fetches=', countFetches(plan.root).length);
console.log(summarize(plan.root));
try {
  const hive = new QueryPlanner(sdl).plan(query);
  let f = 0,
    b = 0;
  (function walk(n) {
    if (!n) return;
    if (n.kind === 'Fetch') f++;
    if (n.kind === 'BatchFetch') b++;
    if (n.nodes) n.nodes.forEach(walk);
    if (n.node) walk(n.node);
  })(hive.node);
  console.log('HIVE Fetch=', f, 'BatchFetch=', b, 'total=', f + b);
} catch (e) {
  console.log('HIVE plan error', e.message);
}
