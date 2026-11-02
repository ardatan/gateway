import type { Subschema } from '@graphql-tools/delegate';
import {
  DocumentNode,
  getNamedType,
  GraphQLSchema,
  isAbstractType,
  isListType,
  isNonNullType,
  Kind,
  OperationTypeNode,
  SelectionSetNode,
  TypeNode,
  type GraphQLType,
} from 'graphql';

export type BatchedMergeEntry = {
  fieldName: string;
  key: (originalResult: any) => any;
  argsFromKeys: (keys: ReadonlyArray<any>) => Record<string, any>;
  dataLoaderOptions?: { cacheKeyFn?: (key: any) => any };
};

/**
 * Resolve a batched type-merge entry from subschema merge config.
 * Works for federation `_entities` and plain stitching (`usersByIds`, etc.).
 */
export function getBatchedMergeEntry(
  subschema: Subschema,
  typeName: string,
): BatchedMergeEntry | null {
  const mergeConfig = subschema.merge?.[typeName];
  if (!mergeConfig) {
    return null;
  }
  if (
    mergeConfig.key != null &&
    mergeConfig.argsFromKeys != null &&
    mergeConfig.fieldName != null
  ) {
    return {
      fieldName: mergeConfig.fieldName,
      key: mergeConfig.key,
      argsFromKeys: mergeConfig.argsFromKeys,
      dataLoaderOptions: mergeConfig.dataLoaderOptions,
    };
  }
  const ep = mergeConfig.entryPoints?.find(
    (e) => e.key != null && e.argsFromKeys != null && e.fieldName != null,
  );
  if (!ep?.key || !ep.argsFromKeys || !ep.fieldName) {
    return null;
  }
  return {
    fieldName: ep.fieldName,
    key: ep.key,
    argsFromKeys: ep.argsFromKeys,
    dataLoaderOptions: ep.dataLoaderOptions,
  };
}

/** Single arg name from `argsFromKeys([])` — multi-arg merges stay on Transformer. */
export function inferMergeArgName(
  argsFromKeys: (keys: ReadonlyArray<any>) => Record<string, any>,
): string | null {
  const sample = argsFromKeys([]);
  if (sample == null || typeof sample !== 'object') {
    return null;
  }
  const names = Object.keys(sample);
  return names.length === 1 ? names[0]! : null;
}

function typeToAST(type: GraphQLType): TypeNode {
  if (isNonNullType(type)) {
    return { kind: Kind.NON_NULL_TYPE, type: typeToAST(type.ofType) };
  }
  if (isListType(type)) {
    return { kind: Kind.LIST_TYPE, type: typeToAST(type.ofType) };
  }
  return {
    kind: Kind.NAMED_TYPE,
    name: { kind: Kind.NAME, value: type.name },
  };
}

function mergeFieldSelection(
  schema: GraphQLSchema,
  fieldName: string,
  aliases: Array<{ entityTypeName: string; selectionSet: SelectionSetNode }>,
): SelectionSetNode | null {
  const queryType = schema.getQueryType();
  const field = queryType?.getFields()[fieldName];
  if (!field) {
    return null;
  }
  const namedReturn = getNamedType(field.type);
  const useInline =
    isAbstractType(namedReturn) ||
    aliases.length > 1 ||
    namedReturn.name !== aliases[0]!.entityTypeName;
  if (!useInline) {
    return aliases[0]!.selectionSet;
  }
  return {
    kind: Kind.SELECTION_SET,
    selections: aliases.map((a) => ({
      kind: Kind.INLINE_FRAGMENT as const,
      typeCondition: {
        kind: Kind.NAMED_TYPE as const,
        name: {
          kind: Kind.NAME as const,
          value: a.entityTypeName,
        },
      },
      selectionSet: a.selectionSet,
    })),
  };
}

/**
 * Prebuilt merge hop document from MergedTypeConfig + subgraph schema
 * (not federation-hardcoded `_entities` / `representations` / `_Any`).
 */
export function buildBatchedMergeDocument(
  schema: GraphQLSchema,
  entry: BatchedMergeEntry,
  aliases: Array<{ entityTypeName: string; selectionSet: SelectionSetNode }>,
): DocumentNode | null {
  if (!aliases.length) {
    return null;
  }
  const argName = inferMergeArgName(entry.argsFromKeys);
  if (argName == null) {
    return null;
  }
  const queryType = schema.getQueryType();
  const field = queryType?.getFields()[entry.fieldName];
  const argDef = field?.args.find((a) => a.name === argName);
  if (!field || !argDef) {
    return null;
  }
  const fieldSelection = mergeFieldSelection(schema, entry.fieldName, aliases);
  if (!fieldSelection) {
    return null;
  }
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
              name: { kind: Kind.NAME, value: argName },
            },
            type: typeToAST(argDef.type),
          },
        ],
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [
            {
              kind: Kind.FIELD,
              name: { kind: Kind.NAME, value: entry.fieldName },
              arguments: [
                {
                  kind: Kind.ARGUMENT,
                  name: { kind: Kind.NAME, value: argName },
                  value: {
                    kind: Kind.VARIABLE,
                    name: { kind: Kind.NAME, value: argName },
                  },
                },
              ],
              selectionSet: fieldSelection,
            },
          ],
        },
      },
    ],
  };
}
