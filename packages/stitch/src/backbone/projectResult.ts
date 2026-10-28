import type {
  FieldNode,
  FragmentDefinitionNode,
  GraphQLObjectType,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
} from 'graphql';
import {
  getNamedType,
  isAbstractType,
  isLeafType,
  isObjectType,
  Kind,
} from 'graphql';
import { collectFields, getDefinedRootType } from '@graphql-tools/utils';
import { getVariableValues } from '@graphql-tools/delegate';

/**
 * Project execution data down to the client operation selection set.
 * Drops planning-only fields such as unrequested `__typename`.
 */
export function projectDataToOperation(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  fragments: Record<string, FragmentDefinitionNode>,
  variableValues: Record<string, any>,
  data: Record<string, any> | null | undefined,
): Record<string, any> | null | undefined {
  if (data == null) {
    return data;
  }
  const rootType = getDefinedRootType(schema, operation.operation);
  const { fields } = collectFields(
    schema,
    fragments,
    getVariableValues(variableValues),
    rootType,
    operation.selectionSet,
  );
  const projected: Record<string, any> = {};
  for (const [responseKey, fieldNodes] of fields) {
    if (!(responseKey in data)) {
      continue;
    }
    const fieldNode = fieldNodes[0]!;
    const field = rootType.getFields()[fieldNode.name.value];
    projected[responseKey] = projectValue(
      schema,
      fragments,
      variableValues,
      field ? getNamedType(field.type) : undefined,
      fieldNodes,
      data[responseKey],
    );
  }
  return projected;
}

function projectValue(
  schema: GraphQLSchema,
  fragments: Record<string, FragmentDefinitionNode>,
  variableValues: Record<string, any>,
  runtimeType: ReturnType<typeof getNamedType> | undefined,
  fieldNodes: FieldNode[],
  value: any,
): any {
  if (value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      projectValue(
        schema,
        fragments,
        variableValues,
        runtimeType,
        fieldNodes,
        item,
      ),
    );
  }
  if (typeof value !== 'object') {
    // Enum intersection / @inaccessible values: serialize through the gateway
    // leaf type so unknown/removed enum values become null (GraphQL.js parity).
    if (runtimeType && isLeafType(runtimeType)) {
      try {
        return runtimeType.serialize(value);
      } catch {
        return null;
      }
    }
    return value;
  }

  let objectType: GraphQLObjectType | undefined;
  if (isObjectType(runtimeType)) {
    objectType = runtimeType;
  } else if (isAbstractType(runtimeType) && typeof value.__typename === 'string') {
    const t = schema.getType(value.__typename);
    if (isObjectType(t)) {
      objectType = t;
    }
  } else if (typeof value.__typename === 'string') {
    const t = schema.getType(value.__typename);
    if (isObjectType(t)) {
      objectType = t;
    }
  }
  if (!objectType) {
    return value;
  }

  const selectionSet: SelectionSetNode = {
    kind: Kind.SELECTION_SET,
    selections: fieldNodes.flatMap(
      (fieldNode) => fieldNode.selectionSet?.selections ?? [],
    ),
  };
  if (!selectionSet.selections.length) {
    // Leaf field — return scalar/object as-is without __typename injection noise
    const { __typename: _t, ...rest } = value as Record<string, any>;
    return Object.keys(rest).length ? rest : value;
  }

  const { fields } = collectFields(
    schema,
    fragments,
    getVariableValues(variableValues),
    objectType,
    selectionSet,
  );
  const projected: Record<string, any> = {};
  for (const [responseKey, nestedFieldNodes] of fields) {
    const nestedFieldNode = nestedFieldNodes[0]!;
    if (nestedFieldNode.name.value === '__typename') {
      projected[responseKey] =
        value[responseKey] ?? value.__typename ?? objectType.name;
      continue;
    }
    if (!(responseKey in value) && !(nestedFieldNode.name.value in value)) {
      continue;
    }
    const field = objectType.getFields()[nestedFieldNode.name.value];
    const raw =
      responseKey in value ? value[responseKey] : value[nestedFieldNode.name.value];
    projected[responseKey] = projectValue(
      schema,
      fragments,
      variableValues,
      field ? getNamedType(field.type) : undefined,
      nestedFieldNodes,
      raw,
    );
  }
  return projected;
}

/** @internal test helper */
export function selectionHasAbstractTypes(
  schema: GraphQLSchema,
  selectionSet: SelectionSetNode,
  parentType: GraphQLObjectType,
  fragments: Record<string, FragmentDefinitionNode>,
  seen = new Set<string>(),
): boolean {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (!selection.selectionSet) {
        continue;
      }
      const field = parentType.getFields()[selection.name.value];
      if (!field) {
        continue;
      }
      const named = getNamedType(field.type);
      if (isAbstractType(named)) {
        return true;
      }
      if (isObjectType(named)) {
        const key = `${named.name}:${selection.name.value}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        if (
          selectionHasAbstractTypes(
            schema,
            selection.selectionSet,
            named,
            fragments,
            seen,
          )
        ) {
          return true;
        }
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const typeName = selection.typeCondition?.name.value;
      if (typeName) {
        const t = schema.getType(typeName);
        if (isAbstractType(t)) {
          return true;
        }
        if (
          isObjectType(t) &&
          selectionHasAbstractTypes(
            schema,
            selection.selectionSet,
            t,
            fragments,
            seen,
          )
        ) {
          return true;
        }
      } else if (
        selectionHasAbstractTypes(
          schema,
          selection.selectionSet,
          parentType,
          fragments,
          seen,
        )
      ) {
        return true;
      }
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragment = fragments[selection.name.value];
      if (!fragment) {
        continue;
      }
      const t = schema.getType(fragment.typeCondition.name.value);
      if (isAbstractType(t)) {
        return true;
      }
      if (
        isObjectType(t) &&
        selectionHasAbstractTypes(
          schema,
          fragment.selectionSet,
          t,
          fragments,
          seen,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

void (null as unknown as SelectionNode);
