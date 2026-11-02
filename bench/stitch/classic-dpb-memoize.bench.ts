/**
 * Classic stitching DPB memoize microbench.
 * Workload: list of N users merged across two subschemas (no @requires).
 * Local executors only — amplifies CPU / planner cost vs network.
 *
 * Current code selectively memoizes this case; "force non-memoize" rebuilds
 * the plan every mergeFields call for comparison.
 */
import { createDefaultExecutor, StitchingInfo } from '@graphql-tools/delegate';
import { normalizedExecutor } from '@graphql-tools/executor';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { stitchSchemas } from '@graphql-tools/stitch';
import { benchConfig } from '@internal/testing';
import { parse } from 'graphql';
import { bench, describe, expect } from 'vitest';

const ENTITY_COUNT = 100;

function buildSchema(classicStitching: boolean) {
  const users = Array.from({ length: ENTITY_COUNT }, (_, i) => ({
    id: String(i),
    name: `u${i}`,
  }));
  const profiles = Object.fromEntries(
    users.map((u) => [u.id, { id: u.id, email: `${u.id}@ex.com`, bio: 'x' }]),
  );

  const listSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type User {
        id: ID!
        name: String
      }
      type Query {
        users: [User!]!
      }
    `,
    resolvers: {
      Query: {
        users: () => users,
      },
    },
  });

  const profileSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type User {
        id: ID!
        email: String
        bio: String
      }
      type Query {
        userById(id: ID!): User
        usersById(ids: [ID!]!): [User]!
      }
    `,
    resolvers: {
      Query: {
        userById: (_: unknown, { id }: { id: string }) => profiles[id] ?? null,
        usersById: (_: unknown, { ids }: { ids: string[] }) =>
          ids.map((id) => profiles[id] ?? null),
      },
    },
  });

  return stitchSchemas({
    classicStitching,
    subschemas: [
      {
        schema: listSchema,
        executor: createDefaultExecutor(listSchema),
        batch: true,
      },
      {
        schema: profileSchema,
        executor: createDefaultExecutor(profileSchema),
        batch: true,
        merge: {
          User: {
            selectionSet: '{ id }',
            fieldName: 'usersById',
            key: (obj: { id: string }) => obj.id,
            argsFromKeys: (ids: string[]) => ({ ids }),
          },
        },
      },
    ],
  });
}

function forceNonMemoizedDpb(schema: ReturnType<typeof stitchSchemas>) {
  const stitchingInfo = schema.extensions?.stitchingInfo as StitchingInfo;
  for (const typeName in stitchingInfo.mergedTypes) {
    const mergedTypeInfo = stitchingInfo.mergedTypes[typeName];
    if (!mergedTypeInfo?.nonMemoizedDelegationPlanBuilder) continue;
    mergedTypeInfo.delegationPlanBuilder =
      mergedTypeInfo.nonMemoizedDelegationPlanBuilder;
  }
}

const document = parse(/* GraphQL */ `
  query {
    users {
      id
      name
      email
      bio
    }
  }
`);

describe('classic stitching DPB selective memoize', () => {
  const schemaMemo = buildSchema(true);
  const schemaNoMemo = buildSchema(true);
  forceNonMemoizedDpb(schemaNoMemo);
  const schemaBackbone = buildSchema(false);

  bench(
    'classic merge list — selective memoize (current)',
    async () => {
      const result = await normalizedExecutor({
        schema: schemaMemo,
        document,
      });
      expect(
        (result as { data: { users: unknown[] } }).data.users,
      ).toHaveLength(ENTITY_COUNT);
    },
    benchConfig,
  );

  bench(
    'classic merge list — force non-memoize',
    async () => {
      const result = await normalizedExecutor({
        schema: schemaNoMemo,
        document,
      });
      expect(
        (result as { data: { users: unknown[] } }).data.users,
      ).toHaveLength(ENTITY_COUNT);
    },
    benchConfig,
  );

  bench(
    'backbone merge list (plan-cached execute)',
    async () => {
      const result = await normalizedExecutor({
        schema: schemaBackbone,
        document,
      });
      expect(
        (result as { data: { users: unknown[] } }).data.users,
      ).toHaveLength(ENTITY_COUNT);
    },
    benchConfig,
  );
});
