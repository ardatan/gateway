export {
  attachBackboneExecutor,
  BACKBONE_EXECUTOR_EXTENSION,
  getBackboneExecutor,
  markChangedRootResolvesAsLocal,
  snapshotRootFieldResolves,
} from './attachBackboneExecutor.js';
export { buildStitchPlan } from './buildStitchPlan.js';
export { createBackboneExecutor } from './createBackboneExecutor.js';
export { executeStitchPlan } from './executeStitchPlan.js';
export { isLocalField } from './localFields.js';
export { projectDataToOperation } from './projectResult.js';
export {
  BACKBONE_EXECUTING,
  getOriginalRootResolve,
  installRootProxyingResolvers,
} from './rootProxyingResolvers.js';
export type {
  BackboneExecutorOptions,
  BuildStitchPlanOptions,
  StitchPlan,
  StitchPlanNode,
} from './types.js';
