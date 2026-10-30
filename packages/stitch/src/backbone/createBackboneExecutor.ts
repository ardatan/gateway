import { createDefaultExecutor } from '@graphql-tools/delegate';
import { getFragmentsFromDocument } from '@graphql-tools/executor';
import {
  createGraphQLError,
  ExecutionRequest,
  ExecutionResult,
  Executor,
  getOperationASTFromRequest,
  isAsyncIterable,
} from '@graphql-tools/utils';
import { handleMaybePromise } from '@whatwg-node/promise-helpers';
import { GraphQLSchema, Kind, OperationDefinitionNode } from 'graphql';
import {
  buildStitchPlan,
  coerceOperationVariables,
} from './buildStitchPlan.js';
import { executeStitchPlan } from './executeStitchPlan.js';
import { projectDataToOperation } from './projectResult.js';
import { installRootTrampoline } from './rootTrampoline.js';
import type { BackboneExecutorOptions, StitchPlan } from './types.js';

/** Full SDL introspection — schema execute (Hive also special-cases these). */
function isSchemaIntrospectionOperation(request: ExecutionRequest): boolean {
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
 * Query that only asks for `__typename` (and aliases) — no subgraph owns the
 * meta-field; Hive routes these to schema execute.
 */
function isOnlyTypenameQuery(operation: OperationDefinitionNode): boolean {
  if (operation.operation !== 'query') {
    return false;
  }
  const stack = [...operation.selectionSet.selections];
  let sawField = false;
  while (stack.length) {
    const sel = stack.pop()!;
    if (sel.kind === Kind.FIELD) {
      sawField = true;
      if (sel.name.value !== '__typename') {
        return false;
      }
      continue;
    }
    if (
      (sel.kind === Kind.INLINE_FRAGMENT ||
        sel.kind === Kind.FRAGMENT_SPREAD) &&
      'selectionSet' in sel &&
      sel.selectionSet
    ) {
      stack.push(...sel.selectionSet.selections);
    }
  }
  return sawField;
}

function documentHasDeferOrStream(request: ExecutionRequest): boolean {
  for (const def of request.document.definitions) {
    if (
      def.kind !== Kind.OPERATION_DEFINITION &&
      def.kind !== Kind.FRAGMENT_DEFINITION
    ) {
      continue;
    }
    const stack = [...def.selectionSet.selections];
    while (stack.length) {
      const sel = stack.pop()!;
      if (
        'directives' in sel &&
        sel.directives?.some(
          (d) => d.name.value === 'defer' || d.name.value === 'stream',
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
  }
  return false;
}

function operationHasSkipOrIncludeFast(
  operation: OperationDefinitionNode,
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
 * Stitching backbone executor — plan once (cached) and run Fetch/Parallel/
 * Sequence/Island/Condition. Subscriptions, SDL introspection, `{ __typename }`,
 * and @defer/@stream still use schema execute (classic subscribe / incremental)
 * until those are planned end-to-end.
 */
export function createBackboneExecutor(
  schema: GraphQLSchema,
  options: BackboneExecutorOptions = {},
): Executor {
  const schemaExecutor = createDefaultExecutor(schema);
  const planCache = new WeakMap<
    ExecutionRequest['document'],
    Map<string | null, StitchPlan>
  >();

  // graphql-js execute on this schema → same backbone (Query/Mutation roots).
  if (options.installRootTrampoline !== false) {
    installRootTrampoline(schema, (request) =>
      stitchingBackboneExecutor(request),
    );
  }

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
    // Condition nodes → one plan per document. Legacy peel still keys by vars.
    const hasSkipInclude = operationHasSkipOrIncludeFast(operation);
    // Default on (Hive-style). Opt out with `useConditionNodes: false`.
    const useConditionPlans = options.useConditionNodes !== false;
    const cacheKey =
      (operation.name?.value ?? '') +
      (useConditionPlans
        ? ''
        : hasSkipInclude
          ? `::${stableStringify(coerced)}`
          : '');
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
      plan = buildStitchPlan(schema, operation, fragments, coerced, options);
    } catch (err) {
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

  function stitchingBackboneExecutor(request: ExecutionRequest) {
    const operation = getOperationASTFromRequest(request);

    // Schema-execute paths (not yet planned end-to-end on the backbone).
    if (
      isSchemaIntrospectionOperation(request) ||
      (operation && isOnlyTypenameQuery(operation)) ||
      (operation && operation.operation === 'subscription') ||
      documentHasDeferOrStream(request)
    ) {
      return schemaExecutor(request);
    }

    const plan = getCachedPlan(request);
    const op = operation ?? plan.operation;
    const coerced = coerceOperationVariables(op, request.variables ?? {});
    const requestWithCoercedVars: ExecutionRequest = {
      ...request,
      variables: coerced,
    };

    if (plan.incomplete) {
      return {
        data: null,
        errors: [
          createGraphQLError(
            `Incomplete stitch plan: ${plan.incompleteReasons.join('; ') || 'unknown'}`,
            { extensions: { code: 'INCOMPLETE_STITCH_PLAN' } },
          ),
        ],
      };
    }

    return handleMaybePromise(
      () => executeStitchPlan(schema, plan, requestWithCoercedVars),
      (result: ExecutionResult) => {
        if (isAsyncIterable(result)) {
          return result;
        }
        const projected: ExecutionResult = {
          ...result,
          data: projectDataToOperation(
            schema,
            op,
            plan.fragments,
            coerced,
            result.data as any,
          ) as any,
        };
        return projected;
      },
    );
  }

  return stitchingBackboneExecutor;
}
