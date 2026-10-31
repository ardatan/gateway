import { createDefaultExecutor } from '@graphql-tools/delegate';
import type { StitchingInfo } from '@graphql-tools/delegate';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { ExecutionResult } from '@graphql-tools/utils';
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildStitchPlan, createBackboneExecutor } from '../src/backbone/index';
import { stitchSchemas } from '../src/stitchSchemas';

async function exec(
  executor: ReturnType<typeof createBackboneExecutor>,
  request: Parameters<typeof executor>[0],
): Promise<ExecutionResult> {
  return (await executor(request)) as ExecutionResult;
}

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
    const result = await exec(executor, {
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
    const planSkip = buildStitchPlan(
      schema,
      operation,
      {},
      {
        id: '1',
        skipEmail: true,
      },
    );
    const planInclude = buildStitchPlan(
      schema,
      operation,
      {},
      {
        id: '1',
        skipEmail: false,
      },
    );
    expect(planSkip.incompleteReasons).toEqual([]);
    expect(planSkip.root.kind).toBe('Condition');
    expect((planSkip.root as any).condition).toBe('skipEmail');
    expect((planSkip.root as any).elseClause).toBeTruthy();
    expect((planSkip.root as any).ifClause).toBeUndefined();
    // Same structure regardless of variable map (one cached plan shape).
    expect(planInclude.root.kind).toBe('Condition');

    const executor = createBackboneExecutor(schema);
    const skipped = await exec(executor, {
      document,
      variables: { id: '1', skipEmail: true },
      context: {},
    });
    expect(skipped.errors).toBeUndefined();
    expect(skipped.data).toEqual({});

    const included = await exec(executor, {
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
    const result = await exec(executor, {
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
    const result = await exec(executor, { document, context: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ __typename: 'Query' });
  });

  it('plans nested additionalResolvers as Island under a Fetch path', async () => {
    const books = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Book {
          id: ID!
          title: String
          authorId: ID!
        }
        type Query {
          books: [Book]
        }
      `,
      resolvers: {
        Query: {
          books: () => [
            { id: 'b1', title: 'Dune', authorId: 'a1' },
            { id: 'b2', title: 'Neuromancer', authorId: 'a2' },
          ],
        },
      },
    });
    const authors = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Author {
          id: ID!
          name: String
        }
        type Query {
          authors(ids: [ID!]!): [Author]!
        }
      `,
      resolvers: {
        Query: {
          authors: (_: unknown, { ids }: { ids: string[] }) =>
            ids.map((id) => ({ id, name: `Author ${id}` })),
        },
      },
    });
    const schema = stitchSchemas({
      subschemas: [
        {
          schema: books,
          executor: createDefaultExecutor(books),
        },
        {
          schema: authors,
          executor: createDefaultExecutor(authors),
          merge: {
            Author: {
              fieldName: 'authors',
              selectionSet: '{ id }',
              key: ({ id }: { id: string }) => id,
              argsFromKeys: (ids: readonly string[]) => ({ ids }),
            },
          },
          batch: true,
        },
      ],
      typeDefs: /* GraphQL */ `
        extend type Book {
          author: Author
        }
      `,
      resolvers: {
        Book: {
          author: {
            selectionSet: '{ authorId }',
            resolve: (book: { authorId: string }) => ({ id: book.authorId }),
          },
        },
      },
    });

    const stitchingInfo = schema.extensions?.['stitchingInfo'] as StitchingInfo;
    expect(stitchingInfo.localFields.get('Book')?.has('author')).toBe(true);

    const document = parse(/* GraphQL */ `
      {
        books {
          title
          author {
            id
            name
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
    expect(plan.incompleteReasons).toEqual([]);

    const hasNestedAuthorIsland = (n: any): boolean => {
      if (!n) return false;
      if (
        n.kind === 'Island' &&
        n.parentTypeName === 'Book' &&
        n.fieldNode?.name?.value === 'author' &&
        Array.isArray(n.flattenPath)
      ) {
        return true;
      }
      if (n.nodes) return n.nodes.some(hasNestedAuthorIsland);
      if (n.continue) return hasNestedAuthorIsland(n.continue);
      if (n.ifClause || n.elseClause) {
        return (
          hasNestedAuthorIsland(n.ifClause) ||
          hasNestedAuthorIsland(n.elseClause)
        );
      }
      return false;
    };
    expect(hasNestedAuthorIsland(plan.root)).toBe(true);

    const executor = createBackboneExecutor(schema);
    const result = await exec(executor, { document, context: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      books: [
        { title: 'Dune', author: { id: 'a1', name: 'Author a1' } },
        { title: 'Neuromancer', author: { id: 'a2', name: 'Author a2' } },
      ],
    });
  });
});
