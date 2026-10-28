import {
  annotateExternalObject,
  createDefaultExecutor,
  mergeFields,
  OBJECT_SUBSCHEMA_SYMBOL,
  Subschema,
  type StitchingInfo,
} from '@graphql-tools/delegate';
// FIELD_SUBSCHEMA_MAP is set by annotateExternalObject; nested stubs from a
// Fetch often lack OBJECT_SUBSCHEMA_SYMBOL until we stamp the fetching subschema.
import { getFragmentsFromDocument } from '@graphql-tools/executor';
import {
  createGraphQLError,
  ExecutionRequest,
  ExecutionResult,
  Executor,
  getArgumentValues,
  getDefinedRootType,
  getOperationASTFromRequest,
  mergeDeep,
} from '@graphql-tools/utils';
import {
  handleMaybePromise,
  isPromise,
  type MaybePromise,
} from '@whatwg-node/promise-helpers';
import {
  FieldNode,
  GraphQLSchema,
  isObjectType,
  Kind,
  OperationTypeNode,
  SelectionNode,
  VariableDefinitionNode,
  visit,
} from 'graphql';
import type {
  BackboneExecutionContext,
  PathSegment,
  StitchPlan,
  StitchPlanNode,
} from './types.js';

function getSubschemaExecutor(subschema: Subschema): Executor {
  if (subschema.executor) {
    return subschema.executor;
  }
  return createDefaultExecutor(subschema.schema);
}

/** Annotate a root/entity payload so mergeFields can resolve follow-up hops. */
function annotateValue(
  value: any,
  errors: readonly any[],
  subschema: Subschema,
): any {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => annotateValue(item, errors, subschema));
  }
  return annotateExternalObject(value, errors as any[], subschema, {});
}

/**
 * Nested objects returned inside a Fetch (e.g. Review.product) often lack
 * OBJECT_SUBSCHEMA_SYMBOL. Stamp the fetching subschema so later entity hops
 * know the correct source when calling delegationPlanBuilder.
 */
function ensureAnnotatedTree(value: any, subschema: Subschema): void {
  if (value == null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      ensureAnnotatedTree(item, subschema);
    }
    return;
  }
  if ((value as any)[OBJECT_SUBSCHEMA_SYMBOL] == null) {
    annotateExternalObject(value, [], subschema, {});
  }
  for (const key of Object.keys(value)) {
    ensureAnnotatedTree(value[key], subschema);
  }
}

/**
 * Merge Parallel shared-root Fetch results into one object/list. Preserves
 * external-object symbols from the left-hand side when both sides are objects.
 */
function mergeRootValues(existing: any, incoming: any): any {
  if (existing == null) {
    return incoming;
  }
  if (incoming == null) {
    return existing;
  }
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    const len = Math.max(existing.length, incoming.length);
    const out: any[] = new Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = mergeRootValues(existing[i], incoming[i]);
    }
    return out;
  }
  if (
    typeof existing === 'object' &&
    typeof incoming === 'object' &&
    !Array.isArray(existing) &&
    !Array.isArray(incoming)
  ) {
    // mergeDeep copies enumerable props; re-apply annotation symbols from either side.
    const merged = mergeDeep([existing, incoming], undefined, true, true);
    const sourceSub =
      (existing as any)[OBJECT_SUBSCHEMA_SYMBOL] ??
      (incoming as any)[OBJECT_SUBSCHEMA_SYMBOL];
    if (sourceSub && merged && typeof merged === 'object') {
      return annotateExternalObject(merged, [], sourceSub, {});
    }
    return merged;
  }
  return incoming;
}

/** Drop @skip/@include — already evaluated at plan time. */
function stripSkipInclude(selection: SelectionNode): SelectionNode {
  if (selection.kind === Kind.FIELD) {
    const directives = selection.directives?.filter(
      (d) => d.name.value !== 'skip' && d.name.value !== 'include',
    );
    const selectionSet = selection.selectionSet
      ? {
          ...selection.selectionSet,
          selections: selection.selectionSet.selections.map(stripSkipInclude),
        }
      : undefined;
    return {
      ...selection,
      directives: directives?.length ? directives : undefined,
      selectionSet,
    };
  }
  if (selection.kind === Kind.INLINE_FRAGMENT) {
    const directives = selection.directives?.filter(
      (d) => d.name.value !== 'skip' && d.name.value !== 'include',
    );
    return {
      ...selection,
      directives: directives?.length ? directives : undefined,
      selectionSet: {
        ...selection.selectionSet,
        selections: selection.selectionSet.selections.map(stripSkipInclude),
      },
    };
  }
  return selection;
}

function collectUsedVariableNames(node: SelectionNode): Set<string> {
  const used = new Set<string>();
  visit(node, {
    Variable(v) {
      used.add(v.name.value);
    },
  });
  return used;
}

function filterVariableDefinitions(
  defs: readonly VariableDefinitionNode[] | undefined,
  used: Set<string>,
): VariableDefinitionNode[] | undefined {
  if (!defs?.length) {
    return undefined;
  }
  const filtered = defs.filter((d) => used.has(d.variable.name.value));
  return filtered.length ? filtered : undefined;
}

function buildRootDocument(
  operationName: string | undefined,
  operationType: OperationTypeNode,
  fieldNode: FieldNode,
  variableDefinitions: StitchPlan['operation']['variableDefinitions'],
  variableValues: Record<string, any>,
) {
  const cleaned = stripSkipInclude(fieldNode) as FieldNode;
  const usedVars = collectUsedVariableNames(cleaned);
  const filteredDefs = filterVariableDefinitions(variableDefinitions, usedVars);
  const filteredVars: Record<string, any> = {};
  for (const name of usedVars) {
    if (name in variableValues) {
      filteredVars[name] = variableValues[name];
    }
  }
  const op = {
    kind: Kind.OPERATION_DEFINITION as const,
    operation: operationType,
    name: operationName
      ? { kind: Kind.NAME as const, value: operationName }
      : undefined,
    variableDefinitions: filteredDefs,
    selectionSet: {
      kind: Kind.SELECTION_SET as const,
      selections: [cleaned],
    },
  };
  return {
    document: {
      kind: Kind.DOCUMENT as const,
      definitions: [op],
    },
    variables: filteredVars,
  };
}

function collectEntitiesAtPath(
  data: any,
  path: PathSegment[],
): Array<Record<string, any>> {
  let current: any[] = [data];
  for (const segment of path) {
    const next: any[] = [];
    for (const item of current) {
      if (item == null) {
        continue;
      }
      if (typeof segment === 'number') {
        if (Array.isArray(item)) {
          const el = item[segment];
          if (el != null) {
            next.push(el);
          }
        }
        continue;
      }
      const value = item[segment];
      if (Array.isArray(value)) {
        for (const el of value) {
          if (el != null && typeof el === 'object') {
            next.push(el);
          }
        }
      } else if (value != null && typeof value === 'object') {
        next.push(value);
      }
    }
    current = next;
  }
  return current;
}

function executeFetchNode(
  node: Extract<StitchPlanNode, { kind: 'Fetch' }>,
  ctx: BackboneExecutionContext,
): MaybePromise<void> {
  const executor = getSubschemaExecutor(node.subschema);

  if (node.rootField) {
    const { document, variables } = buildRootDocument(
      ctx.operation.name?.value,
      ctx.operation.operation,
      node.rootField,
      ctx.operation.variableDefinitions,
      ctx.variableValues,
    );
    const responseKey =
      node.rootField.alias?.value ?? node.rootField.name.value;
    return handleMaybePromise(
      () =>
        executor({
          document,
          variables,
          context: ctx.contextValue,
          rootValue: ctx.rootValue,
          operationType: ctx.operation.operation,
          operationName: ctx.operation.name?.value,
          signal: ctx.signal,
          subgraphName: node.subschema.name,
        } satisfies ExecutionRequest),
      (result: ExecutionResult) => {
        if (result.errors?.length) {
          ctx.errors.push(...result.errors);
        }
        if (result.data && responseKey in result.data) {
          const annotated = annotateValue(
            result.data[responseKey],
            result.errors ?? [],
            node.subschema,
          );
          if (responseKey in ctx.data) {
            ctx.data[responseKey] = mergeRootValues(
              ctx.data[responseKey],
              annotated,
            );
          } else {
            ctx.data[responseKey] = annotated;
          }
        }
      },
      (err) => {
        ctx.errors.push(
          createGraphQLError(err instanceof Error ? err.message : String(err), {
            originalError: err instanceof Error ? err : undefined,
            extensions: {
              code: 'DOWNSTREAM_SERVICE_ERROR',
              serviceName: node.subschema.name,
            },
          }),
        );
      },
    );
  }

  if (!node.entityTypeName || !node.flattenPath) {
    return;
  }

  const parents = collectEntitiesAtPath(ctx.data, node.flattenPath);
  if (!parents.length) {
    return;
  }

  const stitchingInfo = ctx.schema.extensions?.['stitchingInfo'] as
    | StitchingInfo
    | undefined;
  const mergedTypeInfo = stitchingInfo?.mergedTypes[node.entityTypeName];
  if (!mergedTypeInfo) {
    return;
  }

  const type = ctx.schema.getType(node.entityTypeName);
  if (!isObjectType(type)) {
    return;
  }

  // Execute the planned target directly (router-style Fetch), instead of
  // re-running delegationPlanBuilder which can mark the hop non-proxiable
  // based on source *schema* keys even when the parent object already has them.
  const resolver = mergedTypeInfo.resolvers.get(node.subschema);
  if (!resolver) {
    // Fall back to mergeFields when no explicit merge resolver is registered.
    const planningParentField: FieldNode = {
      kind: Kind.FIELD,
      name: { kind: Kind.NAME, value: node.entityTypeName },
      selectionSet: node.selectionSet,
    };
    const jobs: MaybePromise<any>[] = [];
    for (const parent of parents) {
      const sourceSubschema =
        ((parent as any)[OBJECT_SUBSCHEMA_SYMBOL] as Subschema | undefined) ??
        node.subschema;
      const info = {
        ...(ctx.infoStub as any),
        schema: ctx.schema,
        parentType: type,
        returnType: type,
        fieldName: node.entityTypeName,
        fieldNodes: [planningParentField],
        fragments: ctx.fragments,
        operation: ctx.operation,
        variableValues: ctx.variableValues,
        path: {
          typename: node.entityTypeName,
          key: node.flattenPath.at(-1),
          prev: undefined,
        },
      };
      jobs.push(
        mergeFields(
          mergedTypeInfo,
          parent,
          sourceSubschema,
          ctx.contextValue,
          info,
          [planningParentField],
        ),
      );
    }
    return handleMaybePromise(
      () =>
        Promise.all(jobs.map((j) => (isPromise(j) ? j : Promise.resolve(j)))),
      () => {
        for (const parent of parents) {
          ensureAnnotatedTree(parent, node.subschema);
        }
      },
    );
  }

  const info = {
    ...(ctx.infoStub as any),
    schema: ctx.schema,
    parentType: type,
    returnType: type,
    fieldName: node.entityTypeName,
    fieldNodes: [
      {
        kind: Kind.FIELD,
        name: { kind: Kind.NAME, value: node.entityTypeName },
        selectionSet: node.selectionSet,
      },
    ],
    fragments: ctx.fragments,
    operation: ctx.operation,
    variableValues: ctx.variableValues,
    path: {
      typename: node.entityTypeName,
      key: node.flattenPath.at(-1),
      prev: undefined,
    },
  };

  const jobs: MaybePromise<any>[] = parents.map((parent) =>
    handleMaybePromise(
      () =>
        resolver(
          parent,
          ctx.contextValue,
          info,
          node.subschema,
          node.selectionSet,
          undefined,
          type,
        ),
      (resolverResult) => {
        if (resolverResult == null || typeof resolverResult !== 'object') {
          return;
        }
        if (resolverResult instanceof Error) {
          ctx.errors.push(resolverResult);
          return;
        }
        const merged = mergeDeep(
          [parent, resolverResult],
          undefined,
          true,
          true,
        );
        // mutate parent in place so siblings sharing the tree see updates
        Object.assign(parent, merged);
        ensureAnnotatedTree(parent, node.subschema);
      },
    ),
  );

  return handleMaybePromise(
    () => Promise.all(jobs.map((j) => (isPromise(j) ? j : Promise.resolve(j)))),
    () => undefined,
  );
}

function executeIslandNode(
  node: Extract<StitchPlanNode, { kind: 'Island' }>,
  ctx: BackboneExecutionContext,
): MaybePromise<void> {
  const parentType = ctx.schema.getType(node.parentTypeName);
  if (!isObjectType(parentType)) {
    return;
  }
  const fieldName = node.fieldNode.name.value;
  const field = parentType.getFields()[fieldName];
  if (!field?.resolve) {
    return;
  }
  const responseKey = node.fieldNode.alias?.value ?? fieldName;
  const args = getArgumentValues(field, node.fieldNode, ctx.variableValues);
  const rootType = getDefinedRootType(ctx.schema, ctx.operation.operation);
  const info = {
    ...(ctx.infoStub as any),
    schema: ctx.schema,
    parentType: rootType,
    returnType: field.type,
    fieldName,
    fieldNodes: [node.fieldNode],
    fragments: ctx.fragments,
    operation: ctx.operation,
    variableValues: ctx.variableValues,
    path: { typename: rootType.name, key: responseKey, prev: undefined },
  };

  return handleMaybePromise(
    () => field.resolve!(ctx.rootValue, args, ctx.contextValue, info),
    (result) => {
      ctx.data[responseKey] = result;
      if (node.continue) {
        return executePlanNode(node.continue, ctx);
      }
    },
  );
}

function executePlanNode(
  node: StitchPlanNode,
  ctx: BackboneExecutionContext,
): MaybePromise<void> {
  switch (node.kind) {
    case 'Sequence': {
      let chain: MaybePromise<void> = undefined;
      for (const child of node.nodes) {
        chain = handleMaybePromise(
          () => chain,
          () => executePlanNode(child, ctx),
        );
      }
      return chain;
    }
    case 'Parallel': {
      // Shared-root Parallel: multiple root Fetches write the same responseKey.
      // Run them in isolated data bags then merge so concurrent writes don't race.
      const rootFetches = node.nodes.filter(
        (n): n is Extract<StitchPlanNode, { kind: 'Fetch' }> =>
          n.kind === 'Fetch' && Boolean(n.rootField),
      );
      const sameKey =
        rootFetches.length === node.nodes.length &&
        rootFetches.length > 1 &&
        rootFetches.every((n) => {
          const a = rootFetches[0]!.rootField!;
          const b = n.rootField!;
          const keyA = a.alias?.value ?? a.name.value;
          const keyB = b.alias?.value ?? b.name.value;
          return keyA === keyB;
        });
      if (sameKey) {
        const responseKey =
          rootFetches[0]!.rootField!.alias?.value ??
          rootFetches[0]!.rootField!.name.value;
        const jobs = rootFetches.map((child) => {
          const childCtx: BackboneExecutionContext = {
            ...ctx,
            data: {},
            errors: ctx.errors,
          };
          return handleMaybePromise(
            () => executeFetchNode(child, childCtx),
            () => childCtx.data[responseKey],
          );
        });
        return handleMaybePromise(
          () =>
            Promise.all(
              jobs.map((j) => (isPromise(j) ? j : Promise.resolve(j))),
            ),
          (parts: any[]) => {
            let merged: any = undefined;
            for (const part of parts) {
              merged = mergeRootValues(merged, part);
            }
            if (merged !== undefined) {
              ctx.data[responseKey] = merged;
            }
          },
        );
      }
      // Entity Fetches that share a flattenPath mutate the same parent objects
      // (e.g. Product.category from A and B). Run those sequentially so nested
      // merges don't race and drop fields.
      const entityFetches = node.nodes.filter(
        (n): n is Extract<StitchPlanNode, { kind: 'Fetch' }> =>
          n.kind === 'Fetch' && Boolean(n.entityTypeName),
      );
      const sharedEntityPath =
        entityFetches.length === node.nodes.length &&
        entityFetches.length > 1 &&
        entityFetches.every(
          (n) =>
            JSON.stringify(n.flattenPath) ===
            JSON.stringify(entityFetches[0]!.flattenPath),
        );
      if (sharedEntityPath) {
        let chain: ReturnType<typeof executePlanNode> = undefined;
        for (const child of node.nodes) {
          chain = handleMaybePromise(
            () => chain,
            () => executePlanNode(child, ctx),
          );
        }
        return chain;
      }
      const jobs = node.nodes.map((child) => executePlanNode(child, ctx));
      return handleMaybePromise(
        () =>
          Promise.all(
            jobs.map((j) => (isPromise(j) ? j : Promise.resolve(j))),
          ),
        () => undefined,
      );
    }
    case 'Fetch':
      return executeFetchNode(node, ctx);
    case 'Island':
      return executeIslandNode(node, ctx);
    default:
      return;
  }
}

export function executeStitchPlan(
  schema: GraphQLSchema,
  plan: StitchPlan,
  request: ExecutionRequest,
): MaybePromise<ExecutionResult> {
  const operation = getOperationASTFromRequest(request) ?? plan.operation;
  const fragments =
    Object.keys(plan.fragments).length > 0
      ? plan.fragments
      : getFragmentsFromDocument(request.document);

  const variableValues = request.variables ?? {};

  const ctx: BackboneExecutionContext = {
    schema,
    document: request.document,
    operation,
    fragments,
    variableValues,
    contextValue: request.context,
    rootValue: request.rootValue,
    signal: request.signal,
    data: {},
    errors: [],
    infoStub: {},
  };

  return handleMaybePromise(
    () => executePlanNode(plan.root, ctx),
    () => {
      const result: ExecutionResult = {};
      if (Object.keys(ctx.data).length) {
        result.data = ctx.data;
      }
      if (ctx.errors.length) {
        result.errors = ctx.errors as any;
      }
      return result;
    },
  );
}
