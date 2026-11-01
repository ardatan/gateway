import {
  getSubschema,
  getUnpathedErrors,
  isExternalObject,
  resolveExternalValue,
  type ExternalObject,
} from '@graphql-tools/delegate';
import {
  defaultFieldResolver,
  type GraphQLFieldResolver,
  type GraphQLResolveInfo,
} from 'graphql';

/**
 * Default field resolver for stitched schemas once the backbone owns planning.
 *
 * Unlike `defaultMergedResolver`, this does **not** run leftover merge plans or
 * `mergeFields` at resolve time — those hops belong on the stitch plan.
 *
 * It still handles proxied (external) objects the way graphql-js cannot:
 * - read the alias response key first, then fall back to the literal field name
 * - surface subgraph errors / enum coercion via `resolveExternalValue`
 */
export const stitchedDefaultFieldResolver: GraphQLFieldResolver<any, any> =
  function stitchedDefaultFieldResolver(
    parent: ExternalObject | Record<string, any> | null | undefined,
    args: Record<string, any>,
    context: Record<string, any>,
    info: GraphQLResolveInfo,
  ) {
    if (parent == null) {
      return null;
    }

    if (!isExternalObject(parent)) {
      return defaultFieldResolver(parent, args, context, info);
    }

    const responseKey = info.fieldNodes[0]!.alias?.value ?? info.fieldName;

    if (Object.prototype.hasOwnProperty.call(parent, responseKey)) {
      return resolveExternalValue(
        parent[responseKey],
        getUnpathedErrors(parent),
        getSubschema(parent, responseKey),
        context,
        info,
      );
    }

    // Plain resolver data merged onto an external object is keyed by field name.
    if (Object.prototype.hasOwnProperty.call(parent, info.fieldName)) {
      return defaultFieldResolver(parent, args, context, info);
    }

    return undefined;
  };
