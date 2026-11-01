/**
 * Toggle classic (resolve-time mergeFields) vs backbone (planned dataflow).
 *
 * - Env: `GRAPHQL_TOOLS_CLASSIC_STITCHING=1` (or `true`) for local test runs
 * - API: `stitchSchemas({ classicStitching: true })` /
 *   `getStitchedSchemaFromSupergraphSdl({ classicStitching: true })`
 *
 * Explicit option wins over env. Default is backbone.
 */
export const CLASSIC_STITCHING_ENV = 'GRAPHQL_TOOLS_CLASSIC_STITCHING';

export const STITCHING_EXECUTION_MODE_EXTENSION = 'stitchingExecutionMode';

export type StitchingExecutionMode = 'backbone' | 'classic';

export function isClassicStitchingEnabled(options?: {
  classicStitching?: boolean;
}): boolean {
  if (options?.classicStitching === true) {
    return true;
  }
  if (options?.classicStitching === false) {
    return false;
  }
  const env = globalThis.process?.env?.[CLASSIC_STITCHING_ENV];
  return env === '1' || env === 'true';
}

export function getStitchingExecutionMode(schema: {
  extensions?: Record<string, unknown> | null;
}): StitchingExecutionMode {
  const mode = schema.extensions?.[STITCHING_EXECUTION_MODE_EXTENSION];
  return mode === 'classic' ? 'classic' : 'backbone';
}
