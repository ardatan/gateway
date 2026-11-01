import {
  ExecutionRequest,
  ExecutionResult,
  Executor,
  getDirectiveExtensions,
  getOperationASTFromRequest,
  isAsyncIterable,
} from '@graphql-tools/utils';
import { handleMaybePromise, isPromise } from '@whatwg-node/promise-helpers';
import {
  GraphQLSchema,
  isObjectType,
  Kind,
  type FieldNode,
  type GraphQLField,
} from 'graphql';

type PubSubPublishArgs = { pubsubTopic: string };

type PubSubLike = {
  publish: (topic: string, payload: unknown) => void | Promise<void>;
};

/**
 * Re-apply `@pubsubPublish` from Mutation result payloads. Backbone / direct
 * execute skips schema root resolvers, so publish must run as an executor
 * side effect (same role router-runtime's pubsub visitor plays).
 */
export function applyPubsubPublishToResult(
  schema: GraphQLSchema,
  request: ExecutionRequest,
  result: ExecutionResult,
): ExecutionResult | Promise<ExecutionResult> {
  if (result.data == null || result.data === undefined) {
    return result;
  }
  const context = request.context as { pubsub?: PubSubLike } | undefined;
  const pubsub = context?.pubsub;
  if (!pubsub?.publish) {
    return result;
  }
  if (!schema.getDirective('pubsubPublish')) {
    return result;
  }

  const mutationType = schema.getMutationType();
  if (!mutationType || !isObjectType(mutationType)) {
    return result;
  }

  const operation = request.document.definitions.find(
    (d) => d.kind === Kind.OPERATION_DEFINITION && d.operation === 'mutation',
  );
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) {
    return result;
  }

  const fields = mutationType.getFields();
  const jobs: Array<Promise<void>> = [];

  for (const sel of operation.selectionSet.selections) {
    if (sel.kind !== Kind.FIELD || sel.name.value.startsWith('__')) {
      continue;
    }
    const field: GraphQLField<any, any> | undefined = fields[sel.name.value];
    if (!field) {
      continue;
    }
    const directives = getDirectiveExtensions<{
      pubsubPublish: PubSubPublishArgs;
    }>(field, schema);
    const publishes = directives.pubsubPublish;
    if (!publishes?.length) {
      continue;
    }
    const responseKey = fieldResponseKey(sel);
    const payload = (result.data as Record<string, unknown>)[responseKey];
    if (payload === undefined) {
      continue;
    }
    for (const args of publishes) {
      const job = pubsub.publish(args.pubsubTopic, payload);
      if (isPromise(job)) {
        jobs.push(
          job.catch(() => {
            // Swallow publish errors (same as router-runtime visitor).
          }),
        );
      }
    }
  }

  if (!jobs.length) {
    return result;
  }
  return handleMaybePromise(
    () => Promise.all(jobs),
    () => result,
  );
}

/**
 * Wrap a unified-graph executor so Mutation results fire `@pubsubPublish`.
 * No-op when the schema has no such directive.
 */
export function wrapExecutorWithPubsubPublish(
  schema: GraphQLSchema,
  executor: Executor,
): Executor {
  if (!schema.getDirective('pubsubPublish')) {
    return executor;
  }
  return function pubsubPublishExecutor(request) {
    return handleMaybePromise(
      () => executor(request),
      (result) => {
        if (isAsyncIterable(result)) {
          return result;
        }
        const op = getOperationASTFromRequest(request);
        if (op?.operation !== 'mutation') {
          return result;
        }
        return applyPubsubPublishToResult(schema, request, result);
      },
    );
  };
}

function fieldResponseKey(field: FieldNode): string {
  return field.alias?.value ?? field.name.value;
}
