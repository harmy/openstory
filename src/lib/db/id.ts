/**
 * ID Generation Utilities
 * Centralized ID generation for all database entities using ULIDs
 */

import { ulid } from 'ulid';

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 *
 * Format: 01ARZ3NDEKTSV4RRFFQ69G5FAV (26 characters)
 *
 * Benefits over UUID v4:
 * - Lexicographically sortable (better index performance)
 * - Timestamp prefix (can extract creation time)
 * - Shorter (26 vs 36 characters)
 * - Still globally unique
 *
 * @returns ULID string
 *
 * @example
 * ```ts
 * const id = generateId();
 * // "01HF5Z8XKQYC5N8Z3KQXR6TBQM"
 * ```
 */
export function generateId(): string {
  return ulid();
}

/**
 * Validate if a string is a valid ULID
 *
 * @param id - String to validate
 * @returns true if valid ULID
 *
 * @example
 * ```ts
 * isValidId('01ARZ3NDEKTSV4RRFFQ69G5FAV'); // true
 * isValidId('invalid'); // false
 * ```
 */
export function isValidId(id: string): boolean {
  // ULID is exactly 26 characters, Crockford's Base32 alphabet
  const ulidRegex = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
  return ulidRegex.test(id);
}
