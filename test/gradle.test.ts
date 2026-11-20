import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasGradleBuild, ownFolder, serve, sweepBuildCache, writeGradleSettings } from "../src/gradle.ts";

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

// Without reflinks (tmpfs) the clone fails and the home starts empty; the clone itself is checked on btrfs.
const probe = fresh();
put(join(probe, "caches/modules-2/a.jar"));
const reflinks = (await ownFolder(join(fresh(), "probe"), probe)) === undefined;

test("a ward's home is a clone of the dependency caches, transforms and wrapper, without the local build cache", { skip: !reflinks && "no reflinks here" }, async () => {
  const source = fresh();
  put(join(source, "caches/modules-2/files-2.1/a.jar"));
  put(join(source, "caches/modules-2/modules-2.lock"));
  put(join(source, "caches/9.8.2/fileHashes/fileHashes.bin"));
  put(join(source, "caches/9.8.2/gc.properties"));
  put(join(source, "caches/transforms-3/x/a.jar"));
  put(join(source, "caches/build-cache-1/" + key("a")));
  put(join(source, "caches/journal-1/journal-1.lock"));
  put(join(source, "wrapper/dists/gradle-9.8.2-bin/x/gradle-9.8.2.zip.ok"));
  put(join(source, "daemon/9.8.2/registry.bin"));
  const home = join(fresh(), "gradle");
  assert.equal(await ownFolder(home, source), undefined);
  assert.deepEqual(readdirSync(join(home, "caches")).sort(), ["9.8.2", "modules-2", "transforms-3"]);
  assert.deepEqual(readdirSync(join(home, "caches/modules-2")).sort(), ["files-2.1", "modules-2.lock"]);
  assert.deepEqual(readdirSync(join(home, "caches/9.8.2")), ["fileHashes"]);
  assert.ok(existsSync(join(home, "wrapper/dists/gradle-9.8.2-bin/x/gradle-9.8.2.zip.ok")));
  assert.ok(!existsSync(join(home, "daemon")));
});

test("links a ward left where its home goes are removed, never followed", async () => {
  const decoy = fresh();
  put(join(decoy, "home/keep"));
  put(join(decoy, "tmp/keep"));
  const state = fresh();
  symlinkSync(join(decoy, "home"), join(state, "gradle"));
  symlinkSync(join(decoy, "tmp"), join(state, "gradle.tmp"));
  const source = fresh();
  put(join(source, "caches/modules-2/files-2.1/a.jar"));
  await ownFolder(join(state, "gradle"), source);
  assert.ok(lstatSync(join(state, "gradle")).isDirectory());
  assert.ok(!existsSync(join(state, "gradle.tmp")));
  assert.deepEqual([readdirSync(join(decoy, "home")), readdirSync(join(decoy, "tmp"))], [["keep"], ["keep"]]);
});

test("a ward's home is cloned only for a worktree with a Gradle build at its root or one folder down", () => {
  const worktree = fresh();
  put(join(worktree, "src/index.ts"));
  assert.equal(hasGradleBuild(worktree), false);
  put(join(worktree, "android/gradlew"));
  assert.equal(hasGradleBuild(worktree), true);
});

test("a ward's settings add a short idle timeout unless yours set one, and keep your init scripts in step", () => {
  const source = fresh();
  const home = fresh();
  put(join(source, "gradle.properties"), "org.gradle.jvmargs=-Xmx2g");
  put(join(source, "init.d/mine.gradle"));
  put(join(source, "init.d/notes.txt"));
  put(join(source, "init.d/sub/inner.gradle"));
  symlinkSync(join(source, "missing.gradle"), join(source, "init.d/dangling.gradle"));
  put(join(home, "init.d/removed.gradle"));
  writeGradleSettings(home, source);
  assert.match(readFileSync(join(home, "gradle.properties"), "utf8"), /^org\.gradle\.jvmargs=-Xmx2g\n(#.*\n)?org\.gradle\.daemon\.idletimeout=600000\n$/);
  assert.deepEqual(readdirSync(join(home, "init.d")).sort(), ["mine.gradle", "ward-build-cache.gradle"]);

  put(join(source, "gradle.properties"), "org.gradle.daemon.idletimeout = 60000\n");
  writeGradleSettings(home, source);
  assert.equal(readFileSync(join(home, "gradle.properties"), "utf8"), "org.gradle.daemon.idletimeout = 60000\n");
});

test("the cache stores and answers entries by hex key, and refuses other keys, empty entries and ones over the limit", async () => {
  const store = join(fresh(), "repo");
  const server = createServer((req, res) => void serve(store, req, res, 8)).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = (k: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/cache/${k}`;
  try {
    assert.equal((await fetch(url(key("b")))).status, 404);
    assert.equal((await fetch(url(key("b")), { method: "PUT", body: "entry" })).status, 200);
    assert.equal(await (await fetch(url(key("b")))).text(), "entry");
    assert.equal((await fetch(url("..%2Fescape" + key("b")), { method: "PUT", body: "x" })).status, 400);
    assert.equal((await fetch(url(key("B")))).status, 400);
    assert.equal((await fetch(url("c".repeat(129)))).status, 400);
    assert.equal((await fetch(url(key("c")), { method: "PUT", body: "" })).status, 400);
    assert.equal((await fetch(url(key("c")), { method: "PUT", body: "123456789" })).status, 413);
    const chunked = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("12345")), c.enqueue(new TextEncoder().encode("6789")), c.close()) });
    // A streamed body (no Content-Length) is counted as it arrives; `duplex` is missing from TypeScript's RequestInit.
    assert.equal((await fetch(url(key("c")), { method: "PUT", body: chunked, duplex: "half" } as RequestInit)).status, 413);
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
