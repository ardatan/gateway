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
 * Stitching backbone executor.
 *
 * Every request:
 * 1. Builds (or reuses a cached) operation-level plan — this warms
 *    delegation-plan memoization even when we later fall back.
 * 2. If the plan is complete → execute Fetch/Parallel/Sequence/Island and
 *    project to the client selection.
 * 3. If incomplete (abstracts, @skip/@include until Condition nodes exist,
 *    hooks, subscriptions, …) → GraphQL.js schema execute on the stitched
 *    schema (same correctness as classic stitching).
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
    let plan: StitchPlan;
    try {
      plan = buildStitchPlan(
        schema,
        operation,
        fragments,
        request.variables ?? {},
        options,
      );
    } catch (err) {
      // Directive evaluation during planning can throw (e.g. @include with an
      // omitted defaulted variable). Treat as incomplete → schema execute.
      plan = {
        operation,
        fragments,
        root: { kind: 'Parallel', nodes: [] },
        incomplete: true,
        incompleteReasons: [
          err instanceof Error ? err.message : 'Plan build failed',
        ],
      };
    }
    byName.set(cacheKey, plan);
    return plan;
  }

  return function stitchingBackboneExecutor(request: ExecutionRequest) {
    if (isIntrospectionOperation(request)) {
      return schemaExecutor(request);
    }

    const plan = getCachedPlan(request);

    // preferPlannedExecute: true  → always try planned (tests)
    // preferPlannedExecute: false → never planned (escape hatch)
    // undefined (gateway default) → planned when complete
    const prefer = options.preferPlannedExecute;
    const usePlanned =
      prefer === true ? true : prefer === false ? false : !plan.incomplete;

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
