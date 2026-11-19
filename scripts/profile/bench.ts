// bench.ts URL: HTTP latency and throughput against a dev server, e.g.
// http://127.0.0.1:5173 (use IP literals: a name lookup per request would
// swamp the per-connection cost being measured). Requests /ping.txt (tiny
// static file) and /big.bin (64 MiB) and prints one JSON line:
//   newConnMs / keepAliveMs   median latency of sequential requests
//   newConnRps / keepAliveRps throughput with 16 requests in flight
//   bigMBps                   one 64 MiB download
import http from "node:http";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:5173");
const host = base.hostname.replace(/^\[|\]$/g, "");
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 16 });
/** An Agent reuses connections; `false` opens a new one per request. */
type Connections = http.Agent | false;

/** GET a path; resolves with the body's size, rejects on anything but a full 200. */
function get(path: string, agent: Connections): Promise<number> {
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = http.get({ host, port: base.port, path, agent }, (res) => {
      responded = true;
      let bytes = 0;
      res.on("data", (chunk: Buffer) => (bytes += chunk.length));
      res.on("end", () => (res.statusCode === 200 ? resolve(bytes) : reject(new Error(`HTTP ${res.statusCode}`))));
      res.on("error", reject);
      res.on("close", () => res.complete || reject(new Error(`connection closed after ${bytes} bytes`)));
    });
    req.on("error", reject);
    req.on("close", () => responded || reject(new Error("connection closed before a response")));
  });
}

async function sequential(n: number, agent: Connections): Promise<number> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await get("/ping.txt", agent);
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return +ms[Math.floor(n / 2)]!.toFixed(3);
}

async function throughput(n: number, agent: Connections, inFlight = 16): Promise<number> {
  let next = 0;
  const t = performance.now();
  await Promise.all(Array.from({ length: inFlight }, async () => {
    while (next++ < n) await get("/ping.txt", agent);
  }));
  return Math.round(n / ((performance.now() - t) / 1000));
}

await sequential(50, keepAlive); // warm up
const t = performance.now();
const bytes = await get("/big.bin", false);
const bigMBps = Math.round(bytes / 1e6 / ((performance.now() - t) / 1000));
console.log(JSON.stringify({
  newConnMs: await sequential(300, false),
  keepAliveMs: await sequential(1000, keepAlive),
  newConnRps: await throughput(2000, false),
  keepAliveRps: await throughput(4000, keepAlive),
  bigMBps,
}));
keepAlive.destroy();
