import { createDefaultExecutor } from '@graphql-tools/delegate';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { ExecutionResult } from '@graphql-tools/utils';
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { createBackboneExecutor } from '../src/backbone/index';
import { stitchSchemas } from '../src/stitchSchemas';

describe('backbone performance smoke', () => {
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
          email: `${id}@ex.com`,
        }),
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

  async function measure(label: string, run: () => Promise<unknown>) {
    // warmup
    for (let i = 0; i < 50; i++) await run();
    const n = 200;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await run();
    const ms = performance.now() - t0;
    return { label, hz: (n / ms) * 1000, meanMs: ms / n };
  }

  it('planned execute stays within 2x of schema execute on this microbench', async () => {
    const schemaExec = createDefaultExecutor(schema);
    const planned = createBackboneExecutor(schema);
    const request = {
      document,
      variables: { id: '1' },
      context: {},
    };

    const schemaStats = await measure('schema', () =>
      Promise.resolve(schemaExec(request)),
    );
    const plannedStats = await measure('planned', () =>
      Promise.resolve(planned(request)),
    );

    // Sanity: both return the same shape
    const a = (await schemaExec(request)) as ExecutionResult;
    const b = (await planned(request)) as ExecutionResult;
    expect(b.data).toEqual(a.data);

    // Planned path should not be dramatically slower than schema on this
    // workload (plan is cached). Allow 2x slack for CI noise.
    expect(plannedStats.meanMs).toBeLessThan(schemaStats.meanMs * 2 + 0.5);
  });
});
