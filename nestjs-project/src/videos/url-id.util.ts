import { randomBytes } from 'crypto';

const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const URL_ID_LENGTH = 11;

/** Path-param shape of a public video identifier (phase-03-videos/TD-05). */
export const URL_ID_REGEX = /^[0-9A-Za-z]{11}$/;

/**
 * Largest multiple of 62 that fits in a byte; bytes at or above it are
 * rejected so every alphabet character stays equally likely (no modulo bias).
 */
const UNBIASED_BYTE_LIMIT = Math.floor(256 / BASE62_ALPHABET.length) * 62;

export function generateUrlId(length: number = URL_ID_LENGTH): string {
  let id = '';
  while (id.length < length) {
    const bytes = randomBytes(length - id.length);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      id += BASE62_ALPHABET[byte % BASE62_ALPHABET.length];
      if (id.length === length) break;
    }
  }
  return id;
}
