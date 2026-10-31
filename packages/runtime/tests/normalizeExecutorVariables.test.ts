import { describe, expect, it } from 'vitest';
import { normalizeExecutorVariables } from '../src/utils';

describe('normalizeExecutorVariables', () => {
  it('strips undefined entries so GraphQL.js can apply operation defaults', () => {
    expect(normalizeExecutorVariables({ bool: undefined })).toEqual({});
    expect(normalizeExecutorVariables({ bool: false, x: undefined })).toEqual({
      bool: false,
    });
  });

  it('unwraps graphql@17 coerced wrappers', () => {
    expect(
      normalizeExecutorVariables({
        sources: {},
        coerced: { bool: true, missing: undefined },
      }),
    ).toEqual({ bool: true });
  });

  it('preserves null/undefined maps', () => {
    expect(normalizeExecutorVariables(undefined)).toBeUndefined();
    expect(normalizeExecutorVariables(null)).toBeUndefined();
  });
});
