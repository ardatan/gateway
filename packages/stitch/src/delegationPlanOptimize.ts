import type { StitchingInfo, Subschema } from '@graphql-tools/delegate';
import { extractUnavailableFieldsFromSelectionSet } from '@graphql-tools/delegate';
import {
  FieldNode,
  FragmentDefinitionNode,
  GraphQLObjectType,
  Kind,
  SelectionNode,
  SelectionSetNode,
} from 'graphql';

function isIsolationStripTransform(t: { constructor?: { name?: string } }) {
  const name = t?.constructor?.name;
  // FilterTypes is also used by federation filterInternalFieldsAndTypes —
  // only TransformCompositeFields marks computed-field isolation clones.
  return name === 'TransformCompositeFields';
}

/**
 * Drop isolation-only transforms so a unioned selection (inStock ∪
 * shippingEstimate) is not emptied by TransformCompositeFields.
 */
export function subschemaWithoutIsolationStripTransforms(
  subschema: Subschema,
): Subschema {
  const transforms = subschema.transforms;
  if (!transforms?.length) {
    return subschema;
  }
  const kept = transforms.filter((t) => !isIsolationStripTransform(t as any));
  if (kept.length === transforms.length) {
    return subschema;
  }
  return Object.assign(
    Object.create(Object.getPrototypeOf(subschema)),
    subschema,
    {
      transforms: kept,
      _transformedSchema: undefined,
    },
  ) as Subschema;
}

/**
 * When a hop's selection asks for non-merge siblings alongside computed
 * fields, unwrap isolation strips. Single-clone computed hops stay isolated.
 */
export function subschemaForUnionedIsolationHop(
  subschema: Subschema,
  typeName: string,
  selectionSet: SelectionSetNode,
): Subschema {
  const transforms = subschema.transforms;
  if (!transforms?.length) {
    return subschema;
  }
  const mergeFields = subschema.merge?.[typeName]?.fields;
  if (!mergeFields) {
    return subschema;
  }
  let needsUnstripped = false;
  for (const sel of selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) {
      continue;
    }
    const name = sel.name.value;
    if (name === '__typename') {
      continue;
    }
    if (mergeFields[name]) {
      continue;
    }
    needsUnstripped = true;
    break;
  }
  if (!needsUnstripped) {
    return subschema;
  }
  return subschemaWithoutIsolationStripTransforms(subschema);
}

function fieldArgsKey(field: FieldNode): string {
  if (!field.arguments?.length) {
    return '';
  }
  return JSON.stringify(field.arguments.map((a) => [a.name.value, a.value]));
}

function fieldResponseKey(field: FieldNode): string {
  return field.alias?.value ?? field.name.value;
}

function selectionsCompatibleForUnion(
  a: SelectionSetNode,
  b: SelectionSetNode,
): boolean {
  const aFields = new Map<string, FieldNode>();
  for (const sel of a.selections) {
    if (sel.kind === Kind.FIELD) {
      aFields.set(fieldResponseKey(sel), sel);
    }
  }
  for (const sel of b.selections) {
    if (sel.kind !== Kind.FIELD) {
      continue;
    }
    const key = fieldResponseKey(sel);
    const prior = aFields.get(key);
    if (!prior) {
      continue;
    }
    if (
      prior.name.value !== sel.name.value ||
      fieldArgsKey(prior) !== fieldArgsKey(sel)
    ) {
      return false;
    }
    if (prior.selectionSet && sel.selectionSet) {
      if (!selectionsCompatibleForUnion(prior.selectionSet, sel.selectionSet)) {
        return false;
      }
    } else if (prior.selectionSet || sel.selectionSet) {
      return false;
    }
  }
  return true;
}

function unionSelectionSets(
  a: SelectionSetNode,
  b: SelectionSetNode,
): SelectionSetNode {
  const byKey = new Map<string, SelectionNode>();
  const add = (sel: SelectionNode) => {
    if (sel.kind === Kind.FIELD) {
      const key = `f:${fieldResponseKey(sel)}`;
      const prior = byKey.get(key);
      if (!prior || prior.kind !== Kind.FIELD) {
        byKey.set(key, sel);
        return;
      }
      if (prior.selectionSet && sel.selectionSet) {
        byKey.set(key, {
          ...prior,
          selectionSet: unionSelectionSets(
            prior.selectionSet,
            sel.selectionSet,
          ),
        });
      }
      return;
    }
    byKey.set(JSON.stringify(sel), sel);
  };
  for (const sel of a.selections) {
    add(sel);
  }
  for (const sel of b.selections) {
    add(sel);
  }
  return { kind: Kind.SELECTION_SET, selections: [...byKey.values()] };
}

function collectSelectedFieldNames(
  selectionSet: SelectionSetNode,
): Set<string> {
  const names = new Set<string>();
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      names.add(sel.name.value);
    }
  }
  return names;
}

function findMergeFieldConfig(
  stitchingInfo: StitchingInfo | undefined,
  subschema: Subschema,
  typeName: string,
  fieldName: string,
) {
  const direct = subschema.merge?.[typeName]?.fields?.[fieldName];
  if (direct?.selectionSet || direct?.computed) {
    return direct;
  }
  if (!stitchingInfo) {
    return direct;
  }
  for (const s of stitchingInfo.subschemaMap.values()) {
    if (subschema.name && s.name !== subschema.name) {
      continue;
    }
    const field = s.merge?.[typeName]?.fields?.[fieldName];
    if (field?.selectionSet || field?.computed) {
      return field;
    }
  }
  return undefined;
}

function requiresDepsForField(
  stitchingInfo: StitchingInfo | undefined,
  subschema: Subschema,
  typeName: string,
  fieldName: string,
): FieldNode[] {
  if (fieldName === '__typename') {
    return [];
  }
  const mergeField = findMergeFieldConfig(
    stitchingInfo,
    subschema,
    typeName,
    fieldName,
  );
  if (!mergeField?.selectionSet && !mergeField?.computed) {
    return [];
  }
  return stitchingInfo?.fieldNodesByField?.[typeName]?.[fieldName] ?? [];
}

function selectionRequiresCount(
  stitchingInfo: StitchingInfo | undefined,
  subschema: Subschema,
  typeName: string,
  selectionSet: SelectionSetNode,
): number {
  let n = 0;
  for (const sel of selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) {
      continue;
    }
    n += requiresDepsForField(
      stitchingInfo,
      subschema,
      typeName,
      sel.name.value,
    ).length;
  }
  return n;
}

function requiresArgsCompatibleForMaps(
  stitchingInfo: StitchingInfo | undefined,
  typeName: string,
  a: { subschema: Subschema; selectionSet: SelectionSetNode },
  b: { subschema: Subschema; selectionSet: SelectionSetNode },
): boolean {
  const byName = new Map<string, string>();
  for (const entry of [a, b]) {
    for (const sel of entry.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) {
        continue;
      }
      for (const dep of requiresDepsForField(
        stitchingInfo,
        entry.subschema,
        typeName,
        sel.name.value,
      )) {
        const args = fieldArgsKey(dep);
        const prev = byName.get(dep.name.value);
        if (prev != null && prev !== args) {
          return false;
        }
        byName.set(dep.name.value, args);
      }
    }
  }
  return true;
}

function resolveSubschemaForUnion(
  stitchingInfo: StitchingInfo | undefined,
  template: Subschema,
  typeName: string,
  selected: ReadonlySet<string>,
): Subschema {
  const direct = template.merge?.[typeName]?.fields;
  for (const name of selected) {
    const f = direct?.[name];
    if (f?.selectionSet || f?.computed) {
      return template;
    }
  }
  if (!stitchingInfo) {
    return template;
  }
  for (const s of stitchingInfo.subschemaMap.values()) {
    if (template.name && s.name !== template.name) {
      continue;
    }
    const fields = s.merge?.[typeName]?.fields;
    if (!fields) {
      continue;
    }
    for (const name of selected) {
      const f = fields[name];
      if (f?.selectionSet || f?.computed) {
        return s;
      }
    }
  }
  return template;
}

function hasCircularSelectedRequires(
  stitchingInfo: StitchingInfo | undefined,
  subschema: Subschema,
  typeName: string,
  selected: ReadonlySet<string>,
): boolean {
  for (const name of selected) {
    const deps = requiresDepsForField(stitchingInfo, subschema, typeName, name);
    for (const dep of deps) {
      if (dep.name.value === name || !selected.has(dep.name.value)) {
        continue;
      }
      const depMerge = findMergeFieldConfig(
        stitchingInfo,
        subschema,
        typeName,
        dep.name.value,
      );
      if (depMerge?.selectionSet || depMerge?.computed) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Collapse same-subgraph isolation clones in one stage map (inStock ∪
 * shippingEstimate), with @requires safety gates. Prefer the computed clone
 * and unwrap strip transforms when the union spans non-merge siblings.
 */
export function optimizeDelegationMap(
  delegationMap: Map<Subschema, SelectionSetNode>,
  typeName: string,
  fragments: Record<string, FragmentDefinitionNode>,
  stitchingInfo?: StitchingInfo,
): Map<Subschema, SelectionSetNode> {
  // Pass 1: classic availability absorb (original semantics).
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

  // Pass 2: same-name isolation clone union (requires-gated).
  if (stitchingInfo) {
    return unionSameNameIsolationClones(delegationMap, typeName, stitchingInfo);
  }
  return delegationMap;
}

function unionSameNameIsolationClones(
  delegationMap: Map<Subschema, SelectionSetNode>,
  typeName: string,
  stitchingInfo?: StitchingInfo,
): Map<Subschema, SelectionSetNode> {
  const entries = [...delegationMap.entries()];
  if (entries.length < 2) {
    return delegationMap;
  }
  const byName = new Map<string, Array<[Subschema, SelectionSetNode]>>();
  for (const [subschema, selectionSet] of entries) {
    const name = subschema.name;
    if (!name) {
      continue;
    }
    // Only consider clones that carry isolation strip transforms — plain
    // same-name subschemas (or entry-point splits) must not be force-merged.
    const hasIsolation = subschema.transforms?.some((t) =>
      isIsolationStripTransform(t as any),
    );
    if (!hasIsolation) {
      continue;
    }
    let list = byName.get(name);
    if (!list) {
      list = [];
      byName.set(name, list);
    }
    list.push([subschema, selectionSet]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) {
      continue;
    }
    const requiresCounts = group.map(([s, sel]) =>
      selectionRequiresCount(stitchingInfo, s, typeName, sel),
    );
    const withRequires = requiresCounts.filter((n) => n > 0).length;
    // Only the inventory pattern: exactly one computed/@requires side +
    // non-requires siblings. Never merge two plain isolation clones.
    if (withRequires !== 1) {
      continue;
    }
    let ok = true;
    for (let i = 0; i < group.length && ok; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = {
          subschema: group[i]![0],
          selectionSet: group[i]![1],
        };
        const b = {
          subschema: group[j]![0],
          selectionSet: group[j]![1],
        };
        if (!requiresArgsCompatibleForMaps(stitchingInfo, typeName, a, b)) {
          ok = false;
          break;
        }
        if (!selectionsCompatibleForUnion(a.selectionSet, b.selectionSet)) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) {
      continue;
    }
    let selectionSet = group[0]![1];
    for (let i = 1; i < group.length; i++) {
      selectionSet = unionSelectionSets(selectionSet, group[i]![1]);
    }
    let templateIdx = 0;
    for (let i = 0; i < group.length; i++) {
      if (requiresCounts[i]! > 0) {
        templateIdx = i;
        break;
      }
    }
    const template = group[templateIdx]![0];
    const selected = collectSelectedFieldNames(selectionSet);
    if (
      hasCircularSelectedRequires(stitchingInfo, template, typeName, selected)
    ) {
      continue;
    }
    const preferred = resolveSubschemaForUnion(
      stitchingInfo,
      template,
      typeName,
      selected,
    );
    const unwrapped = subschemaForUnionedIsolationHop(
      preferred,
      typeName,
      selectionSet,
    );
    for (const [s] of group) {
      delegationMap.delete(s);
    }
    delegationMap.set(unwrapped, selectionSet);
  }

  return delegationMap;
}

/**
 * Absorb adjacent stage maps that target the same logical subgraph when
 * unioning is the inventory pattern (non-requires → requires), requires-safe.
 */
export function coalesceAdjacentDelegationMaps(
  delegationMaps: Array<Map<Subschema, SelectionSetNode>>,
  typeName: string,
  stitchingInfo?: StitchingInfo,
): Array<Map<Subschema, SelectionSetNode>> {
  if (delegationMaps.length < 2) {
    return delegationMaps;
  }
  const out: Array<Map<Subschema, SelectionSetNode>> = [];
  for (const map of delegationMaps) {
    const prev = out[out.length - 1];
    if (!prev || prev.size !== 1 || map.size !== 1) {
      out.push(map);
      continue;
    }
    const [prevSub, prevSel] = [...prev.entries()][0]!;
    const [nextSub, nextSel] = [...map.entries()][0]!;
    const prevIsolation = prevSub.transforms?.some((t) =>
      isIsolationStripTransform(t as any),
    );
    const nextIsolation = nextSub.transforms?.some((t) =>
      isIsolationStripTransform(t as any),
    );
    if (!prevIsolation && !nextIsolation) {
      out.push(map);
      continue;
    }
    if (
      !prevSub.name ||
      prevSub.name !== nextSub.name ||
      !requiresArgsCompatibleForMaps(
        stitchingInfo,
        typeName,
        { subschema: prevSub, selectionSet: prevSel },
        { subschema: nextSub, selectionSet: nextSel },
      ) ||
      !selectionsCompatibleForUnion(prevSel, nextSel)
    ) {
      out.push(map);
      continue;
    }
    const prevReq = selectionRequiresCount(
      stitchingInfo,
      prevSub,
      typeName,
      prevSel,
    );
    const nextReq = selectionRequiresCount(
      stitchingInfo,
      nextSub,
      typeName,
      nextSel,
    );
    // Inventory pattern only: non-requires stage then requires stage.
    if (!(prevReq === 0 && nextReq > 0)) {
      out.push(map);
      continue;
    }
    const selectionSet = unionSelectionSets(prevSel, nextSel);
    const selected = collectSelectedFieldNames(selectionSet);
    if (
      hasCircularSelectedRequires(stitchingInfo, nextSub, typeName, selected)
    ) {
      out.push(map);
      continue;
    }
    const preferred = resolveSubschemaForUnion(
      stitchingInfo,
      nextSub,
      typeName,
      selected,
    );
    const unwrapped = subschemaForUnionedIsolationHop(
      preferred,
      typeName,
      selectionSet,
    );
    out[out.length - 1] = new Map([[unwrapped, selectionSet]]);
  }
  return out;
}
