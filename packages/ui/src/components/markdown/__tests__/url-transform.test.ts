/**
 * Security tests for markdownUrlTransform.
 *
 * Invariant: XSS-class schemes (javascript:/data:/vbscript:/blob:) must NEVER
 * survive the transform for anchor hrefs, independent of the custom <a>'s own
 * re-sanitization. Only file: is re-allowed from the set the default transform
 * strips, because the custom <a> routes file: links via onFileClick.
 */

import { describe, test, expect } from 'bun:test';
import { markdownUrlTransform } from '../url-transform';

// Minimal hast-like node for an anchor.
const anchorNode = { tagName: 'a' } as never;
const imgNode = { tagName: 'img' } as never;

describe('markdownUrlTransform — anchor href', () => {
  test('strips javascript: scheme', () => {
    expect(markdownUrlTransform('javascript:alert(1)', 'href', anchorNode)).toBe('');
  });

  test('strips data: scheme', () => {
    expect(markdownUrlTransform('data:text/html,<script>alert(1)</script>', 'href', anchorNode)).toBe('');
  });

  test('strips vbscript: scheme', () => {
    expect(markdownUrlTransform('vbscript:msgbox(1)', 'href', anchorNode)).toBe('');
  });

  test('strips blob: scheme', () => {
    expect(markdownUrlTransform('blob:https://evil/x', 'href', anchorNode)).toBe('');
  });

  test('preserves http/https', () => {
    expect(markdownUrlTransform('https://example.com/x', 'href', anchorNode)).toBe('https://example.com/x');
    expect(markdownUrlTransform('http://example.com/x', 'href', anchorNode)).toBe('http://example.com/x');
  });

  test('preserves relative paths', () => {
    expect(markdownUrlTransform('/foo/bar', 'href', anchorNode)).toBe('/foo/bar');
    expect(markdownUrlTransform('./rel', 'href', anchorNode)).toBe('./rel');
  });

  test('re-allows file: (routable via onFileClick)', () => {
    expect(markdownUrlTransform('file:///Users/x/doc.md', 'href', anchorNode)).toBe('file:///Users/x/doc.md');
  });
});

describe('markdownUrlTransform — non-anchor / other keys', () => {
  test('image src is fully sanitized (no file: re-allow)', () => {
    expect(markdownUrlTransform('javascript:alert(1)', 'src', imgNode)).toBe('');
    expect(markdownUrlTransform('file:///etc/passwd', 'src', imgNode)).toBe('');
  });
});
