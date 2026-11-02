import { batchDelegateToSchema } from '@graphql-tools/batch-delegate';
import {
  delegateToSchema,
  MergedTypeConfig,
  MergedTypeResolver,
  MergedTypeResolverOptions,
  Subschema,
} from '@graphql-tools/delegate';
import { handleMaybePromise } from '@whatwg-node/promise-helpers';
import {
  getNamedType,
  GraphQLList,
  GraphQLOutputType,
  OperationTypeNode,
} from 'graphql';
import { GraphQLResolveInfo } from 'graphql/type';
import { entryPointAppliesToParent } from './backbone/mergeEntry.js';

function getMergeOperation(
  info: GraphQLResolveInfo,
  subschema: Subschema<any, any, any, any>,
  fieldName: string | undefined,
): OperationTypeNode {
  // Preserve mutation only when the merge entry point lives on Mutation
  // (graphql-tools#4549). Federation `_entities` and other Query-only merge
  // fields must stay on query even when the gateway operation is a mutation.
  // Subscriptions always merge via query — you cannot re-subscribe for entity fields.
  if (info.operation.operation !== 'mutation' || fieldName == null) {
    return 'query' as OperationTypeNode;
  }
  const schema = subschema.transformedSchema;
  if (schema.getMutationType()?.getFields()[fieldName] != null) {
    return 'mutation' as OperationTypeNode;
  }
  return 'query' as OperationTypeNode;
}

/**
 * Multi-key merge on one subschema: try each entryPoint's `key` until one
 * returns a non-null value, then batchDelegate with that entry's fieldName.
 */
export function createMultiEntryMergedTypeResolver<
  TContext extends Record<string, any> = any,
>(
  mergedTypeConfig: MergedTypeConfig,
  mergedType?: GraphQLOutputType | string,
): MergedTypeResolver<TContext> | undefined {
  const entryPoints = mergedTypeConfig.entryPoints;
  if (entryPoints == null || entryPoints.length < 2) {
    return createMergedTypeResolver(mergedTypeConfig, mergedType);
  }
  const resolvers = entryPoints.map((ep) =>
    createMergedTypeResolver(ep, mergedType),
  );
  return function multiEntryMergedTypeResolver(
    originalResult,
    context,
    info,
    subschema,
    selectionSet,
    _key,
    type,
    skipTypeMerging = true,
  ) {
    const tryAt = (i: number): ReturnType<MergedTypeResolver<TContext>> => {
      if (i >= entryPoints.length) {
        return originalResult;
      }
      const ep = entryPoints[i]!;
      const resolver = resolvers[i];
      if (resolver == null || !entryPointAppliesToParent(ep, originalResult)) {
        return tryAt(i + 1);
      }
      // Batched entries expose `key`; single-result entries use `args` only.
      if (ep.key == null) {
        return resolver(
          originalResult,
          context,
          info,
          subschema,
          selectionSet,
          undefined,
          type,
          skipTypeMerging,
        );
      }
      return handleMaybePromise(
        () => ep.key!(originalResult),
        (key) => {
          if (key == null) {
            return tryAt(i + 1);
          }
          return resolver(
            originalResult,
            context,
            info,
            subschema,
            selectionSet,
            key,
            type,
            skipTypeMerging,
          );
        },
      );
    };
    return tryAt(0);
  };
}

export function createMergedTypeResolver<
  TContext extends Record<string, any> = any,
>(
  mergedTypeResolverOptions: MergedTypeResolverOptions,
  mergedType?: GraphQLOutputType | string,
): MergedTypeResolver<TContext> | undefined {
  const { fieldName, argsFromKeys, valuesFromResults, args } =
    mergedTypeResolverOptions;

  function getType(info: GraphQLResolveInfo): GraphQLOutputType {
    if (!mergedType) {
      return getNamedType(info.returnType);
    }
    if (typeof mergedType === 'string') {
      return info.schema.getType(mergedType) as GraphQLOutputType;
    }
    return mergedType;
  }

  if (argsFromKeys != null) {
    return function mergedBatchedTypeResolver(
      _originalResult,
      context,
      info,
      subschema,
      selectionSet,
      key,
      type = getType(info),
      skipTypeMerging = true,
    ) {
      // After the backbone plan has hydrated the tree, ignore classic
      // leftover mergeFields → batchDelegate (that re-fetches inventory).
      // Still allow batchDelegate while BACKBONE_EXECUTING so Island
      // continues / planned entity hops via merge resolvers work.
      if (
        context != null &&
        typeof context === 'object' &&
        (context as any)[
          Symbol.for('graphql-tools.stitch.backboneHydrated')
        ] &&
        !(context as any)[
          Symbol.for('graphql-tools.stitch.backboneExecuting')
        ]
      ) {
        return _originalResult;
      }
      return batchDelegateToSchema({
        schema: subschema,
        operation: getMergeOperation(info, subschema, fieldName),
        fieldName,
        returnType: new GraphQLList(type),
        key,
        argsFromKeys,
        valuesFromResults,
        selectionSet,
        context,
        info,
        skipTypeMerging,
        dataLoaderOptions: mergedTypeResolverOptions.dataLoaderOptions,
      });
    };
  }

  if (args != null) {
    return function mergedTypeResolver(
      originalResult,
      context,
      info,
      subschema,
      selectionSet,
      _key,
      type = getType(info),
      skipTypeMerging = true,
    ) {
      return delegateToSchema({
        schema: subschema,
        operation: getMergeOperation(info, subschema, fieldName),
        fieldName,
        returnType: type,
        args: args(originalResult),
        selectionSet,
        context,
        info,
        skipTypeMerging,
      });
    };
  }

  return undefined;
}
