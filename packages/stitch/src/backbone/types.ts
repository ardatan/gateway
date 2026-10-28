import type { Subschema } from '@graphql-tools/delegate';
import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLResolveInfo,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql';

export type PathSegment = string | number;

/** One alias inside a multi-type BatchFetch (Hive-style `_e0` / `_e1`). */
export interface StitchBatchAlias {
  /** Response key in the batched `_entities` document (`_e0`, …). */
  alias: string;
  entityTypeName: string;
  selectionSet: SelectionSetNode;
  flattenPaths: PathSegment[][];
}

/** Operation-level stitch plan node tree. */
export type StitchPlanNode =
  | { kind: 'Sequence'; nodes: StitchPlanNode[] }
  | { kind: 'Parallel'; nodes: StitchPlanNode[] }
  | {
      kind: 'Fetch';
      /** Stable id for barrier-free dataflow execute. */
      id?: string;
      /**
       * When same-type multi-path Fetches were collapsed, all original ids
       * that this hop satisfies for downstream dependsOn.
       */
      completesIds?: string[];
      /** Fetch/BatchFetch ids that must complete first. */
      dependsOn?: string[];
      /** Target subschema for this hop. */
      subschema: Subschema;
      /** Root field hops write into `data[responseKey]`. */
      rootField?: FieldNode;
      /** Entity hops: type used for `_entities` / merge resolver. */
      entityTypeName?: string;
      /** Selections to request from the target subschema. */
      selectionSet: SelectionSetNode;
      /** Path from operation root to the list/object being flattened into. */
      flattenPath?: PathSegment[];
      /**
       * Hive-QP BatchFetch: same entity selection applied at multiple flatten
       * paths in one hop (one DataLoader/_entities wave).
       */
      flattenPaths?: PathSegment[][];
    }
  | {
      kind: 'BatchFetch';
      id?: string;
      /**
       * All Fetch ids collapsed into this batch — dataflow marks every id
       * complete when the single HTTP call returns.
       */
      completesIds?: string[];
      dependsOn?: string[];
      subschema: Subschema;
      /** Multi-type / multi-selection aliases → one subgraph HTTP call. */
      aliases: StitchBatchAlias[];
    }
  | {
      kind: 'Island';
      parentTypeName: string;
      fieldNode: FieldNode;
      /** Federated follow-up after the local resolver returns a merge key. */
      continue?: StitchPlanNode;
    };

export interface StitchPlan {
  operation: OperationDefinitionNode;
  fragments: Record<string, FragmentDefinitionNode>;
  root: StitchPlanNode;
  /** When true, executor must fall back to schema execute. */
  incomplete: boolean;
  /** Reasons the plan is incomplete (hooks, unsupported nodes, etc.). */
  incompleteReasons: string[];
}

export interface BackboneExecutorOptions {
  /**
   * Fields introduced via additionalResolvers / @resolveTo / gateway-only
   * typeDefs. Keyed by parent type name → field names.
   */
  localFields?: Map<string, Set<string>>;
  /**
   * When delegation-plan hooks are installed, backbone planning is skipped for
   * safety (hooks may replace the plan with live context).
   */
  hasDelegationPlanHooks?: boolean;
  /**
   * Escape hatch: force GraphQL.js schema execute (unit tests only).
   * Gateway cutover never sets this — incomplete plans must be fixed.
   */
  preferPlannedExecute?: boolean;
}

export interface BackboneExecutionContext {
  schema: import('graphql').GraphQLSchema;
  document: DocumentNode;
  operation: OperationDefinitionNode;
  fragments: Record<string, FragmentDefinitionNode>;
  variableValues: Record<string, any>;
  contextValue: any;
  rootValue: any;
  signal?: AbortSignal;
  data: Record<string, any>;
  errors: Error[];
  infoStub: Partial<GraphQLResolveInfo>;
}
