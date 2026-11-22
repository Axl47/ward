import assert from "node:assert/strict";
import { test } from "node:test";
import { baseName, parseDuration } from "../src/device.ts";

test("durations are seconds, minutes or hours", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("15m"), 900_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  for (const bad of ["", "15", "1.5h", "2d", "-5m", "m"]) assert.equal(parseDuration(bad), undefined, bad);
});

test("a base image is named for what it was built from, so any change in that means another image", () => {
  const sources = ["1", "swangle_indirect", "", "hw.ramSize=2G", "Pkg.Revision=37.2.13", "Pkg.Revision=7", "ro.build.id=x"];
  assert.match(baseName(sources), /^ward-base-[0-9a-f]{8}$/);
  assert.equal(baseName(sources), baseName([...sources]));
  assert.notEqual(baseName(sources), baseName(sources.with(4, "Pkg.Revision=37.3.1")));
  // The parts are kept apart: moving text from one to the next is a change too.
  assert.notEqual(baseName(["ab", "c"]), baseName(["a", "bc"]));
});
