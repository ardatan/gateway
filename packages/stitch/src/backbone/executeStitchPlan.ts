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
  isInterfaceType,
  isNullableType,
  isObjectType,
  Kind,
  OperationTypeNode,
  SelectionNode,
  SelectionSetNode,
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

/**
 * Deep-annotate a root Fetch payload once so nested objects carry
 * OBJECT_SUBSCHEMA_SYMBOL for later entity hops.
 */
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
  const annotated = annotateExternalObject(
    value,
    errors as any[],
    subschema,
    {},
  );
  for (const key of Object.keys(annotated)) {
    const child = annotated[key];
    if (child != null && typeof child === 'object') {
      annotated[key] = annotateValue(child, [], subschema);
    }
  }
  return annotated;
}

/** Stamp subschema on one object without recursing. */
function stampSubschema(object: Record<string, any>, subschema: Subschema): void {
  if ((object as any)[OBJECT_SUBSCHEMA_SYMBOL] == null) {
    annotateExternalObject(object, [], subschema, {});
  } else {
    (object as any)[OBJECT_SUBSCHEMA_SYMBOL] = subschema;
  }
}

/**
 * Prefer concrete object __typename over @interfaceObject interface names.
 */
function resolveMergedTypename(
  priorTypename: string | undefined,
  resultTypename: string | undefined,
  schema: GraphQLSchema,
): string | undefined {
  if (!resultTypename) {
    return priorTypename;
  }
  if (!priorTypename || priorTypename === resultTypename) {
    return resultTypename;
  }
  const priorType = schema.getType(priorTypename);
  const resultType = schema.getType(resultTypename);
  if (isObjectType(priorType) && isInterfaceType(resultType)) {
    return priorTypename;
  }
  if (isInterfaceType(priorType) && isObjectType(resultType)) {
    return resultTypename;
  }
  return resultTypename;
}

/**
 * In-place merge of entity hop fields into an existing parent. Only walks
 * keys from `source` (unlike mergeDeep over the full parent tree). Nested
 * objects keep prior-hop siblings; fresh subgraph payloads are annotated.
 */
function mergeInto(
  target: any,
  source: any,
  schema: GraphQLSchema,
  subschema: Subschema,
): any {
  if (source === undefined) {
    return target;
  }
  if (source == null || typeof source !== 'object') {
    return source;
  }
  if (Array.isArray(source)) {
    if (Array.isArray(target) && target.length === source.length) {
      for (let i = 0; i < source.length; i++) {
        target[i] = mergeInto(target[i], source[i], schema, subschema);
      }
      return target;
    }
    return annotateValue(source, [], subschema);
  }
  if (target == null || typeof target !== 'object' || Array.isArray(target)) {
    return annotateValue(source, [], subschema);
  }

  const priorTypename = target['__typename'] as string | undefined;
  for (const key of Object.keys(source)) {
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      key === '__typename'
    ) {
      continue;
    }
    const incoming = source[key];
    if (
      Object.prototype.hasOwnProperty.call(target, key) &&
      incoming !== undefined
    ) {
      target[key] = mergeInto(target[key], incoming, schema, subschema);
    } else if (incoming != null && typeof incoming === 'object') {
      target[key] = annotateValue(incoming, [], subschema);
    } else {
      target[key] = incoming;
    }
  }
  target['__typename'] = resolveMergedTypename(
    priorTypename,
    source['__typename'] as string | undefined,
    schema,
  );
  stampSubschema(target, subschema);
  return target;
}

/**
 * Light entity merge: deep-merge only hop fields onto the parent in place.
 */
function mergeEntityIntoParent(
  parent: Record<string, any>,
  resolverResult: Record<string, any>,
  schema: GraphQLSchema,
  subschema: Subschema,
): void {
  mergeInto(parent, resolverResult, schema, subschema);
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

/**
 * When sibling inline fragments select the same field with conflicting
 * nullability (User.id: ID! vs Admin.id: ID), rewrite with `_nullable_` /
 * `_nonNullable_` aliases — same as finalizeGatewayRequest.
 */
function rewriteNullabilityConflicts(
  selectionSet: SelectionSetNode,
  schema: GraphQLSchema,
): SelectionSetNode {
  const seenNonNullable = new Set<string>();
  const seenNullable = new Set<string>();
  const selections = selectionSet.selections.map((sel) => {
    if (sel.kind !== Kind.INLINE_FRAGMENT || !sel.typeCondition) {
      if (sel.kind === Kind.FIELD && sel.selectionSet) {
        return {
          ...sel,
          selectionSet: rewriteNullabilityConflicts(sel.selectionSet, schema),
        };
      }
      return sel;
    }
    const type = schema.getType(sel.typeCondition.name.value);
    if (!type || !('getFields' in type) || !sel.selectionSet) {
      return sel;
    }
    const fields = (type as import('graphql').GraphQLObjectType).getFields();
    const nextSels = sel.selectionSet.selections.map((sub) => {
      if (sub.kind !== Kind.FIELD || sub.alias) {
        if (sub.kind === Kind.FIELD && sub.selectionSet) {
          return {
            ...sub,
            selectionSet: rewriteNullabilityConflicts(sub.selectionSet, schema),
          };
        }
        return sub;
      }
      const field = fields[sub.name.value];
      if (!field) {
        return sub;
      }
      const nullable = isNullableType(field.type);
      if (nullable) {
        seenNullable.add(sub.name.value);
      } else {
        seenNonNullable.add(sub.name.value);
      }
      if (
        seenNullable.has(sub.name.value) &&
        seenNonNullable.has(sub.name.value)
      ) {
        return {
          ...sub,
          alias: {
            kind: Kind.NAME as const,
            value: nullable
              ? `_nullable_${sub.name.value}`
              : `_nonNullable_${sub.name.value}`,
          },
          selectionSet: sub.selectionSet
            ? rewriteNullabilityConflicts(sub.selectionSet, schema)
            : undefined,
        };
      }
      return sub.selectionSet
        ? {
            ...sub,
            selectionSet: rewriteNullabilityConflicts(sub.selectionSet, schema),
          }
        : sub;
    });
    return {
      ...sel,
      selectionSet: { ...sel.selectionSet, selections: nextSels },
    };
  });
  return { ...selectionSet, selections };
}

/** Map `_nullable_id` / `_nonNullable_id` response keys back to `id`. */
function unwrapNullabilityAliases(value: any): any {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(unwrapNullabilityAliases);
  }
  const out: Record<string, any> = {};
  for (const [key, v] of Object.entries(value)) {
    const unwrapped = key.startsWith('_nullable_')
      ? key.slice('_nullable_'.length)
      : key.startsWith('_nonNullable_')
        ? key.slice('_nonNullable_'.length)
        : key;
    out[unwrapped] = unwrapNullabilityAliases(v);
  }
  return out;
}

function buildRootDocument(
  operationName: string | undefined,
  operationType: OperationTypeNode,
  fieldNode: FieldNode,
  variableDefinitions: StitchPlan['operation']['variableDefinitions'],
  variableValues: Record<string, any>,
  targetSchema?: GraphQLSchema,
) {
  let cleaned = stripSkipInclude(fieldNode) as FieldNode;
  if (targetSchema && cleaned.selectionSet) {
    cleaned = {
      ...cleaned,
      selectionSet: rewriteNullabilityConflicts(
        cleaned.selectionSet,
        targetSchema,
      ),
    };
  }
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
      node.subschema.schema,
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
        } satisfies ExecutionRequest) as MaybePromise<ExecutionResult>,
      (result: ExecutionResult) => {
        if (result.errors?.length) {
          ctx.errors.push(...result.errors);
        }
        if (result.data && responseKey in result.data) {
          const annotated = annotateValue(
            unwrapNullabilityAliases(result.data[responseKey]),
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

  const flattenPaths =
    node.flattenPaths ??
    (node.flattenPath != null ? [node.flattenPath] : null);
  if (!node.entityTypeName || !flattenPaths?.length) {
    return;
  }

  // Cast/Flatten: hydrate parents matching this entity type, including
  // concrete implementers of an @interfaceObject interface (User → NodeWithName).
  const entityType = ctx.schema.getType(node.entityTypeName);
  const matchParent = (p: Record<string, any>) => {
    if (p == null) {
      return false;
    }
    if (p['__typename'] === node.entityTypeName) {
      return true;
    }
    // Typeless parents: only valid for @interfaceObject interface hops.
    // Concrete Cast (Cat vs Dog) must not claim every typeless list item.
    if (p['__typename'] == null) {
      return isInterfaceType(entityType);
    }
    if (!isInterfaceType(entityType)) {
      return false;
    }
    const runtime = ctx.schema.getType(p['__typename']);
    return (
      isObjectType(runtime) &&
      runtime.getInterfaces().some((i) => i.name === node.entityTypeName)
    );
  };
  const parents: Array<Record<string, any>> = [];
  const seen = new Set<Record<string, any>>();
  for (const path of flattenPaths) {
    for (const p of collectEntitiesAtPath(ctx.data, path)) {
      if (matchParent(p) && !seen.has(p)) {
        seen.add(p);
        parents.push(p);
      }
    }
  }
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
  // Object types and @interfaceObject interfaces both carry merge resolvers.
  if (!isObjectType(type) && !isInterfaceType(type)) {
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
          key: flattenPaths[0]!.at(-1),
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
          stampSubschema(parent, node.subschema);
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
      key: flattenPaths[0]!.at(-1),
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
          type as any,
        ),
      (resolverResult) => {
        if (resolverResult == null || typeof resolverResult !== 'object') {
          return;
        }
        if (resolverResult instanceof Error) {
          ctx.errors.push(resolverResult);
          return;
        }
        // mutate parent in place so siblings sharing the tree see updates
        mergeEntityIntoParent(
          parent,
          resolverResult as Record<string, any>,
          ctx.schema,
          node.subschema,
        );
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
        // Isolate per-fetch errors: provides / union intersection often hit a
        // subgraph that intentionally errors while another returns the data.
        const jobs = rootFetches.map((child) => {
          const childErrors: any[] = [];
          const childCtx: BackboneExecutionContext = {
            ...ctx,
            data: {},
            errors: childErrors,
          };
          return handleMaybePromise(
            () => executeFetchNode(child, childCtx),
            () => ({
              data: childCtx.data[responseKey],
              errors: childErrors,
            }),
          );
        });
        return handleMaybePromise(
          () =>
            Promise.all(
              jobs.map((j) => (isPromise(j) ? j : Promise.resolve(j))),
            ),
          (parts: Array<{ data: any; errors: any[] }>) => {
            let merged: any = undefined;
            let anyData = false;
            for (const part of parts) {
              if (part.data !== undefined) {
                anyData = true;
                merged = mergeRootValues(merged, part.data);
              }
            }
            if (merged !== undefined) {
              ctx.data[responseKey] = merged;
            }
            // Promote sibling errors only when every fetch failed to return data.
            if (!anyData) {
              for (const part of parts) {
                ctx.errors.push(...part.errors);
              }
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
