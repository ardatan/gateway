import {
  defaultMergedResolver as delegateMergedResolver,
  isExternalObject,
  type StitchingInfo,
} from '@graphql-tools/delegate';
import { handleMaybePromise } from '@whatwg-node/promise-helpers';
import {
  getNamedType,
  type GraphQLFieldResolver,
  type GraphQLResolveInfo,
} from 'graphql';
import { resolveLocalFieldResult } from './resolveLocalFieldResult.js';

/**
 * Classic (resolve-time mergeFields) gateway default field resolver.
 *
 * Uses `@graphql-tools/delegate`'s leftover/`mergeFields` DMR for ExternalObjects,
 * then runs `resolveLocalFieldResult` so property-only gateway locals that return
 * a merged type still hydrate — the same contract as the backbone slim DMR.
 */
export const classicMergedResolver: GraphQLFieldResolver<any, any> =
  function defaultMergedResolver(
    parent: any,
    args: Record<string, any>,
    context: Record<string, any>,
    info: GraphQLResolveInfo,
  ) {
    return handleMaybePromise(
      () => delegateMergedResolver(parent, args, context, info),
      (value) => hydrateIfMerged(value, parent, context, info),
    );
  };

function hydrateIfMerged(
  value: any,
  _parent: any,
  context: Record<string, any>,
  info: GraphQLResolveInfo,
): any {
  // Already-annotated external results are handled by mergeFields /
  // resolveExternalValue; only hydrate plain local payloads.
  if (value == null || isExternalObject(value)) {
    return value;
  }
  const stitchingInfo = info.schema.extensions?.['stitchingInfo'] as
    | StitchingInfo
    | undefined;
  if (stitchingInfo == null) {
    return value;
  }
  const returnTypeName = getNamedType(info.returnType).name;
  if (stitchingInfo.mergedTypes[returnTypeName] == null) {
    return value;
  }
  const provided = stitchingInfo.localFields?.get(returnTypeName);
  return resolveLocalFieldResult(
    value,
    context,
    info,
    stitchingInfo,
    provided,
  );
}
