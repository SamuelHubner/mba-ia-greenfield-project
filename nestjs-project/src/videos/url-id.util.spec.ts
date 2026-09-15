import { generateUrlId, URL_ID_LENGTH, URL_ID_REGEX } from './url-id.util';

describe('generateUrlId', () => {
  it('should generate an 11-character identifier by default', () => {
    expect(generateUrlId()).toHaveLength(URL_ID_LENGTH);
    expect(URL_ID_LENGTH).toBe(11);
  });

  it('should honour a custom length', () => {
    expect(generateUrlId(20)).toHaveLength(20);
  });

  it('should only use the base62 alphabet', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateUrlId()).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  it('should not repeat across 10 000 generations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(generateUrlId());
    expect(ids.size).toBe(10_000);
  });
});

describe('URL_ID_REGEX', () => {
  it('should accept a generated identifier', () => {
    expect(URL_ID_REGEX.test(generateUrlId())).toBe(true);
  });

  it.each([
    ['dash', 'abcdefghij-'],
    ['underscore', 'abcdefghij_'],
    ['too short', 'abcdefghij'],
    ['too long', 'abcdefghijkl'],
    ['empty', ''],
  ])('should reject %s (%s)', (_label, value) => {
    expect(URL_ID_REGEX.test(value)).toBe(false);
  });
});
