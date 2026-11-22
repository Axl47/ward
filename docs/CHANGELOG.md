# Changelog

All notable changes to Ward are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Each ward has an Android emulator of its own. The first adb command that needs a device starts it in about 5 seconds, and agents in different wards can build, install and test on Android at the same time without touching each other's device.
- `ward device` starts the ward's device and prints its serial, `ward device --keep 2h` keeps it from stopping while unused, `ward device stop` stops it, and `ward devices` lists every ward's device.
- A ward's device stops by itself after 15 minutes without use and when its ward stops, and the next use starts a fresh one. `WARD_DEVICE_IDLE` and `WARD_DEVICE_MAX` set the idle time and how many run at once.
- `adb forward` works in a ward: the forwarded port opens inside the ward.

### Changed

- adb in a ward finds only the ward's own device. T3's shared emulators, other wards' devices and your phone no longer appear in `adb devices` there, so a Gradle install or a stray `adb -s` can't land on them. Use T3's device tools for those. Wards already running keep the old behavior until they are stopped and started.
- `adb reverse` in a ward opens its port inside the ward directly, with no host port in between.
- Your own AVDs are hidden inside a ward, so an emulator started there can't boot or change T3's shared ones.
- Emulator ports (5554–5585) can no longer be forwarded into wards with `--host-ports`, as adb's can't.

### Fixed

- Transfers through a ward's mapped ports no longer stall on protocols that send small acknowledgements: such traffic could run twenty times slower through a ward than on the host.
