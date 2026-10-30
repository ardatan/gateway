import { createDefaultExecutor } from '@graphql-tools/delegate';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { StitchingInfo } from '@graphql-tools/delegate';
import {
  buildStitchPlan,
  createBackboneExecutor,
} from '../src/backbone/index';
import { stitchSchemas } from '../src/stitchSchemas';

describe('stitching backbone', () => {
  const authors = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type User {
        id: ID!
        email: String
      }
      type Query {
        userById(id: ID!): User
      }
    `,
    resolvers: {
      Query: {
        userById: (_: unknown, { id }: { id: string }) => ({
          id,
          email: `${id}@example.com`,
        }),
      },
    },
  });

  const chirps = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Chirp {
        id: ID!
        text: String
        author: User
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
        chirps: (user: { id: string }) => [
          { id: `c-${user.id}`, text: 'hello', author: { id: user.id } },
        ],
      },
      Chirp: {
        author: (chirp: { author: { id: string } }) => chirp.author,
      },
    },
  });

  function createStitched() {
    return stitchSchemas({
      subschemas: [
        {
          schema: chirps,
          executor: createDefaultExecutor(chirps),
          merge: {
            User: {
              fieldName: 'userById',
              args: (originalResult: { id: string }) => ({
                id: originalResult.id,
              }),
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
              args: (originalResult: { id: string }) => ({
                id: originalResult.id,
              }),
              selectionSet: '{ id }',
            },
          },
          batch: true,
        },
      ],
    });
  }

  it('builds a complete plan for a merged type query', () => {
    const schema = createStitched();
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
    const operation = document.definitions[0] as any;
    const plan = buildStitchPlan(schema, operation, {}, { id: '1' });
    expect(plan.incompleteReasons).toEqual([]);
    // Shared root `userById` on both subschemas → Parallel root Fetches, or a
    // Sequence of root + entity when only one owner is chosen first.
    expect(
      plan.root.kind === 'Sequence' ||
        plan.root.kind === 'Fetch' ||
        plan.root.kind === 'Parallel',
    ).toBe(true);
  });

  it('executes a merged query via the backbone executor', async () => {
    const schema = createStitched();
    const executor = createBackboneExecutor(schema);
    const result = await executor({
      document: parse(/* GraphQL */ `
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
      `),
      variables: { id: '1' },
      context: {},
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      userById: {
        id: '1',
        email: '1@example.com',
        chirps: [{ id: 'c-1', text: 'hello' }],
      },
    });
  });

  it('emits Condition nodes for root @skip/@include and shares one plan', async () => {
    const schema = createStitched();
    const document = parse(/* GraphQL */ `
      query ($id: ID!, $skipEmail: Boolean!) {
        userById(id: $id) @skip(if: $skipEmail) {
          id
          email
        }
      }
    `);
    const operation = document.definitions[0] as any;
    const planSkip = buildStitchPlan(schema, operation, {}, {
      id: '1',
      skipEmail: true,
    });
    const planInclude = buildStitchPlan(schema, operation, {}, {
      id: '1',
      skipEmail: false,
    });
    expect(planSkip.incompleteReasons).toEqual([]);
    expect(planSkip.root.kind).toBe('Condition');
    expect((planSkip.root as any).condition).toBe('skipEmail');
    expect((planSkip.root as any).elseClause).toBeTruthy();
    expect((planSkip.root as any).ifClause).toBeUndefined();
    // Same structure regardless of variable map (one cached plan shape).
    expect(planInclude.root.kind).toBe('Condition');

    const executor = createBackboneExecutor(schema);
    const skipped = await executor({
      document,
      variables: { id: '1', skipEmail: true },
      context: {},
    });
    expect(skipped.errors).toBeUndefined();
    expect(skipped.data).toEqual({});

    const included = await executor({
      document,
      variables: { id: '1', skipEmail: false },
      context: {},
    });
    expect(included.errors).toBeUndefined();
    expect(included.data).toEqual({
      userById: { id: '1', email: '1@example.com' },
    });
  });

  it('marks additionalResolvers as islands and still hydrates merge keys', async () => {
    const schema = stitchSchemas({
      subschemas: [
        {
          schema: authors,
          executor: createDefaultExecutor(authors),
          merge: {
            User: {
              fieldName: 'userById',
              args: (originalResult: { id: string }) => ({
                id: originalResult.id,
              }),
              selectionSet: '{ id }',
            },
          },
          batch: true,
        },
      ],
      typeDefs: /* GraphQL */ `
        extend type Query {
          me: User
        }
      `,
      resolvers: {
        Query: {
          me: () => ({ id: '42' }),
        },
      },
    });

    const stitchingInfo = schema.extensions?.['stitchingInfo'] as StitchingInfo;
    expect(stitchingInfo.localFields.get('Query')?.has('me')).toBe(true);

    const executor = createBackboneExecutor(schema);
    const result = await executor({
      document: parse(/* GraphQL */ `
        {
          me {
            id
            email
          }
        }
      `),
      context: {},
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      me: { id: '42', email: '42@example.com' },
    });
  });

  it('plans pure __typename as Island (no schema-execute escape)', async () => {
    const schema = createStitched();
    const document = parse(/* GraphQL */ `
      {
        __typename
      }
    `);
    const plan = buildStitchPlan(
      schema,
      document.definitions[0] as any,
      {},
      {},
    );
    expect(plan.incompleteReasons).toEqual([]);
    expect(plan.root.kind).toBe('Island');
    expect((plan.root as any).fieldNode.name.value).toBe('__typename');

    const executor = createBackboneExecutor(schema);
    const result = await executor({ document, context: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ __typename: 'Query' });
  });
});
