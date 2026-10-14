/** Moved to the shared `hq-client` package (hq-vscode decision 4); the CLI keeps this path. */
export * from '@hq/client/safe-text.js';

/**
 * Characters `JSON.stringify` leaves RAW that a terminal or a script must never meet raw: DEL and C1
 * (`\u009b` is the 8-bit CSI), the two line separators (they end a line for many JS and log tools),
 * the bidi overrides, isolates and marks (U+200E, U+200F, U+061C: they reorder what a reader sees)
 * and the BOM / zero-width no-break space (U+FEFF, invisible). C0 is already escaped by
 * `JSON.stringify` itself.
 */
const JSON_UNSAFE =
  /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/**
 * train 96 e2e (`--json` `rawName`): one JSON document, safe to print and safe to pipe. It parses to
 * EXACTLY the value given (the server's raw session name survives byte for byte), but the printed
 * line holds no control, separator or bidi character: each is a `\uXXXX` escape. Everything else is
 * `JSON.stringify`'s own output, so ordinary text (accents, emoji) is unchanged.
 *
 * Safe on the whole document: those characters can only appear inside JSON strings, where a
 * `\uXXXX` escape means the same character.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    JSON_UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
