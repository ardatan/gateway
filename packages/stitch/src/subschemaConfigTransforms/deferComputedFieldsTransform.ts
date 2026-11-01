import {
  DelegationContext,
  SubschemaConfig,
  Transform,
} from '@graphql-tools/delegate';
import { ExecutionRequest } from '@graphql-tools/utils';
import {
  DocumentNode,
  FragmentDefinitionNode,
  Kind,
  SelectionNode,
  visit,
} from 'graphql';

/**
 * Clone-less computed-field deferral: keep computed fields on the single
 * subschema schema (so merge hops can select them), but strip them from
 * outbound requests that are not a merge entry point (`fieldName` /
 * `entryPoints[].fieldName`). Initial Query/Mutation hops therefore never
 * resolve computed fields early with missing `@requires` deps; entity /
 * `_products`-style merge hops still receive them.
 */
export class DeferComputedFieldsTransform<TContext = Record<string, any>>
  implements Transform<Record<string, any>, TContext>
{
  private readonly computedByType: Map<string, Set<string>>;
  private readonly mergeEntryFieldNames: Set<string>;

  constructor(
    computedByType: Map<string, Set<string>>,
    mergeEntryFieldNames: Set<string>,
  ) {
    this.computedByType = computedByType;
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
        this.computedByType,
      ),
    };
  }
}

function stripComputedFields(
  document: DocumentNode,
  computedByType: Map<string, Set<string>>,
): DocumentNode {
  const fragments: Record<string, FragmentDefinitionNode> = Object.create(null);
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[def.name.value] = def;
    }
  }
  void fragments;

  const allComputedNames = unionComputedNames(computedByType);
  if (!allComputedNames.size) {
    return document;
  }

  return visit(document, {
    [Kind.INLINE_FRAGMENT]: {
      leave(node) {
        if (!node.typeCondition) {
          return filterFieldSelectionSet(node, allComputedNames);
        }
        const computed = computedByType.get(node.typeCondition.name.value);
        if (!computed?.size) {
          return node;
        }
        return filterFieldSelectionSet(node, computed);
      },
    },
    [Kind.FRAGMENT_DEFINITION]: {
      leave(node) {
        const computed = computedByType.get(node.typeCondition.name.value);
        if (!computed?.size) {
          return node;
        }
        return filterFieldSelectionSet(node, computed);
      },
    },
    [Kind.FIELD]: {
      leave(node) {
        if (!node.selectionSet) {
          return node;
        }
        // Untyped nested selections (concrete return types): strip by global
        // computed name set. Merge-entry hops skip this transform entirely.
        return filterFieldSelectionSet(node, allComputedNames);
      },
    },
  });
}

function filterFieldSelectionSet<
  T extends {
    selectionSet?: { kind: Kind.SELECTION_SET; selections: readonly SelectionNode[] };
  },
>(node: T, computed: Set<string>): T | null {
  if (!node.selectionSet) {
    return node;
  }
  const selections = filterComputedSelections(
    node.selectionSet.selections,
    computed,
  );
  if (selections === node.selectionSet.selections) {
    return node;
  }
  if (!selections.length) {
    return null;
  }
  return {
    ...node,
    selectionSet: {
      kind: Kind.SELECTION_SET,
      selections,
    },
  };
}

function unionComputedNames(
  computedByType: Map<string, Set<string>>,
): Set<string> {
  const all = new Set<string>();
  for (const names of computedByType.values()) {
    for (const name of names) {
      all.add(name);
    }
  }
  return all;
}

function filterComputedSelections(
  selections: readonly SelectionNode[],
  computed: Set<string>,
): SelectionNode[] {
  let strippedComputed = false;
  let hasTypename = false;
  const next: SelectionNode[] = [];
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      if (computed.has(selection.name.value)) {
        strippedComputed = true;
        continue;
      }
      if (
        selection.name.value === '__typename' &&
        (selection.alias == null || selection.alias.value === '__typename')
      ) {
        hasTypename = true;
      }
    }
    next.push(selection);
  }
  if (!strippedComputed) {
    return selections as SelectionNode[];
  }
  // Isolation clones force the "unsatisfied selection" path in
  // prepareGatewayDocument, which injects __typename via fieldNodesByField.
  // With fields kept on the schema, that path is skipped — so when we strip
  // a computed field here, add __typename so merge keys still carry it for
  // `_Entity` / union resolveType on the next hop.
  if (!hasTypename) {
    next.unshift({
      kind: Kind.FIELD,
      name: { kind: Kind.NAME, value: '__typename' },
    });
  }
  return next;
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
  const mergeEntryFieldNames = new Set<string>();

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
    computedByType,
    mergeEntryFieldNames,
  );
  return [
    {
      ...subschemaConfig,
      transforms: [transform, ...(subschemaConfig.transforms ?? [])],
    },
  ];
}
