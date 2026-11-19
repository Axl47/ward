// stats.ts [LABEL]: read numbers (one per line) on stdin, print median and range.
// Also the median/range helpers summarize.ts uses.
import { readFileSync } from "node:fs";

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** "median unit (min–max)", each divided by `scale`. */
export function show(xs: readonly number[], unit: string, scale = 1, digits = 0): string {
  const f = (x: number) => (x / scale).toFixed(digits);
  return `${f(median(xs))}${unit ? ` ${unit}` : ""} (${f(Math.min(...xs))}–${f(Math.max(...xs))})`;
}

if (import.meta.main) {
  const xs = readFileSync(0, "utf8").split(/\s+/).filter(Boolean).map(Number);
  const digits = Math.abs(median(xs)) >= 100 ? 0 : 2;
  console.log(`${process.argv[2] ?? ""}\t${show(xs, "", 1, digits)}\tn=${xs.length}`);
}
