import { describe, expect, it } from 'bun:test';
import { computeSalience, daysBetween } from '../salience.ts';

describe('computeSalience', () => {
  it('returns higher score for recently accessed memories', () => {
    const recent = computeSalience({ similarity: 0.8, reinforcementCount: 1, daysSinceLastAccess: 1, category: 'knowledge' });
    const old = computeSalience({ similarity: 0.8, reinforcementCount: 1, daysSinceLastAccess: 60, category: 'knowledge' });
    expect(recent).toBeGreaterThan(old);
  });

  it('returns higher score for more reinforced memories', () => {
    const reinforced = computeSalience({ similarity: 0.8, reinforcementCount: 10, daysSinceLastAccess: 5, category: 'knowledge' });
    const single = computeSalience({ similarity: 0.8, reinforcementCount: 1, daysSinceLastAccess: 5, category: 'knowledge' });
    expect(reinforced).toBeGreaterThan(single);
  });

  it('returns higher score for more similar memories', () => {
    const similar = computeSalience({ similarity: 0.9, reinforcementCount: 1, daysSinceLastAccess: 5, category: 'knowledge' });
    const dissimilar = computeSalience({ similarity: 0.1, reinforcementCount: 1, daysSinceLastAccess: 5, category: 'knowledge' });
    expect(similar).toBeGreaterThan(dissimilar);
  });

  it('uses different half-lives per category', () => {
    const profile = computeSalience({ similarity: 0.8, reinforcementCount: 1, daysSinceLastAccess: 30, category: 'profile' });
    const event = computeSalience({ similarity: 0.8, reinforcementCount: 1, daysSinceLastAccess: 30, category: 'event' });
    expect(profile).toBeGreaterThan(event);
  });

  it('clamps output to [0, 1]', () => {
    const high = computeSalience({ similarity: 1, reinforcementCount: 1000, daysSinceLastAccess: 0, category: 'profile' });
    const low = computeSalience({ similarity: 0, reinforcementCount: 0, daysSinceLastAccess: 9999, category: 'event' });
    expect(high).toBeLessThanOrEqual(1);
    expect(low).toBeGreaterThanOrEqual(0);
  });

  it('handles zero reinforcement count', () => {
    const score = computeSalience({ similarity: 1, reinforcementCount: 0, daysSinceLastAccess: 0, category: 'knowledge' });
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('handles zero days since access', () => {
    const score = computeSalience({ similarity: 0.5, reinforcementCount: 3, daysSinceLastAccess: 0, category: 'skill' });
    expect(score).toBeGreaterThan(0);
  });
});

describe('daysBetween', () => {
  it('returns 0 for same timestamp', () => {
    const now = Date.now();
    expect(daysBetween(now, now)).toBe(0);
  });

  it('returns correct days for 1 day apart', () => {
    const oneDay = 24 * 60 * 60 * 1000;
    expect(daysBetween(0, oneDay)).toBeCloseTo(1, 1);
  });

  it('never returns negative', () => {
    expect(daysBetween(1000, 0)).toBe(0);
  });
});
