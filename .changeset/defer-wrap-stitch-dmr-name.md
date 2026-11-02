---
'@graphql-tools/delegate': patch
---

Treat nested `defaultMergedResolver` by function name as well as identity so wrapSchema-over-stitch deferred fields do not recurse into the backbone hydration wrap.
