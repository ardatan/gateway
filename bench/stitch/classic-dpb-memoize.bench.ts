/**
 * A/B: classic stitching with/without old DPB memoize5of7, plus backbone.
 * Workload: list of N users merged across two subschemas (high memoize hit rate).
 * Local executors only — amplifies CPU / planner cost vs network.
 */
import { createDefaultExecutor, StitchingInfo } from '@graphql-tools/delegate';
import { normalizedExecutor } from '@graphql-tools/executor';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { stitchSchemas } from '@graphql-tools/stitch';
import { benchConfig } from '@internal/testing';
import { parse } from 'graphql';
import { bench, describe, expect } from 'vitest';
import { memoize5of7 } from '../../packages/stitch/src/memoize5of7.js';

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

function installOldStyleDpbMemoize(schema: ReturnType<typeof stitchSchemas>) {
  const stitchingInfo = schema.extensions?.stitchingInfo as StitchingInfo;
  for (const typeName in stitchingInfo.mergedTypes) {
    const mergedTypeInfo = stitchingInfo.mergedTypes[typeName];
    if (!mergedTypeInfo?.nonMemoizedDelegationPlanBuilder) continue;
    // Match pre-clone-less wrapper: cache on first 5 args, drop `parent`.
    mergedTypeInfo.delegationPlanBuilder = memoize5of7(function (
      schema,
      sourceSubschema,
      variableValues,
      fragments,
      fieldNodes,
      context,
      info,
    ) {
      return mergedTypeInfo.nonMemoizedDelegationPlanBuilder(
        schema,
        sourceSubschema,
        variableValues,
        fragments,
        fieldNodes,
        context,
        info,
      );
    });
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

describe('classic stitching DPB memoize A/B', () => {
  const schemaNoMemo = buildSchema(true);
  const schemaMemo = buildSchema(true);
  installOldStyleDpbMemoize(schemaMemo);
  const schemaBackbone = buildSchema(false);

  bench(
    'classic merge list — no DPB memoize (current)',
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
    'classic merge list — old memoize5of7 (no parent)',
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
