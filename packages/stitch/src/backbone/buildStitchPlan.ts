import type {
  StitchingInfo,
  Subschema,
} from '@graphql-tools/delegate';
import { getVariableValues } from '@graphql-tools/delegate';
import {
  collectFields,
  getDefinedRootType,
} from '@graphql-tools/utils';
import {
  FieldNode,
  FragmentDefinitionNode,
  getNamedType,
  GraphQLObjectType,
  GraphQLSchema,
  isAbstractType,
  isObjectType,
  Kind,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
} from 'graphql';
import { isLocalField } from './localFields.js';
import { selectionHasAbstractTypes } from './projectResult.js';
import type {
  BackboneExecutorOptions,
  StitchPlan,
  StitchPlanNode,
} from './types.js';

function selectionSetOf(
  selections: readonly SelectionNode[],
): SelectionSetNode {
  return { kind: Kind.SELECTION_SET, selections: [...selections] };
}

function operationHasSkipOrInclude(
  operation: OperationDefinitionNode,
  fragments: Record<string, FragmentDefinitionNode>,
): boolean {
  const visitSelections = (selections: readonly SelectionNode[]): boolean => {
    for (const selection of selections) {
      if (
        selection.directives?.some(
          (d) => d.name.value === 'skip' || d.name.value === 'include',
        )
      ) {
        return true;
      }
      if (
        selection.kind === Kind.FIELD ||
        selection.kind === Kind.INLINE_FRAGMENT
      ) {
        if (
          selection.selectionSet &&
          visitSelections(selection.selectionSet.selections)
        ) {
          return true;
        }
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = fragments[selection.name.value];
        if (
          fragment &&
          visitSelections(fragment.selectionSet.selections)
        ) {
          return true;
        }
      }
    }
    return false;
  };
  return visitSelections(operation.selectionSet.selections);
}

function ensureTypename(selectionSet: SelectionSetNode): SelectionSetNode {
  const hasTypename = selectionSet.selections.some(
    (sel) => sel.kind === Kind.FIELD && sel.name.value === '__typename',
  );
  if (hasTypename) {
    return selectionSet;
  }
  return selectionSetOf([
    {
      kind: Kind.FIELD,
      name: { kind: Kind.NAME, value: '__typename' },
    },
    ...selectionSet.selections,
  ]);
}

function findOwningSubschemasForRootField(
  stitchingInfo: StitchingInfo,
  operation: OperationDefinitionNode['operation'],
  fieldName: string,
): Subschema[] {
  const owners: Subschema[] = [];
  for (const subschema of stitchingInfo.subschemaMap.values()) {
    const rootType =
      operation === 'mutation'
        ? subschema.transformedSchema.getMutationType()
        : operation === 'subscription'
          ? subschema.transformedSchema.getSubscriptionType()
          : subschema.transformedSchema.getQueryType();
    if (rootType?.getFields()[fieldName] != null) {
      owners.push(subschema);
    }
  }
  return owners;
}

function fieldAvailableOnSubschema(
  subschema: Subschema,
  typeName: string,
  fieldName: string,
  providedFieldNames?: ReadonlySet<string>,
): boolean {
  if (fieldName === '__typename') {
    return true;
  }
  if (providedFieldNames?.has(fieldName)) {
    return true;
  }
  const type = subschema.transformedSchema.getType(typeName);
  if (!type || !('getFields' in type)) {
    return false;
  }
  return (type as GraphQLObjectType).getFields()[fieldName] != null;
}

/**
 * Top-level field names covered by `@provides` on a parent field for a
 * given subschema (e.g. Query.products → categories on CATEGORY).
 */
/**
 * True when a field is backed by `@requires` / fieldSelectionSets — those need
 * leftover multi-stage resolution the planned executor does not cover yet.
 */
function fieldHasRequiresDependency(
  stitchingInfo: StitchingInfo,
  typeName: string,
  fieldName: string,
): boolean {
  const merged = stitchingInfo.mergedTypes[typeName];
  if (!merged?.fieldSelectionSets?.size) {
    return false;
  }
  for (const [, map] of merged.fieldSelectionSets) {
    if (map?.[fieldName] != null) {
      return true;
    }
  }
  return false;
}

function selectionHasRequiresDependency(
  stitchingInfo: StitchingInfo,
  typeName: string,
  fieldNodes: FieldNode[],
  fragments: Record<string, FragmentDefinitionNode>,
  schema: GraphQLSchema,
  seen = new Set<string>(),
): boolean {
  const parentType = schema.getType(typeName);
  if (!isObjectType(parentType) && !isAbstractType(parentType)) {
    return false;
  }
  for (const fieldNode of fieldNodes) {
    const fieldName = fieldNode.name.value;
    if (fieldName === '__typename') {
      continue;
    }
    if (fieldHasRequiresDependency(stitchingInfo, typeName, fieldName)) {
      return true;
    }
    if (!fieldNode.selectionSet || !isObjectType(parentType)) {
      continue;
    }
    const field = parentType.getFields()[fieldName];
    if (!field) {
      continue;
    }
    const named = getNamedType(field.type);
    const key = `${named.name}:${fieldName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (
      selectionHasRequiresDependency(
        stitchingInfo,
        named.name,
        flattenToFieldNodes(fieldNode.selectionSet.selections, fragments),
        fragments,
        schema,
        seen,
      )
    ) {
      return true;
    }
  }
  return false;
}

function getProvidedFieldNames(
  stitchingInfo: StitchingInfo,
  parentTypeName: string,
  parentFieldName: string,
  subschema: Subschema,
): Set<string> {
  const provided =
    stitchingInfo.mergedTypes[parentTypeName]?.providedSelectionsByField?.get(
      subschema,
    )?.[parentFieldName];
  if (!provided) {
    return new Set();
  }
  const names = new Set<string>();
  for (const sel of provided.selections) {
    if (sel.kind === Kind.FIELD) {
      names.add(sel.name.value);
    }
  }
  return names;
}

/**
 * Split a selection set into fields available on `subschema` vs the rest.
 * Used when building a root/entity Fetch for one subgraph.
 */
function partitionSelectionsForSubschema(
  subschema: Subschema,
  typeName: string,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  providedFieldNames?: ReadonlySet<string>,
): { available: SelectionNode[]; unavailable: SelectionNode[] } {
  const available: SelectionNode[] = [];
  const unavailable: SelectionNode[] = [];

  const visit = (selections: readonly SelectionNode[]) => {
    for (const selection of selections) {
      if (selection.kind === Kind.FIELD) {
        if (
          fieldAvailableOnSubschema(
            subschema,
            typeName,
            selection.name.value,
            providedFieldNames,
          )
        ) {
          available.push(selection);
        } else {
          unavailable.push(selection);
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        const typeCondition =
          selection.typeCondition?.name.value ?? typeName;
        if (
          typeCondition === typeName ||
          fieldAvailableOnSubschema(subschema, typeCondition, '__typename')
        ) {
          const nested = partitionSelectionsForSubschema(
            subschema,
            typeCondition,
            selection.selectionSet,
            fragments,
            // provides apply at the parent field boundary, not nested types
            undefined,
          );
          if (nested.available.length) {
            available.push({
              ...selection,
              selectionSet: selectionSetOf(nested.available),
            });
          }
          if (nested.unavailable.length) {
            unavailable.push({
              ...selection,
              selectionSet: selectionSetOf(nested.unavailable),
            });
          }
        } else {
          unavailable.push(selection);
        }
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = fragments[selection.name.value];
        if (!fragment) {
          unavailable.push(selection);
          continue;
        }
        const typeCondition = fragment.typeCondition.name.value;
        const nested = partitionSelectionsForSubschema(
          subschema,
          typeCondition,
          fragment.selectionSet,
          fragments,
        );
        if (nested.available.length) {
          available.push({
            kind: Kind.INLINE_FRAGMENT,
            typeCondition: fragment.typeCondition,
            directives: [
              ...(fragment.directives ?? []),
              ...(selection.directives ?? []),
            ],
            selectionSet: selectionSetOf(nested.available),
          });
        }
        if (nested.unavailable.length) {
          unavailable.push({
            kind: Kind.INLINE_FRAGMENT,
            typeCondition: fragment.typeCondition,
            directives: [
              ...(fragment.directives ?? []),
              ...(selection.directives ?? []),
            ],
            selectionSet: selectionSetOf(nested.unavailable),
          });
        }
      }
    }
  };

  visit(selectionSet.selections);
  return { available, unavailable };
}

function flattenToFieldNodes(
  selections: readonly SelectionNode[],
  fragments: Record<string, FragmentDefinitionNode>,
): FieldNode[] {
  const fieldNodes: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      fieldNodes.push(selection);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      fieldNodes.push(
        ...flattenToFieldNodes(selection.selectionSet.selections, fragments),
      );
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragment = fragments[selection.name.value];
      if (fragment) {
        fieldNodes.push(
          ...flattenToFieldNodes(fragment.selectionSet.selections, fragments),
        );
      }
    }
  }
  return fieldNodes;
}

/**
 * Expand merge-key / @requires bridge fields the same way
 * `prepareGatewayDocument` does via `fieldNodesByField` — e.g. requesting
 * `nickname` also pulls `email` so the next entity hop has its key.
 */
function expandFieldDependencies(
  stitchingInfo: StitchingInfo,
  typeName: string,
  fieldNodes: FieldNode[],
): FieldNode[] {
  const fieldNodesByField = stitchingInfo.fieldNodesByField?.[typeName];
  if (!fieldNodesByField) {
    return fieldNodes;
  }

  const result: FieldNode[] = [...fieldNodes];
  const seen = new Set(fieldNodes.map((f) => f.name.value));
  const queue = [...fieldNodes];

  while (queue.length) {
    const field = queue.shift()!;
    const deps = fieldNodesByField[field.name.value];
    if (!deps?.length) {
      continue;
    }
    for (const dep of deps) {
      if (seen.has(dep.name.value)) {
        continue;
      }
      seen.add(dep.name.value);
      result.push(dep);
      queue.push(dep);
    }
  }

  return result;
}

function selectionSetFromFieldNodes(
  fieldNodes: readonly FieldNode[],
): SelectionSetNode {
  return selectionSetOf(fieldNodes);
}

function planMergedTypeFollowUps(
  schema: GraphQLSchema,
  stitchingInfo: StitchingInfo,
  typeName: string,
  sourceSubschema: Subschema,
  fieldNodes: FieldNode[],
  fragments: Record<string, FragmentDefinitionNode>,
  variableValues: Record<string, any>,
  flattenPath: Array<string | number>,
  incompleteReasons: string[],
): StitchPlanNode | null {
  const mergedTypeInfo = stitchingInfo.mergedTypes[typeName];
  if (!mergedTypeInfo?.delegationPlanBuilder) {
    return null;
  }

  // delegationPlanBuilder / getFieldsNotInSubschema use collectSubFields, which
  // reads nested selections off parent field nodes. Wrap the merged-type fields
  // the same way defaultMergedResolver does at resolve time.
  const planningParentField: FieldNode = {
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: typeName },
    selectionSet: selectionSetOf(fieldNodes),
  };

  const delegationMaps = mergedTypeInfo.delegationPlanBuilder(
    schema,
    sourceSubschema,
    variableValues,
    fragments,
    [planningParentField],
  );

  const stages: StitchPlanNode[] = [];
  for (const delegationMap of delegationMaps) {
    const parallel: StitchPlanNode[] = [];
    for (const [targetSubschema, selectionSet] of delegationMap) {
      parallel.push({
        kind: 'Fetch',
        subschema: targetSubschema,
        entityTypeName: typeName,
        selectionSet: ensureTypename(selectionSet),
        flattenPath,
      });
    }
    if (parallel.length === 1) {
      stages.push(parallel[0]!);
    } else if (parallel.length > 1) {
      stages.push({ kind: 'Parallel', nodes: parallel });
    }
  }

  // Nested selections on fields that were fetched may themselves need merges.
  // Run even when this type had no entity hops (e.g. Review fields live on the
  // source, but Review.product.inStock still needs an Inventory fetch).
  // Candidate sources: the parent source plus every target we just fetched from
  // (the child object typically arrives stamped with one of those subschemas).
  const nestedSourceCandidates: Subschema[] = [sourceSubschema];
  for (const delegationMap of delegationMaps) {
    for (const [target] of delegationMap) {
      if (!nestedSourceCandidates.includes(target)) {
        nestedSourceCandidates.push(target);
      }
    }
  }
  const uniqueOwner = mergedTypeInfo.uniqueFields;
  for (const fieldNode of fieldNodes) {
    if (!fieldNode.selectionSet || fieldNode.name.value === '__typename') {
      continue;
    }
    const parentType = schema.getType(typeName);
    if (!isObjectType(parentType)) {
      continue;
    }
    const field = parentType.getFields()[fieldNode.name.value];
    if (!field) {
      continue;
    }
    const namedReturn = getNamedType(field.type);
    if (!isObjectType(namedReturn) && !isAbstractType(namedReturn)) {
      continue;
    }
    const responseKey = fieldNode.alias?.value ?? fieldNode.name.value;
    const childTypeName = namedReturn.name;
    if (!stitchingInfo.mergedTypes[childTypeName]) {
      continue;
    }
    const nestedFieldNodes = flattenToFieldNodes(
      fieldNode.selectionSet.selections,
      fragments,
    );
    const preferred = uniqueOwner[fieldNode.name.value];
    const sourcesToTry = preferred
      ? [
          preferred,
          ...nestedSourceCandidates.filter((s) => s !== preferred),
        ]
      : nestedSourceCandidates;
    let childPlan: StitchPlanNode | null = null;
    for (const candidate of sourcesToTry) {
      childPlan = planMergedTypeFollowUps(
        schema,
        stitchingInfo,
        childTypeName,
        candidate,
        nestedFieldNodes,
        fragments,
        variableValues,
        [...flattenPath, responseKey],
        incompleteReasons,
      );
      if (childPlan) {
        break;
      }
    }
    if (childPlan) {
      stages.push(childPlan);
    }
  }

  if (!stages.length) {
    return null;
  }
  if (stages.length === 1) {
    return stages[0]!;
  }
  return { kind: 'Sequence', nodes: stages };
}

function planRootField(
  schema: GraphQLSchema,
  stitchingInfo: StitchingInfo,
  operation: OperationDefinitionNode,
  fieldNode: FieldNode,
  fragments: Record<string, FragmentDefinitionNode>,
  variableValues: Record<string, any>,
  localFields: Map<string, Set<string>> | undefined,
  incompleteReasons: string[],
): StitchPlanNode {
  const rootType = getDefinedRootType(schema, operation.operation);
  const fieldName = fieldNode.name.value;
  const responseKey = fieldNode.alias?.value ?? fieldName;

  if (isLocalField(localFields, rootType.name, fieldName)) {
    let continuePlan: StitchPlanNode | undefined;
    const field = rootType.getFields()[fieldName];
    if (field && fieldNode.selectionSet) {
      const returnType = getNamedType(field.type);
      if (
        (isObjectType(returnType) || isAbstractType(returnType)) &&
        stitchingInfo.mergedTypes[returnType.name]
      ) {
        // After local resolve, hydrate missing federated fields from any
        // subschema that can merge this type — pick the first target.
        const merged = stitchingInfo.mergedTypes[returnType.name]!;
        const someSource = merged.targetSubschemas.keys().next().value as
          | Subschema
          | undefined;
        if (someSource && fieldNode.selectionSet) {
          continuePlan =
            planMergedTypeFollowUps(
              schema,
              stitchingInfo,
              returnType.name,
              someSource,
              flattenToFieldNodes(
                fieldNode.selectionSet.selections,
                fragments,
              ),
              fragments,
              variableValues,
              [responseKey],
              incompleteReasons,
            ) ?? undefined;
        }
      }
    }
    return {
      kind: 'Island',
      parentTypeName: rootType.name,
      fieldNode,
      continue: continuePlan,
    };
  }

  const owners = findOwningSubschemasForRootField(
    stitchingInfo,
    operation.operation,
    fieldName,
  );
  if (!owners.length) {
    incompleteReasons.push(`No subschema owns root field ${fieldName}`);
    return {
      kind: 'Island',
      parentTypeName: rootType.name,
      fieldNode,
    };
  }

  const field = rootType.getFields()[fieldName];
  const returnType = field ? getNamedType(field.type) : null;
  const returnTypeName = returnType?.name;

  const requested: FieldNode[] = fieldNode.selectionSet
    ? flattenToFieldNodes(fieldNode.selectionSet.selections, fragments)
    : [];

  // @requires / fieldSelectionSets need leftover multi-hop resolution that the
  // Fetch executor does not fully cover yet → schema execute for those ops.
  if (
    returnTypeName &&
    requested.length &&
    selectionHasRequiresDependency(
      stitchingInfo,
      returnTypeName,
      requested,
      fragments,
      schema,
    )
  ) {
    incompleteReasons.push(
      `@requires on ${returnTypeName} fields require schema execute until leftover planning is complete`,
    );
  }

  const withDeps =
    returnTypeName && requested.length
      ? expandFieldDependencies(stitchingInfo, returnTypeName, requested)
      : requested;

  // Per-owner partition: schema fields + @provides on this root field.
  type OwnerPartition = {
    owner: Subschema;
    available: SelectionNode[];
    unavailable: SelectionNode[];
    provided: Set<string>;
  };
  const partitions: OwnerPartition[] = owners.map((owner) => {
    const provided = getProvidedFieldNames(
      stitchingInfo,
      rootType.name,
      fieldName,
      owner,
    );
    if (!returnTypeName) {
      return {
        owner,
        available: fieldNode.selectionSet?.selections
          ? [...fieldNode.selectionSet.selections]
          : [],
        unavailable: [],
        provided,
      };
    }
    const partitioned = partitionSelectionsForSubschema(
      owner,
      returnTypeName,
      selectionSetFromFieldNodes(withDeps),
      fragments,
      provided,
    );
    return {
      owner,
      available: partitioned.available,
      unavailable: partitioned.unavailable,
      provided,
    };
  });

  // Shared-root: several subgraphs each contribute distinct selections for the
  // same root field → Parallel root Fetches (results deep-merged at execute).
  const contributing = partitions.filter((p) =>
    p.available.some(
      (sel) =>
        sel.kind !== Kind.FIELD ||
        (sel.name.value !== '__typename' &&
          // ignore pure key-only selections when another owner has real fields;
          // still keep owners that only expose keys if they are the sole owner
          true),
    ),
  );

  const meaningful = contributing.filter((p) =>
    p.available.some(
      (sel) => !(sel.kind === Kind.FIELD && sel.name.value === '__typename'),
    ),
  );
  const usedPartitions = meaningful.length ? meaningful : contributing;

  // Prefer owners that cover more of the client selection (override / provides).
  usedPartitions.sort((a, b) => b.available.length - a.available.length);

  const rootFetches: StitchPlanNode[] = usedPartitions.map((p) => {
    const selectionSet = ensureTypename(selectionSetOf(p.available));
    return {
      kind: 'Fetch' as const,
      subschema: p.owner,
      rootField: {
        ...fieldNode,
        selectionSet,
      },
      selectionSet,
    };
  });

  if (!rootFetches.length) {
    incompleteReasons.push(`No subschema could satisfy root field ${fieldName}`);
    return {
      kind: 'Island',
      parentTypeName: rootType.name,
      fieldNode,
    };
  }

  const rootNode: StitchPlanNode =
    rootFetches.length === 1
      ? rootFetches[0]!
      : { kind: 'Parallel', nodes: rootFetches };

  // Entity follow-ups: fields still missing after all root contributions.
  const coveredNames = new Set<string>();
  for (const p of usedPartitions) {
    for (const sel of p.available) {
      if (sel.kind === Kind.FIELD) {
        coveredNames.add(sel.name.value);
      }
    }
  }
  const followUpFieldNodes = requested.filter(
    (fn) => !coveredNames.has(fn.name.value),
  );

  // Source for merge planning: the owner that covered the most (keys live there).
  const primary = usedPartitions[0]!.owner;

  if (
    returnTypeName &&
    stitchingInfo.mergedTypes[returnTypeName] &&
    followUpFieldNodes.length
  ) {
    const followUp = planMergedTypeFollowUps(
      schema,
      stitchingInfo,
      returnTypeName,
      primary,
      followUpFieldNodes,
      fragments,
      variableValues,
      [responseKey],
      incompleteReasons,
    );
    if (followUp) {
      return { kind: 'Sequence', nodes: [rootNode, followUp] };
    }
  }

  return rootNode;
}

export function buildStitchPlan(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  fragments: Record<string, FragmentDefinitionNode>,
  variableValues: Record<string, any>,
  options: BackboneExecutorOptions = {},
): StitchPlan {
  const incompleteReasons: string[] = [];
  const stitchingInfo = schema.extensions?.['stitchingInfo'] as
    | StitchingInfo
    | undefined;

  if (!stitchingInfo) {
    return {
      operation,
      fragments,
      root: { kind: 'Parallel', nodes: [] },
      incomplete: true,
      incompleteReasons: ['Schema is not a stitched schema'],
    };
  }

  if (options.hasDelegationPlanHooks) {
    return {
      operation,
      fragments,
      root: { kind: 'Parallel', nodes: [] },
      incomplete: true,
      incompleteReasons: [
        'Delegation plan hooks are installed; backbone planning disabled',
      ],
    };
  }

  if (operation.operation === 'subscription') {
    return {
      operation,
      fragments,
      root: { kind: 'Parallel', nodes: [] },
      incomplete: true,
      incompleteReasons: ['Subscriptions are not planned by the backbone yet'],
    };
  }

  const rootType = getDefinedRootType(schema, operation.operation);

  // Abstract types / union fragments need Flatten+Cast semantics the planned
  // executor does not fully cover yet — fall back to schema execute.
  if (
    selectionHasAbstractTypes(
      schema,
      operation.selectionSet,
      rootType,
      fragments,
    )
  ) {
    incompleteReasons.push(
      'Abstract types in selection require schema execute until Cast/Flatten is complete',
    );
  }

  if (Object.keys(fragments).length > 0) {
    for (const fragment of Object.values(fragments)) {
      const t = schema.getType(fragment.typeCondition.name.value);
      if (isAbstractType(t)) {
        incompleteReasons.push(
          `Fragment ${fragment.name.value} on abstract type ${fragment.typeCondition.name.value}`,
        );
      }
    }
  }

  // @skip / @include need Condition nodes. collectFields/getFieldsNotInSubschema
  // evaluate those directives and throw when the variable has a default but was
  // omitted from the variables map — bail out before that walk.
  if (operationHasSkipOrInclude(operation, fragments)) {
    return {
      operation,
      fragments,
      root: { kind: 'Parallel', nodes: [] },
      incomplete: true,
      incompleteReasons: [
        ...incompleteReasons,
        '@skip/@include require schema execute until Condition nodes exist',
      ],
    };
  }

  if (incompleteReasons.length > 0) {
    // Still attempt a best-effort plan for warming, but never throw out of here.
    try {
      return buildCompletePlan(
        schema,
        stitchingInfo,
        operation,
        fragments,
        variableValues,
        options,
        rootType,
        incompleteReasons,
      );
    } catch {
      return {
        operation,
        fragments,
        root: { kind: 'Parallel', nodes: [] },
        incomplete: true,
        incompleteReasons,
      };
    }
  }

  return buildCompletePlan(
    schema,
    stitchingInfo,
    operation,
    fragments,
    variableValues,
    options,
    rootType,
    incompleteReasons,
  );
}

function buildCompletePlan(
  schema: GraphQLSchema,
  stitchingInfo: StitchingInfo,
  operation: OperationDefinitionNode,
  fragments: Record<string, FragmentDefinitionNode>,
  variableValues: Record<string, any>,
  options: BackboneExecutorOptions,
  rootType: GraphQLObjectType,
  incompleteReasons: string[],
): StitchPlan {
  const { fields } = collectFields(
    schema,
    fragments,
    getVariableValues(variableValues),
    rootType,
    operation.selectionSet,
  );

  const rootNodes: StitchPlanNode[] = [];
  for (const [, fieldNodes] of fields) {
    const fieldNode = fieldNodes[0];
    if (!fieldNode) {
      continue;
    }
    if (
      fieldNode.name.value === '__schema' ||
      fieldNode.name.value === '__type'
    ) {
      incompleteReasons.push('Introspection requires schema execute');
      continue;
    }
    rootNodes.push(
      planRootField(
        schema,
        stitchingInfo,
        operation,
        fieldNode,
        fragments,
        variableValues,
        options.localFields,
        incompleteReasons,
      ),
    );
  }

  if (!rootNodes.length && incompleteReasons.length === 0) {
    incompleteReasons.push('Empty operation plan');
  }

  const root: StitchPlanNode =
    rootNodes.length === 1
      ? rootNodes[0]!
      : { kind: 'Parallel', nodes: rootNodes };

  return {
    operation,
    fragments,
    root,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
  };
}
