import type { Executor } from '@graphql-tools/utils';
import type { GraphQLSchema } from 'graphql';
import { createBackboneExecutor } from './createBackboneExecutor.js';
import type { BackboneExecutorOptions } from './types.js';

/** Schema extension key for the operation-level backbone executor. */
export const BACKBONE_EXECUTOR_EXTENSION = 'backboneExecutor';

/**
 * Install the stitching backbone on a schema:
 * - root Query/Mutation trampoline (stock `graphql-js` execute → backbone)
 * - `schema.extensions.backboneExecutor` for gateway / direct execute
 *
 * Call on the **final** schema after any `mapSchema` transforms (federation
 * filter, `@pubsubPublish` wraps). Safe to call again to rebind.
 */
export function attachBackboneExecutor(
  schema: GraphQLSchema,
  options: BackboneExecutorOptions = {},
): GraphQLSchema {
  const executor = createBackboneExecutor(schema, options);
  schema.extensions = {
    ...schema.extensions,
    [BACKBONE_EXECUTOR_EXTENSION]: executor,
  };
  return schema;
}

/** Read the backbone executor from schema extensions, if attached. */
export function getBackboneExecutor(
  schema: GraphQLSchema,
): Executor | undefined {
  return schema.extensions?.[BACKBONE_EXECUTOR_EXTENSION] as
    | Executor
    | undefined;
}
