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
): boolean {
  if (fieldName === '__typename') {
    return true;
  }
  const type = subschema.transformedSchema.getType(typeName);
  if (!type || !('getFields' in type)) {
    return false;
  }
  return (type as GraphQLObjectType).getFields()[fieldName] != null;
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
): { available: SelectionNode[]; unavailable: SelectionNode[] } {
  const available: SelectionNode[] = [];
  const unavailable: SelectionNode[] = [];

  const visit = (selections: readonly SelectionNode[]) => {
    for (const selection of selections) {
      if (selection.kind === Kind.FIELD) {
        if (
          fieldAvailableOnSubschema(subschema, typeName, selection.name.value)
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

  if (!delegationMaps.length) {
    return null;
  }

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
    const uniqueOwner =
      mergedTypeInfo.uniqueFields[fieldNode.name.value] ?? sourceSubschema;
    const nestedFieldNodes = flattenToFieldNodes(
      fieldNode.selectionSet.selections,
      fragments,
    );
    const childPlan = planMergedTypeFollowUps(
      schema,
      stitchingInfo,
      childTypeName,
      uniqueOwner,
      nestedFieldNodes,
      fragments,
      variableValues,
      [...flattenPath, responseKey],
      incompleteReasons,
    );
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

  const primary = owners[0]!;
  const field = rootType.getFields()[fieldName];
  const returnType = field ? getNamedType(field.type) : null;
  const returnTypeName = returnType?.name;

  let selectionSet: SelectionSetNode =
    fieldNode.selectionSet ?? selectionSetOf([]);
  if (returnTypeName) {
    const partitioned = partitionSelectionsForSubschema(
      primary,
      returnTypeName,
      selectionSet,
      fragments,
    );
    selectionSet = ensureTypename(selectionSetOf(partitioned.available));
  } else {
    selectionSet = ensureTypename(selectionSet);
  }

  const rootFetch: StitchPlanNode = {
    kind: 'Fetch',
    subschema: primary,
    rootField: {
      ...fieldNode,
      selectionSet,
    },
    selectionSet,
  };

  if (
    returnTypeName &&
    stitchingInfo.mergedTypes[returnTypeName] &&
    fieldNode.selectionSet
  ) {
    const followUp = planMergedTypeFollowUps(
      schema,
      stitchingInfo,
      returnTypeName,
      primary,
      flattenToFieldNodes(fieldNode.selectionSet.selections, fragments),
      fragments,
      variableValues,
      [responseKey],
      incompleteReasons,
    );
    if (followUp) {
      return { kind: 'Sequence', nodes: [rootFetch, followUp] };
    }
  }

  return rootFetch;
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
