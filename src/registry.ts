// The daemon's persistent record of wards: slot, worktree and port mappings.
// Only wardd writes it; the CLI reads it through the control socket.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REGISTRY_FILE } from "./paths.ts";

export interface WardRecord {
  readonly id: string;
  readonly repo: string;
  readonly worktree: string;
  /**
   * Host ports for this ward are PORT_BASE + slot * SLOT_SIZE + 0..SLOT_SIZE-1.
   * 0 while it has none: a stopped ward's slot goes to a new ward when all are taken.
   */
  readonly slot: number;
  /** Ward port → host port. Stable for the ward's life, across stops. */
  readonly ports: Record<string, number>;
  readonly createdAt: string;
}

interface RegistryFile {
  readonly version: 1;
  readonly wards: Record<string, WardRecord>;
}

export const PORT_BASE = 20000;
export const SLOT_SIZE = 100;
export const MAX_SLOTS = 99;

export function loadRegistry(): Map<string, WardRecord> {
  try {
    const file = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as RegistryFile;
    return new Map(Object.entries(file.wards));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    // Unreadable: keep it for inspection and start empty rather than refuse every ward.
    const aside = `${REGISTRY_FILE}.corrupt-${Date.now()}`;
    renameSync(REGISTRY_FILE, aside);
    console.error(`ward: registry was unreadable (${String(error)}); moved it to ${aside}`);
    return new Map();
  }
}

export function saveRegistry(wards: ReadonlyMap<string, WardRecord>): void {
  const file: RegistryFile = { version: 1, wards: Object.fromEntries(wards) };
  mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
  const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, REGISTRY_FILE);
}

/** Lowest slot no other ward holds, or undefined when all are taken. */
export function freeSlot(wards: ReadonlyMap<string, WardRecord>): number | undefined {
  const used = new Set([...wards.values()].map((w) => w.slot));
  for (let slot = 1; slot <= MAX_SLOTS; slot++) if (!used.has(slot)) return slot;
  return undefined;
}

/** Host ports of a slot, in allocation order. */
export function slotPorts(slot: number): number[] {
  const base = PORT_BASE + slot * SLOT_SIZE;
  return Array.from({ length: SLOT_SIZE }, (_, i) => base + i);
}
