import { describe, expect, it } from 'vitest';
import { parseRange } from '../electron/library.mjs';

describe('media range parser', () => {
  it('serves full files and valid byte ranges', () => {
    expect(parseRange(undefined, 100)).toEqual({ start: 0, end: 99, partial: false });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19, partial: true });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99, partial: true });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99, partial: true });
  });

  it('rejects malformed or unsatisfiable ranges instead of reading outside the file', () => {
    expect(parseRange('items=0-10', 100)).toBeNull();
    expect(parseRange('bytes=100-100', 100)).toBeNull();
    expect(parseRange('bytes=-0', 100)).toBeNull();
    expect(parseRange('bytes=30-20', 100)).toBeNull();
  });
});
