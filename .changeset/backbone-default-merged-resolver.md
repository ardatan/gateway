---
'@graphql-tools/stitch': major
'@graphql-tools/federation': major
'@graphql-mesh/fusion-runtime': major
---

Backbone owns stitched Query/Mutation execution. Gateway default field resolver stays named `defaultMergedResolver` (alias/`resolveExternalValue` + local hydration) without classic leftover merge plans. `onStitchedSchema` root resolver overrides are planned as Islands. `@pubsubPublish` result handling and `join__Graph` name map live in fusion-runtime; router-runtime imports them.
