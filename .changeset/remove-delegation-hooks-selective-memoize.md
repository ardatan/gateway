---
'@graphql-mesh/fusion-runtime': major
'@graphql-hive/gateway-runtime': major
'@graphql-tools/stitch': minor
---

Remove `onDelegationPlan` / `onDelegationStageExecute` plugin hooks (and the debug plugin that depended on them). They conflicted with DPB memoization and were rarely useful.

Restore selective DPB memoization for classic stitching: types without `@requires`/computed `fieldSelectionSets` reuse the old `memoize5of7` plan cache; types with parent-dependent requires stay non-memoized. Progressive override still forces non-memoized plans.
