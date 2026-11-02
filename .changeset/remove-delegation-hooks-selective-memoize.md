---
'@graphql-mesh/fusion-runtime': major
'@graphql-hive/gateway-runtime': major
'@graphql-tools/stitch': minor
---

Remove `onDelegationPlan` / `onDelegationStageExecute` plugin hooks (and the debug plugin that depended on them). They conflicted with DPB memoization and were rarely useful.

Restore DPB memoization for classic stitching with a parent field-presence seed key: types without `@requires`/computed ignore parent (main-era cache behavior); types with `fieldSelectionSets` still memoize when parent shapes match so list merges stay fast without breaking clone-less requires. Progressive override still forces non-memoized plans.
