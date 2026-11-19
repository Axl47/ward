// sampler.ts NAME=CGROUP_DIR...: watch cgroups during a run and print one JSON
// line per cgroup when it gets SIGTERM.
//
// On start it resets each cgroup's memory.peak (write to the file, kernel 6.12+;
// the reset holds for this open fd), so `peakBytes` is the peak during the run.
// SIGUSR1 marks the end of the active workload: CPU used up to then is
// `activeCpuUsec`. Memory is sampled every second after SIGUSR2 (send it once
// the workload has settled): `steadyBytes` is the median memory.current and
// `steadyAnonBytes` the median anonymous memory (memory.current minus page cache
// and kernel memory, from memory.stat).
import { openSync, readFileSync, readSync, writeSync } from "node:fs";
import { median } from "./stats.ts";

/** A number from a cgroup file, e.g. `usage_usec` in cpu.stat. */
function field(dir: string, file: string, key: string): number {
  const match = new RegExp(`^${key} (\\d+)`, "m").exec(readFileSync(`${dir}/${file}`, "utf8"));
  if (!match) throw new Error(`${key} not in ${dir}/${file}`);
  return Number(match[1]);
}
const cpu = (dir: string) => field(dir, "cpu.stat", "usage_usec");

function readPeak(fd: number): number {
  const buf = Buffer.alloc(64);
  return Number(buf.toString("utf8", 0, readSync(fd, buf, 0, 64, 0)).trim());
}

const cgroups = process.argv.slice(2).map((arg) => {
  const [name = "", dir = ""] = arg.split("=");
  const peakFd = openSync(`${dir}/memory.peak`, "r+");
  writeSync(peakFd, "reset\n");
  return { name, dir, peakFd, cpu0: cpu(dir), activeCpu: undefined as number | undefined, current: [] as number[], anon: [] as number[] };
});
let steady = false;

setInterval(() => {
  if (!steady) return;
  for (const c of cgroups) {
    c.current.push(Number(readFileSync(`${c.dir}/memory.current`, "utf8")));
    c.anon.push(field(c.dir, "memory.stat", "anon"));
  }
}, 1000);

process.on("SIGUSR1", () => {
  for (const c of cgroups) c.activeCpu = cpu(c.dir) - c.cpu0;
});
process.on("SIGUSR2", () => (steady = true));
process.on("SIGTERM", () => {
  for (const c of cgroups) {
    console.log(JSON.stringify({
      name: c.name,
      activeCpuUsec: c.activeCpu,
      totalCpuUsec: cpu(c.dir) - c.cpu0,
      peakBytes: readPeak(c.peakFd),
      steadyBytes: c.current.length ? median(c.current) : undefined,
      steadyAnonBytes: c.anon.length ? median(c.anon) : undefined,
      steadySamples: c.current.length,
    }));
  }
  process.exit(0);
});
