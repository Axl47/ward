import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mirrorDeviceHosts } from "../src/device-hosts.ts";

test("the mirror has T3's config names, never their contents, and follows removals", () => {
  const root = mkdtempSync(join(tmpdir(), "device-hosts-"));
  const from = join(root, "hosts");
  const to = join(root, "mirror");
  try {
    mirrorDeviceHosts(from, to); // no hosts folder yet
    assert.deepEqual(readdirSync(to), []);

    mkdirSync(from);
    writeFileSync(join(from, "a.json"), '{"daemonAuthToken":"secret"}');
    writeFileSync(join(from, "b.json"), "{}");
    writeFileSync(join(from, ".endpoint-1.json"), "{}"); // T3's temp file before a rename
    writeFileSync(join(from, "notes.txt"), "");
    mirrorDeviceHosts(from, to);
    assert.deepEqual(readdirSync(to).sort(), ["a.json", "b.json"]);
    assert.equal(readFileSync(join(to, "a.json"), "utf8"), "{}\n");

    rmSync(join(from, "a.json"));
    mirrorDeviceHosts(from, to);
    assert.deepEqual(readdirSync(to), ["b.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
