import {
  createDefaultExecutor,
  delegateToSchema,
  FIELD_SUBSCHEMA_MAP_SYMBOL,
  mergeFields,
  OBJECT_SUBSCHEMA_SYMBOL,
  Subschema,
  UNPATHED_ERRORS_SYMBOL,
  type StitchingInfo,
} from '@graphql-tools/delegate';
// Annotation uses Symbol keys (JSON-invisible) via direct assign — cheaper than
// annotateExternalObject's Object.defineProperties on large entity lists.
import { getFragmentsFromDocument } from '@graphql-tools/executor';
import {
  createGraphQLError,
  ExecutionRequest,
  ExecutionResult,
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
  GraphQLList,
  GraphQLOutputType,
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
import { BACKBONE_EXECUTING } from './rootTrampoline.js';
import type {
  BackboneExecutionContext,
  PathSegment,
  StitchPlan,
  StitchPlanNode,
} from './types.js';

/**
 * Subgraph executor as configured on the Subschema. Gateway/fusion already
 * wraps with getBatchingExecutor when `batch` is enabled — do not re-wrap.
 */
function getSubschemaExecutor(subschema: Subschema) {
  return subschema.executor ?? createDefaultExecutor(subschema.schema);
}

/**
 * Hive Parallel pattern: only real promises enter `Promise.all`. Sync
 * completions stay sync — never `Promise.resolve` every job (extra microtasks).
 */
function awaitMaybePromises(
  jobs: ReadonlyArray<MaybePromise<unknown>>,
): MaybePromise<void> {
  const promises: PromiseLike<unknown>[] = [];
  for (const job of jobs) {
    if (isPromise(job)) {
      promises.push(job);
    }
  }
  if (promises.length === 0) {
    return;
  }
  if (promises.length === 1) {
    return promises[0] as PromiseLike<void>;
  }
  return Promise.all(promises) as PromiseLike<void>;
}

/**
 * Like `awaitMaybePromises` but preserves per-job values. Sync slots are kept
 * as-is; only promise slots are awaited and filled back by index.
 */
function allMaybePromises<T>(
  jobs: ReadonlyArray<MaybePromise<T>>,
): MaybePromise<T[]> {
  const results: T[] = new Array(jobs.length);
  const promises: PromiseLike<T>[] = [];
  const indices: number[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    if (isPromise(job)) {
      promises.push(job);
      indices.push(i);
    } else {
      results[i] = job as T;
    }
  }
  if (promises.length === 0) {
    return results;
  }
  return Promise.all(promises).then((resolved) => {
    for (let k = 0; k < resolved.length; k++) {
      results[indices[k]!] = resolved[k]!;
    }
    return results;
  });
}

/**
 * Computed-field isolation installs TransformCompositeFields that strip
 * sibling fields (inStock vs shippingEstimate) onto separate Subschema clones.
 * When a backbone Fetch unions fields from both clones, drop the strip
 * transforms so the shared executor receives the full selection while keeping
 * merge.fields for @requires. Leave transforms intact for single-clone hops
 * (requires-circular / requires-with-argument must stay isolated).
 */
function subschemaForBackboneEntityHop(
  subschema: Subschema,
  entityTypeName: string,
  selectionSet: SelectionSetNode,
): Subschema {
  const transforms = subschema.transforms;
  if (!transforms?.length) {
    return subschema;
  }
  const mergeFields = subschema.merge?.[entityTypeName]?.fields;
  if (!mergeFields) {
    return subschema;
  }
  // Only rewrite when the selection asks for a non-merge, non-typename field
  // that isolation would strip (e.g. inStock alongside shippingEstimate).
  let needsUnstripped = false;
  for (const sel of selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) {
      continue;
    }
    const name = sel.name.value;
    if (name === '__typename') {
      continue;
    }
    if (mergeFields[name]) {
      continue;
    }
    needsUnstripped = true;
    break;
  }
  if (!needsUnstripped) {
    return subschema;
  }
  const kept = transforms.filter(
    (t) => (t as any)?.constructor?.name !== 'TransformCompositeFields',
  );
  if (kept.length === transforms.length) {
    return subschema;
  }
  return Object.assign(
    Object.create(Object.getPrototypeOf(subschema)),
    subschema,
    {
      transforms: kept,
      _transformedSchema: undefined,
    },
  ) as Subschema;
}

/** Stamp subschema symbols without Object.defineProperties. */
function stampSubschema(
  object: Record<string, any>,
  subschema: Subschema,
  errors?: readonly any[],
): void {
  (object as any)[OBJECT_SUBSCHEMA_SYMBOL] = subschema;
  if ((object as any)[FIELD_SUBSCHEMA_MAP_SYMBOL] == null) {
    // Per-object map: mergeFields writes responseKey → subschema entries.
    (object as any)[FIELD_SUBSCHEMA_MAP_SYMBOL] = Object.create(null);
  }
  if ((object as any)[UNPATHED_ERRORS_SYMBOL] == null) {
    (object as any)[UNPATHED_ERRORS_SYMBOL] = errors?.length
      ? [...errors]
      : [];
  } else if (errors?.length) {
    (object as any)[UNPATHED_ERRORS_SYMBOL] = [...errors];
  }
}

/**
 * Deep-annotate a Fetch payload once so nested objects carry
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
  stampSubschema(value, subschema, errors);
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child != null && typeof child === 'object') {
      annotateValue(child, [], subschema);
    }
  }
  return value;
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
 * Light entity merge — Hive `mergeFlattenEntities`:
 * `Object.assign(target, mergeDeep([target, entity]))` for nested payloads;
 * leaf-only hops skip mergeDeep and assign fields directly.
 */
function mergeEntityIntoParent(
  parent: Record<string, any>,
  resolverResult: Record<string, any>,
  schema: GraphQLSchema,
  subschema: Subschema,
): void {
  let hasNested = false;
  for (const key in resolverResult) {
    if (key === '__typename') {
      continue;
    }
    const v = resolverResult[key];
    if (v != null && typeof v === 'object') {
      hasNested = true;
      break;
    }
  }
  const priorTypename = parent['__typename'] as string | undefined;
  const resultTypename = resolverResult['__typename'] as string | undefined;
  if (!hasNested) {
    for (const key in resolverResult) {
      if (
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype' ||
        key === '__typename'
      ) {
        continue;
      }
      parent[key] = resolverResult[key];
    }
    parent['__typename'] = resolveMergedTypename(
      priorTypename,
      resultTypename,
      schema,
    );
    stampSubschema(parent, subschema);
    return;
  }
  // Nested: Hive Object.assign + mergeDeep, then stamp symbols (mergeDeep
  // copies enumerable props only).
  const merged = mergeDeep([parent, resolverResult], false, true, true);
  Object.assign(parent, merged);
  parent['__typename'] = resolveMergedTypename(
    priorTypename,
    resultTypename,
    schema,
  );
  stampSubschema(parent, subschema);
  // Annotate fresh nested objects from the hop so later entity hops can find
  // OBJECT_SUBSCHEMA_SYMBOL on children.
  for (const key in resolverResult) {
    if (key === '__typename') {
      continue;
    }
    const v = parent[key];
    if (v != null && typeof v === 'object') {
      annotateValue(v, [], subschema);
    }
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
      stampSubschema(merged, sourceSub);
      const leftMap = (existing as any)[FIELD_SUBSCHEMA_MAP_SYMBOL];
      const rightMap = (incoming as any)[FIELD_SUBSCHEMA_MAP_SYMBOL];
      if (leftMap || rightMap) {
        (merged as any)[FIELD_SUBSCHEMA_MAP_SYMBOL] = {
          ...rightMap,
          ...leftMap,
        };
      }
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
    let document = node.document;
    let variables: Record<string, any>;
    if (document) {
      variables = {};
      const op = document.definitions.find(
        (d) => d.kind === Kind.OPERATION_DEFINITION,
      );
      for (const def of op?.variableDefinitions ?? []) {
        const name = def.variable.name.value;
        if (name in ctx.variableValues) {
          variables[name] = ctx.variableValues[name];
        }
      }
    } else {
      const built = buildRootDocument(
        ctx.operation.name?.value,
        ctx.operation.operation,
        node.rootField,
        ctx.operation.variableDefinitions,
        ctx.variableValues,
        node.subschema.schema,
      );
      document = built.document;
      variables = built.variables;
    }
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
      () => awaitMaybePromises(jobs),
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

  const hopSubschema = subschemaForBackboneEntityHop(
    node.subschema,
    node.entityTypeName,
    node.selectionSet,
  );

  // Hive-style: one batched _entities hop for all parents (single
  // batchDelegateToSchema / DataLoader batch instead of N resolver entries).
  const batched = tryExecuteEntitiesBatch(
    node,
    parents,
    hopSubschema,
    ctx,
    info,
    type as GraphQLOutputType,
  );
  if (batched !== undefined) {
    return batched;
  }

  const jobs: MaybePromise<any>[] = parents.map((parent) =>
    handleMaybePromise(
      () =>
        resolver(
          parent,
          ctx.contextValue,
          info,
          hopSubschema,
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
    () => awaitMaybePromises(jobs),
    () => undefined,
  );
}

/**
 * Federation entity hop like Hive: project keys once, one batchDelegate
 * (_entities) for all parents, index-merge. Falls back when merge config
 * is not argsFromKeys/_entities shaped.
 */
function tryExecuteEntitiesBatch(
  node: Extract<StitchPlanNode, { kind: 'Fetch' }>,
  parents: Array<Record<string, any>>,
  hopSubschema: Subschema,
  ctx: BackboneExecutionContext,
  info: Record<string, any>,
  type: GraphQLOutputType,
): MaybePromise<void> | undefined {
  const typeName = node.entityTypeName!;
  const mergeConfig = hopSubschema.merge?.[typeName];
  const entry =
    mergeConfig?.key != null &&
    mergeConfig.argsFromKeys != null &&
    mergeConfig.fieldName === '_entities'
      ? mergeConfig
      : mergeConfig?.entryPoints?.find(
          (e) =>
            e.key != null &&
            e.argsFromKeys != null &&
            e.fieldName === '_entities',
        );
  if (!entry?.key || !entry.argsFromKeys) {
    return undefined;
  }

  const keyFn = entry.key;
  const cacheKeyFn = entry.dataLoaderOptions?.cacheKeyFn;
  const keys: any[] = [];
  const identityToIndex = new Map<string, number>();
  const parentKeyIndex: number[] = new Array(parents.length);
  for (let i = 0; i < parents.length; i++) {
    const key = keyFn(parents[i]!);
    if (key == null) {
      parentKeyIndex[i] = -1;
      continue;
    }
    const identity =
      cacheKeyFn != null ? String(cacheKeyFn(key)) : JSON.stringify(key);
    let idx = identityToIndex.get(identity);
    if (idx == null) {
      idx = keys.length;
      identityToIndex.set(identity, idx);
      keys.push(key);
    }
    parentKeyIndex[i] = idx;
  }
  if (!keys.length) {
    return undefined;
  }

  const mergeResults = (results: any) => {
    if (!Array.isArray(results)) {
      if (results instanceof Error) {
        ctx.errors.push(results);
      }
      return;
    }
    for (let i = 0; i < parents.length; i++) {
      const ki = parentKeyIndex[i]!;
      if (ki < 0) {
        continue;
      }
      const entity = results[ki];
      if (entity instanceof Error) {
        ctx.errors.push(entity);
        continue;
      }
      if (entity == null || typeof entity !== 'object') {
        continue;
      }
      mergeEntityIntoParent(
        parents[i]!,
        entity as Record<string, any>,
        ctx.schema,
        node.subschema,
      );
    }
  };

  // Prebuilt document skips Transformer — only safe for leaf-only selections
  // (Hive inventory/username style). Nested/abstract/requires need
  // prepareGatewayDocument (wrapConcreteTypes, fieldNodesByField, transforms).
  if (node.document && isLeafOnlySelection(node.selectionSet)) {
    const args = entry.argsFromKeys!(keys) as Record<string, any>;
    const executor = getSubschemaExecutor(hopSubschema);
    return handleMaybePromise(
      () =>
        executor({
          document: node.document!,
          variables: args,
          context: ctx.contextValue,
          rootValue: ctx.rootValue,
          operationType: 'query' as OperationTypeNode,
          signal: ctx.signal,
          subgraphName: hopSubschema.name,
        } satisfies ExecutionRequest) as MaybePromise<ExecutionResult>,
      (result: ExecutionResult) => {
        if (result.errors?.length) {
          ctx.errors.push(...result.errors);
        }
        mergeResults(result.data?.['_entities']);
      },
    );
  }

  return handleMaybePromise(
    () =>
      delegateToSchema({
        schema: hopSubschema,
        operation: 'query',
        fieldName: '_entities',
        returnType: new GraphQLList(type),
        args: entry.argsFromKeys!(keys),
        selectionSet: node.selectionSet,
        context: ctx.contextValue,
        info: info as any,
        skipTypeMerging: true,
      }),
    mergeResults,
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
  const responseKey = node.fieldNode.alias?.value ?? fieldName;

  // Meta-field: no GraphQLField.resolve on the type.
  if (fieldName === '__typename') {
    ctx.data[responseKey] = node.parentTypeName;
    return;
  }

  const field = parentType.getFields()[fieldName];
  if (!field?.resolve) {
    return;
  }
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
          () => allMaybePromises(jobs),
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
      // Entity Fetches that share a flattenPath mutate the same parent objects.
      // Serialize only when selected fields overlap (true merge races). Disjoint
      // hops (inventory {inStock} ∥ reviews {reviews}) run in parallel like Hive.
      const entityFetches = node.nodes.filter(
        (n): n is Extract<StitchPlanNode, { kind: 'Fetch' }> =>
          n.kind === 'Fetch' && Boolean(n.entityTypeName),
      );
      const sharedEntityPath =
        entityFetches.length === node.nodes.length &&
        entityFetches.length > 1 &&
        entityFetches.every(
          (n) =>
            JSON.stringify(n.flattenPath ?? n.flattenPaths) ===
            JSON.stringify(
              entityFetches[0]!.flattenPath ?? entityFetches[0]!.flattenPaths,
            ),
        );
      if (sharedEntityPath) {
        const fieldSets = entityFetches.map((f) => {
          const names = new Set<string>();
          for (const sel of f.selectionSet.selections) {
            if (sel.kind === Kind.FIELD && sel.name.value !== '__typename') {
              names.add(sel.name.value);
            }
          }
          return names;
        });
        let overlapping = false;
        for (let i = 0; i < fieldSets.length && !overlapping; i++) {
          for (let j = i + 1; j < fieldSets.length; j++) {
            for (const name of fieldSets[i]!) {
              if (fieldSets[j]!.has(name)) {
                overlapping = true;
                break;
              }
            }
            if (overlapping) {
              break;
            }
          }
        }
        if (overlapping) {
          let chain: ReturnType<typeof executePlanNode> = undefined;
          for (const child of node.nodes) {
            chain = handleMaybePromise(
              () => chain,
              () => executePlanNode(child, ctx),
            );
          }
          return chain;
        }
      }
      const jobs = node.nodes.map((child) => executePlanNode(child, ctx));
      return awaitMaybePromises(jobs);
    }
    case 'Fetch':
      return executeFetchNode(node, ctx);
    case 'BatchFetch':
      return executeBatchFetchNode(node, ctx);
    case 'Island':
      return executeIslandNode(node, ctx);
    case 'Condition': {
      const value = ctx.variableValues?.[node.condition];
      if (value === true) {
        return node.ifClause ? executePlanNode(node.ifClause, ctx) : undefined;
      }
      return node.elseClause
        ? executePlanNode(node.elseClause, ctx)
        : undefined;
    }
    default:
      return;
  }
}

type ExecutableHop =
  | Extract<StitchPlanNode, { kind: 'Fetch' }>
  | Extract<StitchPlanNode, { kind: 'BatchFetch' }>;

function collectExecutableHops(
  node: StitchPlanNode,
  out: ExecutableHop[],
): void {
  if (node.kind === 'Fetch' || node.kind === 'BatchFetch') {
    out.push(node);
    return;
  }
  if (node.kind === 'Sequence' || node.kind === 'Parallel') {
    for (const child of node.nodes) {
      collectExecutableHops(child, out);
    }
  }
}

function hopCompletesIds(hop: ExecutableHop): string[] {
  if (hop.completesIds?.length) {
    return hop.completesIds;
  }
  return hop.id ? [hop.id] : [];
}

/**
 * Barrier-free dataflow: fire every Fetch/BatchFetch as soon as its
 * `dependsOn` ids are complete — Sequence wave barriers are ignored.
 */
function executeDataflowPlan(
  root: StitchPlanNode,
  ctx: BackboneExecutionContext,
): MaybePromise<void> {
  const hops: ExecutableHop[] = [];
  collectExecutableHops(root, hops);
  if (!hops.length) {
    return;
  }
  // Fall back when planner didn't attach deps (legacy / incomplete annotate).
  if (!hops.every((h) => h.id != null && h.dependsOn != null)) {
    return executePlanNode(root, ctx);
  }

  const done = new Set<string>();
  const pending = new Set(hops);
  let remaining = hops.length;

  const runReady = (): MaybePromise<void> => {
    if (remaining === 0) {
      return;
    }
    const ready: ExecutableHop[] = [];
    for (const hop of pending) {
      if (hop.dependsOn!.every((d) => done.has(d))) {
        ready.push(hop);
      }
    }
    if (!ready.length) {
      // Missed edge — drain sequentially.
      let chain: MaybePromise<void> = undefined;
      for (const hop of pending) {
        chain = handleMaybePromise(
          () => chain,
          () =>
            hop.kind === 'BatchFetch'
              ? executeBatchFetchNode(hop, ctx)
              : executeFetchNode(hop, ctx),
        );
      }
      return chain;
    }
    for (const hop of ready) {
      pending.delete(hop);
    }
    const jobs = ready.map((hop) =>
      handleMaybePromise(
        () =>
          hop.kind === 'BatchFetch'
            ? executeBatchFetchNode(hop, ctx)
            : executeFetchNode(hop, ctx),
        () => {
          for (const id of hopCompletesIds(hop)) {
            done.add(id);
          }
          remaining--;
        },
      ),
    );
    return handleMaybePromise(
      () => awaitMaybePromises(jobs),
      () => runReady(),
    );
  };

  return runReady();
}

function matchEntityParent(
  parent: Record<string, any>,
  entityTypeName: string,
  schema: GraphQLSchema,
): boolean {
  if (parent == null) {
    return false;
  }
  if (parent['__typename'] === entityTypeName) {
    return true;
  }
  const entityType = schema.getType(entityTypeName);
  if (parent['__typename'] == null) {
    return isInterfaceType(entityType);
  }
  if (!isInterfaceType(entityType)) {
    return false;
  }
  const runtime = schema.getType(parent['__typename']);
  return (
    isObjectType(runtime) &&
    runtime.getInterfaces().some((i) => i.name === entityTypeName)
  );
}

function collectAliasParents(
  ctx: BackboneExecutionContext,
  entityTypeName: string,
  flattenPaths: PathSegment[][],
): Array<Record<string, any>> {
  const parents: Array<Record<string, any>> = [];
  const seen = new Set<Record<string, any>>();
  for (const path of flattenPaths) {
    for (const p of collectEntitiesAtPath(ctx.data, path)) {
      if (matchEntityParent(p, entityTypeName, ctx.schema) && !seen.has(p)) {
        seen.add(p);
        parents.push(p);
      }
    }
  }
  return parents;
}

function projectRepresentations(
  parents: Array<Record<string, any>>,
  hopSubschema: Subschema,
  entityTypeName: string,
): {
  keys: any[];
  parentKeyIndex: number[];
  entry: {
    key: (p: any) => any;
    argsFromKeys: (keys: ReadonlyArray<any>) => Record<string, any>;
  };
} | null {
  const mergeConfig = hopSubschema.merge?.[entityTypeName];
  const entry =
    mergeConfig?.key != null &&
    mergeConfig.argsFromKeys != null &&
    mergeConfig.fieldName === '_entities'
      ? mergeConfig
      : mergeConfig?.entryPoints?.find(
          (e) =>
            e.key != null &&
            e.argsFromKeys != null &&
            e.fieldName === '_entities',
        );
  if (!entry?.key || !entry.argsFromKeys) {
    return null;
  }
  const cacheKeyFn = entry.dataLoaderOptions?.cacheKeyFn;
  const keys: any[] = [];
  const identityToIndex = new Map<string, number>();
  const parentKeyIndex: number[] = new Array(parents.length);
  for (let i = 0; i < parents.length; i++) {
    const key = entry.key(parents[i]!);
    if (key == null) {
      parentKeyIndex[i] = -1;
      continue;
    }
    const identity =
      cacheKeyFn != null ? String(cacheKeyFn(key)) : JSON.stringify(key);
    let idx = identityToIndex.get(identity);
    if (idx == null) {
      idx = keys.length;
      identityToIndex.set(identity, idx);
      keys.push(key);
    }
    parentKeyIndex[i] = idx;
  }
  return {
    keys,
    parentKeyIndex,
    entry: { key: entry.key, argsFromKeys: entry.argsFromKeys },
  };
}

type BatchAliasPrep = {
  alias: string;
  parents: Array<Record<string, any>>;
  parentKeyIndex: number[];
};

/**
 * True when selection is only scalar/enum fields (+ __typename) — no nests,
 * fragments, args, or directives. Directives (`@include`/`@skip`) need
 * variable defs that Transformer/finalizeGatewayRequest would attach.
 */
function isLeafOnlySelection(selectionSet: SelectionSetNode): boolean {
  for (const sel of selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) {
      return false;
    }
    if (sel.name.value === '__typename') {
      continue;
    }
    if (
      sel.selectionSet ||
      sel.arguments?.length ||
      sel.directives?.length
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Multi-type BatchFetch — Hive model: one prebuilt multi-alias `_entities`
 * document (`_e0`/`_e1`…), one subgraph HTTP round-trip, then per-alias merge.
 * Nested alias selections fall back to parallel Fetches (gateway `batch`
 * executor still collapses same-tick `_entities` into one HTTP).
 */
function executeBatchFetchNode(
  node: Extract<StitchPlanNode, { kind: 'BatchFetch' }>,
  ctx: BackboneExecutionContext,
): MaybePromise<void> {
  if (!node.aliases.length) {
    return;
  }

  // Prefer one multi-alias HTTP whenever the plan attached a document.
  // Alias selectionSets stay unfiltered for the parallel-Fetch fallback;
  // the document itself carries subgraph-filtered selections.
  if (node.document) {
    const prepared: BatchAliasPrep[] = [];
    const variables: Record<string, any> = Object.create(null);
    let anyKeys = false;
    let canRawBatch = true;

    for (let i = 0; i < node.aliases.length; i++) {
      const a = node.aliases[i]!;
      const varName = a.representationsVariable ?? `__batch_reps_${i}`;
      const parents = collectAliasParents(
        ctx,
        a.entityTypeName,
        a.flattenPaths,
      );
      if (!parents.length) {
        variables[varName] = [];
        continue;
      }
      const hopSubschema = subschemaForBackboneEntityHop(
        node.subschema,
        a.entityTypeName,
        a.selectionSet,
      );
      const projected = projectRepresentations(
        parents,
        hopSubschema,
        a.entityTypeName,
      );
      if (!projected) {
        canRawBatch = false;
        break;
      }
      variables[varName] = projected.keys;
      if (projected.keys.length) {
        anyKeys = true;
      }
      prepared.push({
        alias: a.alias,
        parents,
        parentKeyIndex: projected.parentKeyIndex,
      });
    }

    if (canRawBatch) {
      if (!anyKeys) {
        return;
      }
      const executor = getSubschemaExecutor(node.subschema);
      return handleMaybePromise(
        () =>
          executor({
            document: node.document!,
            variables,
            context: ctx.contextValue,
            rootValue: ctx.rootValue,
            operationType: 'query' as OperationTypeNode,
            signal: ctx.signal,
            subgraphName: node.subschema.name,
          } satisfies ExecutionRequest) as MaybePromise<ExecutionResult>,
        (result: ExecutionResult) => {
          if (result.errors?.length) {
            ctx.errors.push(...result.errors);
          }
          const data = result.data;
          if (!data || typeof data !== 'object') {
            return;
          }
          for (const prep of prepared) {
            const entities = (data as Record<string, any>)[prep.alias];
            if (!Array.isArray(entities)) {
              continue;
            }
            for (let i = 0; i < prep.parents.length; i++) {
              const ki = prep.parentKeyIndex[i]!;
              if (ki < 0) {
                continue;
              }
              const entity = entities[ki];
              if (entity instanceof Error) {
                ctx.errors.push(entity);
                continue;
              }
              if (entity == null || typeof entity !== 'object') {
                continue;
              }
              mergeEntityIntoParent(
                prep.parents[i]!,
                entity as Record<string, any>,
                ctx.schema,
                node.subschema,
              );
            }
          }
        },
        (err) => {
          ctx.errors.push(
            createGraphQLError(
              err instanceof Error ? err.message : String(err),
              {
                originalError: err instanceof Error ? err : undefined,
                extensions: {
                  code: 'DOWNSTREAM_SERVICE_ERROR',
                  serviceName: node.subschema.name,
                },
              },
            ),
          );
        },
      );
    }
  }

  // Nested / abstract aliases: parallel Fetch (gateway batch executor merges
  // same-tick `_entities` when `batch` is enabled).
  const jobs = node.aliases.map((a) =>
    executeFetchNode(
      {
        kind: 'Fetch',
        subschema: node.subschema,
        entityTypeName: a.entityTypeName,
        selectionSet: a.selectionSet,
        flattenPaths: a.flattenPaths,
        flattenPath: a.flattenPaths[0],
      },
      ctx,
    ),
  );
  return awaitMaybePromises(jobs);
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

  const contextValue =
    request.context != null && typeof request.context === 'object'
      ? request.context
      : Object.create(null);
  // Let root trampoline know Island resolvers must use original resolves.
  (contextValue as any)[BACKBONE_EXECUTING] = true;

  const ctx: BackboneExecutionContext = {
    schema,
    document: request.document,
    operation,
    fragments,
    variableValues,
    contextValue,
    rootValue: request.rootValue,
    signal: request.signal,
    data: {},
    errors: [],
    infoStub: {},
  };

  // Tree Sequence/Parallel execute. Dataflow (executeDataflowPlan) needs
  // complete @provides/abstract edges beyond Sequence barriers — keep tree
  // until fetchDependsOn covers those cases.
  return handleMaybePromise(
    () => executePlanNode(plan.root, ctx),
    () => {
      try {
        const result: ExecutionResult = {};
        if (Object.keys(ctx.data).length) {
          result.data = ctx.data;
        }
        if (ctx.errors.length) {
          result.errors = ctx.errors as any;
        }
        return result;
      } finally {
        delete (contextValue as any)[BACKBONE_EXECUTING];
      }
    },
  );
}
