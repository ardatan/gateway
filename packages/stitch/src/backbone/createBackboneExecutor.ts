import { createDefaultExecutor } from '@graphql-tools/delegate';
import { getFragmentsFromDocument } from '@graphql-tools/executor';
import {
  ExecutionRequest,
  Executor,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';
import { handleMaybePromise } from '@whatwg-node/promise-helpers';
import { GraphQLSchema, Kind } from 'graphql';
import { buildStitchPlan } from './buildStitchPlan.js';
import { executeStitchPlan } from './executeStitchPlan.js';
import type { BackboneExecutorOptions, StitchPlan } from './types.js';

function isIntrospectionOperation(request: ExecutionRequest): boolean {
  let found = false;
  const doc = request.document;
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) {
      continue;
    }
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) {
        continue;
      }
      if (sel.name.value === '__schema' || sel.name.value === '__type') {
        found = true;
        break;
      }
    }
  }
  return found;
}

/**
 * Operation-level stitching executor: plan once (cached per DocumentNode),
 * then run Fetch/Parallel/Sequence/Island nodes. Islands cover
 * additionalResolvers; incomplete plans can fall back to schema execute.
 */
export function createBackboneExecutor(
  schema: GraphQLSchema,
  options: BackboneExecutorOptions = {},
): Executor {
  const fallbackToSchemaExecute = options.fallbackToSchemaExecute !== false;
  const schemaExecutor = createDefaultExecutor(schema);
  const planCache = new WeakMap<
    ExecutionRequest['document'],
    Map<string | null, StitchPlan>
  >();

  function getCachedPlan(request: ExecutionRequest): StitchPlan {
    const operation = getOperationASTFromRequest(request);
    if (!operation) {
      return {
        operation: operation as any,
        fragments: {},
        root: { kind: 'Parallel', nodes: [] },
        incomplete: true,
        incompleteReasons: ['Missing operation'],
      };
    }
    const fragments = getFragmentsFromDocument(request.document);
    const cacheKey = operation.name?.value ?? null;
    let byName = planCache.get(request.document);
    if (byName) {
      const cached = byName.get(cacheKey);
      if (cached) {
        return cached;
      }
    } else {
      byName = new Map();
      planCache.set(request.document, byName);
    }
    const plan = buildStitchPlan(
      schema,
      operation,
      fragments,
      request.variables ?? {},
      options,
    );
    byName.set(cacheKey, plan);
    return plan;
  }

  return function stitchingBackboneExecutor(request: ExecutionRequest) {
    if (isIntrospectionOperation(request)) {
      return schemaExecutor(request);
    }

    const plan = getCachedPlan(request);
    if (plan.incomplete && fallbackToSchemaExecute) {
      return schemaExecutor(request);
    }

    return handleMaybePromise(
      () => executeStitchPlan(schema, plan, request),
      (result) => result,
      (err) => {
        if (fallbackToSchemaExecute) {
          return schemaExecutor(request);
        }
        throw err;
      },
    );
  };
}
