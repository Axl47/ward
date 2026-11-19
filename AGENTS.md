# Agent notes

- The installed Ward runs from the main checkout; test a worktree's code with a second instance, never by restarting the live `wardd`: export `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` pointing at private folders plus `WARD_UNIT=<name>`, install a `<name>@.service` copied from `units/ward@.service` with those three variables as `Environment=`, and run this checkout's `src/daemon.ts` and `bin/ward` with the same environment.
- With a private `XDG_RUNTIME_DIR`, symlink `systemd` and `bus` from `/run/user/<uid>` into it, or `systemctl --user` fails; keep it short (e.g. `/run/user/<uid>/<name>`), since Podman's socket path inside it must fit in 108 bytes.
- A second instance's registry starts at slot 1 like the live one; seed it with placeholder records for low slots so its host ports don't take ones live wards will want.
