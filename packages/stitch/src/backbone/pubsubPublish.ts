import {
  ExecutionRequest,
  ExecutionResult,
  getDirectiveExtensions,
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
 * Backbone execute bypasses schema root resolvers. Re-apply `@pubsubPublish`
 * side effects from Mutation result payloads so EDFS / NATS mutations still
 * fan out (same role router-runtime's pubsub visitor plays for classic execute).
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

function fieldResponseKey(field: FieldNode): string {
  return field.alias?.value ?? field.name.value;
}
