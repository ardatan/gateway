import type { Subschema } from '@graphql-tools/delegate';
import {
  DocumentNode,
  FieldNode,
  getNamedType,
  GraphQLSchema,
  isObjectType,
  Kind,
  OperationTypeNode,
  SelectionNode,
  SelectionSetNode,
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
      // Drop concrete spreads that cannot apply under an object parent.
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

/**
 * Strip foreign fields and attach prebuilt `_entities` documents so execute
 * can skip Transformer / prepareGatewayDocument (Hive QP model).
 */
export function preparePlanDocuments(
  root: StitchPlanNode,
  fragments: Record<string, any>,
): StitchPlanNode {
  if (root.kind === 'Sequence' || root.kind === 'Parallel') {
    return {
      kind: root.kind,
      nodes: root.nodes.map((n) => preparePlanDocuments(n, fragments)),
    };
  }
  if (root.kind === 'Island') {
    return root.continue
      ? {
          ...root,
          continue: preparePlanDocuments(root.continue, fragments),
        }
      : root;
  }
  if (root.kind === 'Fetch') {
    if (!root.entityTypeName || root.rootField) {
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
      selectionSet: filtered,
      document: buildEntitiesDocument(root.entityTypeName, filtered),
    };
  }
  if (root.kind === 'BatchFetch') {
    const schema = targetSchema(root.subschema);
    const aliases = root.aliases.map((a, i) => {
      const filtered = filterSelectionSetForSubschema(
        a.selectionSet,
        a.entityTypeName,
        schema,
        fragments,
      );
      return {
        ...a,
        selectionSet: filtered,
        representationsVariable: a.representationsVariable ?? `__batch_reps_${i}`,
      };
    });
    return {
      ...root,
      aliases,
      document: buildBatchEntitiesDocument(aliases),
    };
  }
  return root;
}
