# Ward resource profile

What Ward costs, measured on 2026-11-19. The workload is four copies of a small project running at once, each with a Vite dev server (minimal React app), a Postgres 17 container started by `docker compose` with a healthcheck, and a `node --test` run doing 300 inserts and 300 selects through `pg`. **Warded**, each copy is its own T3 worktree with its own ward, and all four use the default ports 5173 and 5432. **Unwarded**, the same four checkouts run directly on the host on distinct ports (5174–5177, 5433–5436) with distinct compose project names, against one host rootless Podman service. Everything was repeated at least 5 times; figures are medians with the range in parentheses.

AMD Ryzen 5 7600X (6 cores, 12 threads), 61 GiB RAM, btrfs, Linux 7.2.15 (Omarchy), Node 26.12, Podman 6.1.4, crun 1.30.1, pasta 2026_10_02, Docker Compose 5.6.1, Vite 7.3.8, Ward at `2354242`. Other agents were working on the machine throughout: load average 0.9–4.0 during the workload runs, 1.3–2.2 during the rest.

## Method

The scripts are in [`scripts/profile/`](../scripts/profile/): `setup.sh` generates the fixture (`fixture.sh`), its worktrees and checkouts, installs dependencies and pulls `postgres:17` into both image stores; `measure.sh workload ports disk idle startup wardd` runs the measurements below into `~/.cache/ward-profile/results`; `summarize.ts` reduces them; `cleanup.sh` removes everything.

- **Memory and CPU** come from cgroup v2 files, read by `sampler.ts`. Warded, each ward is a systemd unit (`ward@<id>.service`) whose cgroup holds everything in the ward, containers included. Unwarded, the Podman service, the dev servers, the compose and test commands each run in a `systemd-run --user --scope` inside one transient slice, `wardprofilehost.slice`, and a compose override (`cgroup_parent: wardprofilehost.slice`) puts each container, its `conmon` and Podman's port forwarder in that slice too, so the slice counts the whole unwarded workload. CPU is `cpu.stat` `usage_usec` from the start of the workload until every test has passed, with the engines (wards, host Podman service) already up. Steady memory is the median of `memory.current` over 20 s, starting 20 s after the workload; peak is `memory.peak`, reset at the start of each run. Only one mode runs at a time.
- **Disk** is `du` of each ward's state folder (`~/.local/state/ward/wards/<id>`), read as root of the ward's user namespace, against the host's Podman volume and container layer for each copy.
- **Startup**: `ward up` on a stopped ward; the first `ward exec -- true` in a newly created worktree; 200 warm `ward exec -- true` against 200 `/usr/bin/true`; `docker compose up -d --wait` from no containers or volume to healthy.
- **Port mapping**: `bench.ts` (no load tool besides `hey` was installed, so a small Node client) sends 300 sequential requests on new connections and 1000 on one keep-alive connection to a tiny static file, then 2000 and 4000 requests with 16 in flight, and downloads one 64 MiB file. It runs inside the ward against the dev server, on the host through the port Ward maps, and against an unwarded dev server.

## Results

| | Unwarded | Warded | Ward's overhead |
| --- | --- | --- | --- |
| Memory, steady, 4 copies | 546 MiB (541–547) | 765 MiB (761–770) | +219 MiB, about 55 MiB per copy |
| … of which anonymous (not page cache) | 294 MiB (290–297) | 504 MiB (498–507) | +210 MiB |
| Memory, peak, 4 copies | 725 MiB (720–730) | 954 MiB (950–962) ¹ | +229 MiB |
| One idle ward, nothing running | | 78 MiB | 78 MiB per running ward |
| `wardd`, the daemon | | 130 MiB with 1 ward up, 200 MiB with 6 | once per machine |
| CPU, workload start to tests passed | 4.95 s (4.88–5.25) | 4.59 s (4.54–4.81) | −0.36 s ² |
| Wall time, same span | 5.42 s (4.91–5.65) | 4.75 s (4.72–6.61) | −0.67 s |
| CPU, one idle ward | | 0.04 s per minute | negligible |
| CPU, `wardd` polling | | 0.26 s/min with 1 ward up, 1.19 s/min with 5 | about 0.23 s/min (0.4 % of a core) per running ward |
| Disk, data per copy (Postgres volume + container layer) | 38.7 MiB + 1.0 MiB | 39.0 MiB | none |
| Disk, `TMPDIR` per copy | shared `/tmp` | 0.7 MiB (Node's compile cache, rebuilt per ward) | 0.7 MiB |
| Disk, `postgres:17` image | 473 MiB once | 473 MiB once (shared store) | none; 473 MiB **per ward** if each ward pulls into its own store |
| `ward up`, stopped ward | | 220 ms (204–272) | |
| First `ward exec -- true` in a new worktree | | 283 ms (272–300) | once per worktree |
| Every command: `true` | 0.7 ms (0.7–0.9) | 10.7 ms (10.2–29.7) | +10 ms per agent command |
| `docker compose up -d --wait` to healthy | 3.15 s (2.17–3.17) | 3.65 s (3.64–3.66) | +0.5 s ³ |
| Request latency, new connection | 0.237 ms | inside 0.235 ms, mapped port 0.314 ms | +0.08 ms through the mapped port |
| Request latency, keep-alive | 0.105 ms | inside 0.107 ms, mapped port 0.152 ms | +0.05 ms through the mapped port |
| Throughput, new connections | 9325 req/s | inside 9433, mapped port 8211 | −12 % through the mapped port |
| Throughput, keep-alive | 24664 req/s | inside 24593, mapped port 19228 | −22 % through the mapped port |
| 64 MiB download | 1395 MB/s | inside 1424, mapped port 1177 | −16 % through the mapped port ⁴ |

¹ The sum of the four wards' own peaks, which can overstate a little since they need not peak together. The wards slice as a whole isn't comparable: other agents' wards were in it.
² Unwarded, published container ports go through Podman's rootless port forwarder, a userspace proxy, and the Postgres traffic pays for it; in a ward, Podman runs as root of the ward and forwards in the kernel. The unwarded side also counts `systemd-run` for each command, and doesn't count its healthchecks (systemd timers outside the slice). The warded side doesn't count `wardd`, shown on its own rows. The shorter wall time is likely four Podman services working in parallel instead of one shared one; that wasn't isolated.
³ `wardd` ran container healthchecks on its once-a-second scan, so a 1 s interval ran every 2 s in practice; fixed since (below).
⁴ Through the mapped port every byte is copied by `wardd`, which used 0.38 s of CPU per benchmark run. The Node client is the bottleneck here; `curl` downloads the same file through the mapped port at about 2.3 GB/s.

## What it means

Inside a ward, a project runs as fast as on the host: the dev server, Postgres and tests take no more CPU or time, and disk per copy is the same. What Ward adds is a fixed cost per running ward, about 55–80 MiB of memory (mostly its port broker, Podman service and pasta) and a little `wardd` polling, plus about 130–200 MiB for `wardd` once per machine; about 10 ms on every agent command; and a slower path when something on the host, such as the preview browser, talks to a ward's server through its mapped port, which is fine for a dev server and not for bulk transfers. Use the shared image store (`ward images pull`) for large images, or each ward keeps its own copy. For a project whose agents run dev servers or containers in parallel, those costs are small next to the port and container collisions Ward removes; for a project that runs neither, Ward costs the 10 ms per command and buys nothing.

## Since this profile

Measured the same day on a second Ward instance with idle, empty wards, before and after the fixes that followed. `wardd`'s polling CPU went from 0.29 to 0.07 s/min with one ward up and from 1.23 to 0.12 with five: nearly all of it was reading each ward's `/proc/net/tcp`, which walked the host's whole TCP table until each ward's namespace got a table of its own. The port broker went from 31 MB to 15 MB of private memory (75 to 55 MB resident) by dropping TypeScript, which Node parses with a WebAssembly module. A later live test measured the broker at 53 MiB idle and 83 MiB after heavy traffic through its ward's mapped ports. Healthchecks now run on each container's own interval (a 1 s interval checks every 1.0 s, not 2 s), and a service healthy 1.5 s after start takes 2.65 s instead of 3.65 s for `docker compose up -d --wait`. `wardd`'s own size is mostly heap kept after carrying traffic: 44 MB anonymous when idle, against 126 MB for the live daemon after the day's benchmarks.
