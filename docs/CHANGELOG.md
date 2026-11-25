# Changelog

All notable changes to Ward are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Each ward has an Android emulator of its own. The first adb command that needs a device starts it in about 5 seconds, and agents in different wards can build, install and test on Android at the same time without touching each other's device.
- `ward device` starts the ward's device and prints its serial, `ward device --keep 2h` keeps it from stopping while unused, `ward device stop` stops it, and `ward devices` lists every ward's device.
- A ward's device stops by itself after 15 minutes without use and when its ward stops, and the next use starts a fresh one. `WARD_DEVICE_IDLE` and `WARD_DEVICE_MAX` set the idle time and how many run at once.
- `adb forward` works in a ward: the forwarded port opens inside the ward.

### Changed

- adb in a ward finds only the ward's own device. T3's shared emulators, other wards' devices and your phone no longer appear in `adb devices` there, so a Gradle install or a stray `adb -s` can't land on them. Use T3's device tools for those from a thread without a ward. Wards already running keep the old behavior until they are stopped and started.
- `adb reverse` in a ward opens its port inside the ward directly, with no host port in between.
- Your own AVDs are hidden inside a ward, so an emulator started there can't boot or change T3's shared ones.
- Emulator ports (5554–5585) can no longer be forwarded into wards with `--host-ports`, as adb's can't.
- T3's `agent-device` command runs a daemon of its own inside the ward instead of using T3's daemon on the host. It reaches only the ward's device, and Maestro `runScript`, `--out` and app paths act inside the ward. A command `device_open` returns for any other device (a shared emulator, your phone, a remote device host) no longer works in a ward. An agent-device session left open lets go of the ward's device after 10 minutes idle. Wards already running lose agent-device until they are stopped and started.

### Fixed

- A ward could start containers as you outside the ward, through your rootless Podman's API socket (`$XDG_RUNTIME_DIR/podman/podman.sock`), and every `podman` command in a ward deleted your Podman's `pause.pid`. A ward now sees an empty folder where your Podman keeps its socket, and its own in place of your Podman's runtime state; its own `podman` and `docker` work as before. Restart running wards: until then they keep both.
- A ward could connect to sockets in other wards' runtime folders: drive another ward's Podman as its root, or another desktop's compositor and session bus. A ward now sees only its own folder there. Restart running wards: until then they keep that reach, also into wards started after them.
- A ward could read your adb key, which a phone paired for wireless debugging trusts, and connect to that phone. A ward now sees empty key files and its adb has no key; its own device needs none. If you have no adb key, Ward makes one before a ward starts. Restart running wards: until then they can still read the key.
- A ward's own Podman socket could come up private after a restart, refusing the ward's `podman` and `docker`.
- A ward could read the token of T3's device daemon and, through it, drive any device on the host's adb server, read and write files the ward can't see, and run code on the host. A ward started now sees no token and can't reach that daemon. Restart running wards: until then they keep both.
- A ward could reach every port on the host's loopback through its network gateway, including the host's adb server (your phone and every emulator) and T3's device daemon. Only the forwarded ports are reachable now, in wards started after this.
- An app installed from the host (a Gradle `installDebug` or `adb install`) while Ward builds its base image no longer ends up in every ward's device: the image is built where no adb server can see it.
- The first adb command right after a ward started could find no device and fail once: the ward now counts as started only when its adb port is ready.
- Transfers through a ward's mapped ports no longer stall on protocols that send small acknowledgements: such traffic could run twenty times slower through a ward than on the host.
