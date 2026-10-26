# Install

## From DSH Market

Search for `dsh-memory-watchdog` (display name **DSH Memory Guard**) in the DSH Desktop plugin market and restart DSH once after installing. **Automatic restart** and **resume after crash** both stay off after installation; only monitoring, attribution, pagefile advice and the crash timeline run.

## From npm

```sh
dsh plugin add dsh-memory-watchdog
```

A DSH profile pins plugins to an exact version, so a new release is not picked up automatically. To upgrade, name the version explicitly:

```sh
dsh plugin add dsh-memory-watchdog@0.2.1
```

## From a local checkout (development)

See [DEV.md](./DEV.md): `npm run deploy` syncs the working tree in place into `~/.dsh/profiles/desktop/node_modules/dsh-memory-watchdog` and updates the profile's `dependencies`, `dsh.profile.bundles` and `.modules.yaml`.

## Upgrading and uninstalling

- Upgrade: restart DSH after changing the installed version. History under `~/.dsh/memory-watchdog/` is kept.
- Uninstall: the plugin clears its timers, cancels a pending restart and stops the sampling child process. Files under `~/.dsh/memory-watchdog/` are removed manually.
- **Do not uninstall while a restart handoff has already started**: the detached helper may still complete that restart.
- Migrating from the older `dsh-memory-guard` 0.1.x: uninstall it before installing this package, otherwise two watchdogs run at once (two samplers, two status pills). The old `~/.dsh/memory-guard/` directory can be deleted.
