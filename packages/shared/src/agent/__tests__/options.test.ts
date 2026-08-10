import { describe, expect, it } from 'bun:test';
import { getDefaultOptions } from '../options.ts';

describe('getDefaultOptions', () => {
  it('loads only project and local Claude settings', () => {
    expect(getDefaultOptions().settingSources).toEqual(['project', 'local']);
  });
});
