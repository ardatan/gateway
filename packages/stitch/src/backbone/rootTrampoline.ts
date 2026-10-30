import type { ExecutionRequest, Executor } from '@graphql-tools/utils';
import {
  defaultFieldResolver,
  GraphQLFieldResolver,
  GraphQLSchema,
  isObjectType,
  Kind,
} from 'graphql';

const TRAMPOLINE_INSTALLED = Symbol.for(
  'graphql-tools.stitch.backboneTrampoline',
);

/** Set on context while backbone execute runs so root Islands skip trampoline. */
export const BACKBONE_EXECUTING = Symbol.for(
  'graphql-tools.stitch.backboneExecuting',
);

const ORIGINAL_RESOLVE = Symbol.for(
  'graphql-tools.stitch.backboneOriginalResolve',
);

/**
 * Replace Query/Mutation root field resolvers so stock graphql-js `execute`
 * runs the backbone plan once per operation, then returns cached root values.
 * Subscription roots are left alone (schema subscribe / backbone schema path).
 */
export function installRootTrampoline(
  schema: GraphQLSchema,
  runBackbone: Executor,
): void {
  if ((schema as any)[TRAMPOLINE_INSTALLED]) {
    return;
  }
  (schema as any)[TRAMPOLINE_INSTALLED] = true;

  const CONTEXT_PLAN_RESULT = Symbol('backboneTrampolineResult');
  const CONTEXT_PLAN_PROMISE = Symbol('backboneTrampolinePromise');

  for (const op of ['query', 'mutation'] as const) {
    const rootType =
      op === 'query' ? schema.getQueryType() : schema.getMutationType();
    if (!rootType || !isObjectType(rootType)) {
      continue;
    }
    const fields = rootType.getFields();
    for (const fieldName of Object.keys(fields)) {
      const field = fields[fieldName]!;
      const previousResolve: GraphQLFieldResolver<any, any> =
        field.resolve ?? defaultFieldResolver;
      (field as any)[ORIGINAL_RESOLVE] = previousResolve;
      field.resolve = function backboneRootTrampoline(
        root,
        args,
        context,
        info,
      ) {
        // Nested/backbone Island path: call the real local resolver.
        if (
          context != null &&
          typeof context === 'object' &&
          (context as any)[BACKBONE_EXECUTING]
        ) {
          return previousResolve(root, args, context, info);
        }
        if (context == null || typeof context !== 'object') {
          return previousResolve(root, args, context, info);
        }
        const responseKey = info.path.key;
        const cached = (context as any)[CONTEXT_PLAN_RESULT];
        if (cached != null) {
          if (cached.errors?.length && cached.data == null) {
            throw cached.errors[0];
          }
          return cached.data?.[responseKey];
        }

        let pending = (context as any)[CONTEXT_PLAN_PROMISE] as
          | PromiseLike<any>
          | undefined;
        if (!pending) {
          const request: ExecutionRequest = {
            document: {
              kind: Kind.DOCUMENT,
              definitions: [
                info.operation,
                ...Object.values(info.fragments ?? {}),
              ],
            },
            variables: info.variableValues ?? {},
            context,
            rootValue: root,
            operationName: info.operation.name?.value,
          };
          pending = Promise.resolve(runBackbone(request)).then((result) => {
            (context as any)[CONTEXT_PLAN_RESULT] = result;
            return result;
          });
          (context as any)[CONTEXT_PLAN_PROMISE] = pending;
        }
        return Promise.resolve(pending).then((result) => {
          if (result?.errors?.length && result.data == null) {
            throw result.errors[0];
          }
          return result?.data?.[responseKey];
        });
      };
    }
  }
}

/** Original root resolver before trampoline (for tests / debugging). */
export function getOriginalRootResolve(
  field: { resolve?: GraphQLFieldResolver<any, any> },
): GraphQLFieldResolver<any, any> | undefined {
  return (field as any)[ORIGINAL_RESOLVE];
}
