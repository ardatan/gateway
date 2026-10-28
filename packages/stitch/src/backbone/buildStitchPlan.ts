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
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLUnionType,
  isAbstractType,
  isInterfaceType,
  isLeafType,
  isObjectType,
  isUnionType,
  Kind,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
  valueFromASTUntyped,
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

/** True when `owner` exposes the interface but not its concrete implementers. */
function isInterfaceObjectOwner(
  owner: Subschema,
  returnType: GraphQLInterfaceType | GraphQLUnionType,
  schema: GraphQLSchema,
): boolean {
  if (owner.transformedSchema.getType(returnType.name) == null) {
    return false;
  }
  if (!isInterfaceType(returnType) && !isUnionType(returnType)) {
    return false;
  }
  return schema
    .getPossibleTypes(returnType)
    .some((concrete) => owner.transformedSchema.getType(concrete.name) == null);
}

/**
 * Prefer a target subgraph that defines at least one concrete implementer
 * (so entity resolution can replace interface-object __typename).
 */
function findConcreteImplementerSubschema(
  mergedTypeInfo: NonNullable<StitchingInfo['mergedTypes'][string]>,
  source: Subschema,
  returnType: GraphQLInterfaceType | GraphQLUnionType,
  schema: GraphQLSchema,
): Subschema | undefined {
  const targets = mergedTypeInfo.targetSubschemas.get(source) ?? [];
  const possibles = schema.getPossibleTypes(returnType);
  return targets.find((t) =>
    possibles.some((c) => t.transformedSchema.getType(c.name) != null),
  );
}

function rootTypeOf(
  schema: import('graphql').GraphQLSchema,
  operation: OperationDefinitionNode['operation'],
) {
  return operation === 'mutation'
    ? schema.getMutationType()
    : operation === 'subscription'
      ? schema.getSubscriptionType()
      : schema.getQueryType();
}

function findOwningSubschemasForRootField(
  stitchingInfo: StitchingInfo,
  operation: OperationDefinitionNode['operation'],
  fieldName: string,
): Subschema[] {
  const owners: Subschema[] = [];
  for (const subschema of stitchingInfo.subschemaMap.values()) {
    // Prefer transformedSchema, but fall back to the raw subgraph schema —
    // stitching transforms sometimes drop Query fields on @interfaceObject
    // graphs (e.g. anotherUsers) while the HTTP executor still serves them.
    const transformedRoot = rootTypeOf(subschema.transformedSchema, operation);
    const rawRoot = rootTypeOf(subschema.schema, operation);
    if (
      transformedRoot?.getFields()[fieldName] != null ||
      rawRoot?.getFields()[fieldName] != null
    ) {
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
  for (const schema of [subschema.transformedSchema, subschema.schema]) {
    const type = schema.getType(typeName);
    if (type && 'getFields' in type) {
      if ((type as GraphQLObjectType).getFields()[fieldName] != null) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when the field exists on the subschema AND any @requires deps are either
 * already provided or also available on the same hop. Fields like
 * `username @requires(fields: "name")` stay out of the root Fetch when `name`
 * is external — they become a later entity stage after the dep is fetched.
 */
function fieldFetchableOnSubschema(
  stitchingInfo: StitchingInfo,
  subschema: Subschema,
  typeName: string,
  fieldName: string,
  providedFieldNames?: ReadonlySet<string>,
): boolean {
  if (
    !fieldAvailableOnSubschema(
      subschema,
      typeName,
      fieldName,
      providedFieldNames,
    )
  ) {
    return false;
  }
  if (fieldName === '__typename') {
    return true;
  }
  const deps = stitchingInfo.fieldNodesByField?.[typeName]?.[fieldName];
  if (!deps?.length) {
    return true;
  }
  for (const dep of deps) {
    if (dep.name.value === fieldName) {
      continue;
    }
    if (providedFieldNames?.has(dep.name.value)) {
      continue;
    }
    if (
      !fieldAvailableOnSubschema(
        subschema,
        typeName,
        dep.name.value,
        providedFieldNames,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Field names covered by `@provides` on a parent field for a given subschema.
 *
 * - `forTypeName` omitted: only unconditional fields (e.g. `categories { id }`).
 * - `forTypeName` set: also fields under `... on forTypeName` (e.g. media
 *   provides `... on Book { title }` → title when partitioning Book).
 */
function getProvidedFieldNames(
  stitchingInfo: StitchingInfo,
  parentTypeName: string,
  parentFieldName: string,
  subschema: Subschema,
  forTypeName?: string,
): Set<string> {
  const provided =
    stitchingInfo.mergedTypes[parentTypeName]?.providedSelectionsByField?.get(
      subschema,
    )?.[parentFieldName];
  if (!provided) {
    return new Set();
  }
  const names = new Set<string>();
  const visit = (
    selections: readonly SelectionNode[],
    activeType: string | null,
  ) => {
    for (const sel of selections) {
      if (sel.kind === Kind.FIELD) {
        if (
          forTypeName == null
            ? activeType == null
            : activeType == null || activeType === forTypeName
        ) {
          names.add(sel.name.value);
        }
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        visit(
          sel.selectionSet.selections,
          sel.typeCondition?.name.value ?? activeType,
        );
      }
    }
  };
  visit(provided.selections, null);
  return names;
}

/**
 * Split a selection set into fields available on `subschema` vs the rest.
 * Used when building a root/entity Fetch for one subgraph.
 */
/** Origin of @provides on a parent field — used to expand type-conditioned provides. */
type ProvidesOrigin = {
  parentTypeName: string;
  parentFieldName: string;
};

function partitionSelectionsForSubschema(
  subschema: Subschema,
  typeName: string,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  providedFieldNames?: ReadonlySet<string>,
  stitchingInfo?: StitchingInfo,
  /** Gateway schema — needed to resolve nested return types for @provides fields absent from the subgraph SDL. */
  gatewaySchema?: GraphQLSchema,
  providesOrigin?: ProvidesOrigin,
): { available: SelectionNode[]; unavailable: SelectionNode[] } {
  const available: SelectionNode[] = [];
  const unavailable: SelectionNode[] = [];
  // Merge type-conditioned provides (e.g. `... on Book { title }`) for this typeName.
  let effectiveProvided = providedFieldNames;
  if (stitchingInfo && providesOrigin) {
    const typed = getProvidedFieldNames(
      stitchingInfo,
      providesOrigin.parentTypeName,
      providesOrigin.parentFieldName,
      subschema,
      typeName,
    );
    if (typed.size) {
      effectiveProvided = new Set([
        ...(providedFieldNames ?? []),
        ...typed,
      ]);
    }
  }
  const fetchable = (fieldName: string) => {
    const ok = stitchingInfo
      ? fieldFetchableOnSubschema(
          stitchingInfo,
          subschema,
          typeName,
          fieldName,
          effectiveProvided,
        )
      : fieldAvailableOnSubschema(
          subschema,
          typeName,
          fieldName,
          effectiveProvided,
        );
    return ok;
  };

  const visit = (selections: readonly SelectionNode[]) => {
    for (const selection of selections) {
      if (selection.kind === Kind.FIELD) {
        if (!fetchable(selection.name.value)) {
          unavailable.push(selection);
          continue;
        }
        if (!selection.selectionSet) {
          available.push(selection);
          continue;
        }
        // Recurse into nested selections so union/interface fragments for
        // types absent from this subgraph are stripped (Movie on graph A).
        // Prefer the subgraph field type when present (Viewer.book → Book on A
        // so `... on Song` is rejected); fall back to the gateway schema for
        // @provides fields absent from the subgraph SDL (Product.categories).
        const subParent =
          subschema.transformedSchema.getType(typeName) ??
          subschema.schema.getType(typeName);
        const gatewayParent = gatewaySchema?.getType(typeName);
        const subField =
          subParent && 'getFields' in subParent
            ? (subParent as GraphQLObjectType).getFields()[selection.name.value]
            : undefined;
        const gatewayField =
          gatewayParent && 'getFields' in gatewayParent
            ? (gatewayParent as GraphQLObjectType).getFields()[
                selection.name.value
              ]
            : undefined;
        const nestedReturn = subField
          ? getNamedType(subField.type)
          : gatewayField
            ? getNamedType(gatewayField.type)
            : undefined;
        const nestedTypeName = nestedReturn?.name ?? typeName;
        // @provides on this field (e.g. products.categories → name) apply to
        // the nested type's partition, not the parent type's.
        const nestedOrigin: ProvidesOrigin | undefined = stitchingInfo
          ? {
              parentTypeName: typeName,
              parentFieldName: selection.name.value,
            }
          : undefined;
        const nestedProvided =
          stitchingInfo != null
            ? getProvidedFieldNames(
                stitchingInfo,
                typeName,
                selection.name.value,
                subschema,
              )
            : undefined;
        const nested = partitionSelectionsForSubschema(
          subschema,
          nestedTypeName,
          selection.selectionSet,
          fragments,
          nestedProvided?.size ? nestedProvided : undefined,
          stitchingInfo,
          gatewaySchema,
          nestedOrigin,
        );
        if (nested.available.length) {
          available.push({
            ...selection,
            selectionSet: selectionSetOf(nested.available),
          });
        } else if (nested.unavailable.length) {
          // Field exists here but no nested selection applies (e.g. aMedia
          // with only `... on Movie` on graph A) — keep a stub so the key
          // still appears as {} in the response.
          available.push({
            ...selection,
            selectionSet: selectionSetOf([
              {
                kind: Kind.FIELD,
                name: { kind: Kind.NAME, value: '__typename' },
              },
            ]),
          });
        }
        if (nested.unavailable.length && nested.available.length) {
          unavailable.push({
            ...selection,
            selectionSet: selectionSetOf(nested.unavailable),
          });
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        const typeCondition =
          selection.typeCondition?.name.value ?? typeName;
        // Must check the type exists on this subgraph — __typename is always
        // "available" and must not be used as a proxy for type presence.
        const condType =
          subschema.transformedSchema.getType(typeCondition) ??
          subschema.schema.getType(typeCondition);
        const parentType =
          subschema.transformedSchema.getType(typeName) ??
          subschema.schema.getType(typeName);
        let typeOnSubschema =
          typeCondition === typeName || condType != null;
        // Object parents cannot host fragments on a different object type
        // (book: Book cannot take `... on Song`).
        if (
          typeOnSubschema &&
          isObjectType(parentType) &&
          typeCondition !== typeName
        ) {
          if (isObjectType(condType) && condType.name !== parentType.name) {
            typeOnSubschema = false;
          } else if (
            isInterfaceType(condType) &&
            !parentType
              .getInterfaces()
              .some((i) => i.name === condType.name)
          ) {
            typeOnSubschema = false;
          } else if (
            isUnionType(condType) &&
            !condType.getTypes().some((t) => t.name === parentType.name)
          ) {
            typeOnSubschema = false;
          }
        }
        if (typeOnSubschema) {
          const nested = partitionSelectionsForSubschema(
            subschema,
            typeCondition,
            selection.selectionSet,
            fragments,
            // Keep parent provides origin so `... on Book { title }` applies.
            providedFieldNames,
            stitchingInfo,
            gatewaySchema,
            providesOrigin,
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
          providedFieldNames,
          stitchingInfo,
          gatewaySchema,
          providesOrigin,
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

/**
 * Merge-key selections (usually `{ id }`) required on the parent before an
 * entity Fetch can build representations.
 */
function mergeKeySelectionsForType(
  mergedTypeInfo: NonNullable<StitchingInfo['mergedTypes'][string]>,
  owner: Subschema,
  typeName: string,
  alreadyCovered: ReadonlySet<string>,
): SelectionNode[] {
  const keys: SelectionNode[] = [];
  const seen = new Set<string>();
  const addFrom = (selectionSet: SelectionSetNode | undefined) => {
    if (!selectionSet) {
      return;
    }
    for (const sel of selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) {
        continue;
      }
      const name = sel.name.value;
      if (
        name === '__typename' ||
        alreadyCovered.has(name) ||
        seen.has(name) ||
        !fieldAvailableOnSubschema(owner, typeName, name)
      ) {
        continue;
      }
      seen.add(name);
      keys.push(sel);
    }
  };
  for (const selectionSet of mergedTypeInfo.selectionSets.values()) {
    addFrom(selectionSet);
  }
  // Federation entities always key on `id` when present on the interface object.
  if (
    !alreadyCovered.has('id') &&
    !seen.has('id') &&
    fieldAvailableOnSubschema(owner, typeName, 'id')
  ) {
    keys.push({
      kind: Kind.FIELD,
      name: { kind: Kind.NAME, value: 'id' },
    });
  }
  return keys;
}

/** Add selections (e.g. requires bridges) into every root Fetch of a plan node. */
function injectSelectionsIntoRootFetches(
  node: StitchPlanNode,
  extra: readonly SelectionNode[],
): StitchPlanNode {
  if (node.kind === 'Fetch' && node.rootField) {
    const selectionSet = selectionSetOf([
      ...(node.rootField.selectionSet?.selections ?? []),
      ...extra,
    ]);
    return {
      ...node,
      selectionSet,
      rootField: { ...node.rootField, selectionSet },
    };
  }
  if (node.kind === 'Parallel' || node.kind === 'Sequence') {
    return {
      ...node,
      nodes: node.nodes.map((n) => injectSelectionsIntoRootFetches(n, extra)),
    };
  }
  return node;
}

/**
 * Collect client field nodes that apply to a concrete implementer of an
 * interface/union: shared fields on the abstract type + fields from matching
 * inline fragments / spreads.
 */
function collectFieldsForConcreteType(
  abstractType: GraphQLInterfaceType | GraphQLUnionType,
  concrete: GraphQLObjectType,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  schema: GraphQLSchema,
): FieldNode[] {
  const fields: FieldNode[] = [];
  const concreteFields = concrete.getFields();

  const visit = (
    selections: readonly SelectionNode[],
    underConcreteFragment: boolean,
  ) => {
    for (const sel of selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value === '__typename') {
          fields.push(sel);
          continue;
        }
        // Shared interface fields, or fields selected under a matching fragment
        if (
          underConcreteFragment ||
          (isInterfaceType(abstractType) &&
            abstractType.getFields()[sel.name.value] != null)
        ) {
          if (concreteFields[sel.name.value] != null || sel.name.value === '__typename') {
            fields.push(sel);
          }
        }
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        const cond = sel.typeCondition?.name.value;
        if (!cond || cond === concrete.name || cond === abstractType.name) {
          visit(
            sel.selectionSet.selections,
            cond === concrete.name || underConcreteFragment,
          );
        } else {
          // Fragment on a sibling interface the concrete also implements
          const t = schema.getType(cond);
          if (
            isInterfaceType(t) &&
            concrete.getInterfaces().some((i) => i.name === cond)
          ) {
            visit(sel.selectionSet.selections, true);
          }
        }
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = fragments[sel.name.value];
        if (!fragment) {
          continue;
        }
        const cond = fragment.typeCondition.name.value;
        if (cond === concrete.name || cond === abstractType.name) {
          visit(
            fragment.selectionSet.selections,
            cond === concrete.name || underConcreteFragment,
          );
        }
      }
    }
  };

  visit(selectionSet.selections, false);
  return fields;
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
  /** Extra selections (e.g. `... on User { age }` for @interfaceObject). */
  extraSelections: readonly SelectionNode[] = [],
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
    selectionSet: selectionSetOf([...fieldNodes, ...extraSelections]),
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

  const appendNestedForFields = (
    fields: readonly FieldNode[],
    /**
     * Subgraph that produced these field values (delegation map target). When
     * set, it is the first source for nested entity planning so fields like
     * Product.sku are not treated as already-local on PRODUCTS.
     */
    producedBy?: Subschema,
  ) => {
    const parentType = schema.getType(typeName);
    if (!isObjectType(parentType) && !isInterfaceType(parentType)) {
      return;
    }
    const uniqueOwner = mergedTypeInfo.uniqueFields;
    for (const fieldNode of fields) {
      if (!fieldNode.selectionSet || fieldNode.name.value === '__typename') {
        continue;
      }
      const field = (parentType as GraphQLObjectType).getFields()[
        fieldNode.name.value
      ];
      if (!field) {
        continue;
      }
      const namedReturn = getNamedType(field.type);
      if (!isObjectType(namedReturn) && !isAbstractType(namedReturn)) {
        continue;
      }
      const responseKey = fieldNode.alias?.value ?? fieldNode.name.value;
      const childPath = [...flattenPath, responseKey];
      const preferred = uniqueOwner[fieldNode.name.value];
      const sourcesToTry: Subschema[] = [];
      const pushUnique = (s: Subschema | undefined) => {
        if (s && !sourcesToTry.includes(s)) {
          sourcesToTry.push(s);
        }
      };
      // 1) Subgraph that actually returned this parent/field data
      pushUnique(producedBy);
      // 2) Field's unique owner (reviews → REVIEWS)
      pushUnique(preferred);
      // 3) Other known sources from this merge plan
      for (const s of nestedSourceCandidates) {
        pushUnique(s);
      }

      // Nested abstract (Review.product → Product): fan out Book/Magazine hops.
      if (isAbstractType(namedReturn) && fieldNode.selectionSet) {
        const nestedFollowUps: StitchPlanNode[] = [];
        for (const concrete of schema.getPossibleTypes(namedReturn)) {
          if (!stitchingInfo.mergedTypes[concrete.name]) {
            continue;
          }
          const forConcrete = collectFieldsForConcreteType(
            namedReturn,
            concrete,
            fieldNode.selectionSet,
            fragments,
            schema,
          );
          if (!forConcrete.length) {
            continue;
          }
          let childPlan: StitchPlanNode | null = null;
          for (const candidate of sourcesToTry) {
            childPlan = planMergedTypeFollowUps(
              schema,
              stitchingInfo,
              concrete.name,
              candidate,
              forConcrete,
              fragments,
              variableValues,
              childPath,
              incompleteReasons,
            );
            if (childPlan) {
              break;
            }
          }
          if (childPlan) {
            nestedFollowUps.push(childPlan);
          }
        }
        if (nestedFollowUps.length === 1) {
          stages.push(nestedFollowUps[0]!);
        } else if (nestedFollowUps.length > 1) {
          stages.push({ kind: 'Parallel', nodes: nestedFollowUps });
        }
        continue;
      }

      const childTypeName = namedReturn.name;
      if (!stitchingInfo.mergedTypes[childTypeName]) {
        continue;
      }
      const nestedFieldNodes = flattenToFieldNodes(
        fieldNode.selectionSet.selections,
        fragments,
      );
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
          childPath,
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
    for (const [target, selectionSet] of delegationMap) {
      appendNestedForFields(
        flattenToFieldNodes(selectionSet.selections, fragments),
        target,
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
    /** Scalar/enum root field — Fetch the field node as-is (no selection set). */
    leafField?: boolean;
  };
  const partitions: OwnerPartition[] = owners.map((owner) => {
    const provided = getProvidedFieldNames(
      stitchingInfo,
      rootType.name,
      fieldName,
      owner,
    );
    // Scalars/enums (mutations like add → Int): the root field is the unit.
    if (returnType != null && isLeafType(returnType)) {
      return {
        owner,
        available: [],
        unavailable: [],
        provided,
        leafField: true,
      };
    }
    if (!returnTypeName || !fieldNode.selectionSet) {
      return {
        owner,
        available: fieldNode.selectionSet?.selections
          ? [...fieldNode.selectionSet.selections]
          : [],
        unavailable: [],
        provided,
        leafField: !fieldNode.selectionSet,
      };
    }
    // Abstract return types: keep inline fragments / spreads and partition
    // against each concrete type condition so we don't flatten away the shape.
    if (returnType && isAbstractType(returnType) && fieldNode.selectionSet) {
      const available: SelectionNode[] = [];
      const unavailable: SelectionNode[] = [];
      for (const sel of fieldNode.selectionSet.selections) {
        if (sel.kind === Kind.FIELD) {
          if (sel.name.value === '__typename') {
            available.push(sel);
            continue;
          }
          if (
            !fieldFetchableOnSubschema(
              stitchingInfo,
              owner,
              returnTypeName,
              sel.name.value,
              provided,
            )
          ) {
            unavailable.push(sel);
            continue;
          }
          if (!sel.selectionSet) {
            available.push(sel);
            continue;
          }
          // Same recursive strip as partitionSelectionsForSubschema — do not
          // keep nested `... on Cat { age }` when age is foreign to this graph.
          const nestedProvided = getProvidedFieldNames(
            stitchingInfo,
            returnTypeName,
            sel.name.value,
            owner,
          );
          const fieldDef = (
            schema.getType(returnTypeName) ??
            owner.transformedSchema.getType(returnTypeName) ??
            owner.schema.getType(returnTypeName)
          ) as GraphQLObjectType | undefined;
          const nestedReturn = fieldDef?.getFields()?.[sel.name.value]
            ? getNamedType(fieldDef.getFields()[sel.name.value]!.type)
            : undefined;
          const nested = partitionSelectionsForSubschema(
            owner,
            nestedReturn?.name ?? returnTypeName,
            sel.selectionSet,
            fragments,
            nestedProvided.size ? nestedProvided : provided,
            stitchingInfo,
            schema,
            {
              parentTypeName: returnTypeName,
              parentFieldName: sel.name.value,
            },
          );
          if (nested.available.length) {
            available.push({
              ...sel,
              // __typename enables later Cat/Dog Cast filtering on list items.
              selectionSet: ensureTypename(selectionSetOf(nested.available)),
            });
          } else if (nested.unavailable.length) {
            available.push({
              ...sel,
              selectionSet: selectionSetOf([
                {
                  kind: Kind.FIELD,
                  name: { kind: Kind.NAME, value: '__typename' },
                },
              ]),
            });
          }
          if (nested.unavailable.length && nested.available.length) {
            unavailable.push({
              ...sel,
              selectionSet: selectionSetOf(nested.unavailable),
            });
          }
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          const cond = sel.typeCondition?.name.value ?? returnTypeName;
          const mediaProvidesOrigin: ProvidesOrigin = {
            parentTypeName: rootType.name,
            parentFieldName: fieldName,
          };
          if (owner.transformedSchema.getType(cond) != null) {
            const nested = partitionSelectionsForSubschema(
              owner,
              cond,
              sel.selectionSet,
              fragments,
              provided,
              stitchingInfo,
              schema,
              mediaProvidesOrigin,
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
          } else if (owner.transformedSchema.getType(returnTypeName) != null) {
            // @interfaceObject: concrete type (User/Admin) absent here, but the
            // interface is present — fields the interface object owns (username,
            // name) stay on this root Fetch; the rest go to entity follow-ups.
            const nested = partitionSelectionsForSubschema(
              owner,
              returnTypeName,
              sel.selectionSet,
              fragments,
              provided,
              stitchingInfo,
              schema,
              mediaProvidesOrigin,
            );
            for (const a of nested.available) {
              available.push(a);
            }
            if (nested.unavailable.length) {
              unavailable.push({
                ...sel,
                selectionSet: selectionSetOf(nested.unavailable),
              });
            } else if (nested.available.length) {
              // Concrete fragment was only for interface-owned fields; still
              // need a typename-discrimination marker for later hops.
              unavailable.push({
                ...sel,
                selectionSet: selectionSetOf([
                  {
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: '__typename' },
                  },
                ]),
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
          const spreadProvidesOrigin: ProvidesOrigin = {
            parentTypeName: rootType.name,
            parentFieldName: fieldName,
          };
          if (owner.transformedSchema.getType(cond) != null) {
            const nested = partitionSelectionsForSubschema(
              owner,
              cond,
              fragment.selectionSet,
              fragments,
              provided,
              stitchingInfo,
              schema,
              spreadProvidesOrigin,
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
          } else if (owner.transformedSchema.getType(returnTypeName) != null) {
            const nested = partitionSelectionsForSubschema(
              owner,
              returnTypeName,
              fragment.selectionSet,
              fragments,
              provided,
              stitchingInfo,
              schema,
              spreadProvidesOrigin,
            );
            for (const a of nested.available) {
              available.push(a);
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
            } else if (nested.available.length) {
              unavailable.push({
                kind: Kind.INLINE_FRAGMENT,
                typeCondition: fragment.typeCondition,
                directives: [
                  ...(fragment.directives ?? []),
                  ...(sel.directives ?? []),
                ],
                selectionSet: selectionSetOf([
                  {
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: '__typename' },
                  },
                ]),
              });
            }
          } else {
            unavailable.push(sel);
          }
        }
      }
      // Own the root even when only concrete fragments were requested: fetch
      // interface __typename + merge keys so entity hops can run.
      if (
        available.length === 0 &&
        unavailable.length > 0 &&
        owner.transformedSchema.getType(returnTypeName) != null
      ) {
        available.push({
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: '__typename' },
        });
        if (fieldAvailableOnSubschema(owner, returnTypeName, 'id')) {
          available.push({
            kind: Kind.FIELD,
            name: { kind: Kind.NAME, value: 'id' },
          });
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
      stitchingInfo,
      schema,
      { parentTypeName: rootType.name, parentFieldName: fieldName },
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
  const contributing = partitions.filter(
    (p) => p.leafField || p.available.length > 0,
  );

  const meaningful = contributing.filter(
    (p) =>
      p.leafField ||
      p.available.some(
        (sel) => !(sel.kind === Kind.FIELD && sel.name.value === '__typename'),
      ),
  );
  let usedPartitions = meaningful.length ? meaningful : contributing;

  // Prefer owners that cover more of the client selection (override / provides).
  usedPartitions.sort((a, b) => b.available.length - a.available.length);

  // Mutations must not fan out to every declared owner (addCategory on A+B would
  // run twice). Keep the single best-covering subgraph.
  if (operation.operation === 'mutation' && usedPartitions.length > 1) {
    usedPartitions = [usedPartitions[0]!];
  }

  const rootFetches: StitchPlanNode[] = usedPartitions.map((p) => {
    if (p.leafField) {
      return {
        kind: 'Fetch' as const,
        subschema: p.owner,
        rootField: { ...fieldNode, selectionSet: undefined },
        selectionSet: selectionSetOf([]),
      };
    }
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

  // Fields already fetched on any root contribution.
  // Unconditional fields (shared) vs type-conditioned (`... on Book { title }`)
  // stay separate — Book.title must not suppress Movie.title hops.
  const coveredNames = new Set<string>();
  const coveredByType = new Map<string, Set<string>>();
  const markCovered = (fieldName: string, typeCond?: string | null) => {
    if (typeCond) {
      let set = coveredByType.get(typeCond);
      if (!set) {
        set = new Set();
        coveredByType.set(typeCond, set);
      }
      set.add(fieldName);
    } else {
      coveredNames.add(fieldName);
    }
  };
  const isFieldCovered = (fieldName: string, typeName?: string) => {
    if (coveredNames.has(fieldName)) {
      return true;
    }
    if (typeName && coveredByType.get(typeName)?.has(fieldName)) {
      return true;
    }
    return false;
  };
  const collectCovered = (
    sels: readonly SelectionNode[],
    typeCond?: string | null,
  ) => {
    for (const sel of sels) {
      if (sel.kind === Kind.FIELD) {
        markCovered(sel.name.value, typeCond);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        collectCovered(
          sel.selectionSet.selections,
          sel.typeCondition?.name.value ?? typeCond,
        );
      }
    }
  };
  for (const p of usedPartitions) {
    collectCovered(p.available);
  }

  const primary = usedPartitions[0]!.owner;

  // Partial root fields (animals { id name } fetched, but `... on Cat { age }`
  // still unavailable): plan nested entity hops for the unavailable remainder
  // without re-fetching the already-covered field.
  const partialUnavailableFollowUps: StitchPlanNode[] = [];
  if (returnType && fieldNode.selectionSet) {
    for (const p of usedPartitions) {
      const availNames = new Set(
        p.available
          .filter((s) => s.kind === Kind.FIELD)
          .map((s) => (s as FieldNode).name.value),
      );
      for (const sel of p.unavailable ?? []) {
        if (sel.kind !== Kind.FIELD || !sel.selectionSet) {
          continue;
        }
        if (!availNames.has(sel.name.value)) {
          continue;
        }
        const parentFields =
          isObjectType(returnType) || isInterfaceType(returnType)
            ? returnType.getFields()
            : undefined;
        const field = parentFields?.[sel.name.value];
        if (!field) {
          continue;
        }
        const namedReturn = getNamedType(field.type);
        if (!isAbstractType(namedReturn) && !isObjectType(namedReturn)) {
          continue;
        }
        const responseKey = sel.alias?.value ?? sel.name.value;
        const rootKey = fieldNode.alias?.value ?? fieldNode.name.value;
        if (isAbstractType(namedReturn)) {
          for (const concrete of schema.getPossibleTypes(namedReturn)) {
            if (!stitchingInfo.mergedTypes[concrete.name]) {
              continue;
            }
            const forConcrete = collectFieldsForConcreteType(
              namedReturn,
              concrete,
              sel.selectionSet,
              fragments,
              schema,
            );
            if (!forConcrete.length) {
              continue;
            }
            const child = planMergedTypeFollowUps(
              schema,
              stitchingInfo,
              concrete.name,
              p.owner,
              forConcrete,
              fragments,
              variableValues,
              [rootKey, responseKey],
              incompleteReasons,
            );
            if (child) {
              partialUnavailableFollowUps.push(child);
            }
          }
        } else if (
          isObjectType(namedReturn) &&
          stitchingInfo.mergedTypes[namedReturn.name]
        ) {
          // Nested object remainder (categories.subCategories { name }).
          const nestedFields = flattenToFieldNodes(
            sel.selectionSet.selections,
            fragments,
          );
          // May need a further hop under list items: plan from the nested
          // field's children (subCategories → Category.name).
          for (const nestedFn of nestedFields) {
            if (!nestedFn.selectionSet) {
              // Scalar remainder on the object itself
              const child = planMergedTypeFollowUps(
                schema,
                stitchingInfo,
                namedReturn.name,
                p.owner,
                nestedFields,
                fragments,
                variableValues,
                [rootKey, responseKey],
                incompleteReasons,
              );
              if (child) {
                partialUnavailableFollowUps.push(child);
              }
              break;
            }
            const nestedFieldDef = namedReturn.getFields()[nestedFn.name.value];
            if (!nestedFieldDef) {
              continue;
            }
            const nestedNamed = getNamedType(nestedFieldDef.type);
            if (
              !isObjectType(nestedNamed) &&
              !isAbstractType(nestedNamed)
            ) {
              continue;
            }
            if (!stitchingInfo.mergedTypes[nestedNamed.name]) {
              continue;
            }
            const deepFields = flattenToFieldNodes(
              nestedFn.selectionSet.selections,
              fragments,
            );
            if (isAbstractType(nestedNamed)) {
              for (const concrete of schema.getPossibleTypes(nestedNamed)) {
                if (!stitchingInfo.mergedTypes[concrete.name]) {
                  continue;
                }
                const forConcrete = collectFieldsForConcreteType(
                  nestedNamed,
                  concrete,
                  nestedFn.selectionSet,
                  fragments,
                  schema,
                );
                if (!forConcrete.length) {
                  continue;
                }
                const child = planMergedTypeFollowUps(
                  schema,
                  stitchingInfo,
                  concrete.name,
                  p.owner,
                  forConcrete,
                  fragments,
                  variableValues,
                  [
                    rootKey,
                    responseKey,
                    nestedFn.alias?.value ?? nestedFn.name.value,
                  ],
                  incompleteReasons,
                );
                if (child) {
                  partialUnavailableFollowUps.push(child);
                }
              }
            } else {
              const child = planMergedTypeFollowUps(
                schema,
                stitchingInfo,
                nestedNamed.name,
                p.owner,
                deepFields,
                fragments,
                variableValues,
                [
                  rootKey,
                  responseKey,
                  nestedFn.alias?.value ?? nestedFn.name.value,
                ],
                incompleteReasons,
              );
              if (child) {
                partialUnavailableFollowUps.push(child);
              }
            }
          }
        }
      }
    }
  }

  const withPartialFollowUps = (node: StitchPlanNode): StitchPlanNode => {
    if (!partialUnavailableFollowUps.length) {
      return node;
    }
    const extra =
      partialUnavailableFollowUps.length === 1
        ? partialUnavailableFollowUps[0]!
        : { kind: 'Parallel' as const, nodes: partialUnavailableFollowUps };
    return { kind: 'Sequence', nodes: [node, extra] };
  };

  // Interface/union returns:
  // - @interfaceObject (NodeWithName): plan entity hops on the interface type
  //   when it has targetSubschemas; concrete fields go as `... on User { age }`.
  // - Product-style interfaces with empty targets: fan out per concrete type.
  if (
    returnType &&
    isAbstractType(returnType) &&
    fieldNode.selectionSet &&
    (isInterfaceType(returnType) || isUnionType(returnType))
  ) {
    const absMerged = stitchingInfo.mergedTypes[returnType.name];
    const interfaceHasTargets =
      absMerged?.targetSubschemas != null &&
      absMerged.targetSubschemas.size > 0;

    if (interfaceHasTargets && isInterfaceType(returnType)) {
      const interfaceFields: FieldNode[] = [];
      const concreteFragments: SelectionNode[] = [];
      let clientHasConcreteFragments = false;
      for (const sel of fieldNode.selectionSet.selections) {
        if (sel.kind === Kind.FIELD) {
          if (
            sel.name.value !== '__typename' &&
            !isFieldCovered(sel.name.value, returnType.name)
          ) {
            interfaceFields.push(sel);
          }
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          const cond = sel.typeCondition?.name.value;
          if (!cond) {
            continue;
          }
          if (cond !== returnType.name) {
            clientHasConcreteFragments = true;
          }
          const nested = flattenToFieldNodes(
            sel.selectionSet.selections,
            fragments,
          ).filter(
            (fn) =>
              fn.name.value !== '__typename' &&
              !isFieldCovered(fn.name.value, cond),
          );
          if (!nested.length) {
            // Still keep a typename probe so Cast can resolve Admin vs Regular
            // when the interface-object root already covered every field.
            if (cond !== returnType.name) {
              concreteFragments.push({
                ...sel,
                selectionSet: selectionSetOf([
                  {
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: '__typename' },
                  },
                ]),
              });
            }
            continue;
          }
          if (cond === returnType.name) {
            interfaceFields.push(...nested);
          } else {
            concreteFragments.push({
              ...sel,
              selectionSet: selectionSetOf(nested),
            });
          }
        } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
          const fragment = fragments[sel.name.value];
          if (!fragment) {
            continue;
          }
          const cond = fragment.typeCondition.name.value;
          if (cond !== returnType.name) {
            clientHasConcreteFragments = true;
          }
          const nested = flattenToFieldNodes(
            fragment.selectionSet.selections,
            fragments,
          ).filter(
            (fn) =>
              fn.name.value !== '__typename' &&
              !isFieldCovered(fn.name.value, cond),
          );
          if (!nested.length) {
            if (cond !== returnType.name) {
              concreteFragments.push({
                kind: Kind.INLINE_FRAGMENT,
                typeCondition: fragment.typeCondition,
                selectionSet: selectionSetOf([
                  {
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: '__typename' },
                  },
                ]),
              });
            }
            continue;
          }
          if (cond === returnType.name) {
            interfaceFields.push(...nested);
          } else {
            concreteFragments.push({
              kind: Kind.INLINE_FRAGMENT,
              typeCondition: fragment.typeCondition,
              selectionSet: selectionSetOf(nested),
            });
          }
        }
      }

      // Expand requires bridges for interface fields onto the root Fetch.
      const bridgeFragments: SelectionNode[] = [];
      if (interfaceFields.length) {
        const withDeps = expandFieldDependencies(
          stitchingInfo,
          returnType.name,
          interfaceFields,
        );
        const bridge = withDeps.filter(
          (fn) =>
            !isFieldCovered(fn.name.value, returnType.name) &&
            !interfaceFields.some((m) => m.name.value === fn.name.value) &&
            fieldAvailableOnSubschema(primary, returnType.name, fn.name.value),
        );
        for (const b of bridge) {
          markCovered(b.name.value, returnType.name);
          bridgeFragments.push(b);
        }
      }

      let rooted = rootNode;
      if (bridgeFragments.length) {
        rooted = injectSelectionsIntoRootFetches(rootNode, bridgeFragments);
      }

      let child = planMergedTypeFollowUps(
        schema,
        stitchingInfo,
        returnType.name,
        primary,
        interfaceFields,
        fragments,
        variableValues,
        [responseKey],
        incompleteReasons,
        concreteFragments,
      );

      // Interface-object roots often already own every selected field; still hop
      // to a concrete-implementer subgraph so `... on Admin` can discriminate.
      if (
        !child &&
        clientHasConcreteFragments &&
        isInterfaceObjectOwner(primary, returnType, schema)
      ) {
        const concreteOwner = findConcreteImplementerSubschema(
          absMerged,
          primary,
          returnType,
          schema,
        );
        if (concreteOwner) {
          child = {
            kind: 'Fetch',
            subschema: concreteOwner,
            entityTypeName: returnType.name,
            selectionSet: ensureTypename(selectionSetOf([])),
            flattenPath: [responseKey],
          };
        }
      }

      // Also resolve concrete __typename when the client explicitly asks for it
      // on an interface-object (Account.__typename → Admin/Regular via subgraph A).
      const clientRequestsTypename = fieldNode.selectionSet.selections.some(
        (sel) => sel.kind === Kind.FIELD && sel.name.value === '__typename',
      );
      if (
        !child &&
        clientRequestsTypename &&
        isInterfaceObjectOwner(primary, returnType, schema)
      ) {
        const concreteOwner = findConcreteImplementerSubschema(
          absMerged,
          primary,
          returnType,
          schema,
        );
        if (concreteOwner) {
          child = {
            kind: 'Fetch',
            subschema: concreteOwner,
            entityTypeName: returnType.name,
            selectionSet: ensureTypename(selectionSetOf([])),
            flattenPath: [responseKey],
          };
        }
      }

      if (child) {
        const keySels = mergeKeySelectionsForType(
          absMerged!,
          primary,
          returnType.name,
          coveredNames,
        );
        const withKeys = keySels.length
          ? injectSelectionsIntoRootFetches(rooted, keySels)
          : rooted;
        return withPartialFollowUps({
          kind: 'Sequence',
          nodes: [withKeys, child],
        });
      }
      return withPartialFollowUps(rooted);
    }

    const concreteFollowUps: StitchPlanNode[] = [];
    const bridgeFragments: SelectionNode[] = [];
    for (const concrete of schema.getPossibleTypes(returnType)) {
      if (!stitchingInfo.mergedTypes[concrete.name]) {
        continue;
      }
      const forConcrete = collectFieldsForConcreteType(
        returnType,
        concrete,
        fieldNode.selectionSet,
        fragments,
        schema,
      );
      const missing = forConcrete.filter(
        (fn) =>
          fn.name.value !== '__typename' &&
          !isFieldCovered(fn.name.value, concrete.name),
      );
      if (!missing.length) {
        continue;
      }
      const withDeps = expandFieldDependencies(
        stitchingInfo,
        concrete.name,
        missing,
      );
      const bridge = withDeps.filter(
        (fn) =>
          fn.name.value !== '__typename' &&
          !isFieldCovered(fn.name.value, concrete.name) &&
          !missing.some((m) => m.name.value === fn.name.value) &&
          fieldAvailableOnSubschema(primary, concrete.name, fn.name.value),
      );
      if (bridge.length) {
        bridgeFragments.push({
          kind: Kind.INLINE_FRAGMENT,
          typeCondition: {
            kind: Kind.NAMED_TYPE,
            name: { kind: Kind.NAME, value: concrete.name },
          },
          selectionSet: selectionSetOf(bridge),
        });
        // Do not add type-conditioned bridge fields to the shared coveredNames
        // set — Book.dimensions must not suppress Magazine.dimensions.
      }
      const child = planMergedTypeFollowUps(
        schema,
        stitchingInfo,
        concrete.name,
        primary,
        missing,
        fragments,
        variableValues,
        [responseKey],
        incompleteReasons,
      );
      if (child) {
        concreteFollowUps.push(child);
      }
    }

    let rooted = rootNode;
    if (bridgeFragments.length) {
      rooted = injectSelectionsIntoRootFetches(rootNode, bridgeFragments);
    }

    if (concreteFollowUps.length === 1) {
      return withPartialFollowUps({
        kind: 'Sequence',
        nodes: [rooted, concreteFollowUps[0]!],
      });
    }
    if (concreteFollowUps.length > 1) {
      return withPartialFollowUps({
        kind: 'Sequence',
        nodes: [rooted, { kind: 'Parallel', nodes: concreteFollowUps }],
      });
    }
    return withPartialFollowUps(rooted);
  }

  const followUpFieldNodes = requested.filter(
    (fn) => !isFieldCovered(fn.name.value, returnTypeName),
  );

  if (
    returnTypeName &&
    stitchingInfo.mergedTypes[returnTypeName] &&
    followUpFieldNodes.length
  ) {
    // Inject @requires / merge-key bridges onto the root Fetch even when the
    // parent field name is already covered (e.g. client asked for
    // `data { __typename }` but requirer needs `data { foo ... on Bar { … } }`).
    // Duplicate field names are fine — execute/collectFields merges them.
    let rooted = rootNode;
    const withDeps = expandFieldDependencies(
      stitchingInfo,
      returnTypeName,
      followUpFieldNodes,
    );
    const bridges = withDeps.filter(
      (fn) =>
        fn.name.value !== '__typename' &&
        !followUpFieldNodes.some((m) => m.name.value === fn.name.value) &&
        fieldAvailableOnSubschema(primary, returnTypeName, fn.name.value),
    );
    if (bridges.length) {
      rooted = injectSelectionsIntoRootFetches(rooted, bridges);
    }

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
      return withPartialFollowUps({
        kind: 'Sequence',
        nodes: [rooted, followUp],
      });
    }
    return withPartialFollowUps(rooted);
  }

  return withPartialFollowUps(rootNode);
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

  // Abstract / interface / union selections are planned (inline fragments on
  // root + entity hops on concrete members). Do not mark incomplete solely for
  // abstracts — Cast/Flatten gaps must fail at execute so we fix plan quality.

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

  // Mutations often share subgraph state (requestId counters); root fields must
  // run in document order. Queries/subscriptions can fan out in Parallel.
  const root: StitchPlanNode =
    rootNodes.length === 1
      ? rootNodes[0]!
      : {
          kind:
            operation.operation === 'mutation' ? 'Sequence' : 'Parallel',
          nodes: rootNodes,
        };

  return {
    operation,
    fragments,
    root,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
  };
}
