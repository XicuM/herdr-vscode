import { describe, expect, it } from 'vitest';
import { formatReference, referencePath } from '../src/mentions';

describe('formatReference', () => {
  it('uses each harness mention syntax', () => {
    expect(formatReference('claude', 'notes/a.md')).toBe('@notes/a.md ');
    expect(formatReference('opencode', 'notes/a.md', 10, 20)).toBe('@notes/a.md#L10-20 ');
    expect(formatReference('codex', 'notes/a.md', 10, 12)).toBe('notes/a.md:10-12 ');
    expect(formatReference('copilot', 'notes/a.md', 7, 7)).toBe('@notes/a.md:7 ');
    expect(formatReference('agy', 'notes/a.md', 1, 3)).toBe('@notes/a.md:1-3 ');
    expect(formatReference('grok', 'notes/a.md', 1, 3)).toBe('@notes/a.md:1-3 ');
    expect(formatReference('pi', 'notes/a.md', 4, 5)).toBe('@notes/a.md:4-5 ');
  });

  it('quotes paths with spaces inside the mention', () => {
    expect(formatReference('claude', 'my notes/a.md')).toBe('@"my notes/a.md" ');
    expect(formatReference('claude', 'my notes/a.md', 2, 3)).toBe('@"my notes/a.md#L2-3" ');
    expect(formatReference('codex', 'my notes/a.md')).toBe('"my notes/a.md" ');
  });

  it('falls back to a plain path for shells and unknown harnesses', () => {
    expect(formatReference(null, 'notes/a.md', 3, 4)).toBe('@notes/a.md#L3-4 ');
    expect(formatReference('unknown', 'notes/a.md')).toBe('@notes/a.md ');
  });
});

describe('referencePath', () => {
  it('returns a relative path inside the folder', () => {
    expect(referencePath('/work/proj', '/work/proj/notes/a.md')).toBe('notes/a.md');
  });

  it('returns the absolute path outside the folder', () => {
    expect(referencePath('/work/proj', '/work/other/a.md')).toBe('/work/other/a.md');
  });
});
