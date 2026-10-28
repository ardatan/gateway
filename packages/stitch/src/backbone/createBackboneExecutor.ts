import { createDefaultExecutor } from '@graphql-tools/delegate';
import { getFragmentsFromDocument } from '@graphql-tools/executor';
import {
  ExecutionRequest,
  ExecutionResult,
  Executor,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';
import { handleMaybePromise } from '@whatwg-node/promise-helpers';
import { GraphQLSchema, Kind } from 'graphql';
import { buildStitchPlan } from './buildStitchPlan.js';
import { executeStitchPlan } from './executeStitchPlan.js';
import { projectDataToOperation } from './projectResult.js';
import type { BackboneExecutorOptions, StitchPlan } from './types.js';

function isIntrospectionOperation(request: ExecutionRequest): boolean {
  for (const def of request.document.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) {
      continue;
    }
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) {
        continue;
      }
      if (sel.name.value === '__schema' || sel.name.value === '__type') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Operation-level stitching executor.
 *
 * Always builds/caches an operation plan (warming delegation memoization).
 * When `preferPlannedExecute` is true (or omitted and the plan is complete),
 * runs Fetch/Parallel/Sequence/Island execution with client projection.
 * Otherwise uses GraphQL.js schema execute for full federation correctness.
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

    // Always build/warm the plan (memoize delegation builders).
    const plan = getCachedPlan(request);

    // Explicit false → never use planned execute (gateway default until audit
    // parity). Explicit true → always try planned. Undefined → planned only
    // when the plan is complete.
    const prefer = options.preferPlannedExecute;
    const usePlanned =
      prefer === true
        ? true
        : prefer === false
          ? false
          : !plan.incomplete;

    if (!usePlanned) {
      return schemaExecutor(request);
    }

    return handleMaybePromise(
      () => executeStitchPlan(schema, plan, request),
      (result: ExecutionResult) => {
        const operation = getOperationASTFromRequest(request) ?? plan.operation;
        const projected: ExecutionResult = {
          ...result,
          data: projectDataToOperation(
            schema,
            operation,
            plan.fragments,
            request.variables ?? {},
            result.data as any,
          ) as any,
        };

        if (projected.errors?.length && fallbackToSchemaExecute) {
          return schemaExecutor(request);
        }
        return projected;
      },
      (err) => {
        if (fallbackToSchemaExecute) {
          return schemaExecutor(request);
        }
        throw err;
      },
    );
  };
}
