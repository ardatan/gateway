---
'@graphql-tools/stitch': patch
---

Surface shared-root Parallel subgraph errors on partial success, and forward them through root proxying into stock graphql-js results (via `UNPATHED_ERRORS` / throw-on-null).
