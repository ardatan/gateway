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
  PathSegment,
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
 * Concrete types that may appear under `parentTypeName` on this subgraph.
 * Mirrors Hive QP FetchGraph: interface parents only list subgraph implementers;
 * union parents list subgraph members (even if they don't implement a sibling
 * interface locally — e.g. Product → Oven on A for `... on Node { id }`).
 */
function concretesOnSubschema(
  subschema: Subschema,
  parentTypeName: string,
  gatewaySchema: GraphQLSchema,
): GraphQLObjectType[] {
  const subType =
    subschema.transformedSchema.getType(parentTypeName) ??
    subschema.schema.getType(parentTypeName);
  if (isUnionType(subType)) {
    return subType.getTypes().filter(isObjectType);
  }
  if (isInterfaceType(subType)) {
    return subschema.transformedSchema.getPossibleTypes(subType).filter(isObjectType);
  }
  // Parent absent here (e.g. interface-object): fall back to gateway possibles
  // that physically exist on the subgraph.
  const gw = gatewaySchema.getType(parentTypeName);
  if (isAbstractType(gw)) {
    return gatewaySchema
      .getPossibleTypes(gw)
      .filter(
        (c) =>
          isObjectType(c) &&
          (subschema.transformedSchema.getType(c.name) != null ||
            subschema.schema.getType(c.name) != null),
      );
  }
  return [];
}

/**
 * Can `... on typeCondition` be spread under `parentTypeName` on this subgraph?
 */
function canSpreadOnSubschema(
  subschema: Subschema,
  parentTypeName: string,
  typeCondition: string,
): boolean {
  if (typeCondition === parentTypeName) {
    return subschema.transformedSchema.getType(parentTypeName) != null;
  }
  const parent =
    subschema.transformedSchema.getType(parentTypeName) ??
    subschema.schema.getType(parentTypeName);
  const cond =
    subschema.transformedSchema.getType(typeCondition) ??
    subschema.schema.getType(typeCondition);
  if (!parent || !cond) {
    return false;
  }
  if (isObjectType(cond)) {
    if (isUnionType(parent)) {
      return parent.getTypes().some((t) => t.name === typeCondition);
    }
    if (isInterfaceType(parent)) {
      return subschema.transformedSchema
        .getPossibleTypes(parent)
        .some((t) => t.name === typeCondition);
    }
    return parentTypeName === typeCondition;
  }
  // Interface condition under union/interface: valid if the type exists; field
  // expansion rewrites to concretes.
  return isInterfaceType(cond) || isUnionType(cond);
}

/**
 * Hive-QP-style rewrite: expand interface/union fragments into concrete
 * `... on Type` selections that are valid on this subgraph. Impossible spreads
 * (e.g. `... on Oven` under Node on A) become unavailable for later hops.
 */
function expandAbstractSelectionsForSubschema(
  subschema: Subschema,
  parentTypeName: string,
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  stitchingInfo: StitchingInfo,
  gatewaySchema: GraphQLSchema,
  providedFieldNames?: ReadonlySet<string>,
  providesOrigin?: ProvidesOrigin,
): { available: SelectionNode[]; unavailable: SelectionNode[] } {
  const available: SelectionNode[] = [];
  const unavailable: SelectionNode[] = [];

  const pushConcreteFields = (
    concreteName: string,
    fieldSelections: readonly SelectionNode[],
  ) => {
    const nested = partitionSelectionsForSubschema(
      subschema,
      concreteName,
      selectionSetOf(fieldSelections),
      fragments,
      providedFieldNames,
      stitchingInfo,
      gatewaySchema,
      providesOrigin,
    );
    if (nested.available.length) {
      available.push({
        kind: Kind.INLINE_FRAGMENT,
        typeCondition: {
          kind: Kind.NAMED_TYPE,
          name: { kind: Kind.NAME, value: concreteName },
        },
        selectionSet: selectionSetOf(nested.available),
      });
    }
    if (nested.unavailable.length) {
      unavailable.push({
        kind: Kind.INLINE_FRAGMENT,
        typeCondition: {
          kind: Kind.NAMED_TYPE,
          name: { kind: Kind.NAME, value: concreteName },
        },
        selectionSet: selectionSetOf(nested.unavailable),
      });
    }
  };

  /** Flatten nested interface fragments onto a concrete (Toaster ← WithWarranty). */
  const flattenOntoConcrete = (
    concreteName: string,
    selections: readonly SelectionNode[],
  ): SelectionNode[] => {
    const out: SelectionNode[] = [];
    for (const sel of selections) {
      if (sel.kind === Kind.FIELD) {
        out.push(sel);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        const cond = sel.typeCondition?.name.value;
        if (!cond || cond === concreteName) {
          out.push(...flattenOntoConcrete(concreteName, sel.selectionSet.selections));
          continue;
        }
        const gwCond = gatewaySchema.getType(cond);
        const concrete = gatewaySchema.getType(concreteName);
        if (
          isInterfaceType(gwCond) &&
          isObjectType(concrete) &&
          concrete.getInterfaces().some((i) => i.name === cond)
        ) {
          // Only keep if this concrete implements cond on the subgraph OR the
          // selected fields exist on the concrete locally (union+sibling iface).
          const subConcrete = subschema.transformedSchema.getType(concreteName);
          if (
            isObjectType(subConcrete) &&
            (subschema.transformedSchema
              .getPossibleTypes?.(
                subschema.transformedSchema.getType(cond) as GraphQLInterfaceType,
              )
              ?.some((t) => t.name === concreteName) ||
              sel.selectionSet.selections.some(
                (s) =>
                  s.kind === Kind.FIELD &&
                  (s.name.value === '__typename' ||
                    fieldAvailableOnSubschema(
                      subschema,
                      concreteName,
                      s.name.value,
                    )),
              ))
          ) {
            out.push(
              ...flattenOntoConcrete(concreteName, sel.selectionSet.selections),
            );
          }
        } else if (cond === parentTypeName) {
          out.push(...flattenOntoConcrete(concreteName, sel.selectionSet.selections));
        }
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = fragments[sel.name.value];
        if (!fragment) {
          continue;
        }
        out.push(
          ...flattenOntoConcrete(concreteName, fragment.selectionSet.selections),
        );
      }
    }
    return out;
  };

  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      if (sel.name.value === '__typename') {
        available.push(sel);
        continue;
      }
      // Hive QP: abstract fields are planned per concrete. A field on the
      // interface SDL may be @override'd away from a local concrete (Post.
      // createdAt on A vs ImagePost) — only emit where the concrete has it.
      const concretes = concretesOnSubschema(
        subschema,
        parentTypeName,
        gatewaySchema,
      );
      if (concretes.length) {
        let anyLocal = false;
        for (const concrete of concretes) {
          if (
            fieldFetchableOnSubschema(
              stitchingInfo,
              subschema,
              concrete.name,
              sel.name.value,
              providedFieldNames,
            )
          ) {
            pushConcreteFields(concrete.name, [sel]);
            anyLocal = true;
          } else {
            unavailable.push({
              kind: Kind.INLINE_FRAGMENT,
              typeCondition: {
                kind: Kind.NAMED_TYPE,
                name: { kind: Kind.NAME, value: concrete.name },
              },
              selectionSet: selectionSetOf([sel]),
            });
          }
        }
        if (!anyLocal) {
          // No local concrete can satisfy it — keep a typeless marker so
          // follow-up planning still sees the client field.
          unavailable.push(sel);
        }
        continue;
      }
      // Interface-object (no local concretes): fetch on the interface itself.
      if (
        fieldFetchableOnSubschema(
          stitchingInfo,
          subschema,
          parentTypeName,
          sel.name.value,
          providedFieldNames,
        )
      ) {
        available.push(sel);
      } else {
        unavailable.push(sel);
      }
      continue;
    }

    if (sel.kind === Kind.INLINE_FRAGMENT) {
      const cond = sel.typeCondition?.name.value ?? parentTypeName;
      const gwCond = gatewaySchema.getType(cond);

      if (isObjectType(gwCond)) {
        if (canSpreadOnSubschema(subschema, parentTypeName, cond)) {
          pushConcreteFields(cond, sel.selectionSet.selections);
        } else if (
          // @interfaceObject: concrete absent / not spreadable, but the
          // interface parent is here — keep interface-owned fields on this hop.
          isInterfaceType(
            subschema.transformedSchema.getType(parentTypeName) ??
              subschema.schema.getType(parentTypeName),
          )
        ) {
          const nested = partitionSelectionsForSubschema(
            subschema,
            parentTypeName,
            sel.selectionSet,
            fragments,
            providedFieldNames,
            stitchingInfo,
            gatewaySchema,
            providesOrigin,
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
            // Typename probe so later hops can discriminate Admin vs User.
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
        continue;
      }

      if (isInterfaceType(gwCond) || isUnionType(gwCond) || cond === parentTypeName) {
        // Expand to subgraph concretes under the parent (Hive FetchGraph style).
        const concretes = concretesOnSubschema(
          subschema,
          parentTypeName,
          gatewaySchema,
        );
        // For a narrower interface condition (WithWarranty under Node), intersect
        // with gateway implementers that also exist in the concrete list.
        let targets = concretes;
        if (isInterfaceType(gwCond) && cond !== parentTypeName) {
          const impl = new Set(
            gatewaySchema.getPossibleTypes(gwCond).map((t) => t.name),
          );
          const parentSub =
            subschema.transformedSchema.getType(parentTypeName) ??
            subschema.schema.getType(parentTypeName);
          if (isUnionType(parentSub)) {
            // Under a union, Hive expands sibling interfaces onto union members
            // that implement them in the supergraph (Oven gets Node.id on A even
            // though Oven does not implement Node locally).
            targets = concretes.filter((c) => impl.has(c.name));
          } else {
            // Under an interface parent, only local implementers are spreadable.
            const subCond = subschema.transformedSchema.getType(cond);
            if (isInterfaceType(subCond)) {
              const local = new Set(
                subschema.transformedSchema
                  .getPossibleTypes(subCond)
                  .map((t) => t.name),
              );
              targets = concretes.filter((c) => local.has(c.name));
            } else {
              targets = concretes.filter((c) => impl.has(c.name));
            }
          }
        }
        if (!targets.length) {
          unavailable.push(sel);
          continue;
        }
        for (const concrete of targets) {
          const flattened = flattenOntoConcrete(
            concrete.name,
            sel.selectionSet.selections,
          );
          if (flattened.length) {
            pushConcreteFields(concrete.name, flattened);
          }
        }
        continue;
      }

      unavailable.push(sel);
      continue;
    }

    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const fragment = fragments[sel.name.value];
      if (!fragment) {
        unavailable.push(sel);
        continue;
      }
      const expanded = expandAbstractSelectionsForSubschema(
        subschema,
        fragment.typeCondition.name.value,
        fragment.selectionSet,
        fragments,
        stitchingInfo,
        gatewaySchema,
        providedFieldNames,
        providesOrigin,
      );
      // Re-home under parent: concrete fragments stay; fields wrap in condition.
      for (const a of expanded.available) {
        available.push(a);
      }
      for (const u of expanded.unavailable) {
        unavailable.push(u);
      }
    }
  }

  return { available, unavailable };
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
  // Only enforce @requires bridges (merge.fields / computed). fieldNodesByField
  // also carries cross-key links (Book.upc → id, Product.id → upc) that must
  // NOT block reading a locally-owned key — Hive QP still fetches Book.upc
  // from A without id.
  const mergeField = subschema.merge?.[typeName]?.fields?.[fieldName];
  if (!mergeField?.selectionSet && !mergeField?.computed) {
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
          // Nested entities need __typename so later Flatten/entity Fetches
          // can match parents (Hive: book{__typename upc}).
          const nestedSs =
            nestedReturn &&
            (isObjectType(nestedReturn) || isAbstractType(nestedReturn))
              ? ensureTypename(selectionSetOf(nested.available))
              : selectionSetOf(nested.available);
          available.push({
            ...selection,
            selectionSet: nestedSs,
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

/** True when every field in `selection` is present on `subschema` under type. */
function selectionFullyLocalOnSubschema(
  subschema: Subschema,
  typeName: string,
  selection: SelectionNode,
  fragments: Record<string, FragmentDefinitionNode>,
): boolean {
  if (selection.kind === Kind.FIELD) {
    if (selection.name.value === '__typename') {
      return true;
    }
    if (!fieldAvailableOnSubschema(subschema, typeName, selection.name.value)) {
      return false;
    }
    if (!selection.selectionSet) {
      return true;
    }
    const type =
      subschema.transformedSchema.getType(typeName) ??
      subschema.schema.getType(typeName);
    if (!type || !('getFields' in type)) {
      return false;
    }
    const field = (type as GraphQLObjectType).getFields()[selection.name.value];
    if (!field) {
      return false;
    }
    const nestedTypeName = getNamedType(field.type).name;
    return selection.selectionSet.selections.every((sel) =>
      selectionFullyLocalOnSubschema(
        subschema,
        nestedTypeName,
        sel,
        fragments,
      ),
    );
  }
  if (selection.kind === Kind.INLINE_FRAGMENT) {
    const cond = selection.typeCondition?.name.value ?? typeName;
    if (
      subschema.transformedSchema.getType(cond) == null &&
      subschema.schema.getType(cond) == null
    ) {
      return false;
    }
    return selection.selectionSet.selections.every((sel) =>
      selectionFullyLocalOnSubschema(subschema, cond, sel, fragments),
    );
  }
  if (selection.kind === Kind.FRAGMENT_SPREAD) {
    const fragment = fragments[selection.name.value];
    if (!fragment) {
      return false;
    }
    return selectionFullyLocalOnSubschema(
      subschema,
      fragment.typeCondition.name.value,
      {
        kind: Kind.INLINE_FRAGMENT,
        typeCondition: fragment.typeCondition,
        selectionSet: fragment.selectionSet,
      },
      fragments,
    );
  }
  return false;
}

/**
 * When a nested field is only reachable by re-fetching the parent entity on
 * another subgraph (parent-entity-call), emit that entity Fetch directly.
 */
function planParentEntityNestedHop(
  _schema: GraphQLSchema,
  stitchingInfo: StitchingInfo,
  entityTypeName: string,
  sourceSubschema: Subschema,
  fieldNode: FieldNode,
  flattenPath: Array<string | number>,
  fragments: Record<string, FragmentDefinitionNode>,
): StitchPlanNode | null {
  if (!stitchingInfo.mergedTypes[entityTypeName]) {
    return null;
  }
  for (const target of stitchingInfo.subschemaMap.values()) {
    if (target === sourceSubschema) {
      continue;
    }
    if (
      target.transformedSchema.getType(entityTypeName) == null &&
      target.schema.getType(entityTypeName) == null
    ) {
      continue;
    }
    // Require the full nested path (category.details.products) to be local —
    // typename stubs from partition must not count as a match (B vs C).
    if (
      !selectionFullyLocalOnSubschema(
        target,
        entityTypeName,
        fieldNode,
        fragments,
      )
    ) {
      continue;
    }
    return {
      kind: 'Fetch',
      subschema: target,
      entityTypeName,
      selectionSet: ensureTypename(selectionSetOf([fieldNode])),
      flattenPath,
    };
  }
  return null;
}

/**
 * Keep only selections fetchable on `subschema`, recursively stripping nested
 * fields the subgraph does not own (e.g. ProductList key `products { id pid }`
 * on PRODUCTS → `products { id }` — pid lives on LINK).
 */
function filterSelectionTreeForSubschema(
  subschema: Subschema,
  typeName: string,
  selection: SelectionNode,
  stitchingInfo: StitchingInfo,
  gatewaySchema: GraphQLSchema,
  providedFieldNames?: ReadonlySet<string>,
): SelectionNode | null {
  if (selection.kind === Kind.FIELD) {
    if (selection.name.value === '__typename') {
      return selection;
    }
    if (
      !fieldFetchableOnSubschema(
        stitchingInfo,
        subschema,
        typeName,
        selection.name.value,
        providedFieldNames,
      )
    ) {
      return null;
    }
    if (!selection.selectionSet) {
      return selection;
    }
    const parent =
      subschema.transformedSchema.getType(typeName) ??
      subschema.schema.getType(typeName) ??
      gatewaySchema.getType(typeName);
    const field =
      parent && 'getFields' in parent
        ? (parent as GraphQLObjectType).getFields()[selection.name.value]
        : undefined;
    if (!field) {
      return null;
    }
    const nestedTypeName = getNamedType(field.type).name;
    const nested: SelectionNode[] = [];
    for (const sel of selection.selectionSet.selections) {
      const kept = filterSelectionTreeForSubschema(
        subschema,
        nestedTypeName,
        sel,
        stitchingInfo,
        gatewaySchema,
        undefined,
      );
      if (kept) {
        nested.push(kept);
      }
    }
    if (!nested.length) {
      return null;
    }
    return {
      ...selection,
      selectionSet: selectionSetOf(nested),
    };
  }
  if (selection.kind === Kind.INLINE_FRAGMENT) {
    const cond = selection.typeCondition?.name.value ?? typeName;
    if (
      subschema.transformedSchema.getType(cond) == null &&
      subschema.schema.getType(cond) == null
    ) {
      return null;
    }
    const nested: SelectionNode[] = [];
    for (const sel of selection.selectionSet.selections) {
      const kept = filterSelectionTreeForSubschema(
        subschema,
        cond,
        sel,
        stitchingInfo,
        gatewaySchema,
        providedFieldNames,
      );
      if (kept) {
        nested.push(kept);
      }
    }
    if (!nested.length) {
      return null;
    }
    return {
      ...selection,
      selectionSet: selectionSetOf(nested),
    };
  }
  return null;
}

/** Strip bridge selections to fields the Fetch's subschema can actually query. */
function filterBridgesForRootFetch(
  node: StitchPlanNode,
  bridges: readonly SelectionNode[],
  stitchingInfo: StitchingInfo,
  gatewaySchema: GraphQLSchema,
  parentTypeName: string,
): SelectionNode[] {
  if (node.kind !== 'Fetch' || !node.rootField) {
    return [];
  }
  const kept: SelectionNode[] = [];
  for (const bridge of bridges) {
    const filtered = filterSelectionTreeForSubschema(
      node.subschema,
      parentTypeName,
      bridge,
      stitchingInfo,
      gatewaySchema,
    );
    if (filtered) {
      kept.push(filtered);
    }
  }
  return kept;
}

/** Add selections (e.g. requires bridges) into every root Fetch of a plan node. */
function injectSelectionsIntoRootFetches(
  node: StitchPlanNode,
  extra: readonly SelectionNode[],
  /**
   * When set, each Fetch only receives the subset of `extra` valid on its
   * subschema (nested key fields like Product.pid on PRODUCTS are dropped).
   */
  filterCtx?: {
    stitchingInfo: StitchingInfo;
    gatewaySchema: GraphQLSchema;
    parentTypeName: string;
  },
): StitchPlanNode {
  if (node.kind === 'Fetch' && node.rootField) {
    const toInject = filterCtx
      ? filterBridgesForRootFetch(
          node,
          extra,
          filterCtx.stitchingInfo,
          filterCtx.gatewaySchema,
          filterCtx.parentTypeName,
        )
      : extra;
    if (!toInject.length) {
      return node;
    }
    const selectionSet = selectionSetOf([
      ...(node.rootField.selectionSet?.selections ?? []),
      ...toInject,
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
      nodes: node.nodes.map((n) =>
        injectSelectionsIntoRootFetches(n, extra, filterCtx),
      ),
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

  // Avoid planning the same nested entity path twice — once from a delegation
  // map selection (deep reviews tree) and again from the original fieldNodes.
  const plannedNestedKeys = new Set<string>();
  const nestedKey = (
    hopType: string,
    path: Array<string | number>,
  ): string => `${hopType}::${path.join('\0')}`;

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
          const key = nestedKey(concrete.name, childPath);
          if (plannedNestedKeys.has(key)) {
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
            plannedNestedKeys.add(key);
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
      const key = nestedKey(childTypeName, childPath);
      if (plannedNestedKeys.has(key)) {
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
        plannedNestedKeys.add(key);
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
    // Order leftovers by @requires edges among themselves (byNovice before
    // byExpert in requires-circular). Independent leftovers stay Parallel.
    const leftoverEntries = [...leftoverByTarget.entries()];
    const leftoverFieldNodes = leftoverEntries.flatMap(([, fields]) => fields);
    const leftoverNames = new Set(leftoverFieldNodes.map((f) => f.name.value));
    const dependsOnLeftover = (fieldName: string): string[] => {
      const deps = stitchingInfo.fieldNodesByField?.[typeName]?.[fieldName];
      if (!deps?.length) {
        return [];
      }
      return deps
        .map((d) => d.name.value)
        .filter((n) => n !== fieldName && leftoverNames.has(n));
    };
    const hasCrossDeps = leftoverFieldNodes.some(
      (f) => dependsOnLeftover(f.name.value).length > 0,
    );
    if (!hasCrossDeps) {
      if (leftoverByTarget.size === 1) {
        const [target, fields] = leftoverEntries[0]!;
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
          nodes: leftoverEntries.map(([target, fields]) => ({
            kind: 'Fetch' as const,
            subschema: target,
            entityTypeName: typeName,
            selectionSet: ensureTypename(selectionSetOf(fields)),
            flattenPath,
          })),
        });
      }
    } else {
      // Topological batches: fields with no unmet leftover deps first.
      const remaining = new Map(
        leftoverFieldNodes.map((f) => [f.name.value, f] as const),
      );
      const ownerOf = new Map<string, Subschema>();
      for (const [target, fields] of leftoverEntries) {
        for (const f of fields) {
          ownerOf.set(f.name.value, target);
        }
      }
      const orderedBatches: FieldNode[][] = [];
      while (remaining.size) {
        const batch: FieldNode[] = [];
        for (const [name, field] of remaining) {
          const unmet = dependsOnLeftover(name).filter((d) => remaining.has(d));
          if (!unmet.length) {
            batch.push(field);
          }
        }
        if (!batch.length) {
          // Cycle fallback — emit the rest in one parallel group.
          batch.push(...remaining.values());
          remaining.clear();
        } else {
          for (const f of batch) {
            remaining.delete(f.name.value);
          }
        }
        orderedBatches.push(batch);
      }
      const batchNodes: StitchPlanNode[] = orderedBatches.map((batch) => {
        const byTarget = new Map<Subschema, FieldNode[]>();
        for (const f of batch) {
          const target = ownerOf.get(f.name.value)!;
          let list = byTarget.get(target);
          if (!list) {
            list = [];
            byTarget.set(target, list);
          }
          list.push(f);
        }
        if (byTarget.size === 1) {
          const [target, fields] = [...byTarget.entries()][0]!;
          return {
            kind: 'Fetch' as const,
            subschema: target,
            entityTypeName: typeName,
            selectionSet: ensureTypename(selectionSetOf(fields)),
            flattenPath,
          };
        }
        return {
          kind: 'Parallel' as const,
          nodes: [...byTarget.entries()].map(([target, fields]) => ({
            kind: 'Fetch' as const,
            subschema: target,
            entityTypeName: typeName,
            selectionSet: ensureTypename(selectionSetOf(fields)),
            flattenPath,
          })),
        };
      });
      if (batchNodes.length === 1) {
        stages.push(batchNodes[0]!);
      } else {
        stages.push({ kind: 'Sequence', nodes: batchNodes });
      }
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
    // Abstract return types: Hive-QP-style concrete expansion so subgraph
    // queries stay valid (`... on Oven` under Node on A is stripped; `... on
    // Node { id }` under Product expands to Oven+Toaster).
    if (returnType && isAbstractType(returnType) && fieldNode.selectionSet) {
      const mediaProvidesOrigin: ProvidesOrigin = {
        parentTypeName: rootType.name,
        parentFieldName: fieldName,
      };
      const expanded = expandAbstractSelectionsForSubschema(
        owner,
        returnTypeName!,
        fieldNode.selectionSet,
        fragments,
        stitchingInfo,
        schema,
        provided,
        mediaProvidesOrigin,
      );
      const available: SelectionNode[] = [...expanded.available];
      const unavailable: SelectionNode[] = [...expanded.unavailable];
      // Retain nested object-field partitioning for rare abstract.field { … }
      // selections (not fragment-shaped) that expand left as FIELD nodes.
      for (const sel of [...available]) {
        if (sel.kind !== Kind.FIELD || !sel.selectionSet) {
          continue;
        }
        if (sel.name.value === '__typename') {
          continue;
        }
        const nestedProvided = getProvidedFieldNames(
          stitchingInfo,
          returnTypeName!,
          sel.name.value,
          owner,
        );
        const fieldDef = (
          schema.getType(returnTypeName!) ??
          owner.transformedSchema.getType(returnTypeName!) ??
          owner.schema.getType(returnTypeName!)
        ) as GraphQLObjectType | undefined;
        const nestedReturn = fieldDef?.getFields()?.[sel.name.value]
          ? getNamedType(fieldDef.getFields()[sel.name.value]!.type)
          : undefined;
        if (!nestedReturn || !isAbstractType(nestedReturn) && !isObjectType(nestedReturn)) {
          continue;
        }
        if (isAbstractType(nestedReturn)) {
          const nested = expandAbstractSelectionsForSubschema(
            owner,
            nestedReturn.name,
            sel.selectionSet,
            fragments,
            stitchingInfo,
            schema,
            nestedProvided.size ? nestedProvided : provided,
            {
              parentTypeName: returnTypeName!,
              parentFieldName: sel.name.value,
            },
          );
          const idx = available.indexOf(sel);
          if (nested.available.length) {
            available[idx] = {
              ...sel,
              selectionSet: ensureTypename(selectionSetOf(nested.available)),
            };
          } else {
            available.splice(idx, 1);
          }
          if (nested.unavailable.length) {
            unavailable.push({
              ...sel,
              selectionSet: selectionSetOf(nested.unavailable),
            });
          }
          continue;
        }
        const nested = partitionSelectionsForSubschema(
          owner,
          nestedReturn.name,
          sel.selectionSet,
          fragments,
          nestedProvided.size ? nestedProvided : provided,
          stitchingInfo,
          schema,
          {
            parentTypeName: returnTypeName!,
            parentFieldName: sel.name.value,
          },
        );
        const idx = available.indexOf(sel);
        if (nested.available.length) {
          available[idx] = {
            ...sel,
            selectionSet: ensureTypename(selectionSetOf(nested.available)),
          };
        } else if (nested.unavailable.length) {
          available[idx] = {
            ...sel,
            selectionSet: selectionSetOf([
              {
                kind: Kind.FIELD,
                name: { kind: Kind.NAME, value: '__typename' },
              },
            ]),
          };
        }
        if (nested.unavailable.length && nested.available.length) {
          unavailable.push({
            ...sel,
            selectionSet: selectionSetOf(nested.unavailable),
          });
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

  // Hive QP: bare fields on an abstract root (node { id }) need a subgraph that
  // can resolve the field for every runtime type it may return. Complementary
  // Parallel fetches (`A: ... on Account { id }` + `B: ... on Chat { id }`) are
  // not a valid path — corrupted-supergraph-node-id expects plan failure.
  // Only when multiple root owners contribute: a single owner can finish via
  // entity hops (override-type-interface createdAt, @interfaceObject).
  if (
    returnType &&
    isAbstractType(returnType) &&
    fieldNode.selectionSet &&
    usedPartitions.length > 1
  ) {
    for (const sel of fieldNode.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD || sel.name.value === '__typename') {
        continue;
      }
      const bareName = sel.name.value;
      const resolvableOnSomeOwner = usedPartitions.some((p) => {
        // @interfaceObject: no local concretes — interface-level fields are OK.
        const localConcretes = concretesOnSubschema(
          p.owner,
          returnType.name,
          schema,
        );
        if (!localConcretes.length) {
          return fieldFetchableOnSubschema(
            stitchingInfo,
            p.owner,
            returnType.name,
            bareName,
            p.provided,
          );
        }
        // Every concrete this subgraph may return must own the field locally.
        return localConcretes.every((c) =>
          fieldFetchableOnSubschema(
            stitchingInfo,
            p.owner,
            c.name,
            bareName,
            p.provided,
          ),
        );
      });
      if (!resolvableOnSomeOwner) {
        incompleteReasons.push(
          `No paths found for selection item: ${fieldName} (unresolvable interface field ${bareName})`,
        );
        return {
          kind: 'Island',
          parentTypeName: rootType.name,
          fieldNode,
        };
      }
    }
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
      // Also collect field names covered under concrete fragments
      // (`... on Book { animals }`) so partial hops still attach.
      for (const a of p.available) {
        if (a.kind === Kind.INLINE_FRAGMENT) {
          for (const nested of a.selectionSet.selections) {
            if (nested.kind === Kind.FIELD) {
              availNames.add(nested.name.value);
            }
          }
        }
      }
      for (const sel of p.unavailable ?? []) {
        // Concrete-expanded remainders: `... on Book { animals { ... on Cat { age } } }`
        // Skip fields another root partition already covered (B @provides title
        // must not spawn a punished C hop from A's unavailable Book.title).
        if (sel.kind === Kind.INLINE_FRAGMENT && sel.typeCondition) {
          const concreteName = sel.typeCondition.name.value;
          if (!stitchingInfo.mergedTypes[concreteName]) {
            continue;
          }
          const remnantFields: FieldNode[] = [];
          for (const fn of flattenToFieldNodes(
            sel.selectionSet.selections,
            fragments,
          )) {
            if (fn.name.value === '__typename') {
              continue;
            }
            if (!isFieldCovered(fn.name.value, concreteName)) {
              remnantFields.push(fn);
              continue;
            }
            // Field already fetched (animals via @provides id/name) — only keep
            // nested type-conditioned remnants (`... on Cat { age }`).
            if (!fn.selectionSet) {
              continue;
            }
            const onlyFragments = fn.selectionSet.selections.filter(
              (s) =>
                s.kind === Kind.INLINE_FRAGMENT ||
                s.kind === Kind.FRAGMENT_SPREAD,
            );
            if (onlyFragments.length) {
              remnantFields.push({
                ...fn,
                selectionSet: selectionSetOf(onlyFragments),
              });
            }
          }
          if (!remnantFields.length) {
            continue;
          }
          // Prefer the partition that already fetched the parent field
          // (B @provides animals) as the entity source — hopping from A
          // overwrites animals with null under PUNISH_FOR_POOR_PLANS.
          let sourceOwner = p.owner;
          let bestScore = -1;
          for (const op of usedPartitions) {
            for (const a of op.available) {
              if (
                a.kind !== Kind.INLINE_FRAGMENT ||
                a.typeCondition?.name.value !== concreteName
              ) {
                continue;
              }
              const score = a.selectionSet.selections.length;
              if (score > bestScore) {
                bestScore = score;
                sourceOwner = op.owner;
              }
            }
          }
          // Deduplicate: only emit from the first unavailable we see once the
          // best source is known — skip if this partition isn't that source
          // and another partition already covers the concrete.
          if (bestScore >= 0 && sourceOwner !== p.owner) {
            continue;
          }
          const child = planMergedTypeFollowUps(
            schema,
            stitchingInfo,
            concreteName,
            sourceOwner,
            remnantFields,
            fragments,
            variableValues,
            [fieldNode.alias?.value ?? fieldNode.name.value],
            incompleteReasons,
          );
          if (child) {
            partialUnavailableFollowUps.push(child);
          }
          continue;
        }
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
        const nestedResponseKey = sel.alias?.value ?? sel.name.value;
        const rootKey = fieldNode.alias?.value ?? fieldNode.name.value;
        if (isAbstractType(namedReturn)) {
          // @interfaceObject parent (Media on C): hop on the interface type
          // first — concrete Video has no edge from C, but Media → A does.
          const absMerged = stitchingInfo.mergedTypes[namedReturn.name];
          if (
            absMerged?.targetSubschemas != null &&
            absMerged.targetSubschemas.size > 0
          ) {
            const child = planMergedTypeFollowUps(
              schema,
              stitchingInfo,
              namedReturn.name,
              p.owner,
              [],
              fragments,
              variableValues,
              [rootKey, nestedResponseKey],
              incompleteReasons,
              sel.selectionSet.selections,
            );
            if (child) {
              partialUnavailableFollowUps.push(child);
              continue;
            }
          }
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
              [rootKey, nestedResponseKey],
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
          // Nested object remainder. Prefer a parent-entity hop (Hive QP:
          // Book ← author { name }), not a hop onto a non-merged child type.
          const nestedFields = flattenToFieldNodes(
            sel.selectionSet.selections,
            fragments,
          );
          const parentHop = planMergedTypeFollowUps(
            schema,
            stitchingInfo,
            namedReturn.name,
            p.owner,
            nestedFields,
            fragments,
            variableValues,
            [rootKey, nestedResponseKey],
            incompleteReasons,
          );
          if (parentHop) {
            partialUnavailableFollowUps.push(parentHop);
            continue;
          }
          // parent-entity-call: Category.details is only reachable via Product
          // on C — delegationPlanBuilder returns empty for Category/Product
          // from A. Scan subgraphs for an entity that can satisfy the nested
          // path (Hive: Product → C { category { details } }).
          if (
            returnTypeName &&
            stitchingInfo.mergedTypes[returnTypeName] &&
            sel.kind === Kind.FIELD
          ) {
            const enclosingHop = planParentEntityNestedHop(
              schema,
              stitchingInfo,
              returnTypeName,
              p.owner,
              sel,
              [rootKey],
              fragments,
            );
            if (enclosingHop) {
              partialUnavailableFollowUps.push(enclosingHop);
              continue;
            }
          }
          // Fall back: deeper merged child (categories.subCategories { name }).
          for (const nestedFn of nestedFields) {
            if (!nestedFn.selectionSet) {
              continue;
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
                    nestedResponseKey,
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
                  nestedResponseKey,
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

  const nestedPrereqNode = (): StitchPlanNode | null => {
    if (!partialUnavailableFollowUps.length) {
      return null;
    }
    return partialUnavailableFollowUps.length === 1
      ? partialUnavailableFollowUps[0]!
      : { kind: 'Parallel' as const, nodes: partialUnavailableFollowUps };
  };

  /**
   * Hive QP orders key-providing nested hops (Product.pid via LINK) before
   * parent-entity hops that need those keys (ProductList → LIST). Sequence:
   * root → nested prereqs → parent follow-ups.
   */
  const sequenceRootFollowUps = (
    rooted: StitchPlanNode,
    followUp: StitchPlanNode | null,
  ): StitchPlanNode => {
    const parts: StitchPlanNode[] = [rooted];
    const prereq = nestedPrereqNode();
    if (prereq) {
      parts.push(prereq);
    }
    if (followUp) {
      parts.push(followUp);
    }
    return parts.length === 1
      ? parts[0]!
      : { kind: 'Sequence', nodes: parts };
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
          ? injectSelectionsIntoRootFetches(rooted, keySels, {
              stitchingInfo,
              gatewaySchema: schema,
              parentTypeName: returnType.name,
            })
          : rooted;
        return sequenceRootFollowUps(withKeys, child);
      }
      return sequenceRootFollowUps(rooted, null);
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
      // Only inject concrete fragments that the subgraph can spread under the
      // abstract parent (Hive QP never sends `... on Oven` under Node on A).
      if (
        bridge.length &&
        canSpreadOnSubschema(primary, returnType.name, concrete.name)
      ) {
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
      rooted = injectSelectionsIntoRootFetches(rootNode, bridgeFragments, {
        stitchingInfo,
        gatewaySchema: schema,
        parentTypeName: returnType.name,
      });
    }

    if (concreteFollowUps.length === 1) {
      return sequenceRootFollowUps(rooted, concreteFollowUps[0]!);
    }
    if (concreteFollowUps.length > 1) {
      return sequenceRootFollowUps(rooted, {
        kind: 'Parallel',
        nodes: concreteFollowUps,
      });
    }
    return sequenceRootFollowUps(rooted, null);
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
    // Nested key fields not owned by the root subgraph (Product.pid on
    // PRODUCTS) are stripped — Hive fetches them via an earlier entity hop.
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
      rooted = injectSelectionsIntoRootFetches(rooted, bridges, {
        stitchingInfo,
        gatewaySchema: schema,
        parentTypeName: returnTypeName,
      });
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
    return sequenceRootFollowUps(rooted, followUp);
  }

  return sequenceRootFollowUps(rootNode, null);
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

/** Stable identity for coalescing sibling/adjacent Fetches (includes path). */
function coalesceFetchKey(
  node: Extract<StitchPlanNode, { kind: 'Fetch' }>,
): string | null {
  const sub = node.subschema.name ?? '';
  const paths =
    node.flattenPaths ??
    (node.flattenPath != null ? [node.flattenPath] : null);
  if (node.entityTypeName && paths?.length) {
    return `e:${sub}:${node.entityTypeName}:${paths.map((p) => p.join('\0')).join('/')}`;
  }
  if (node.rootField) {
    const rk = node.rootField.alias?.value ?? node.rootField.name.value;
    return `r:${sub}:${rk}`;
  }
  return null;
}

function selectionIdentity(sel: SelectionNode): string {
  if (sel.kind === Kind.FIELD) {
    const args = sel.arguments?.length
      ? JSON.stringify(sel.arguments.map((a) => [a.name.value, a.value]))
      : '';
    return `f:${sel.alias?.value ?? ''}:${sel.name.value}:${args}`;
  }
  if (sel.kind === Kind.INLINE_FRAGMENT) {
    return `i:${sel.typeCondition?.name.value ?? ''}`;
  }
  if (sel.kind === Kind.FRAGMENT_SPREAD) {
    return `s:${sel.name.value}`;
  }
  return '?';
}

function selectionSetKey(ss: SelectionSetNode): string {
  return ss.selections.map(selectionIdentity).join(',');
}

/** Batch key ignores flatten path — same entity selection across paths. */
function entityBatchKey(
  node: Extract<StitchPlanNode, { kind: 'Fetch' }>,
): string | null {
  if (node.rootField || !node.entityTypeName) {
    return null;
  }
  const paths =
    node.flattenPaths ??
    (node.flattenPath != null ? [node.flattenPath] : null);
  if (!paths?.length) {
    return null;
  }
  return `${node.subschema.name ?? ''}|${node.entityTypeName}|${selectionSetKey(node.selectionSet)}`;
}

/** Same subgraph entity (selection/path ignored) — candidate for field union. */
function entityTypeKey(
  node: Extract<StitchPlanNode, { kind: 'Fetch' }>,
): string | null {
  if (node.rootField || !node.entityTypeName) {
    return null;
  }
  if (!fetchFlattenPaths(node).length) {
    return null;
  }
  return `${node.subschema.name ?? ''}|${node.entityTypeName}`;
}

function fieldResponseKey(field: FieldNode): string {
  return field.alias?.value ?? field.name.value;
}

function fieldArgsKey(field: FieldNode): string {
  if (!field.arguments?.length) {
    return '';
  }
  return JSON.stringify(field.arguments.map((a) => [a.name.value, a.value]));
}

function pathsHaveNesting(paths: PathSegment[][]): boolean {
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths.length; j++) {
      if (i !== j && pathIsPrefix(paths[i]!, paths[j]!)) {
        return true;
      }
    }
  }
  return false;
}

function pathsEqual(a: PathSegment[], b: PathSegment[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/**
 * Locate merge field config across computed-isolation Subschema clones that
 * share a name but split `merge.fields` (e.g. shippingEstimate vs EUR).
 */
function findMergeFieldConfig(
  stitchingInfo: StitchingInfo,
  subschema: Subschema,
  typeName: string,
  fieldName: string,
) {
  const direct = subschema.merge?.[typeName]?.fields?.[fieldName];
  if (direct?.selectionSet || direct?.computed) {
    return direct;
  }
  for (const s of stitchingInfo.subschemaMap.values()) {
    if (subschema.name && s.name !== subschema.name) {
      continue;
    }
    const field = s.merge?.[typeName]?.fields?.[fieldName];
    if (field?.selectionSet || field?.computed) {
      return field;
    }
  }
  return undefined;
}

/** @requires bridge field nodes for one client field on a merge target. */
function requiresDepsForField(
  stitchingInfo: StitchingInfo,
  subschema: Subschema,
  typeName: string,
  fieldName: string,
): FieldNode[] {
  if (fieldName === '__typename') {
    return [];
  }
  const mergeField = findMergeFieldConfig(
    stitchingInfo,
    subschema,
    typeName,
    fieldName,
  );
  if (!mergeField?.selectionSet && !mergeField?.computed) {
    return [];
  }
  return stitchingInfo.fieldNodesByField?.[typeName]?.[fieldName] ?? [];
}

/**
 * Collect @requires deps for every field in a Fetch selection. Used both for
 * selection-union safety (arg conflicts) and wave dependency edges.
 */
function collectRequiresDeps(
  stitchingInfo: StitchingInfo,
  fetch: Extract<StitchPlanNode, { kind: 'Fetch' }>,
): FieldNode[] {
  if (!fetch.entityTypeName) {
    return [];
  }
  const deps: FieldNode[] = [];
  for (const sel of fetch.selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) {
      continue;
    }
    deps.push(
      ...requiresDepsForField(
        stitchingInfo,
        fetch.subschema,
        fetch.entityTypeName,
        sel.name.value,
      ),
    );
  }
  return deps;
}


function collectSelectedFieldNames(
  selectionSet: SelectionSetNode,
): Set<string> {
  const names = new Set<string>();
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      names.add(sel.name.value);
    }
  }
  return names;
}

/**
 * True when two selections can share one _entities Fetch: no @requires key
 * argument conflicts (requires-with-argument-conflict must stay split).
 */
function requiresArgsCompatible(
  stitchingInfo: StitchingInfo,
  a: Extract<StitchPlanNode, { kind: 'Fetch' }>,
  b: Extract<StitchPlanNode, { kind: 'Fetch' }>,
): boolean {
  const byName = new Map<string, string>();
  for (const dep of [
    ...collectRequiresDeps(stitchingInfo, a),
    ...collectRequiresDeps(stitchingInfo, b),
  ]) {
    const args = fieldArgsKey(dep);
    const prev = byName.get(dep.name.value);
    if (prev != null && prev !== args) {
      return false;
    }
    byName.set(dep.name.value, args);
  }
  return true;
}

function selectionsCompatibleForUnion(
  a: SelectionSetNode,
  b: SelectionSetNode,
): boolean {
  const aFields = new Map<string, FieldNode>();
  for (const sel of a.selections) {
    if (sel.kind === Kind.FIELD) {
      aFields.set(fieldResponseKey(sel), sel);
    }
  }
  for (const sel of b.selections) {
    if (sel.kind !== Kind.FIELD) {
      continue;
    }
    const key = fieldResponseKey(sel);
    const prior = aFields.get(key);
    if (!prior) {
      continue;
    }
    if (
      prior.name.value !== sel.name.value ||
      fieldArgsKey(prior) !== fieldArgsKey(sel)
    ) {
      return false;
    }
    if (prior.selectionSet && sel.selectionSet) {
      if (!selectionsCompatibleForUnion(prior.selectionSet, sel.selectionSet)) {
        return false;
      }
    } else if (prior.selectionSet || sel.selectionSet) {
      return false;
    }
  }
  return true;
}

function unionSelectionSets(
  a: SelectionSetNode,
  b: SelectionSetNode,
): SelectionSetNode {
  const byKey = new Map<string, SelectionNode>();
  const add = (sel: SelectionNode) => {
    if (sel.kind === Kind.FIELD) {
      const key = `f:${fieldResponseKey(sel)}`;
      const prior = byKey.get(key);
      if (!prior || prior.kind !== Kind.FIELD) {
        byKey.set(key, sel);
        return;
      }
      if (prior.selectionSet && sel.selectionSet) {
        byKey.set(key, {
          ...prior,
          selectionSet: unionSelectionSets(
            prior.selectionSet,
            sel.selectionSet,
          ),
        });
      }
      return;
    }
    byKey.set(selectionIdentity(sel), sel);
  };
  for (const sel of a.selections) {
    add(sel);
  }
  for (const sel of b.selections) {
    add(sel);
  }
  return { kind: Kind.SELECTION_SET, selections: [...byKey.values()] };
}

/**
 * Merge entity Fetches on the same subgraph type into one multi-path Fetch
 * with a unioned selection when @requires keys don't conflict.
 */
function tryUnionEntityFetches(
  stitchingInfo: StitchingInfo,
  fetches: Array<Extract<StitchPlanNode, { kind: 'Fetch' }>>,
): Extract<StitchPlanNode, { kind: 'Fetch' }> | null {
  if (fetches.length < 2) {
    return null;
  }
  const typeKey = entityTypeKey(fetches[0]!);
  if (!typeKey || fetches.some((f) => entityTypeKey(f) !== typeKey)) {
    return null;
  }
  const pathMap = new Map<string, PathSegment[]>();
  for (const p of fetches.flatMap(fetchFlattenPaths)) {
    pathMap.set(p.join('\0'), p);
  }
  const paths = [...pathMap.values()];
  if (!paths.length || pathsHaveNesting(paths)) {
    return null;
  }
  // Do not union different field sets across different flatten paths when any
  // side has @requires — that would schedule shippingEstimate on deep paths
  // before PRODUCTS weight is available (Hive keeps those waves separate).
  const pathKeys = new Set(
    fetches.map((f) =>
      fetchFlattenPaths(f)
        .map((p) => p.join('\0'))
        .sort()
        .join('/'),
    ),
  );
  const requiresCounts = fetches.map(
    (f) => collectRequiresDeps(stitchingInfo, f).length,
  );
  const fetchesWithRequires = requiresCounts.filter((n) => n > 0).length;
  // At most one hop in the union may carry @requires fields. This allows
  // inStock (no requires) ∪ shippingEstimate, but keeps requires-circular /
  // requires-with-argument sibling computed fields in separate Fetches.
  if (fetchesWithRequires > 1) {
    return null;
  }
  if (pathKeys.size > 1 && fetchesWithRequires > 0) {
    return null;
  }
  for (let i = 0; i < fetches.length; i++) {
    for (let j = i + 1; j < fetches.length; j++) {
      if (!requiresArgsCompatible(stitchingInfo, fetches[i]!, fetches[j]!)) {
        return null;
      }
      if (
        !selectionsCompatibleForUnion(
          fetches[i]!.selectionSet,
          fetches[j]!.selectionSet,
        )
      ) {
        return null;
      }
    }
  }
  let selectionSet = fetches[0]!.selectionSet;
  for (let i = 1; i < fetches.length; i++) {
    selectionSet = unionSelectionSets(selectionSet, fetches[i]!.selectionSet);
  }
  // Reject unions where one selected field @requires another selected
  // computed field (requires-circular: byExpert needs byNovice first).
  const selected = collectSelectedFieldNames(selectionSet);
  const template = fetches[0]!;
  for (const name of selected) {
    const deps = requiresDepsForField(
      stitchingInfo,
      template.subschema,
      template.entityTypeName!,
      name,
    );
    for (const dep of deps) {
      if (dep.name.value === name || !selected.has(dep.name.value)) {
        continue;
      }
      const depMerge = findMergeFieldConfig(
        stitchingInfo,
        template.subschema,
        template.entityTypeName!,
        dep.name.value,
      );
      if (depMerge?.selectionSet || depMerge?.computed) {
        return null;
      }
    }
  }
  return {
    kind: 'Fetch',
    subschema: template.subschema,
    entityTypeName: template.entityTypeName,
    selectionSet,
    flattenPath: paths[0],
    flattenPaths: paths,
  };
}

/**
 * True when `selectionSet` nests fields matching `suffix` (path segments after
 * an earlier flatten path). Entity hops only "produce" deeper paths when their
 * selection actually returns those nested objects — hydrating inStock on
 * Product does not create Product.reviews.author.
 */
function selectionProducesPathSuffix(
  selectionSet: SelectionSetNode,
  suffix: PathSegment[],
): boolean {
  if (!suffix.length) {
    return true;
  }
  const head = suffix[0];
  if (typeof head !== 'string') {
    return selectionProducesPathSuffix(selectionSet, suffix.slice(1));
  }
  for (const sel of selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) {
      continue;
    }
    const key = sel.alias?.value ?? sel.name.value;
    if (key !== head) {
      continue;
    }
    if (suffix.length === 1) {
      return true;
    }
    if (sel.selectionSet) {
      return selectionProducesPathSuffix(sel.selectionSet, suffix.slice(1));
    }
  }
  return false;
}

/**
 * Parallel(PROVIDER…, INV_early), INV_late → [PROVIDER…, INV_early∪late]
 * when INV_late needs PROVIDER for @requires and the two INV hops can union.
 */
function trySinkRequiresUnion(
  parallel: Extract<StitchPlanNode, { kind: 'Parallel' }>,
  late: Extract<StitchPlanNode, { kind: 'Fetch' }>,
  stitchingInfo: StitchingInfo,
): StitchPlanNode | null {
  const lateKey = entityTypeKey(late);
  if (!lateKey) {
    return null;
  }
  let earlyIdx = -1;
  let early: Extract<StitchPlanNode, { kind: 'Fetch' }> | null = null;
  for (let i = 0; i < parallel.nodes.length; i++) {
    const n = parallel.nodes[i]!;
    if (n.kind === 'Fetch' && entityTypeKey(n) === lateKey) {
      earlyIdx = i;
      early = n;
      break;
    }
  }
  if (!early || earlyIdx < 0) {
    return null;
  }
  const providers = parallel.nodes.filter(
    (n, i) =>
      i !== earlyIdx &&
      n.kind === 'Fetch' &&
      fetchDependsOn(stitchingInfo, late, n),
  );
  if (!providers.length) {
    return null;
  }
  const united = tryUnionEntityFetches(stitchingInfo, [early, late]);
  if (!united) {
    return null;
  }
  const remaining = parallel.nodes.filter((_, i) => i !== earlyIdx);
  if (!remaining.length) {
    return united;
  }
  return {
    kind: 'Sequence',
    nodes: [toParOrSingle(remaining), united],
  };
}

/**
 * Does `later` need `earlier` to complete first? Path production or @requires.
 */
function fetchDependsOn(
  stitchingInfo: StitchingInfo,
  later: Extract<StitchPlanNode, { kind: 'Fetch' }>,
  earlier: Extract<StitchPlanNode, { kind: 'Fetch' }>,
): boolean {
  const laterPaths = fetchFlattenPaths(later);
  const earlierPaths = fetchFlattenPaths(earlier);
  if (earlier.rootField) {
    const rk =
      earlier.rootField.alias?.value ?? earlier.rootField.name.value;
    // Root Fetch produces the top segment; also check nested selection under it.
    for (const lp of laterPaths) {
      if (lp[0] !== rk) {
        continue;
      }
      if (lp.length === 1) {
        return true;
      }
      if (
        selectionProducesPathSuffix(earlier.selectionSet, lp.slice(1))
      ) {
        return true;
      }
    }
  }

  for (const lp of laterPaths) {
    for (const ep of earlierPaths) {
      if (!pathIsPrefix(ep, lp)) {
        continue;
      }
      const suffix = lp.slice(ep.length);
      if (selectionProducesPathSuffix(earlier.selectionSet, suffix)) {
        return true;
      }
    }
  }

  const reqNames = new Set(
    collectRequiresDeps(stitchingInfo, later).map((d) => d.name.value),
  );
  if (!reqNames.size) {
    return false;
  }
  const provided = collectSelectedFieldNames(earlier.selectionSet);
  let providesNeeded = false;
  for (const n of reqNames) {
    if (provided.has(n)) {
      providesNeeded = true;
      break;
    }
  }
  if (!providesNeeded) {
    return false;
  }
  // Requires edge only if paths relate (same / ancestor / root).
  if (earlier.rootField) {
    const rk =
      earlier.rootField.alias?.value ?? earlier.rootField.name.value;
    if (laterPaths.some((lp) => lp[0] === rk)) {
      return true;
    }
  }
  for (const lp of laterPaths) {
    for (const ep of earlierPaths) {
      // earlier must be at the same path or an ancestor path of later —
      // a deeper Fetch cannot satisfy requires for a shallower one.
      if (pathsEqual(lp, ep) || pathIsPrefix(ep, lp)) {
        return true;
      }
    }
  }
  return false;
}

function fetchFlattenPaths(
  node: Extract<StitchPlanNode, { kind: 'Fetch' }>,
): PathSegment[][] {
  if (node.flattenPaths?.length) {
    return node.flattenPaths.map((p) => [...p]);
  }
  if (node.flattenPath) {
    return [[...node.flattenPath]];
  }
  return [];
}

function pathIsPrefix(
  shorter: PathSegment[],
  longer: PathSegment[],
): boolean {
  if (shorter.length >= longer.length) {
    return false;
  }
  return shorter.every((seg, i) => seg === longer[i]);
}

function flattenSequenceNodes(node: StitchPlanNode): StitchPlanNode[] {
  if (node.kind === 'Sequence') {
    return node.nodes.flatMap(flattenSequenceNodes);
  }
  return [node];
}

function toSeqOrSingle(nodes: StitchPlanNode[]): StitchPlanNode {
  if (nodes.length === 1) {
    return nodes[0]!;
  }
  return { kind: 'Sequence', nodes };
}

function toParOrSingle(nodes: StitchPlanNode[]): StitchPlanNode {
  if (nodes.length === 1) {
    return nodes[0]!;
  }
  return { kind: 'Parallel', nodes };
}

type BatchLoc = {
  seqIdx: number;
  /** Index in the flattened sequence (Parallel wrapper or Fetch). */
  pos: number;
  /** When set, Fetch lives inside seq[pos] Parallel at this index. */
  parallelIdx?: number;
  fetch: Extract<StitchPlanNode, { kind: 'Fetch' }>;
};

function collectBatchLocs(seqs: StitchPlanNode[][]): BatchLoc[] {
  const locs: BatchLoc[] = [];
  for (let si = 0; si < seqs.length; si++) {
    const seq = seqs[si]!;
    for (let pos = 0; pos < seq.length; pos++) {
      const n = seq[pos]!;
      if (n.kind === 'Fetch') {
        if (entityTypeKey(n) || entityBatchKey(n)) {
          locs.push({ seqIdx: si, pos, fetch: n });
        }
      } else if (n.kind === 'Parallel') {
        for (let pi = 0; pi < n.nodes.length; pi++) {
          const c = n.nodes[pi]!;
          if (c.kind === 'Fetch' && (entityTypeKey(c) || entityBatchKey(c))) {
            locs.push({
              seqIdx: si,
              pos,
              parallelIdx: pi,
              fetch: c,
            });
          }
        }
      }
    }
  }
  return locs;
}

/** Remove a batched Fetch from its sequence, returning { prefix, suffix }. */
function splitSeqAroundLoc(
  seq: StitchPlanNode[],
  loc: BatchLoc,
): { prefix: StitchPlanNode[]; suffix: StitchPlanNode[] } {
  const pos = loc.pos;
  if (loc.parallelIdx == null) {
    return {
      prefix: seq.slice(0, pos),
      suffix: seq.slice(pos + 1),
    };
  }
  const par = seq[pos]!;
  if (par.kind !== 'Parallel') {
    return { prefix: seq.slice(0, pos), suffix: seq.slice(pos + 1) };
  }
  const remaining = par.nodes.filter((_, i) => i !== loc.parallelIdx);
  const prefix = seq.slice(0, pos);
  const suffix = seq.slice(pos + 1);
  if (remaining.length === 1) {
    return {
      prefix: [...prefix, remaining[0]!],
      suffix,
    };
  }
  if (remaining.length > 1) {
    return {
      prefix: [...prefix, { kind: 'Parallel', nodes: remaining }],
      suffix,
    };
  }
  return { prefix, suffix };
}

/**
 * Hive-QP BatchFetch: across Parallel branches that are Sequences, hoist
 * identical entity selections at different flatten paths into one multi-path
 * Fetch between the prefixes and suffixes of those sequences.
 */
function tryCrossBatchSequences(
  parallelNodes: StitchPlanNode[],
  _stitchingInfo: StitchingInfo,
): StitchPlanNode | null {
  if (parallelNodes.length < 2) {
    return null;
  }
  const seqs = parallelNodes.map((n) => flattenSequenceNodes(n));
  const allLocs = collectBatchLocs(seqs);
  // Identical selection only across sequences (safe BatchFetch). Field-set
  // union across sequences is handled by adjacent/Parallel same-path union.
  const byKey = new Map<string, BatchLoc[]>();
  for (const loc of allLocs) {
    const key = entityBatchKey(loc.fetch);
    if (!key) {
      continue;
    }
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
    }
    list.push(loc);
  }

  let best: BatchLoc[] | null = null;
  for (const locs of byKey.values()) {
    const latestBySeq = new Map<number, BatchLoc>();
    for (const loc of locs) {
      const prev = latestBySeq.get(loc.seqIdx);
      if (
        !prev ||
        loc.pos > prev.pos ||
        (loc.pos === prev.pos &&
          (loc.parallelIdx ?? 0) > (prev.parallelIdx ?? 0))
      ) {
        latestBySeq.set(loc.seqIdx, loc);
      }
    }
    const uniq = [...latestBySeq.values()];
    if (uniq.length < 2) {
      continue;
    }
    const paths = uniq.flatMap((l) => fetchFlattenPaths(l.fetch));
    if (pathsHaveNesting(paths)) {
      continue;
    }
    if (!best || uniq.length > best.length) {
      best = uniq;
    }
  }
  if (!best) {
    return null;
  }

  const batchPaths = best.flatMap((l) => fetchFlattenPaths(l.fetch));
  const pathMap = new Map<string, PathSegment[]>();
  for (const p of batchPaths) {
    pathMap.set(p.join('\0'), p);
  }
  const dedupedPaths = [...pathMap.values()];
  const template = best[0]!.fetch;
  const batchFetch: Extract<StitchPlanNode, { kind: 'Fetch' }> = {
    kind: 'Fetch',
    subschema: template.subschema,
    entityTypeName: template.entityTypeName,
    selectionSet: template.selectionSet,
    flattenPath: dedupedPaths[0],
    flattenPaths: dedupedPaths,
  };

  const locBySeq = new Map(best.map((l) => [l.seqIdx, l]));
  const prefixes: StitchPlanNode[] = [];
  const suffixes: StitchPlanNode[] = [];
  const untouched: StitchPlanNode[] = [];

  for (let si = 0; si < seqs.length; si++) {
    const loc = locBySeq.get(si);
    const seq = seqs[si]!;
    if (!loc) {
      untouched.push(toSeqOrSingle(seq));
      continue;
    }
    const { prefix, suffix } = splitSeqAroundLoc(seq, loc);
    if (prefix.length) {
      prefixes.push(toSeqOrSingle(prefix));
    }
    if (suffix.length) {
      suffixes.push(toSeqOrSingle(suffix));
    }
  }

  const batchChain: StitchPlanNode[] = [];
  if (prefixes.length) {
    batchChain.push(toParOrSingle(prefixes));
  }
  batchChain.push(batchFetch);
  if (suffixes.length) {
    batchChain.push(toParOrSingle(suffixes));
  }
  const batched = toSeqOrSingle(batchChain);
  if (!untouched.length) {
    return batched;
  }
  return { kind: 'Parallel', nodes: [...untouched, batched] };
}

function mergeMultiPathFetches(
  fetches: Array<Extract<StitchPlanNode, { kind: 'Fetch' }>>,
): Extract<StitchPlanNode, { kind: 'Fetch' }> {
  const paths = fetches.flatMap(fetchFlattenPaths);
  const template = fetches[0]!;
  return {
    kind: 'Fetch',
    subschema: template.subschema,
    entityTypeName: template.entityTypeName,
    selectionSet: template.selectionSet,
    flattenPath: paths[0],
    flattenPaths: paths,
  };
}

/**
 * Plan cleanup:
 * - Flatten nested Sequence/Parallel of the same kind (except Parallel root
 *   fan-outs that must keep sameKey isolation)
 * - Drop exact-duplicate Fetches left by double nested planning
 */
function optimizeStitchPlanNode(
  node: StitchPlanNode,
  stitchingInfo: StitchingInfo,
): StitchPlanNode {
  if (node.kind === 'Island') {
    return node.continue
      ? {
          ...node,
          continue: optimizeStitchPlanNode(node.continue, stitchingInfo),
        }
      : node;
  }
  if (node.kind !== 'Sequence' && node.kind !== 'Parallel') {
    return node;
  }

  const kind = node.kind;
  const hasRootFetch = (n: StitchPlanNode): boolean => {
    if (n.kind === 'Fetch') {
      return Boolean(n.rootField);
    }
    if (n.kind === 'Parallel' || n.kind === 'Sequence') {
      return n.nodes.some(hasRootFetch);
    }
    if (n.kind === 'Island') {
      return true;
    }
    return false;
  };
  const flat: StitchPlanNode[] = [];
  for (const child of node.nodes.map((c) =>
    optimizeStitchPlanNode(c, stitchingInfo),
  )) {
    // Do not flatten Parallel groups that contain root Fetches — shared-root
    // sameKey isolation (account vs chat) requires each alias's fan-out to stay
    // in its own Parallel unit.
    if (
      child.kind === kind &&
      !(kind === 'Parallel' && hasRootFetch(child))
    ) {
      flat.push(...child.nodes);
    } else {
      flat.push(child);
    }
  }

  // Parallel: same-path field union (inStock∥shippingEstimate), then multi-path
  // BatchFetch for identical selections across flatten paths.
  const coalesced: StitchPlanNode[] = [];
  if (kind === 'Parallel') {
    const byTypePath = new Map<
      string,
      Array<Extract<StitchPlanNode, { kind: 'Fetch' }>>
    >();
    const nonEntity: StitchPlanNode[] = [];
    for (const child of flat) {
      if (child.kind !== 'Fetch' || !entityTypeKey(child)) {
        nonEntity.push(child);
        continue;
      }
      const pk = fetchFlattenPaths(child)
        .map((p) => p.join('\0'))
        .sort()
        .join('/');
      const key = `${entityTypeKey(child)}::${pk}`;
      let list = byTypePath.get(key);
      if (!list) {
        list = [];
        byTypePath.set(key, list);
      }
      list.push(child);
    }
    const afterUnion: StitchPlanNode[] = [...nonEntity];
    for (const group of byTypePath.values()) {
      const united = tryUnionEntityFetches(stitchingInfo, group);
      if (united) {
        afterUnion.push(united);
      } else {
        afterUnion.push(...group);
      }
    }
    const batchGroups = new Map<
      string,
      Array<Extract<StitchPlanNode, { kind: 'Fetch' }>>
    >();
    const rest: StitchPlanNode[] = [];
    const seenExact = new Set<string>();
    for (const child of afterUnion) {
      if (child.kind !== 'Fetch') {
        rest.push(child);
        continue;
      }
      const exact = coalesceFetchKey(child);
      if (exact) {
        const exactFull = `${exact}::${selectionSetKey(child.selectionSet)}`;
        if (seenExact.has(exactFull)) {
          continue;
        }
        seenExact.add(exactFull);
      }
      const bKey = entityBatchKey(child);
      if (bKey) {
        let list = batchGroups.get(bKey);
        if (!list) {
          list = [];
          batchGroups.set(bKey, list);
        }
        list.push(child);
      } else {
        rest.push(child);
      }
    }
    for (const group of batchGroups.values()) {
      if (group.length === 1) {
        coalesced.push(group[0]!);
      } else if (pathsHaveNesting(group.flatMap(fetchFlattenPaths))) {
        coalesced.push(...group);
      } else {
        coalesced.push(mergeMultiPathFetches(group));
      }
    }
    coalesced.push(...rest);
  } else {
    for (const child of flat) {
      const prev = coalesced[coalesced.length - 1];
      if (child.kind === 'Fetch' && prev?.kind === 'Fetch') {
        const a = coalesceFetchKey(prev);
        const b = coalesceFetchKey(child);
        if (
          a &&
          b &&
          a === b &&
          selectionSetKey(prev.selectionSet) ===
            selectionSetKey(child.selectionSet)
        ) {
          continue;
        }
        const united = tryUnionEntityFetches(stitchingInfo, [prev, child]);
        if (united) {
          coalesced[coalesced.length - 1] = united;
          continue;
        }
      }
      // Sink pattern: Parallel(PROVIDER, INV_a), INV_b → PROVIDER then INV_a∪b
      // when INV_b @requires fields from PROVIDER (Hive: one inventory hop).
      if (
        child.kind === 'Fetch' &&
        prev?.kind === 'Parallel' &&
        entityTypeKey(child)
      ) {
        const sunk = trySinkRequiresUnion(prev, child, stitchingInfo);
        if (sunk) {
          coalesced[coalesced.length - 1] = sunk;
          continue;
        }
      }
      coalesced.push(child);
    }
    const withinBatched = tryBatchWithinSequence(coalesced, stitchingInfo);
    if (withinBatched) {
      return optimizeStitchPlanNode(
        { kind: 'Sequence', nodes: withinBatched },
        stitchingInfo,
      );
    }
  }

  if (coalesced.length === 1) {
    return coalesced[0]!;
  }

  if (kind === 'Parallel') {
    const crossBatched = tryCrossBatchSequences(coalesced, stitchingInfo);
    if (crossBatched) {
      return optimizeStitchPlanNode(crossBatched, stitchingInfo);
    }
  }

  return { kind, nodes: coalesced };
}

/**
 * Within one Sequence, merge identical entity selections at different paths
 * into one multi-path Fetch placed at the latest occurrence (prefixes for all
 * paths have already run by then).
 */
function tryBatchWithinSequence(
  nodes: StitchPlanNode[],
  stitchingInfo: StitchingInfo,
): StitchPlanNode[] | null {
  const locs = collectBatchLocs([nodes]);
  const byKey = new Map<string, BatchLoc[]>();
  for (const loc of locs) {
    const key = entityBatchKey(loc.fetch);
    if (!key) {
      continue;
    }
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
    }
    list.push(loc);
  }

  let best: BatchLoc[] | null = null;
  for (const group of byKey.values()) {
    if (group.length < 2) {
      continue;
    }
    const paths = group.flatMap((l) => fetchFlattenPaths(l.fetch));
    const pathKeys = new Set(paths.map((p) => p.join('\0')));
    if (pathKeys.size < 2) {
      continue;
    }
    if (pathsHaveNesting(paths)) {
      continue;
    }
    if (!best || group.length > best.length) {
      best = group;
    }
  }
  if (!best) {
    return null;
  }

  // Place batch at the latest loc; remove all group members from the sequence.
  const sorted = [...best].sort(
    (a, b) =>
      a.pos - b.pos || (a.parallelIdx ?? 0) - (b.parallelIdx ?? 0),
  );
  const latest = sorted[sorted.length - 1]!;
  const batchPaths = best.flatMap((l) => fetchFlattenPaths(l.fetch));
  const pathMap = new Map<string, PathSegment[]>();
  for (const p of batchPaths) {
    pathMap.set(p.join('\0'), p);
  }
  const dedupedPaths = [...pathMap.values()];
  const template = latest.fetch;
  const batchFetch: Extract<StitchPlanNode, { kind: 'Fetch' }> = {
    kind: 'Fetch',
    subschema: template.subschema,
    entityTypeName: template.entityTypeName,
    selectionSet: template.selectionSet,
    flattenPath: dedupedPaths[0],
    flattenPaths: dedupedPaths,
  };

  // Rebuild sequence: walk positions, skip removed fetches, insert batch at latest.
  const removeSet = new Set(best);
  const out: StitchPlanNode[] = [];
  for (let pos = 0; pos < nodes.length; pos++) {
    const n = nodes[pos]!;
    const locsAtPos = best.filter((l) => l.pos === pos);
    if (!locsAtPos.length) {
      out.push(n);
      continue;
    }
    if (n.kind === 'Fetch') {
      // Entire node is a batched fetch — skip; insert batch when we hit latest.
      if (pos === latest.pos && latest.parallelIdx == null) {
        out.push(batchFetch);
      }
      continue;
    }
    if (n.kind === 'Parallel') {
      const removeIdx = new Set(
        locsAtPos
          .filter((l) => l.parallelIdx != null)
          .map((l) => l.parallelIdx!),
      );
      const remaining = n.nodes.filter((_, i) => !removeIdx.has(i));
      if (pos === latest.pos) {
        // Insert batch after remaining siblings at this parallel slot.
        if (remaining.length === 1) {
          out.push(remaining[0]!);
        } else if (remaining.length > 1) {
          out.push({ kind: 'Parallel', nodes: remaining });
        }
        out.push(batchFetch);
      } else if (remaining.length === 1) {
        out.push(remaining[0]!);
      } else if (remaining.length > 1) {
        out.push({ kind: 'Parallel', nodes: remaining });
      }
      continue;
    }
    out.push(n);
  }
  void removeSet;
  return out;
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
  const rootRaw: StitchPlanNode =
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
    root: optimizeStitchPlanNode(rootRaw, stitchingInfo),
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
  };
}
