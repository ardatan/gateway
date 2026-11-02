---
'@graphql-tools/stitch': minor
'@graphql-tools/delegate': patch
---

Keep multiple merged-type `entryPoints` on a single subschema instead of cloning N SubschemaConfigs. DPB treats a target as proxiable when any entry's keys are available; classic and backbone merge pick the matching entry at hop time.
