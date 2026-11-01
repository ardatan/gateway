import type { StitchingInfo, Subschema } from '@graphql-tools/delegate';
import { extractUnavailableFieldsFromSelectionSet } from '@graphql-tools/delegate';
import {
  FragmentDefinitionNode,
  GraphQLObjectType,
  Kind,
  SelectionSetNode,
} from 'graphql';

/**
 * Absorb selections onto a subschema that already covers them.
 * Isolation-clone union was removed with isolateComputedFieldsTransformer.
 */
export function optimizeDelegationMap(
  delegationMap: Map<Subschema, SelectionSetNode>,
  typeName: string,
  fragments: Record<string, FragmentDefinitionNode>,
  _stitchingInfo?: StitchingInfo,
): Map<Subschema, SelectionSetNode> {
  for (const [subschema, selectionSet] of delegationMap) {
    for (const [subschema2, selectionSet2] of delegationMap) {
      if (subschema === subschema2) {
        continue;
      }
      const unavailableFields = extractUnavailableFieldsFromSelectionSet(
        subschema2.transformedSchema,
        subschema2.transformedSchema.getType(typeName) as GraphQLObjectType,
        selectionSet,
        () => true,
        fragments,
      );
      if (!unavailableFields.length) {
        delegationMap.set(subschema2, {
          kind: Kind.SELECTION_SET,
          selections: [...selectionSet2.selections, ...selectionSet.selections],
        });
        delegationMap.delete(subschema);
      }
    }
  }
  return delegationMap;
}

/**
 * Adjacent-stage isolation-clone coalesce removed with clone-less deferral.
 * Kept as a no-op so call sites stay stable.
 */
export function coalesceAdjacentDelegationMaps(
  delegationMaps: Array<Map<Subschema, SelectionSetNode>>,
  _typeName: string,
  _stitchingInfo?: StitchingInfo,
): Array<Map<Subschema, SelectionSetNode>> {
  return delegationMaps;
}
