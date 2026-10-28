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

/** Operation-level stitch plan node tree. */
export type StitchPlanNode =
  | { kind: 'Sequence'; nodes: StitchPlanNode[] }
  | { kind: 'Parallel'; nodes: StitchPlanNode[] }
  | {
      kind: 'Fetch';
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
