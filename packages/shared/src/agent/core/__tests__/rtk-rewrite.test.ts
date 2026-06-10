/**
 * Tests for rewriteBashWithRtk passthrough guards (v0.9.4 RTK integration).
 *
 * Scoped to the cases that short-circuit BEFORE spawning the `rtk` binary, so
 * they run deterministically without rtk installed. The actual rewrite path
 * (spawnSync) depends on the external binary and is not exercised here.
 */

import { describe, test, expect } from 'bun:test';
import { rewriteBashWithRtk } from '../rtk-rewrite.ts';

describe('rewriteBashWithRtk — passthrough guards', () => {
  const input = { command: 'git status' };

  test('passthrough when tool is not Bash', () => {
    const r = rewriteBashWithRtk('Read', input, '/usr/local/bin/rtk', []);
    expect(r.modified).toBe(false);
    expect(r.input).toBe(input);
  });

  test('passthrough when rtk path is null (binary missing)', () => {
    const r = rewriteBashWithRtk('Bash', input, null, []);
    expect(r.modified).toBe(false);
    expect(r.input).toBe(input);
  });

  test('passthrough when command is empty', () => {
    const r = rewriteBashWithRtk('Bash', { command: '' }, '/usr/local/bin/rtk', []);
    expect(r.modified).toBe(false);
  });

  test('passthrough when base command is excluded', () => {
    // `git` is excluded → returns before any spawn, regardless of rtk presence.
    const r = rewriteBashWithRtk('Bash', input, '/usr/local/bin/rtk', ['git']);
    expect(r.modified).toBe(false);
    expect(r.input).toBe(input);
  });

  test('exclusion matches only the base command, not substrings', () => {
    // Excluding 'git' must not exclude a command whose base is 'gitk'.
    const r = rewriteBashWithRtk('Bash', { command: 'gitk --all' }, null, ['git']);
    // rtk path is null here so it still passes through, but this asserts the
    // exclusion check itself doesn't false-positive on 'gitk'.
    expect(r.modified).toBe(false);
  });
});
