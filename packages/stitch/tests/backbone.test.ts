import { createDefaultExecutor } from '@graphql-tools/delegate';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  buildStitchPlan,
  collectLocalFieldsFromResolvers,
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
    expect(plan.root.kind === 'Sequence' || plan.root.kind === 'Fetch').toBe(
      true,
    );
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
    expect(result.data).toMatchObject({
      userById: {
        id: '1',
        email: '1@example.com',
        chirps: [{ id: 'c-1', text: 'hello' }],
      },
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

    const localFields = collectLocalFieldsFromResolvers({
      Query: { me: () => ({ id: '42' }) },
    });
    expect(localFields.get('Query')?.has('me')).toBe(true);

    const executor = createBackboneExecutor(schema, { localFields });
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
    expect(result.data).toMatchObject({
      me: { id: '42', email: '42@example.com' },
    });
  });
});
