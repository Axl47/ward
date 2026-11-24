import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Make `to` hold the agent-device configs in `from` by name only, each `{}`: T3's hold
 * its device daemon's address and token, which a ward must not see. A ward's CLI given
 * an empty config starts a daemon of its own inside the ward (docs/DESIGN.md: Devices).
 * The contents never change, so a file is written once and removed when `from`'s is.
 * A missing `from` mirrors as an empty folder; other failures throw.
 */
export function mirrorDeviceHosts(from: string, to: string): void {
  let names: string[];
  try {
    names = readdirSync(from).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  } catch {
    names = []; // no device host yet
  }
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(to)) if (!names.includes(name)) rmSync(join(to, name), { force: true });
  for (const name of names) if (!existsSync(join(to, name))) writeFileSync(join(to, name), "{}\n");
}
