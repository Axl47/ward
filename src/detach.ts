// `node src/detach.ts PATH`: detaches the mount at PATH, never following a link there
// (umount2 with MNT_DETACH | UMOUNT_NOFOLLOW). libexec/ward-runtime.sh's watcher
// unmounts what it showed at names in a ward's runtime folder, which the ward can
// write: umount(8), run as root, follows a link the ward put there instead, onto
// whatever mount it points at. Exits 0 when PATH was detached.
import { dlopen } from "node:ffi";

const MNT_DETACH = 2;
const UMOUNT_NOFOLLOW = 8;
const path = process.argv[2];
if (path === undefined) {
  console.error("usage: node src/detach.ts PATH");
  process.exit(2);
}
const libc = dlopen("libc.so.6", { umount2: { arguments: ["buffer", "int32"], return: "int32" } });
process.exitCode = libc.functions.umount2(Buffer.from(`${path}\0`), MNT_DETACH | UMOUNT_NOFOLLOW) === 0 ? 0 : 1;
