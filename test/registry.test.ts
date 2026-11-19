import assert from "node:assert/strict";
import { test } from "node:test";
import { freeSlot, slotPorts, type WardRecord } from "../src/registry.ts";

const ward = (slot: number): [string, WardRecord] => [`r.${slot}`, { id: `r.${slot}`, repo: "r", worktree: "/w", slot, ports: {}, createdAt: "" }];

test("freeSlot picks the lowest unused slot", () => {
  assert.equal(freeSlot(new Map()), 1);
  assert.equal(freeSlot(new Map([ward(1), ward(3)])), 2);
});

test("slotPorts gives each slot its own block of 100", () => {
  const ports = slotPorts(2);
  assert.equal(ports.length, 100);
  assert.equal(ports[0], 20200);
  assert.equal(ports.at(-1), 20299);
});
