import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloneGradleHome, serve, sweepBuildCache, writeGradleSettings } from "../src/gradle.ts";

const scratch = mkdtempSync(join(tmpdir(), "ward-gradle-"));
test.after(() => rmSync(scratch, { recursive: true }));
let n = 0;
const fresh = () => {
  const dir = join(scratch, String(n++));
  mkdirSync(dir);
  return dir;
};
const put = (path: string, content = "x", ageSeconds = 0) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const t = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(path, t, t);
};
const key = (c: string) => c.repeat(32);

test("a ward's home is a clone of the dependency caches and wrapper, without locks or the local build cache", async () => {
  const source = fresh();
  put(join(source, "caches/modules-2/files-2.1/a.jar"));
  put(join(source, "caches/modules-2/modules-2.lock"));
  put(join(source, "caches/9.8.2/fileHashes/fileHashes.bin"));
  put(join(source, "caches/9.8.2/fileHashes/fileHashes.lock"));
  put(join(source, "caches/build-cache-1/" + key("a")));
  put(join(source, "caches/journal-1/journal-1.lock"));
  put(join(source, "wrapper/dists/gradle-9.8.2-bin/x/gradle-9.8.2.zip.ok"));
  put(join(source, "daemon/9.8.2/registry.bin"));
  const home = join(fresh(), "gradle");
  assert.equal(await cloneGradleHome(home, source), undefined);
  assert.deepEqual(readdirSync(join(home, "caches")).sort(), ["9.8.2", "modules-2"]);
  assert.deepEqual(readdirSync(join(home, "caches/modules-2")), ["files-2.1"]);
  assert.deepEqual(readdirSync(join(home, "caches/9.8.2/fileHashes")), ["fileHashes.bin"]);
  assert.ok(existsSync(join(home, "wrapper/dists/gradle-9.8.2-bin/x/gradle-9.8.2.zip.ok")));
  assert.ok(!existsSync(join(home, "daemon")));
});

test("a ward's settings add a short idle timeout unless yours set one, and keep init scripts in step", () => {
  const source = fresh();
  const home = fresh();
  put(join(source, "gradle.properties"), "org.gradle.jvmargs=-Xmx2g");
  put(join(source, "init.d/mine.gradle"));
  put(join(home, "init.d/removed.gradle"));
  writeGradleSettings(home, source);
  assert.match(readFileSync(join(home, "gradle.properties"), "utf8"), /^org\.gradle\.jvmargs=-Xmx2g\n(#.*\n)?org\.gradle\.daemon\.idletimeout=600000\n$/);
  assert.deepEqual(readdirSync(join(home, "init.d")).sort(), ["mine.gradle", "ward-build-cache.gradle"]);

  put(join(source, "gradle.properties"), "org.gradle.daemon.idletimeout = 60000\n");
  writeGradleSettings(home, source);
  assert.equal(readFileSync(join(home, "gradle.properties"), "utf8"), "org.gradle.daemon.idletimeout = 60000\n");
});

test("the cache stores and answers entries by hex key and refuses other keys", async () => {
  const store = join(fresh(), "repo");
  const server = createServer((req, res) => void serve(store, req, res)).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = (k: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/cache/${k}`;
  try {
    assert.equal((await fetch(url(key("b")))).status, 404);
    assert.equal((await fetch(url(key("b")), { method: "PUT", body: "entry" })).status, 200);
    assert.equal(await (await fetch(url(key("b")))).text(), "entry");
    assert.equal((await fetch(url("..%2Fescape" + key("b")), { method: "PUT", body: "x" })).status, 400);
    assert.equal((await fetch(url(key("B")))).status, 400);
    assert.deepEqual(readdirSync(store), [key("b")]);
  } finally {
    server.close();
  }
});

test("the sweep deletes the least recently used entries down to the cap, and stale uploads", async () => {
  const dir = fresh();
  put(join(dir, "a", key("1")), "1234", 300);
  put(join(dir, "b", key("2")), "1234", 200);
  put(join(dir, "a", key("3")), "1234", 100);
  put(join(dir, "a", ".tmp-old"), "", 7200);
  put(join(dir, "a", ".tmp-new"), "", 60);
  assert.equal(await sweepBuildCache(dir, 5), 3);
  assert.deepEqual(readdirSync(join(dir, "a")).sort(), [".tmp-new", key("3")]);
  assert.deepEqual(readdirSync(join(dir, "b")), []);
});
