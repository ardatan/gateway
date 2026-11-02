---
'@graphql-tools/stitch': major
'@graphql-tools/delegate': minor
---

**Breaking:** Remove `isolateComputedFieldsTransformer` and isolation-clone planning. Stitching always uses clone-less computed-field deferral (`deferComputedFieldsTransformer`) with field-level `@requires` gates. Callers that previously passed `isolateComputedFieldsTransformer` via `subschemaConfigTransforms` should drop it — the default presets already defer computed fields without cloning subschemas.
