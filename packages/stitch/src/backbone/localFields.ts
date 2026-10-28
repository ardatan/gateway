import type { IResolvers } from '@graphql-tools/utils';
import { asArray } from '@graphql-tools/utils';

/**
 * Collect field names that are owned by gateway-local resolvers (additionalResolvers),
 * so the backbone planner can emit Island nodes for them.
 */
export function collectLocalFieldsFromResolvers(
  additionalResolvers?: IResolvers<any, any> | IResolvers<any, any>[],
): Map<string, Set<string>> {
  const localFields = new Map<string, Set<string>>();
  if (additionalResolvers == null) {
    return localFields;
  }
  for (const resolverMap of asArray(additionalResolvers)) {
    for (const typeName of Object.keys(resolverMap)) {
      const typeResolvers = resolverMap[typeName];
      if (typeResolvers == null || typeof typeResolvers !== 'object') {
        continue;
      }
      let fields = localFields.get(typeName);
      if (!fields) {
        fields = new Set();
        localFields.set(typeName, fields);
      }
      for (const fieldName of Object.keys(typeResolvers)) {
        fields.add(fieldName);
      }
    }
  }
  return localFields;
}

export function isLocalField(
  localFields: Map<string, Set<string>> | undefined,
  typeName: string,
  fieldName: string,
): boolean {
  return localFields?.get(typeName)?.has(fieldName) === true;
}
