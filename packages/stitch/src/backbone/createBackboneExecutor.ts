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
import {
  buildStitchPlan,
  coerceOperationVariables,
} from './buildStitchPlan.js';
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

function operationHasSkipOrIncludeFast(
  operation: import('graphql').OperationDefinitionNode,
): boolean {
  const stack = [...operation.selectionSet.selections];
  while (stack.length) {
    const sel = stack.pop()!;
    if (
      'directives' in sel &&
      sel.directives?.some(
        (d) => d.name.value === 'skip' || d.name.value === 'include',
      )
    ) {
      return true;
    }
    if (
      (sel.kind === Kind.FIELD || sel.kind === Kind.INLINE_FRAGMENT) &&
      sel.selectionSet
    ) {
      stack.push(...sel.selectionSet.selections);
    }
  }
  return false;
}

function stableStringify(value: Record<string, any>): string {
  const keys = Object.keys(value).sort();
  const sorted: Record<string, any> = {};
  for (const k of keys) {
    sorted[k] = value[k];
  }
  return JSON.stringify(sorted);
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
    const coerced = coerceOperationVariables(
      operation,
      request.variables ?? {},
    );
    // Include coerced variables in the cache key when @skip/@include are present
    // so directive evaluation stays consistent with the planned selection.
    const hasSkipInclude = operationHasSkipOrIncludeFast(operation);
    const cacheKey =
      (operation.name?.value ?? '') +
      (hasSkipInclude ? `::${stableStringify(coerced)}` : '');
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
        coerced,
        options,
      );
    } catch (err) {
      // Directive evaluation during planning can throw; fall back to schema.
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
    const operation = getOperationASTFromRequest(request) ?? plan.operation;
    const coerced = coerceOperationVariables(
      operation,
      request.variables ?? {},
    );
    const requestWithCoercedVars: ExecutionRequest = {
      ...request,
      variables: coerced,
    };

    // preferPlannedExecute: true  → always try planned (tests)
    // preferPlannedExecute: false → never planned (escape hatch)
    // undefined (gateway default) → planned when complete
    const prefer = options.preferPlannedExecute;
    const usePlanned =
      prefer === true ? true : prefer === false ? false : !plan.incomplete;

    if (!usePlanned) {
      return schemaExecutor(requestWithCoercedVars);
    }

    return handleMaybePromise(
      () => executeStitchPlan(schema, plan, requestWithCoercedVars),
      (result: ExecutionResult) => {
        const projected: ExecutionResult = {
          ...result,
          data: projectDataToOperation(
            schema,
            operation,
            plan.fragments,
            coerced,
            result.data as any,
          ) as any,
        };

        if (projected.errors?.length && fallbackToSchemaExecute) {
          return schemaExecutor(requestWithCoercedVars);
        }
        return projected;
      },
      (err) => {
        if (fallbackToSchemaExecute) {
          return schemaExecutor(requestWithCoercedVars);
        }
        throw err;
      },
    );
  };
}
