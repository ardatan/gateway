import {
  annotateExternalObject,
  createDefaultExecutor,
  mergeFields,
  OBJECT_SUBSCHEMA_SYMBOL,
  Subschema,
  type StitchingInfo,
} from '@graphql-tools/delegate';
import { getFragmentsFromDocument } from '@graphql-tools/executor';
import {
  createGraphQLError,
  ExecutionRequest,
  ExecutionResult,
  Executor,
  getArgumentValues,
  getDefinedRootType,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';
import {
  handleMaybePromise,
  isPromise,
  type MaybePromise,
} from '@whatwg-node/promise-helpers';
import {
  FieldNode,
  GraphQLSchema,
  isObjectType,
  Kind,
  OperationTypeNode,
} from 'graphql';
import type {
  BackboneExecutionContext,
  PathSegment,
  StitchPlan,
  StitchPlanNode,
} from './types.js';

function getSubschemaExecutor(subschema: Subschema): Executor {
  if (subschema.executor) {
    return subschema.executor;
  }
  return createDefaultExecutor(subschema.schema);
}

function buildRootDocument(
  operationName: string | undefined,
  operationType: OperationTypeNode,
  fieldNode: FieldNode,
  variableDefinitions: StitchPlan['operation']['variableDefinitions'],
) {
  const op = {
    kind: Kind.OPERATION_DEFINITION as const,
    operation: operationType,
    name: operationName
      ? { kind: Kind.NAME as const, value: operationName }
      : undefined,
    variableDefinitions,
    selectionSet: {
      kind: Kind.SELECTION_SET as const,
      selections: [fieldNode],
    },
  };
  return {
    kind: Kind.DOCUMENT as const,
    definitions: [op],
  };
}

function collectEntitiesAtPath(
  data: any,
  path: PathSegment[],
): Array<Record<string, any>> {
  let current: any[] = [data];
  for (const segment of path) {
    const next: any[] = [];
    for (const item of current) {
      if (item == null) {
        continue;
      }
      if (typeof segment === 'number') {
        if (Array.isArray(item)) {
          const el = item[segment];
          if (el != null) {
            next.push(el);
          }
        }
        continue;
      }
      const value = item[segment];
      if (Array.isArray(value)) {
        for (const el of value) {
          if (el != null && typeof el === 'object') {
            next.push(el);
          }
        }
      } else if (value != null && typeof value === 'object') {
        next.push(value);
      }
    }
    current = next;
  }
  return current;
}

function executeFetchNode(
  node: Extract<StitchPlanNode, { kind: 'Fetch' }>,
  ctx: BackboneExecutionContext,
): MaybePromise<void> {
  const executor = getSubschemaExecutor(node.subschema);

  if (node.rootField) {
    const document = buildRootDocument(
      ctx.operation.name?.value,
      ctx.operation.operation,
      node.rootField,
      ctx.operation.variableDefinitions,
    );
    const responseKey =
      node.rootField.alias?.value ?? node.rootField.name.value;
    return handleMaybePromise(
      () =>
        executor({
          document,
          variables: ctx.variableValues,
          context: ctx.contextValue,
          rootValue: ctx.rootValue,
          operationType: ctx.operation.operation,
          operationName: ctx.operation.name?.value,
          signal: ctx.signal,
          subgraphName: node.subschema.name,
        } satisfies ExecutionRequest),
      (result: ExecutionResult) => {
        if (result.errors?.length) {
          ctx.errors.push(...result.errors);
        }
        if (result.data && responseKey in result.data) {
          const value = result.data[responseKey];
          if (value != null && typeof value === 'object') {
            ctx.data[responseKey] = annotateExternalObject(
              value,
              result.errors ?? [],
              node.subschema,
              {},
            );
          } else {
            ctx.data[responseKey] = value;
          }
        }
      },
      (err) => {
        ctx.errors.push(
          createGraphQLError(err instanceof Error ? err.message : String(err), {
            originalError: err instanceof Error ? err : undefined,
            extensions: {
              code: 'DOWNSTREAM_SERVICE_ERROR',
              serviceName: node.subschema.name,
            },
          }),
        );
      },
    );
  }

  if (!node.entityTypeName || !node.flattenPath) {
    return;
  }

  const parents = collectEntitiesAtPath(ctx.data, node.flattenPath);
  if (!parents.length) {
    return;
  }

  const stitchingInfo = ctx.schema.extensions?.['stitchingInfo'] as
    | StitchingInfo
    | undefined;
  const mergedTypeInfo = stitchingInfo?.mergedTypes[node.entityTypeName];
  if (!mergedTypeInfo) {
    return;
  }

  const type = ctx.schema.getType(node.entityTypeName);
  if (!isObjectType(type)) {
    return;
  }

  // Same wrapping defaultMergedResolver uses so collectSubFields sees nested fields.
  const planningParentField: FieldNode = {
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: node.entityTypeName },
    selectionSet: node.selectionSet,
  };

  const jobs: MaybePromise<any>[] = [];
  for (const parent of parents) {
    const sourceSubschema =
      ((parent as any)[OBJECT_SUBSCHEMA_SYMBOL] as Subschema | undefined) ??
      node.subschema;

    const info = {
      ...(ctx.infoStub as any),
      schema: ctx.schema,
      parentType: type,
      returnType: type,
      fieldName: node.entityTypeName,
      fieldNodes: [planningParentField],
      fragments: ctx.fragments,
      operation: ctx.operation,
      variableValues: ctx.variableValues,
      path: {
        typename: node.entityTypeName,
        key: node.flattenPath.at(-1),
        prev: undefined,
      },
    };

    jobs.push(
      mergeFields(
        mergedTypeInfo,
        parent,
        sourceSubschema,
        ctx.contextValue,
        info,
        [planningParentField],
      ),
    );
  }

  return handleMaybePromise(
    () => Promise.all(jobs.map((j) => (isPromise(j) ? j : Promise.resolve(j)))),
    () => undefined,
  );
}

function executeIslandNode(
  node: Extract<StitchPlanNode, { kind: 'Island' }>,
  ctx: BackboneExecutionContext,
): MaybePromise<void> {
  const parentType = ctx.schema.getType(node.parentTypeName);
  if (!isObjectType(parentType)) {
    return;
  }
  const fieldName = node.fieldNode.name.value;
  const field = parentType.getFields()[fieldName];
  if (!field?.resolve) {
    return;
  }
  const responseKey = node.fieldNode.alias?.value ?? fieldName;
  const args = getArgumentValues(field, node.fieldNode, ctx.variableValues);
  const rootType = getDefinedRootType(ctx.schema, ctx.operation.operation);
  const info = {
    ...(ctx.infoStub as any),
    schema: ctx.schema,
    parentType: rootType,
    returnType: field.type,
    fieldName,
    fieldNodes: [node.fieldNode],
    fragments: ctx.fragments,
    operation: ctx.operation,
    variableValues: ctx.variableValues,
    path: { typename: rootType.name, key: responseKey, prev: undefined },
  };

  return handleMaybePromise(
    () => field.resolve!(ctx.rootValue, args, ctx.contextValue, info),
    (result) => {
      ctx.data[responseKey] = result;
      if (node.continue) {
        return executePlanNode(node.continue, ctx);
      }
    },
  );
}

function executePlanNode(
  node: StitchPlanNode,
  ctx: BackboneExecutionContext,
): MaybePromise<void> {
  switch (node.kind) {
    case 'Sequence': {
      let chain: MaybePromise<void> = undefined;
      for (const child of node.nodes) {
        chain = handleMaybePromise(
          () => chain,
          () => executePlanNode(child, ctx),
        );
      }
      return chain;
    }
    case 'Parallel': {
      const jobs = node.nodes.map((child) => executePlanNode(child, ctx));
      return handleMaybePromise(
        () =>
          Promise.all(
            jobs.map((j) => (isPromise(j) ? j : Promise.resolve(j))),
          ),
        () => undefined,
      );
    }
    case 'Fetch':
      return executeFetchNode(node, ctx);
    case 'Island':
      return executeIslandNode(node, ctx);
    default:
      return;
  }
}

export function executeStitchPlan(
  schema: GraphQLSchema,
  plan: StitchPlan,
  request: ExecutionRequest,
): MaybePromise<ExecutionResult> {
  const operation = getOperationASTFromRequest(request) ?? plan.operation;
  const fragments =
    Object.keys(plan.fragments).length > 0
      ? plan.fragments
      : getFragmentsFromDocument(request.document);

  const variableValues = request.variables ?? {};

  const ctx: BackboneExecutionContext = {
    schema,
    document: request.document,
    operation,
    fragments,
    variableValues,
    contextValue: request.context,
    rootValue: request.rootValue,
    signal: request.signal,
    data: {},
    errors: [],
    infoStub: {},
  };

  return handleMaybePromise(
    () => executePlanNode(plan.root, ctx),
    () => {
      const result: ExecutionResult = {};
      if (Object.keys(ctx.data).length) {
        result.data = ctx.data;
      }
      if (ctx.errors.length) {
        result.errors = ctx.errors as any;
      }
      return result;
    },
  );
}
