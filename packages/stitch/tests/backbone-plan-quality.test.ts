import { createDefaultExecutor } from '@graphql-tools/delegate';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { parse, print } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildStitchPlan, type StitchPlanNode } from '../src/backbone/index';
import { stitchSchemas } from '../src/stitchSchemas';

function countFetches(node: StitchPlanNode): {
  root: number;
  entity: number;
  island: number;
} {
  const acc = { root: 0, entity: 0, island: 0 };
  const walk = (n: StitchPlanNode) => {
    if (n.kind === 'Fetch') {
      if (n.rootField) acc.root++;
      else acc.entity++;
    } else if (n.kind === 'Island') {
      acc.island++;
      if (n.continue) walk(n.continue);
    } else {
      for (const c of n.nodes) walk(c);
    }
  };
  walk(node);
  return acc;
}

function listFetches(node: StitchPlanNode): string[] {
  const out: string[] = [];
  const walk = (n: StitchPlanNode) => {
    if (n.kind === 'Fetch') {
      const kind = n.rootField ? 'root' : 'entity';
      const sel = print(n.selectionSet).replace(/\s+/g, ' ').trim();
      out.push(`${kind}:${n.entityTypeName ?? n.rootField?.name.value} ${sel}`);
    } else if (n.kind === 'Island') {
      out.push(`island:${n.fieldNode.name.value}`);
      if (n.continue) walk(n.continue);
    } else {
      for (const c of n.nodes) walk(c);
    }
  };
  walk(node);
  return out;
}

describe('backbone plan quality', () => {
  const authors = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type User {
        id: ID!
        email: String
      }
      type Query {
        userById(id: ID!): User
        users: [User]
      }
    `,
    resolvers: {
      Query: {
        userById: (_: unknown, { id }: { id: string }) => ({
          id,
          email: `${id}@ex.com`,
        }),
        users: () => [{ id: '1', email: '1@ex.com' }],
      },
    },
  });

  const chirps = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Chirp {
        id: ID!
        text: String
      }
      type User {
        id: ID!
        chirps: [Chirp]
      }
      type Query {
        userById(id: ID!): User
      }
    `,
    resolvers: {
      Query: {
        userById: (_: unknown, { id }: { id: string }) => ({ id }),
      },
      User: {
        chirps: (u: { id: string }) => [
          { id: `c-${u.id}`, text: 'hello' },
        ],
      },
    },
  });

  const schema = stitchSchemas({
    subschemas: [
      {
        schema: chirps,
        executor: createDefaultExecutor(chirps),
        merge: {
          User: {
            fieldName: 'userById',
            args: (o: { id: string }) => ({ id: o.id }),
            selectionSet: '{ id }',
          },
        },
        batch: true,
      },
      {
        schema: authors,
        executor: createDefaultExecutor(authors),
        merge: {
          User: {
            fieldName: 'userById',
            args: (o: { id: string }) => ({ id: o.id }),
            selectionSet: '{ id }',
          },
        },
        batch: true,
      },
    ],
  });

  it('plans a single root fetch + one entity fetch for cross-subgraph User fields', () => {
    const document = parse(/* GraphQL */ `
      query ($id: ID!) {
        userById(id: $id) {
          id
          email
          chirps {
            id
            text
          }
        }
      }
    `);
    const plan = buildStitchPlan(
      schema,
      document.definitions[0] as any,
      {},
      { id: '1' },
    );
    expect(plan.incomplete).toBe(false);
    const counts = countFetches(plan.root);
    // Ideal: 1 root (chirps owns userById+chirps) + 1 entity (authors email)
    expect(counts.root).toBe(1);
    expect(counts.entity).toBe(1);
    expect(counts.island).toBe(0);
    const fetches = listFetches(plan.root);
    expect(fetches.some((f) => f.includes('email'))).toBe(true);
  });

  it('plans parallel root fetches for independent root fields', () => {
    const document = parse(/* GraphQL */ `
      {
        users {
          id
          email
        }
        userById(id: "1") {
          id
          chirps {
            text
          }
        }
      }
    `);
    const plan = buildStitchPlan(
      schema,
      document.definitions[0] as any,
      {},
      {},
    );
    expect(plan.incomplete).toBe(false);
    const counts = countFetches(plan.root);
    expect(counts.root).toBeGreaterThanOrEqual(2);
  });
});
