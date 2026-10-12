// N#HH line anchors, byte-compatible with pi-multiedit and pi-hashline-edit: xxHash32 of the
// right-trimmed line, low byte mapped to two letters (same code as pi-jev-kit's anchor.ts).
import XXH from "xxhashjs";

const NIBBLES = "ZPMQVRWSNKTXJBYH";
const DICT = Array.from({ length: 256 }, (_, i) => NIBBLES[i >>> 4] + NIBBLES[i & 15]);
const SIGNIFICANT = /[\p{L}\p{N}]/u;

export function lineHash(lineNumber: number, line: string): string {
  const text = line.replace(/\r/g, "").trimEnd();
  // Punctuation-only lines collide constantly; they are seeded by position.
  const seed = SIGNIFICANT.test(text) ? 0 : lineNumber;
  return DICT[(XXH.h32(text, seed).toNumber() >>> 0) & 0xff];
}

/** `lines[i]` rendered as `N#HH:text`, numbers padded so the hash column aligns. */
export function formatAnchored(lines: string[], firstLine: number): string {
  const width = String(firstLine + Math.max(0, lines.length - 1)).length;
  return lines.map((line, i) => `${String(firstLine + i).padStart(width)}#${lineHash(firstLine + i, line)}:${line}`).join("\n");
}

/** `lines[i]` rendered as `N: text` for read tools without anchors. */
export function formatNumbered(lines: string[], firstLine: number): string {
  const width = String(firstLine + Math.max(0, lines.length - 1)).length;
  return lines.map((line, i) => `${String(firstLine + i).padStart(width)}: ${line}`).join("\n");
}
