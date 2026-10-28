import type {
  StitchingInfo,
  Subschema,
} from '@graphql-tools/delegate';
import {
  getVariableValues,
  leftOverByDelegationPlan,
} from '@graphql-tools/delegate';
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
  valueFromASTUntyped,
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

/**
 * Fill omitted operation variables from their GraphQL default values so
 * `@skip`/`@include` and collectFields can evaluate without throwing.
 */
export function coerceOperationVariables(
  operation: OperationDefinitionNode,
  variableValues: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = { ...variableValues };
  for (const def of operation.variableDefinitions ?? []) {
    const name = def.variable.name.value;
    if (out[name] === undefined && def.defaultValue != null) {
      out[name] = valueFromASTUntyped(def.defaultValue, out);
    }
  }
  // Drop remaining undefined entries (Yoga may inject them).
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) {
      delete out[key];
    }
  }
  return out;
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
/** Stable identity for a field node including alias + arguments (requires keys). */
function fieldNodeKey(field: FieldNode): string {
  const alias = field.alias?.value;
  const name = field.name.value;
  const args = field.arguments?.length
    ? JSON.stringify(
        field.arguments.map((a) => [a.name.value, a.value]),
      )
    : '';
  return `${alias ?? ''}:${name}:${args}`;
}

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
  const seen = new Set(fieldNodes.map(fieldNodeKey));
  const queue = [...fieldNodes];

  while (queue.length) {
    const field = queue.shift()!;
    const deps = fieldNodesByField[field.name.value];
    if (!deps?.length) {
      continue;
    }
    for (const dep of deps) {
      const key = fieldNodeKey(dep);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
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

  const nestedSourceCandidates: Subschema[] = [sourceSubschema];
  for (const delegationMap of delegationMaps) {
    for (const [target] of delegationMap) {
      if (!nestedSourceCandidates.includes(target)) {
        nestedSourceCandidates.push(target);
      }
    }
  }

  const appendNestedForFields = (fields: readonly FieldNode[]) => {
    const parentType = schema.getType(typeName);
    if (!isObjectType(parentType)) {
      return;
    }
    const uniqueOwner = mergedTypeInfo.uniqueFields;
    for (const fieldNode of fields) {
      if (!fieldNode.selectionSet || fieldNode.name.value === '__typename') {
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
  };

  // Nested merges for fields fetched in requires-dep stages (e.g. Comment.authorId
  // after Post fetches `_comments: comments { authorId }`) — must run before the
  // leftover client-field hop that depends on those keys.
  for (const delegationMap of delegationMaps) {
    for (const [, selectionSet] of delegationMap) {
      appendNestedForFields(
        flattenToFieldNodes(selectionSet.selections, fragments),
      );
    }
  }

  // @requires leftovers: after deps (+ nested key resolution), fetch the real
  // client fields from the requiring subschemas.
  const leftOver = leftOverByDelegationPlan.get(delegationMaps);
  if (
    leftOver?.unproxiableFieldNodes?.length &&
    leftOver.nonProxiableSubschemas?.length
  ) {
    if (leftOver.nonProxiableSubschemas) {
      for (const s of leftOver.nonProxiableSubschemas) {
        if (!nestedSourceCandidates.includes(s)) {
          nestedSourceCandidates.push(s);
        }
      }
    }
    const leftoverByTarget = new Map<Subschema, FieldNode[]>();
    for (const fieldNode of leftOver.unproxiableFieldNodes) {
      const fieldName = fieldNode.name.value;
      const unique = mergedTypeInfo.uniqueFields[fieldName];
      const targets = unique
        ? leftOver.nonProxiableSubschemas.filter((s) => s === unique)
        : leftOver.nonProxiableSubschemas.filter((s) => {
            const nonUnique = mergedTypeInfo.nonUniqueFields[fieldName];
            return nonUnique?.includes(s) || unique == null;
          });
      const chosen =
        (targets.length ? targets : leftOver.nonProxiableSubschemas)[0];
      if (!chosen) {
        continue;
      }
      let list = leftoverByTarget.get(chosen);
      if (!list) {
        list = [];
        leftoverByTarget.set(chosen, list);
      }
      list.push(fieldNode);
    }
    if (leftoverByTarget.size === 1) {
      const [target, fields] = [...leftoverByTarget.entries()][0]!;
      stages.push({
        kind: 'Fetch',
        subschema: target,
        entityTypeName: typeName,
        selectionSet: ensureTypename(selectionSetOf(fields)),
        flattenPath,
      });
    } else if (leftoverByTarget.size > 1) {
      stages.push({
        kind: 'Parallel',
        nodes: [...leftoverByTarget.entries()].map(([target, fields]) => ({
          kind: 'Fetch' as const,
          subschema: target,
          entityTypeName: typeName,
          selectionSet: ensureTypename(selectionSetOf(fields)),
          flattenPath,
        })),
      });
    }
  }

  // Nested merges for the original client selection (Review.product.inStock, …).
  appendNestedForFields(fieldNodes);

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
    // Abstract return types: keep inline fragments / spreads and partition
    // against each concrete type condition so we don't flatten away the shape.
    if (returnType && isAbstractType(returnType) && fieldNode.selectionSet) {
      const available: SelectionNode[] = [];
      const unavailable: SelectionNode[] = [];
      for (const sel of fieldNode.selectionSet.selections) {
        if (sel.kind === Kind.FIELD) {
          if (
            fieldAvailableOnSubschema(
              owner,
              returnTypeName,
              sel.name.value,
              provided,
            ) ||
            sel.name.value === '__typename'
          ) {
            available.push(sel);
          } else {
            unavailable.push(sel);
          }
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          const cond = sel.typeCondition?.name.value ?? returnTypeName;
          const concrete = schema.getType(cond);
          if (
            concrete &&
            owner.transformedSchema.getType(cond) != null
          ) {
            const nested = partitionSelectionsForSubschema(
              owner,
              cond,
              sel.selectionSet,
              fragments,
              provided,
            );
            if (nested.available.length) {
              available.push({
                ...sel,
                selectionSet: selectionSetOf(nested.available),
              });
            }
            if (nested.unavailable.length) {
              unavailable.push({
                ...sel,
                selectionSet: selectionSetOf(nested.unavailable),
              });
            }
          } else {
            unavailable.push(sel);
          }
        } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
          const fragment = fragments[sel.name.value];
          if (!fragment) {
            unavailable.push(sel);
            continue;
          }
          const cond = fragment.typeCondition.name.value;
          if (owner.transformedSchema.getType(cond) != null) {
            const nested = partitionSelectionsForSubschema(
              owner,
              cond,
              fragment.selectionSet,
              fragments,
            );
            if (nested.available.length) {
              available.push({
                kind: Kind.INLINE_FRAGMENT,
                typeCondition: fragment.typeCondition,
                directives: [
                  ...(fragment.directives ?? []),
                  ...(sel.directives ?? []),
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
                  ...(sel.directives ?? []),
                ],
                selectionSet: selectionSetOf(nested.unavailable),
              });
            }
          } else {
            unavailable.push(sel);
          }
        }
      }
      return { owner, available, unavailable, provided };
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

  // Entity follow-ups for object return types. Abstract roots stay as
  // pass-through Fetches (inline fragments) until Cast/Flatten lands.
  if (returnType && isAbstractType(returnType)) {
    return rootNode;
  }

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

  // Abstract types / union fragments need Flatten+Cast for cross-subgraph
  // member hydration. Root pass-through plans are still built (inline
  // fragments partitioned per owner) for warming, but execute falls back.
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

  // Apply variable defaults so @skip/@include + collectFields evaluate safely.
  // Plans that depend on directive variables are cached per coerced variable map
  // in createBackboneExecutor.
  const coercedVariables = coerceOperationVariables(operation, variableValues);

  if (incompleteReasons.length > 0) {
    // Still attempt a best-effort plan for warming, but never throw out of here.
    try {
      return buildCompletePlan(
        schema,
        stitchingInfo,
        operation,
        fragments,
        coercedVariables,
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
    coercedVariables,
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
