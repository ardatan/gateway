import {
  DelegationContext,
  SubschemaConfig,
  Transform,
} from '@graphql-tools/delegate';
import {
  collectFields,
  ExecutionRequest,
  parseSelectionSet,
} from '@graphql-tools/utils';
import {
  DocumentNode,
  FragmentDefinitionNode,
  getNamedType,
  GraphQLSchema,
  isCompositeType,
  Kind,
  SelectionNode,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from 'graphql';

/**
 * Clone-less computed-field deferral: keep computed fields on the single
 * subschema schema (so merge hops can select them), but strip them from
 * outbound requests that are not a merge entry point (`fieldName` /
 * `entryPoints[].fieldName`). Initial Query/Mutation hops therefore never
 * resolve computed fields early with missing `@requires` deps; entity /
 * `_products`-style merge hops still receive them.
 *
 * When a computed field is stripped, inject the type's merge-key fields
 * (`@key` / `selectionSet`) so the parent still carries identity for later
 * leftover hops.
 */
export class DeferComputedFieldsTransform<TContext = Record<string, any>>
  implements Transform<Record<string, any>, TContext>
{
  private readonly computedByType: Map<string, Set<string>>;
  private readonly keyFieldsByType: Map<string, Set<string>>;
  private readonly mergeEntryFieldNames: Set<string>;
  private readonly schema: GraphQLSchema;

  constructor(
    schema: GraphQLSchema,
    computedByType: Map<string, Set<string>>,
    keyFieldsByType: Map<string, Set<string>>,
    mergeEntryFieldNames: Set<string>,
  ) {
    this.schema = schema;
    this.computedByType = computedByType;
    this.keyFieldsByType = keyFieldsByType;
    this.mergeEntryFieldNames = mergeEntryFieldNames;
  }

  transformRequest(
    originalRequest: ExecutionRequest,
    delegationContext: DelegationContext<TContext>,
  ): ExecutionRequest {
    if (this.mergeEntryFieldNames.has(delegationContext.fieldName)) {
      return originalRequest;
    }
    return {
      ...originalRequest,
      document: stripComputedFields(
        originalRequest.document,
        this.schema,
        this.computedByType,
        this.keyFieldsByType,
      ),
    };
  }
}

function stripComputedFields(
  document: DocumentNode,
  schema: GraphQLSchema,
  computedByType: Map<string, Set<string>>,
  keyFieldsByType: Map<string, Set<string>>,
): DocumentNode {
  if (!computedByType.size) {
    return document;
  }

  const typeInfo = new TypeInfo(schema);
  return visit(
    document,
    visitWithTypeInfo(typeInfo, {
      [Kind.SELECTION_SET]: {
        leave(node) {
          const parentType = typeInfo.getParentType();
          if (parentType == null) {
            return node;
          }
          const typeName = getNamedType(parentType).name;
          const computed = computedByType.get(typeName);
          if (!computed?.size) {
            return node;
          }
          const keys = keyFieldsByType.get(typeName);
          const selections = filterComputedSelections(
            node.selections,
            computed,
            keys,
          );
          if (selections === node.selections) {
            return node;
          }
          if (!selections.length) {
            return null;
          }
          return {
            kind: Kind.SELECTION_SET,
            selections,
          };
        },
      },
    }),
  );
}

function filterComputedSelections(
  selections: readonly SelectionNode[],
  computed: Set<string>,
  keyFields: Set<string> | undefined,
): SelectionNode[] {
  let strippedComputed = false;
  const present = new Set<string>();
  const next: SelectionNode[] = [];
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      if (computed.has(selection.name.value)) {
        strippedComputed = true;
        continue;
      }
      present.add(selection.name.value);
    }
    next.push(selection);
  }
  if (!strippedComputed) {
    return selections as SelectionNode[];
  }
  // Isolation's schema-strip makes prepareGatewayDocument inject key +
  // __typename deps. We kept the field on the schema (fast path skips that),
  // so restore identity fields here when a computed leaf was the only pick.
  if (!present.has('__typename')) {
    next.unshift({
      kind: Kind.FIELD,
      name: { kind: Kind.NAME, value: '__typename' },
    });
    present.add('__typename');
  }
  if (keyFields) {
    for (const key of keyFields) {
      if (!present.has(key) && !computed.has(key)) {
        next.push({
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: key },
        });
        present.add(key);
      }
    }
  }
  return next;
}

function collectKeyFieldNames(
  schema: GraphQLSchema,
  typeName: string,
  selectionSetStr: string | undefined,
): string[] {
  if (!selectionSetStr) {
    return [];
  }
  const type = schema.getType(typeName);
  if (!type || !isCompositeType(type)) {
    return [];
  }
  const parsed = parseSelectionSet(selectionSetStr, { noLocation: true });
  const collected = collectFields(schema, {}, {}, type, parsed);
  return Array.from(collected.fields.keys());
}

/**
 * Replace isolation cloning with a single-subschema request deferral for
 * computed fields (`computed: true` + `selectionSet`).
 */
export function deferComputedFieldsTransformer(
  subschemaConfig: SubschemaConfig,
): Array<SubschemaConfig> {
  if (subschemaConfig.merge == null) {
    return [subschemaConfig];
  }

  const computedByType = new Map<string, Set<string>>();
  const keyFieldsByType = new Map<string, Set<string>>();
  const mergeEntryFieldNames = new Set<string>();
  const schema = subschemaConfig.schema;

  for (const typeName in subschemaConfig.merge) {
    const mergedTypeConfig = subschemaConfig.merge[typeName]!;
    if (mergedTypeConfig.fieldName) {
      mergeEntryFieldNames.add(mergedTypeConfig.fieldName);
    }
    for (const entry of mergedTypeConfig.entryPoints ?? []) {
      if (entry.fieldName) {
        mergeEntryFieldNames.add(entry.fieldName);
      }
    }

    const keys = new Set<string>();
    for (const key of collectKeyFieldNames(
      schema,
      typeName,
      mergedTypeConfig.selectionSet,
    )) {
      keys.add(key);
    }
    for (const entry of mergedTypeConfig.entryPoints ?? []) {
      for (const key of collectKeyFieldNames(
        schema,
        typeName,
        entry.selectionSet,
      )) {
        keys.add(key);
      }
    }
    if (keys.size) {
      keyFieldsByType.set(typeName, keys);
    }

    if (!mergedTypeConfig.fields) {
      continue;
    }
    let computed: Set<string> | undefined;
    for (const fieldName in mergedTypeConfig.fields) {
      const fieldConfig = mergedTypeConfig.fields[fieldName];
      if (fieldConfig?.computed && fieldConfig.selectionSet) {
        computed ||= new Set();
        computed.add(fieldName);
      }
    }
    if (computed?.size) {
      computedByType.set(typeName, computed);
    }
  }

  if (!computedByType.size) {
    return [subschemaConfig];
  }

  const transform = new DeferComputedFieldsTransform(
    schema,
    computedByType,
    keyFieldsByType,
    mergeEntryFieldNames,
  );
  return [
    {
      ...subschemaConfig,
      transforms: [transform, ...(subschemaConfig.transforms ?? [])],
    },
  ];
}
