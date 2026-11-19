// summarize.ts RESULTS_DIR: medians and ranges over the workload runs and the
// port benchmark. Startup, idle, disk and wardd results are already summarized
// in their own files.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { show } from "./stats.ts";

interface Sample {
  name: string;
  activeCpuUsec: number;
  peakBytes: number;
  steadyBytes: number;
  steadyAnonBytes: number;
}
interface Bench {
  newConnMs: number;
  keepAliveMs: number;
  newConnRps: number;
  keepAliveRps: number;
  bigMBps: number;
}

const dir = process.argv[2] ?? ".";
const MiB = 1024 * 1024;
const files = (prefix: string, ext: string) => readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(ext));
const read = (f: string) => readFileSync(join(dir, f), "utf8");

for (const mode of ["host", "warded"] as const) {
  const runs = files(`workload-${mode}-`, ".jsonl").map((f) => read(f).trim().split("\n").map((l) => JSON.parse(l) as Sample));
  // Per run, the copies' own cgroups: the slice for host, the N ward units for warded.
  const own = runs.map((rows) => rows.filter((r) => (mode === "host" ? r.name === "host-slice" : /^p\d+$/.test(r.name))));
  const total = (k: keyof Omit<Sample, "name">) => own.map((rows) => rows.reduce((a, r) => a + r[k], 0));
  const walls = files(`workload-${mode}-`, ".txt").map((f) => Number(/wall: (\d+)/.exec(read(f))?.[1]));
  console.log(`## ${mode} (${runs.length} runs)`);
  console.log(`wall          ${show(walls, "s", 1000, 2)}`);
  console.log(`cpu active    ${show(total("activeCpuUsec"), "s", 1e6, 2)}`);
  console.log(`steady mem    ${show(total("steadyBytes"), "MiB", MiB)}`);
  console.log(`steady anon   ${show(total("steadyAnonBytes"), "MiB", MiB)}`);
  console.log(`peak (sum)    ${show(total("peakBytes"), "MiB", MiB)}`);
  if (mode === "warded") console.log(`steady/ward   ${show(own.flat().map((r) => r.steadyBytes), "MiB", MiB)}`);
}

const ports = read("ports.txt").split("\n");
console.log("## ports");
for (const path of ["inside", "mapped", "direct"] as const) {
  const rows = ports.filter((l) => l.startsWith(`${path} {`)).map((l) => JSON.parse(l.slice(path.length + 1)) as Bench);
  const col = (k: keyof Bench) => rows.map((r) => r[k]);
  console.log(`${path}: new conn ${show(col("newConnMs"), "ms", 1, 3)}, keep-alive ${show(col("keepAliveMs"), "ms", 1, 3)}, ` +
    `new conn ${show(col("newConnRps"), "req/s")}, keep-alive ${show(col("keepAliveRps"), "req/s")}, 64 MiB ${show(col("bigMBps"), "MB/s")}`);
}
