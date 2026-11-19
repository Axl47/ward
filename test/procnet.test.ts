import assert from "node:assert/strict";
import { test } from "node:test";
import { dialAddresses, listeningPorts } from "../src/procnet.ts";

test("dialAddresses maps loopback and wildcard binds, skips specific addresses", () => {
  assert.deepEqual(dialAddresses("00000000"), ["127.0.0.1"]);
  assert.deepEqual(dialAddresses("0100007F"), ["127.0.0.1"]);
  assert.equal(dialAddresses("0100590A"), undefined); // 10.89.0.1, Podman's DNS
  assert.deepEqual(dialAddresses("00000000000000000000000000000000"), ["::1", "127.0.0.1"]);
  assert.deepEqual(dialAddresses("00000000000000000000000001000000"), ["::1"]);
  assert.deepEqual(dialAddresses("0000000000000000FFFF00000100007F"), ["127.0.0.1"]);
  assert.equal(dialAddresses("000080FE00000000FF00000001000000"), undefined); // link-local
});

test("listeningPorts keeps LISTEN sockets only", () => {
  const text = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1",
    "   1: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2",
    "   2: 0100590A:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3",
    "   3: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 4",
    "",
  ].join("\n");
  assert.deepEqual(
    listeningPorts(text),
    new Map([
      [3000, ["127.0.0.1"]],
      [5432, ["127.0.0.1"]],
    ]),
  );
});
