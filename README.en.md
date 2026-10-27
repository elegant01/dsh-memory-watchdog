# DSH Memory Guard (dsh-memory-watchdog)

A Windows commit-memory watchdog for DSH Desktop. It continuously samples system commit charge, tells you **who is eating commit memory**, gives read-only pagefile advice and a 7-day crash timeline, and warns in the UI when memory enters the warning or critical range. **Automatic restart is off by default**, and **resume-after-crash is off by default**.

- Platform: Windows x64
- DSH: `>=0.2.0-rc.1 <0.3`
- Automatic restart: **off by default (opt-in)**
- Resume after crash: **off by default (opt-in)**
- Sampling: a lightweight PowerShell process owned by the plugin, using read-only performance counters
- No WMI/CIM, no service, no scheduled task, no native addon

## Automatic restart is off by default

Monitoring, attribution, the crash timeline and warnings start as soon as the plugin loads, but **nothing is restarted and no message is ever injected** until you enable the switches under
Settings → Plugins → DSH Memory Guard. The setting page always shows the full cost of enabling them; there is no confirmation dialog to expand or dismiss.

Turning the switch off immediately cancels any pending restart that has not started. Monitoring and warnings continue.

## Thresholds are configurable (defaults stay documented)

| Setting | Default | Range | Meaning |
| --- | --- | --- | --- |
| `warningPct` | 80 | 50–95 | commit percentage that raises a warning |
| `criticalPct` | 90 | 55–99 | commit percentage that raises critical; always above `warningPct` |
| `criticalAvailMb` | 2048 | 256–32768 | critical also fires when available commit falls below this |
| `confirmSamples` | 3 | 1–10 | consecutive samples required for any state change |
| `cooldownMinutes` | 30 | 5–1440 | minimum gap between restart attempts |
| `restartGatePct` | 20 | 0–100 | restart gate; 0 disables the check |

Every field is volatile, so a change applies immediately without restarting DSH. Out-of-range input is clamped to the boundary, and `criticalPct` is always kept above `warningPct`. There is also an absolute backstop: at 95% the state is critical regardless of available commit.

## What it does

- Reads Windows committed memory, commit limit, physical total and physical available every 5 seconds.
- Requires consecutive samples (three by default) to change pressure state and uses hysteresis to avoid flapping:

  | State | Enter (3 consecutive samples by default) | Exit |
  | --- | --- | --- |
  | normal | from unknown: three consecutive valid samples `<75%` | — |
  | warning | `>=80%` **or** available commit `<=6 GiB` | `<75%` back to normal |
  | critical | `>=90%` and available `<=2 GiB`, **or** `>=95%` | `<85%` back to warning |
  | unknown | missing, invalid or stale (>30 s) samples | three consecutive valid samples leave it by band: `<75%` to normal, a hot band to warning / critical |

- Samples **commit attribution** every 30 seconds: how much of the commit charge the DSH process tree holds, plus the largest consumers.
- Reads the **pagefile and commit-limit configuration** every 5 minutes and gives read-only advice.
- Builds a **7-day crash and memory-event timeline** every 10 minutes from DSH crash logs and the Windows System event log.
- Keeps the last 50 events, viewable in the card and exportable as JSON, plus a "Copy diagnostics" button.
- Shows pressure state, action state, commit numbers, available commit, physical memory, Host RSS, cooldown, last error and the last restart record.
- Emits an in-page toast for warning / critical / recovery / collector errors / restart outcomes / setting changes, plus a small always-visible status pill in the bottom-right corner. **Clicking the pill opens a summary popover in place** (pressure percentage with used/limit, the current state and next action, the automatic-restart capability, activity detection, the latest event and error, the DSH share, the restart-gate verdict and the three largest consumers). Click the pill again, press Escape or click outside to collapse it; the popover reads the same status as the settings card, and its Refresh button re-fetches immediately.
- Sampler hiccups stay quiet: when a state enters unknown because samples went stale, the toast is **delayed by 2 minutes**; if samples come back within that window the transitions stay in the event log plus a "sample delays" counter (visible in the summary popover and the diagnostics text, with the worst lag) and no toast appears. A genuinely dead sampler still warns immediately.
- Cooldown survives a plugin reload; records are stored locally.

## Commit attribution and the restart gate

- Attribution uses one `CreateToolhelp32Snapshot` process walk plus per-process `GetProcessMemoryInfo` (`PrivateUsage`), with the system commit total as the denominator. It is read-only, never reads another process's memory, and does not use WMI/CIM. One round takes about 1.9 s on the test machine, including PowerShell startup.
- The card shows the DSH process count, the tree's total commit, its share of the system commit charge, and the top five processes (name + PID + commit).
- **Restart gate**: by default an automatic restart is only allowed when the DSH process tree holds at least 20% of the commit charge. If the share is lower, or attribution data is missing or older than 60 seconds, the restart is **blocked** (fail closed) and the reason is shown in the card and a toast — once per critical episode, not in a loop. Set `restartGatePct` to 0 to turn the check off.

## Pagefile advice (read-only)

- Reads `PagingFiles` / `ExistingPageFiles` from `Session Manager\Memory Management`, the actual pagefile sizes, and `GetPerformanceInfo` for the commit limit and physical memory.
- Warns when there is no pagefile, when the commit limit is less than 2 GiB above physical memory, when every pagefile sits on the system volume (on machines with ≥16 GiB RAM), and notes when Windows manages the pagefile automatically.
- The plugin **never changes any system setting** and never drives the Windows virtual-memory dialog for you. Changing the pagefile is your own action and usually needs a reboot.

## Crash timeline

- Collects `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` (the first line of the `--- error ---` section) and System log events `2004` (virtual memory exhaustion), `26` (low virtual memory popup) and `41` (unexpected shutdown) over a 7-day window, up to 20 entries.
- Multiple logs from one incident (`main` + `renderer` + `web-boot`) are merged into a single entry, prioritized OOM > host > main > renderer > web-boot.
- Everything is read locally and nothing is uploaded. Log bodies can contain local paths, so the card only shows the first error line and the copied diagnostics contain **no** log bodies and no full session ids.

## Resume after a crash (off by default)

When `resumeAfterCrash` is on, the plugin scans sessions after DSH restarts and injects one "verify the current state, then continue" message into conversations whose turn was interrupted:

- Only `turn/end` with `reason.kind === 'interrupted'` is resumed; `aborted` (you stopped it yourself) is **never** resumed.
- Only sessions with a human prompt in the last 12 hours that are not running and not blank qualify, and the interruption must be at least 20 seconds old so a freshly opened session is not raced.
- At most two attempts per session per hour; the counter resets once an hour without a new attempt.
- If a subagent was interrupted, the parent session is woken once even when its own turn already ended `completed`, and that child is then marked handled so a zombie child cannot wake the parent forever.
- The injected `requestId` is derived as `memory-watchdog-resume-<sessionId>-<turn>[-child]`, so repeated scans cannot inject twice.
- Scans run at 20 s / 60 s / 180 s / 600 s after startup, and deferred sessions are rescheduled at their due time. The card also has a "Scan now" button.
- The ledger lives in `$DSH_HOME/memory-watchdog/resume.json`; the card shows the shortened session id, turn, cause and attempt count.
- A resumed turn runs with that session's existing tools and permissions — **the main thing to weigh before turning this on**.

## How a restart is decided

Automatic restart begins only when **all** of the following are true:

1. the user has enabled the switch;
2. pressure is confirmed critical with a fresh sample, including a re-check immediately before handoff;
3. no cooldown (30 minutes by default) is active and this critical episode has not already been attempted;
4. the restart gate passes (DSH's commit share is high enough, or the gate is set to 0);
5. activity checks explicitly confirm idle;
6. the platform and DSH version are supported;
7. the helper capability self-check has passed;
8. the user has not canceled the pending action.

Activity checks cover running agents, queued `nextTurn` / `nextStep` work, and `running` / `stopping` jobs in both the global and per-agent scopes. If the activity API is missing, throws, or returns an unreadable shape, the plugin treats the desktop as **not idle**.

Idle must be confirmed by three checks one second apart, followed by a 1.5-second grace period. New work during the grace period cancels the confirmation and returns to waiting. Busy desktops are never force-restarted; while waiting, a reminder is shown at most every five minutes.

The restart uses a two-phase handoff. The helper first verifies the Host and Electron main process executable, creation time and parent relationship, writes `verified`, and waits for the Host's `go`. Before writing `go`, the Host re-checks every condition, including the restart gate. If `go` never arrives (20-second timeout), the Host exits early, or the user cancels, the helper exits without touching any process.

## Read this before enabling it

- The switch restarts the **entire DSH Desktop** (the Electron main process and all of its children), not just the UI or the plugin.
- Restarting **can discard unsent drafts**.
- The handoff **bypasses the Electron shell's native quit confirmation**. Profile and session data are still flushed by the Host's graceful shutdown, but you will not be asked again in the UI.
- If commit pressure comes from other software, **restarting DSH may not help** — that is exactly what the restart gate is for.
- At most one restart per configured cooldown (30 minutes by default), and at most one attempt per persistent critical episode. Failures also enter cooldown and are not retried in a storm.
- Before relaunching, the helper waits for the old processes to exit (up to 10 seconds) and the port to be released (up to 10 seconds). If the old instance is still running or the port is still held, the attempt is recorded as failed and **no new instance is started**, avoiding a double instance or a silent failure.
- After the old instance exits, the helper waits up to 30 seconds for commit to fall. If that wait times out it still relaunches, which may trigger another episode soon. The new instance must listen on the original port within 15 seconds after a 3-second startup observation window; otherwise the attempt is recorded as failed (the new process is not killed automatically).
- A restart can take tens of seconds, during which DSH Desktop is unavailable.
- With resume enabled, the plugin **injects messages into your conversations on your behalf** and lets the agent keep working; a resumed turn has that session's existing tools and permissions.

The plugin does **not** guarantee protection from OOM, crashes or data loss, does not diagnose a specific leak, and is not an independent system-level watchdog.

## Permissions and process behavior

- Sampling uses Windows PowerShell from its fixed system path in a hidden window. It uses a process-scoped `-ExecutionPolicy Bypass` only; it **never changes** machine or user execution policy persistently.
- All four PowerShell resources are read-only: `collector.ps1` (performance counters), `top.ps1` (per-process commit), `system-info.ps1` (pagefile and commit limit) and `crash-history.ps1` (crash logs plus `Get-WinEvent`). None of them uses WMI, CIM or `wmic`.
- Capability checks and pre-handoff checks read the target executable path, creation time and command line, and verify the Host/Electron parent relationship.
- During a restart, only the **identity-verified** Electron main process, the Host, and previously recorded descendants with the same executable are touched. The helper may suspend first and terminate only after a timeout. It does **not** use `taskkill /IM ... /T /F` and does not choose victims by memory usage.
- Resume only calls DSH's `sessionController` `list` / `inspect` / `prompt` (with `mode: 'queue'`). It uses no process-creation API and writes nothing outside the session log.
- State, events, capability results, the resume ledger and handoff files live under `$DSH_HOME/memory-watchdog/` (default `~/.dsh/memory-watchdog/`).
- Status, events, cancel and resume routes are registered through DSH's authenticated `ctx.connection.fetch`; responses are not cached. The client cannot supply a PID, executable, command line, script path or helper arguments, and cannot change settings.
- The plugin makes no network requests and uploads no telemetry or diagnostics.

## Resource cost

- The resident sampling PowerShell process uses about **62–70 MB** working set and **~49 MB** commit in local measurements; sampling runs every 5 seconds and takes about 7 ms per sample.
- One attribution round takes about **1.9 s** (every 30 s), pagefile info about **1.8 s** (every 5 minutes) and the crash timeline about **1.6 s** (every 10 minutes). All three are short-lived processes that exit when done.
- The helper starts only for an actual handoff and does not stay resident.

## Notification boundary

DSH does not currently expose a system notification or tray API to plugins. Notifications therefore exist only inside the page (toast plus the always-visible pill); **system-level notifications are not promised**. If the renderer is already dead or no page is open, in-page prompts are unavailable. Events, the crash timeline and the last-restart record under `$DSH_HOME/memory-watchdog/` are shown the next time the UI loads.

## Known limits

- If the Host itself is completely hung or OOM, the plugin cannot continue. This boundary cannot be removed.
- If the renderer dies before the Host, in-page notifications are unavailable.
- Attribution can only open processes the current user may query (about 197 of ~320 processes on the test machine), and the share is measured against total commit, so the DSH share is a lower bound.
- Resume cannot know how much of the interrupted turn already happened, which is why the injected message demands a state check first. That reduces the risk; it does not remove it.
- Activity checks reduce the chance of a bad restart but do not eliminate every concurrency race.
- Different Windows / DSH launch paths may change the job flags. When the helper self-check finds it runs inside a job, it measures whether a new process can escape that job by starting two no-op children that exit immediately: if the escape works, automatic restart stays available (the card shows which escape was used); if it does not, the check fails closed. No process is ever terminated by this probe. Switching to a taskbar / Explorer launch only helps when that job came from the terminal or agent that started DSH - on the reference machine DSH creates a job for its own process tree, so the launch path changes nothing.
- Real-world restarts, different launch paths and long-term stability still need to be verified against the release checklist.

## Install and uninstall

Install from DSH Market, or use DSH's plugin installation capability to install a built npm tarball. No service is required after installation, and no build step runs on the consumer machine.

On uninstall the plugin clears its timers, cancels pending actions and stops the sampling child process. Historical files under `$DSH_HOME/memory-watchdog/` are not deleted automatically and may be removed manually once no longer needed. **Do not uninstall while a restart handoff is already in progress**: the detached helper may still complete that restart.

## Development

```text
npm test          # node:test unit and integration tests
npm run preflight # package-content and safety-rule checks
npm pack          # build a tarball that needs no consumer build step
```

The source is ESM JavaScript, PowerShell and a browser client bundle. There is no TypeScript build, native addon or install script.

### Data files

| File | Purpose |
| --- | --- |
| `state.json` | Persistent cooldown and last-attempt information |
| `last-event.json` | Most recent pressure / action event |
| `events.json` | Last 50 events (used by the card and the JSON export) |
| `last-restart.json` | Most recent restart result (shown at startup) |
| `capability.json` | Most recent helper capability self-check |
| `resume.json` | Resume ledger (attempts, handled children, unreadable sessions) |
| `handoff/<id>/` | Two-phase handoff markers and result |

## License

MIT. See [LICENSE](./LICENSE).
