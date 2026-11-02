import { makeExecutableSchema } from '@graphql-tools/schema';
import {
  getBackboneExecutor,
  getStitchingExecutionMode,
  stitchSchemas,
} from '@graphql-tools/stitch';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMergedResolver as backboneDefaultMergedResolver } from '../src/backbone/defaultMergedResolver.js';
import { classicMergedResolver } from '../src/classicMergedResolver.js';

const ENV = 'GRAPHQL_TOOLS_CLASSIC_STITCHING';

function stitchHello(opts?: { classicStitching?: boolean }) {
  return stitchSchemas({
    subschemas: [
      makeExecutableSchema({
        typeDefs: `type Query { hello: String }`,
        resolvers: { Query: { hello: () => 'hi' } },
      }),
    ],
    ...opts,
  });
}

describe('classic vs backbone stitching flag', () => {
  const prev = process.env[ENV];

  afterEach(() => {
    if (prev === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = prev;
    }
  });

  it('defaults to backbone with executor attached', () => {
    delete process.env[ENV];
    const schema = stitchHello();
    expect(getStitchingExecutionMode(schema)).toBe('backbone');
    expect(getBackboneExecutor(schema)).toBeDefined();
    expect(schema.extensions?.['stitchingInfo']).toBeDefined();
  });

  it('classicStitching: true skips backbone; classic and backbone DMRs differ', () => {
    delete process.env[ENV];
    const schema = stitchHello({ classicStitching: true });
    expect(getStitchingExecutionMode(schema)).toBe('classic');
    expect(getBackboneExecutor(schema)).toBeUndefined();
    expect(classicMergedResolver).not.toBe(backboneDefaultMergedResolver);
  });

  it('classicStitching: false wins over env', () => {
    process.env[ENV] = '1';
    const schema = stitchHello({ classicStitching: false });
    expect(getStitchingExecutionMode(schema)).toBe('backbone');
    expect(getBackboneExecutor(schema)).toBeDefined();
  });

  it('env GRAPHQL_TOOLS_CLASSIC_STITCHING=1 enables classic', () => {
    process.env[ENV] = '1';
    const schema = stitchHello();
    expect(getStitchingExecutionMode(schema)).toBe('classic');
    expect(getBackboneExecutor(schema)).toBeUndefined();
  });
});
