# Running Ward

What to expect from wards day to day. [DESIGN.md](DESIGN.md) explains why each of these works the way it does.

## Lifecycle

A ward starts on the first command in a worktree. It stops once every T3 thread on the worktree has settled (T3's flag for a thread whose work is done), or 30 minutes after the last command when the worktree has no active thread. When the worktree is deleted, the ward's data goes to a trash for 7 days.

## Desktops

`ward desktop -- CMD` runs `CMD` in the ward on a desktop of its own: a headless Umbriel with one 1280×720 output, its own session bus and no shell. It starts on the first `ward desktop` and stops with the ward. It shares no compositor, session bus, notifications, portals or sound server with your session (apps on it play nothing, or into a sink of its own when a capture tool provides one), and apps get a profile of their own there: its config folder mirrors `~/.config` with links to your files, minus browser and Electron profiles, and what an app creates stays in the ward. `ward desktop` alone prints its environment (`WAYLAND_DISPLAY` and the rest) for a tool that should drive it. Its log is `desktop.log` in the ward's data folder.

Where a T3 thread has no ward, the same command gives the thread a desktop of its own: the same desktop without the network namespace, so apps on it reach the thread's `localhost` ports directly. It starts with the first `ward desktop -- CMD` (plain `ward desktop` prints nothing until then, and exits 3). It stops when the thread settles or after 2 hours unused, keeping nothing, and the thread's next call starts it again, empty.

Only the prefixed command is on that desktop: a GUI app started without it opens on your screen, and outside both a ward and a T3 thread the prefixed command fails rather than opening there. The prefixed command has no keyring or `systemctl --user`, so build, commit and push without it. A plain `ward exec` command still plays sound through your session's PipeWire, out of your speakers. X11-only apps don't run there. The rest of your home folder is shared, so an app that finds its running copy through files there still reaches the one on your screen: a Firefox with its profile in `~/.mozilla` refuses to start beside it (give it `--profile DIR`), and Zed keeps a socket in `~/.local/share/zed`.

## Devices

Each ward has an Android emulator of its own, and it is the only device adb finds there: `adb devices`, `./gradlew installDebug`, Expo and React Native all see one device, never another ward's, T3's shared emulators or your phone. Nothing needs setting up in the ward. The first adb command that needs a device starts it (about 5 s; about 45 s the first time ever and after an emulator or system image update, while Ward builds the image all devices start from), and `adb reverse` and `adb forward` open their ports inside the ward. T3's Device panel and device tools open it for the ward's threads and no others.

A device stops after 15 minutes without use (`WARD_DEVICE_IDLE=30m` for `wardd` changes that; `ward device --keep 2h` keeps this one, for up to 4 hours), when its ward stops, and with `ward device stop`. The next use starts a fresh one: apps installed and data on the old one are gone. At most 8 run at once (`WARD_DEVICE_MAX`), each holding about 3.6 GB of memory; one more takes the place of the device unused longest, if that has been 6 minutes, and is refused otherwise. `ward devices` lists every ward's device.

Ward devices copy the hardware and system image of one of your AVDs, which is only read: the first by name when Ward first looked (`WARD_DEVICE_TEMPLATE=name` for `wardd` picks another). For another API level, or your phone, use T3's device tools, which run outside the ward; your own AVDs are hidden in a ward, so an emulator started there can't run from them. Outside wards nothing changes: a Gradle install or `adb` on the host acts on every device listed, ward devices included, unless `ANDROID_SERIAL` names one.

## Limits

- `sudo` doesn't work in a ward.
- Host services are reachable only on the ports in `WARD_HOST_PORTS` (default `3773`, T3's server, plus DNS) and the project's own, set with `ward enable <repo> --host-ports 39003,…`. The flag replaces the project's list, and a ward picks up a new list only when it next starts: `ward enable` names the running wards still on the old one (`ward stop` them to apply it now). A forwarded host port is taken inside the ward, so a server in the ward can't listen on it (`EADDRINUSE`). Port 53, adb's ports (5037 and 5038, which reach the ward's own device), emulator ports (5554–5585), Ward's own host ports (20100–29999) and lists over 200 ports in all are refused. In a ward, `WARD_FORWARDED_PORTS` lists what it reaches.
- From inside a ward, `ward` can only map that ward's ports, start its desktop, start and stop its device and list it; stopping, removing or starting wards, and anything about another ward, is for the host.
- `/tmp` and `XDG_RUNTIME_DIR` are the host's, shared by every ward, so keep per-worktree pid files and sockets in `TMPDIR`.
- `ps` shows only the ward's own processes and `kill` reaches nothing else; there is no `systemctl --user`, and the session bus reaches only the keyring.
- Ward's own state, config and checkout are read-only; Ward's T3 token and T3's `userdata` (except `attachments`) are hidden. A screen-timeline recorder's store (`~/.local/share/miranda`) is hidden too, apart from its shell hook's folder. [DESIGN.md](DESIGN.md) lists what a ward can still reach on purpose.
- Connections through a mapped port end with a reset when their ward stops or `wardd` restarts, so a transfer in flight fails rather than looking complete.

## Gradle

Each ward has its own Gradle home at `~/.gradle` and its own Kotlin daemon folder, so wards never wait on each other's locks or stop each other's daemons. A ward whose worktree has a Gradle build (at its root or one folder down, such as `android/`) gets a copy of your dependency caches and wrapper when it is created; other wards start with an empty home. A ward's dependencies are a snapshot from when it was created, and a dependency added later is downloaded once in each ward.

Your `gradle.properties` and `init.d` are read-only in a ward and follow yours when it starts and at an explicit `ward up` (a running ward gets no change otherwise), with idle daemons stopping after 10 minutes unless your file sets `org.gradle.daemon.idletimeout`.

Builds with `org.gradle.caching=true` share a build cache with the project's other wards through `wardd`, unless the project sets up a remote cache of its own; any ward of a project can write an entry the others use. It lives in `~/.local/state/ward/build-cache/<repo>`, and deleting a project's folder there clears its cache; `--no-build-cache` skips it for one build, `--offline` builds in a ward don't use it, and your host builds don't read it. It is capped at `WARD_BUILD_CACHE_MAX` (default `10G`). On an Android project a ward that has built holds about 4.5 GB in its Gradle and Kotlin daemons until they exit, about 10 minutes after its last build.

## Upgrade

`git pull`, then `systemctl --user restart wardd`, and `bin/ward install` again when `units/` changed. The restart resets connections open through mapped ports and cuts adb commands running in wards, which work when run again; wards and what else runs in them carry on, and ward devices keep running.

Running wards keep the settings they started with (their TCP table size, host ports) until they next start. A ward started before wards had their own Gradle home keeps the shared one, and one started before wards had devices keeps reaching the host's adb server, with every device on it, until it is stopped and started.
