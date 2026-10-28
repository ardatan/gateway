import type { Subschema } from '@graphql-tools/delegate';
import {
  DocumentNode,
  FieldNode,
  getNamedType,
  GraphQLSchema,
  isNullableType,
  isObjectType,
  Kind,
  OperationDefinitionNode,
  OperationTypeNode,
  SelectionNode,
  SelectionSetNode,
  VariableDefinitionNode,
  visit,
} from 'graphql';
import type { StitchBatchAlias, StitchPlanNode } from './types.js';

const TYPENAME_FIELD: FieldNode = {
  kind: Kind.FIELD,
  name: { kind: Kind.NAME, value: '__typename' },
};

/**
 * Hive QP strips selections to what the target subgraph can resolve — at plan
 * time. Recurse into nested selections; inject `__typename` for later entity
 * matching. Fragment spreads become inline fragments when the type exists.
 */
export function filterSelectionSetForSubschema(
  selectionSet: SelectionSetNode,
  typeName: string,
  schema: GraphQLSchema,
  fragments: Record<
    string,
    {
      typeCondition: { name: { value: string } };
      selectionSet: SelectionSetNode;
    }
  >,
): SelectionSetNode {
  const type = schema.getType(typeName);
  if (!type || !('getFields' in type)) {
    return { kind: Kind.SELECTION_SET, selections: [TYPENAME_FIELD] };
  }
  const fields = (
    type as { getFields(): Record<string, { type: any }> }
  ).getFields();
  const next: SelectionNode[] = [];
  let hasTypename = false;
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      const name = sel.name.value;
      if (name === '__typename') {
        hasTypename = true;
        next.push(sel);
        continue;
      }
      const field = fields[name];
      if (!field) {
        continue;
      }
      if (!sel.selectionSet) {
        next.push(sel);
        continue;
      }
      const childType = getNamedType(field.type);
      next.push({
        ...sel,
        selectionSet: filterSelectionSetForSubschema(
          sel.selectionSet,
          childType.name,
          schema,
          fragments,
        ),
      });
      continue;
    }
    if (sel.kind === Kind.INLINE_FRAGMENT) {
      const on = sel.typeCondition?.name.value ?? typeName;
      if (sel.typeCondition && !schema.getType(on)) {
        continue;
      }
      if (
        sel.typeCondition &&
        isObjectType(type) &&
        on !== type.name &&
        isObjectType(schema.getType(on))
      ) {
        continue;
      }
      const filtered = filterSelectionSetForSubschema(
        sel.selectionSet,
        on,
        schema,
        fragments,
      );
      if (filtered.selections.length) {
        next.push({ ...sel, selectionSet: filtered });
      }
      continue;
    }
    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const frag = fragments[sel.name.value];
      if (!frag) {
        continue;
      }
      const on = frag.typeCondition.name.value;
      if (!schema.getType(on)) {
        continue;
      }
      const filtered = filterSelectionSetForSubschema(
        frag.selectionSet,
        on,
        schema,
        fragments,
      );
      if (filtered.selections.length) {
        next.push({
          kind: Kind.INLINE_FRAGMENT,
          typeCondition: frag.typeCondition,
          selectionSet: filtered,
        });
      }
    }
  }
  if (!hasTypename) {
    next.unshift(TYPENAME_FIELD);
  }
  return { kind: Kind.SELECTION_SET, selections: next };
}

function anyTypeRef() {
  return {
    kind: Kind.NON_NULL_TYPE as const,
    type: {
      kind: Kind.LIST_TYPE as const,
      type: {
        kind: Kind.NON_NULL_TYPE as const,
        type: {
          kind: Kind.NAMED_TYPE as const,
          name: { kind: Kind.NAME as const, value: '_Any' },
        },
      },
    },
  };
}

function buildEntitiesDocument(
  typeName: string,
  selectionSet: SelectionSetNode,
): DocumentNode {
  return {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: 'query' as OperationTypeNode,
        variableDefinitions: [
          {
            kind: Kind.VARIABLE_DEFINITION,
            variable: {
              kind: Kind.VARIABLE,
              name: { kind: Kind.NAME, value: 'representations' },
            },
            type: anyTypeRef(),
          },
        ],
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [
            {
              kind: Kind.FIELD,
              name: { kind: Kind.NAME, value: '_entities' },
              arguments: [
                {
                  kind: Kind.ARGUMENT,
                  name: { kind: Kind.NAME, value: 'representations' },
                  value: {
                    kind: Kind.VARIABLE,
                    name: { kind: Kind.NAME, value: 'representations' },
                  },
                },
              ],
              selectionSet: {
                kind: Kind.SELECTION_SET,
                selections: [
                  {
                    kind: Kind.INLINE_FRAGMENT,
                    typeCondition: {
                      kind: Kind.NAMED_TYPE,
                      name: { kind: Kind.NAME, value: typeName },
                    },
                    selectionSet,
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };
}

function buildBatchEntitiesDocument(
  aliases: StitchBatchAlias[],
): DocumentNode {
  const variableDefinitions = aliases.map((a, i) => {
    const varName = a.representationsVariable ?? `__batch_reps_${i}`;
    return {
      kind: Kind.VARIABLE_DEFINITION as const,
      variable: {
        kind: Kind.VARIABLE as const,
        name: { kind: Kind.NAME as const, value: varName },
      },
      type: anyTypeRef(),
    };
  });
  const selections = aliases.map((a, i) => {
    const varName = a.representationsVariable ?? `__batch_reps_${i}`;
    return {
      kind: Kind.FIELD as const,
      alias: { kind: Kind.NAME as const, value: a.alias },
      name: { kind: Kind.NAME as const, value: '_entities' },
      arguments: [
        {
          kind: Kind.ARGUMENT as const,
          name: { kind: Kind.NAME as const, value: 'representations' },
          value: {
            kind: Kind.VARIABLE as const,
            name: { kind: Kind.NAME as const, value: varName },
          },
        },
      ],
      selectionSet: {
        kind: Kind.SELECTION_SET as const,
        selections: [
          {
            kind: Kind.INLINE_FRAGMENT as const,
            typeCondition: {
              kind: Kind.NAMED_TYPE as const,
              name: {
                kind: Kind.NAME as const,
                value: a.entityTypeName,
              },
            },
            selectionSet: a.selectionSet,
          },
        ],
      },
    };
  });
  return {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: 'query' as OperationTypeNode,
        variableDefinitions,
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections,
        },
      },
    ],
  };
}

function targetSchema(subschema: Subschema): GraphQLSchema {
  return subschema.schema;
}

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

/** Same as execute rewriteNullabilityConflicts — plan-time for root docs. */
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

function buildRootFetchDocument(
  operation: OperationDefinitionNode,
  fieldNode: FieldNode,
  subgraphSchema: GraphQLSchema,
): DocumentNode {
  let cleaned = stripSkipInclude(fieldNode) as FieldNode;
  if (cleaned.selectionSet) {
    cleaned = {
      ...cleaned,
      selectionSet: rewriteNullabilityConflicts(
        cleaned.selectionSet,
        subgraphSchema,
      ),
    };
  }
  const usedVars = collectUsedVariableNames(cleaned);
  const filteredDefs = filterVariableDefinitions(
    operation.variableDefinitions,
    usedVars,
  );
  return {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: operation.operation,
        name: operation.name,
        variableDefinitions: filteredDefs,
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [cleaned],
        },
      },
    ],
  };
}

export interface PreparePlanDocumentsOptions {
  operation: OperationDefinitionNode;
  fragments: Record<string, any>;
}

/**
 * Attach prebuilt subgraph documents (Hive QP model).
 * Original selectionSets stay intact for Transformer fallback on nested/abstract.
 */
export function preparePlanDocuments(
  root: StitchPlanNode,
  options: PreparePlanDocumentsOptions,
): StitchPlanNode {
  const { operation, fragments } = options;
  if (root.kind === 'Sequence' || root.kind === 'Parallel') {
    return {
      kind: root.kind,
      nodes: root.nodes.map((n) => preparePlanDocuments(n, options)),
    };
  }
  if (root.kind === 'Island') {
    return root.continue
      ? {
          ...root,
          continue: preparePlanDocuments(root.continue, options),
        }
      : root;
  }
  if (root.kind === 'Fetch') {
    if (root.rootField) {
      return {
        ...root,
        document: buildRootFetchDocument(
          operation,
          root.rootField,
          targetSchema(root.subschema),
        ),
      };
    }
    if (!root.entityTypeName) {
      return root;
    }
    const schema = targetSchema(root.subschema);
    const filtered = filterSelectionSetForSubschema(
      root.selectionSet,
      root.entityTypeName,
      schema,
      fragments,
    );
    return {
      ...root,
      document: buildEntitiesDocument(root.entityTypeName, filtered),
    };
  }
  if (root.kind === 'BatchFetch') {
    const schema = targetSchema(root.subschema);
    const aliases: StitchBatchAlias[] = root.aliases.map((a, i) => ({
      ...a,
      representationsVariable: a.representationsVariable ?? `__batch_reps_${i}`,
    }));
    const document = buildBatchEntitiesDocument(
      aliases.map((a) => ({
        ...a,
        selectionSet: filterSelectionSetForSubschema(
          a.selectionSet,
          a.entityTypeName,
          schema,
          fragments,
        ),
      })),
    );
    return {
      ...root,
      aliases,
      document,
    };
  }
  return root;
}
