import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_HOST_PORTS, parseProjectHostPorts, wardHostPorts } from "../src/hostports.ts";
import { parsePorts } from "../src/paths.ts";

test("only plain decimal ports parse", () => {
  assert.deepEqual(parsePorts("80, 443,0x50,1e3,+80,-1,0,65536,8080"), [80, 443, 8080]);
  for (const bad of ["0x50", "1e3", "+80", "80.0", "0", "65536", "abc"]) assert.throws(() => parseProjectHostPorts(bad, []), /bad port/);
});

test("project ports: DNS and Ward's own range are refused, duplicates merged", () => {
  assert.throws(() => parseProjectHostPorts("53", [3773]), /DNS/);
  assert.throws(() => parseProjectHostPorts("28000", [3773]), /range/);
  assert.deepEqual(parseProjectHostPorts("39003, 3773,39003,20099,30000", [3773]), [39003, 3773, 20099, 30000]);
});

test("a list that can't fit pasta's rules is refused", () => {
  const many = Array.from({ length: MAX_HOST_PORTS }, (_, i) => 40000 + i).join(",");
  assert.throws(() => parseProjectHostPorts(many, [3773]), /at most/);
  assert.equal(parseProjectHostPorts(many, []).length, MAX_HOST_PORTS);
});

test("a ward's list is deduplicated and cleaned even from a hand-edited marker", () => {
  assert.deepEqual(wardHostPorts([8081, 53, 28000, 39003], [3773, 8081]), [3773, 8081, 39003]);
});

test("the host's adb server and emulators are never forwarded: a ward has its own", () => {
  assert.deepEqual(wardHostPorts([5037, 5555, 39003], [3773, 5037, 5554]), [3773, 39003]);
  assert.throws(() => parseProjectHostPorts("5037", [3773]), /adb's in every ward/);
  assert.throws(() => parseProjectHostPorts("5585", [3773]), /an emulator's port/);
});
