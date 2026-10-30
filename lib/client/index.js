window.__ModuleLoader__.load({
  id: "dsh-memory-watchdog",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useEffect, useRef, useState } = react;

    const STATUS_PATH = "/api/memory-watchdog.status";
    const CANCEL_PATH = "/api/memory-watchdog.cancel";
    const EVENTS_PATH = "/api/memory-watchdog.events";
    const RESUME_PATH = "/api/memory-watchdog.resume";
    const PLUGINS_PATH = "/api/memory-watchdog.plugins";
    const PLUGINS_SAMPLE_PATH = "/api/memory-watchdog.plugins-sample";
    const PLUGINS_EXPORT_PATH = "/api/memory-watchdog.plugins-export";
    const SNAPSHOT_PATH = "/api/memory-watchdog.snapshot";
    const POLL_MS = 2000;

    const zh = {
      title: "DSH 内存守护",
      subtitle: "监控 Windows 提交内存；自动重启默认关闭。",
      version: "版本 {version}",
      loading: "正在读取状态…",
      offline: "无法连接插件 Host：{message}。监控可能已中断，或 DSH Desktop 正在重启。",
      unsupported: "当前环境不支持自动重启；内存监控与预警仍会运行：{reason}",
      pressureTitle: "系统内存",
      used: "已提交",
      limit: "提交上限",
      pct: "使用率",
      available: "可用提交",
      physical: "物理内存",
      hostRss: "Host RSS",
      sampleAge: "样本年龄",
      stale: "样本已过期，压力状态不可用",
      stateLabel: "压力状态",
      state: { normal: "正常", warning: "预警", critical: "危险", unknown: "未知" },
      actionLabel: "当前动作",
      action: {
        observing: "观察中",
        waiting: "等待空闲",
        confirming: "确认空闲",
        handoff: "重启交接",
        cooldown: "冷却中",
      },
      actionDetail: {
        waiting: "检测到任务正在运行，确认空闲后才会重启。",
        confirming: "已连续确认空闲，几秒后进入交接。",
        handoff: "正在重启整个 DSH Desktop。",
        cooldown: "冷却期内不会再次自动重启。",
      },
      cooldownLabel: "冷却剩余",
      cooldownNone: "无",
      staleBlips: "采样延迟 {count} 次都在提示前自行恢复（最大滞后 {lag}）",
      capabilityLabel: "自动重启能力",
      capabilityChecking: "正在自检 helper…",
      capabilityOk: "自动重启可用",
      capabilityOkEscape: "自动重启可用（新进程可脱离作业对象：{escape}）",
      capabilityUnavailable: "当前环境不支持自动重启：{reason}",
      enabledOn: "自动重启：已开启",
      enabledOff: "自动重启：已关闭（默认）",
      cancel: "取消本次待执行重启",
      cancelIdle: "当前没有可取消的待执行动作",
      cancelDone: "已取消本次待执行动作。",
      cancelFailed: "取消失败：{message}",
      refresh: "刷新",
      refreshing: "刷新中…",
      collapse: "收起",
      activityLabel: "活动检测",
      activityIdle: "空闲",
      activityBusy: "忙碌：{reason}",
      activityUnknown: "尚未检查",
      lastError: "最近错误（{source}）：{message}",
      lastEvent: "最近事件：{kind}（{time}）",
      lastRestart: "最近一次重启：{text}",
      restartSucceeded: "成功，新进程 PID {pid}",
      restartFailed: "失败：{reason}",
      restartNone: "还没有重启记录",
      restartMemory: "重启前 {before} → 重启后 {after}",
      disclosureTitle: "开启前请确认",
      disclosureQuit: "交接会绕过 Electron 壳的原生退出确认框；profile 与会话数据仍由 Host 的优雅 shutdown 落盘。",
      disclosure1: "该开关会重启整个 DSH Desktop（主进程及其全部子进程），不是只刷新界面。",
      disclosure2: "重启可能丢失未发送的草稿。",
      disclosure3: "触发条件：提交内存达到危险水位，且连续样本数达到设置值（默认 3 个）确认，且活动检测确认空闲。",
      disclosure4: "若提交内存压力来自其他软件，重启可能无效。",
      disclosure5: "冷却时长可配置（默认 30 分钟内最多重启一次）；每个危险 episode 最多尝试一次。",
      external: "外部软件造成的提交内存压力可能无法通过重启 DSH 解决。",
      footnote: "自动重启开关位于本插件的设置项中，更改后立即生效。",
      disclosure6: "重启门限：只有 DSH 进程树占到提交内存的 {gate} 才会自动重启；归因数据不可用时不会重启。",
      disclosure7: "崩溃续接默认关闭；开启后只会被中断（interrupted）的对话注入一条“先核对状态再继续”的提示，你手动停止的对话不会被续接。",
      attributionTitle: "提交内存归因",
      attributionSummary: "DSH 进程树 {count} 个进程 · {bytes} · 占系统提交 {share}",
      attributionAge: "（采样于 {age}前）",
      attributionNone: "归因数据暂不可用：{error}",
      attributionTopLabel: "提交内存占用最高的进程",
      attributionDshTag: "DSH",
      residentGrowLabel: "增长盯梢（5 分钟窗口）",
      residentNone: "本轮采样没有进程在快速上涨（阈值 {grow}）",
      residentOther: "{name}（PID {pid}）在 {span} 里涨了 {delta}，现在 {mb}（已运行 {age}）—— 压力主要来自它，重启 DSH 不会把它降下来。",
      residentDsh: "{name}（PID {pid}）在 {span} 里涨了 {delta}，现在 {mb}（已运行 {age}）—— 这是 DSH 自己的进程。",
      residentExe: "可执行文件：{path}",
      gateLabel: "重启门限",
      gate: {
        passed: "已通过：DSH 是当前主要占用者。",
        disabled: "门限设为 0，已跳过占用判定。",
        unavailable: "归因数据不可用，已阻止自动重启。",
        stale: "归因数据已过期，已阻止自动重启。",
        "share-below": "DSH 只占 {share}，低于门限 {gate}，重启多半无益，已阻止。",
        unknown: "尚未完成归因采样。",
      },
      systemTitle: "虚拟内存配置（只读）",
      systemNone: "配置信息暂不可用：{error}",
      commitHeadroom: "提交上限 − 物理内存",
      commitUsed: "已提交 / 上限",
      pagefileLabel: "分页文件",
      pagefileNone: "未检测到分页文件",
      pagefileItem: "{path} · {size}",
      adviceLabel: "只读建议",
      advice: {
        "pagefile-ok": "分页文件与提交上限看起来正常。",
        "pagefile-none": "系统没有分页文件，提交上限几乎等于物理内存；建议设置至少 {suggestionMb} MiB。",
        "pagefile-small": "提交上限只比物理内存多 {headroomMb} MiB；建议把分页文件增大到至少 {suggestionMb} MiB。",
        "pagefile-system-volume": "分页文件只放在系统盘；若其他盘更空，可以考虑移出系统盘。",
        "pagefile-automatic": "分页文件由系统自动管理。",
        unknown: "建议项：{code}",
      },
      pagefileAction: "本插件不会修改任何系统设置；调整分页文件需要你自己在 Windows 虚拟内存设置里做，通常要重启生效。",
      crashTitle: "崩溃与内存事件（最近 {days} 天）",
      crashCounts: "DSH 崩溃 {crash} 次 · 系统内存事件 {event} 次",
      crashNone: "最近没有崩溃或内存事件记录",
      crashUnavailable: "时间线暂不可用：{error}",
      crashCodes: {
        "crash.renderer-oom": "渲染进程内存耗尽（OOM）",
        "crash.host-exit": "Host 进程退出",
        "crash.main": "主进程错误",
        "crash.renderer": "渲染进程错误",
        "crash.web-boot": "Web 启动失败",
        "crash.other": "DSH 错误",
        "system.resource-exhaustion": "Windows 报告虚拟内存耗尽",
        "system.low-virtual-memory": "Windows 低虚拟内存提示",
        "system.unexpected-shutdown": "系统意外关机",
      },
      historyTitle: "最近事件",
      historyNone: "还没有事件记录",
      historyKinds: {
        "pressure-normal": "压力恢复正常",
        "pressure-warning": "进入预警",
        "pressure-critical": "进入危险",
        "pressure-unknown": "采样丢失",
        "restart-attempt": "准备重启",
        "restart-handoff": "重启交接",
        "restart-failed": "重启失败",
      },
      historyItem: "{kind} · {pct} · {time}",
      historyFoot: "事件保存在 ~/.dsh/memory-watchdog/events.json，最多保留 50 条。",
      resumeTitle: "崩溃后自动续接",
      resumeOn: "已开启：DSH 重启后会自动续接被中断的对话。",
      resumeOff: "已关闭（默认）：不会自动注入任何消息。",
      resumeRule: "只续接被中断（interrupted）的 turn；手动停止（aborted）的对话永不续接；每个会话每 {window} 最多 {max} 次。",
      resumeScan: "立即扫描",
      resumeScanning: "正在扫描…",
      resumeScanDone: "扫描完成：候选 {candidates} 个，续接 {resumed} 个。",
      resumeScanDeferred: "扫描完成：{deferred} 个会话仍在静置期，稍后自动重试。",
      resumeScanFailed: "扫描失败：{message}",
      resumeScanUnavailable: "扫描失败：{code}",
      resumeLastScan: "上次扫描：{time}",
      resumeNever: "还没有扫描记录",
      resumeLedger: "续接记录",
      resumeLedgerEmpty: "还没有续接记录",
      resumeLedgerItem: "{session} · 第 {turn} 轮 · {cause} · 共 {attempts} 次 · {time}",
      resumeCauseSelf: "自身中断",
      resumeCauseChild: "子代理中断",
      pluginTitle: "插件内存",
      pluginOn: "已开启：按插件统计定时器、事件监听与堆分配。",
      pluginOff: "已关闭：不会统计任何插件。",
      pluginInspectorMissing: "当前环境无法打开 inspector 会话，只能看结构计数，不能做堆采样。",
      pluginSamplingOff: "周期采样已关闭：点「采样一次」可手动分析。",
      pluginSamplingOn: "周期采样：每 {minutes} 分钟一次，窗口 {seconds} 秒。",
      pluginNeverSampled: "还没有采样记录",
      pluginLastSample: "上次采样：{time}",
      pluginNextSample: "下次采样：{time}",
      pluginSample: "采样一次",
      pluginSampling: "采样中…（窗口 {seconds} 秒，期间界面可能略慢）",
      pluginSampleDone: "采样完成：窗口内分配 {bytes}。",
      pluginSampleFailed: "采样失败：{message}",
      pluginSampleUnavailable: "采样失败：{code}",
      pluginExport: "导出堆采样",
      pluginExportDone: "已导出 .heapprofile（{bytes}）。",
      pluginSnapshot: "堆快照",
      pluginSnapshotRunning: "正在写堆快照…",
      pluginSnapshotDone: "堆快照已写入：{path}（{bytes}）",
      pluginSnapshotFailed: "堆快照失败：{message}",
      pluginHead: "插件 · 分配 · 占比 · 增长 · 定时器 · 监听",
      pluginEmpty: "还没有插件数据",
      pluginRisk: { high: "疑似泄漏", medium: "增长偏快", low: "正常", unknown: "数据不足" },
      pluginNotSampled: "未采样",
      pluginReason: { "bytes-growth": "字节增长", "handle-growth": "句柄增长", "short-span": "观察太短", "not-enough-data": "窗口不足" },
      pluginTotals: "窗口 {bytes} · 系统原生 {native} · 进程 RSS {rss} · V8 堆 {heap}",
      pluginCore: "DSH 核心 {bytes}",
      pluginRadar: "结构计数：定时器 {timers} · 监听 {listeners}",
      pluginInventory: "已安装插件 {count} 个（版本均已识别）",
      pluginAttributionOff: "结构计数无法归因到插件：已归因 {attributed} 次、丢弃 {unattributed} 次。",
      pluginAdvice: "建议只重载该插件（在插件管理器里单独停用再启用），不要重启整个 DSH。",
      pluginFoot: "数据保存在 ~/.dsh/memory-watchdog/plugin-memory.json；采样只统计窗口内新分配且仍存活的对象。",
      capabilityHints: {
        platform: "自动重启需要 64 位 Windows，当前环境不满足；监控与预警仍在运行。",
        powershell: "找不到系统 PowerShell，自动重启不可用；监控与预警仍在运行。",
        job: "helper 位于 Windows 作业对象（Job Object）内，且实测新进程脱离不开这个作业，自动重启在这种环境下会失败关闭；监控、归因和崩溃时间线照常运行。若这个作业是启动器带进来的（从终端或 agent 里拉起 DSH），改从任务栏 / 资源管理器（或开机自启）启动就能绕开；若作业是 DSH 自己创建的，换启动方式也无效。",
        generic: "helper 自检未通过，自动重启已停用；监控与预警仍在运行。",
      },
      copyDiagnostics: "复制诊断信息",
      copyDone: "诊断信息已复制到剪贴板。",
      copyFailed: "复制失败，请手动截图或导出事件。",
      exportEvents: "导出事件 JSON",
      exportDone: "事件已导出为 JSON 文件。",
      exportFailed: "导出失败：{message}",
      toast: {
        "pressure.normal": "内存压力已恢复正常。",
        "pressure.warning": "提交内存进入预警区间：{pct}。",
        "pressure.critical": "提交内存进入危险区间：{pct}；若已开启自动重启，将在确认空闲后执行。",
        "pressure.unknown": "内存采样不可用，自动重启已暂停。",
        "action.waiting": "内存危险，但有任务正在运行，等待空闲。",
        "action.waitingReminder": "仍在等待空闲：{reason}",
        "action.confirming": "已确认空闲，准备重启 DSH Desktop。",
        "action.confirmationCanceled": "宽限期内出现新任务，已取消本次确认。",
        "action.canceled.recovered": "内存压力恢复，已取消待执行重启。",
        "action.canceled.disabled": "自动重启已关闭，待执行动作已取消。",
        "action.canceled.user": "已取消本次待执行重启。",
        "action.canceled.capability": "自动重启能力不可用，已取消：{reason}",
        "restart.attempt": "正在准备重启 DSH Desktop…",
        "restart.handoff": "交接已开始，DSH Desktop 即将重启。",
        "restart.failed": "重启失败：{reason}",
        "restart.succeeded": "DSH Desktop 已重启（PID {newPid}）。",
        "capability.available": "自动重启能力自检已通过。",
        "capability.unavailable": "自动重启不可用：{reason}",
        "collector.failed": "内存采集失败：{message}",
        "collector.malformed": "采集输出异常，已重启采集进程：{message}",
        "collector.recovered": "内存采集已恢复。",
        "settings.autoRestart.on": "自动重启已开启。",
        "settings.autoRestart.off": "自动重启已关闭。",
        "settings.thresholds": "阈值已更新：预警 {warningPct} / 危险 {criticalPct} / 确认 {confirmSamples} 个样本 / 冷却 {cooldownMinutes} 分钟 / 门限 {restartGatePct}。",
        "settings.resume.on": "崩溃后自动续接已开启。",
        "settings.resume.off": "崩溃后自动续接已关闭。",
        "settings.plugins": "插件内存设置已更新。",
        "attribution.resident-growing": "内存增长盯梢：{name}（PID {pid}）在 {spanMinutes} 分钟内涨了 {deltaMb} MB，现在 {mb} MB。",
        "action.skipped.external": "提交内存压力主要来自其他软件（DSH 占 {sharePct}），本次危险 episode 不会自动重启。",
      },
      toastFallback: "内存守护事件：{code}",
      cancelInProgress: "正在取消…",
    };

    const en = {
      title: "DSH Memory Guard",
      subtitle: "Watches Windows commit memory. Automatic restart is off by default.",
      version: "version {version}",
      loading: "Reading status…",
      offline: "Cannot reach the plugin Host: {message}. Monitoring may be interrupted, or DSH Desktop is restarting.",
      unsupported: "Automatic restart is not supported here. Monitoring and warnings keep running: {reason}",
      pressureTitle: "System memory",
      used: "Committed",
      limit: "Commit limit",
      pct: "Used",
      available: "Available commit",
      physical: "Physical memory",
      hostRss: "Host RSS",
      sampleAge: "Sample age",
      stale: "Sample is stale; pressure state is unavailable",
      stateLabel: "Pressure",
      state: { normal: "normal", warning: "warning", critical: "critical", unknown: "unknown" },
      actionLabel: "Action",
      action: {
        observing: "observing",
        waiting: "waiting for idle",
        confirming: "confirming idle",
        handoff: "restart handoff",
        cooldown: "cooling down",
      },
      actionDetail: {
        waiting: "A task is running. The restart waits for a confirmed idle window.",
        confirming: "Idle has been confirmed. The handoff starts in a few seconds.",
        handoff: "Restarting the entire DSH Desktop.",
        cooldown: "No automatic restart will happen during the cooldown.",
      },
      cooldownLabel: "Cooldown remaining",
      cooldownNone: "none",
      staleBlips: "{count} sample delays recovered before any toast (worst lag {lag})",
      capabilityLabel: "Automatic restart capability",
      capabilityChecking: "Checking the helper…",
      capabilityOk: "Automatic restart is available",
      capabilityOkEscape: "Automatic restart is available (new processes escape the job: {escape})",
      capabilityUnavailable: "Automatic restart is unavailable: {reason}",
      enabledOn: "Automatic restart: on",
      enabledOff: "Automatic restart: off (default)",
      cancel: "Cancel the pending restart",
      cancelIdle: "There is no pending action to cancel",
      cancelDone: "The pending action was canceled.",
      cancelFailed: "Cancel failed: {message}",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      collapse: "Collapse",
      activityLabel: "Activity check",
      activityIdle: "idle",
      activityBusy: "busy: {reason}",
      activityUnknown: "not checked yet",
      lastError: "Last error ({source}): {message}",
      lastEvent: "Last event: {kind} ({time})",
      lastRestart: "Last restart: {text}",
      restartSucceeded: "succeeded, new PID {pid}",
      restartFailed: "failed: {reason}",
      restartNone: "No restart has been attempted yet",
      restartMemory: "commit {before} before → {after} after",
      disclosureTitle: "Before you enable it",
      disclosureQuit: "The handoff bypasses the Electron shell's native quit confirmation. Profile and session data are still flushed by the Host's graceful shutdown.",
      disclosure1: "The switch restarts the entire DSH Desktop (the main process and all of its children), not just the UI.",
      disclosure2: "Restarting can discard unsent drafts.",
      disclosure3: "It triggers only when commit memory is critical, the configured number of consecutive samples confirm it, and the activity check reports idle.",
      disclosure4: "If the commit pressure comes from other software, restarting may not help.",
      disclosure5: "At most one restart per configured cooldown (30 minutes by default), and at most one attempt per critical episode.",
      external: "Commit pressure caused by other software may not be solvable by restarting DSH.",
      footnote: "The automatic-restart switch lives in this plugin's settings and applies immediately.",
      disclosure6: "Restart gate: the restart only runs when the DSH process tree holds at least {gate} of the commit charge; it stays blocked while attribution data is unavailable.",
      disclosure7: "Crash resume is off by default. When it is on, only turns that were interrupted get one injected “verify the state, then continue” message; turns you canceled yourself are never resumed.",
      attributionTitle: "Commit attribution",
      attributionSummary: "DSH process tree: {count} processes · {bytes} · {share} of the system commit charge",
      attributionAge: " (sampled {age} ago)",
      attributionNone: "Attribution data is unavailable: {error}",
      attributionTopLabel: "Largest commit consumers",
      attributionDshTag: "DSH",
      residentGrowLabel: "Growth watch (5-minute window)",
      residentNone: "No process is climbing right now (threshold {grow})",
      residentOther: "{name} (PID {pid}) grew {delta} within {span} and now holds {mb} (running {age}). The pressure comes from it; restarting DSH will not release it.",
      residentDsh: "{name} (PID {pid}) grew {delta} within {span} and now holds {mb} (running {age}). This one belongs to DSH.",
      residentExe: "executable: {path}",
      gateLabel: "Restart gate",
      gate: {
        passed: "Passed: DSH is the main committer right now.",
        disabled: "Gate is 0%, so the committer check is skipped.",
        unavailable: "Attribution data is unavailable, so automatic restart is blocked.",
        stale: "Attribution data is stale, so automatic restart is blocked.",
        "share-below": "DSH holds only {share}, below the {gate} gate, so restarting would not help. Blocked.",
        unknown: "Attribution has not been sampled yet.",
      },
      systemTitle: "Virtual memory setup (read-only)",
      systemNone: "System information is unavailable: {error}",
      commitHeadroom: "Commit limit − physical memory",
      commitUsed: "Committed / limit",
      pagefileLabel: "Paging files",
      pagefileNone: "No paging file was detected",
      pagefileItem: "{path} · {size}",
      adviceLabel: "Read-only advice",
      advice: {
        "pagefile-ok": "The pagefile and commit limit look healthy.",
        "pagefile-none": "There is no paging file, so the commit limit is almost the same as physical memory. Consider at least {suggestionMb} MiB.",
        "pagefile-small": "The commit limit is only {headroomMb} MiB above physical memory. Consider growing the pagefile to at least {suggestionMb} MiB.",
        "pagefile-system-volume": "Every pagefile sits on the system volume. If another drive has more free space, consider moving it off the system drive.",
        "pagefile-automatic": "The pagefile is managed automatically by Windows.",
        unknown: "Advice: {code}",
      },
      pagefileAction: "This plugin never changes system settings. Adjusting the pagefile is a Windows virtual-memory setting you have to change yourself, and it usually needs a reboot.",
      crashTitle: "Crashes and memory events (last {days} days)",
      crashCounts: "{crash} DSH crashes · {event} system memory events",
      crashNone: "No crash or memory events in this window",
      crashUnavailable: "The timeline is unavailable: {error}",
      crashCodes: {
        "crash.renderer-oom": "Renderer ran out of memory (OOM)",
        "crash.host-exit": "Host process exited",
        "crash.main": "Main process error",
        "crash.renderer": "Renderer error",
        "crash.web-boot": "Web boot failure",
        "crash.other": "DSH error",
        "system.resource-exhaustion": "Windows reported virtual memory exhaustion",
        "system.low-virtual-memory": "Windows low virtual memory warning",
        "system.unexpected-shutdown": "Unexpected system shutdown",
      },
      historyTitle: "Recent events",
      historyNone: "No events recorded yet",
      historyKinds: {
        "pressure-normal": "pressure back to normal",
        "pressure-warning": "entered warning",
        "pressure-critical": "entered critical",
        "pressure-unknown": "sampling lost",
        "restart-attempt": "restart prepared",
        "restart-handoff": "restart handoff",
        "restart-failed": "restart failed",
      },
      historyItem: "{kind} · {pct} · {time}",
      historyFoot: "Events are kept in ~/.dsh/memory-watchdog/events.json, up to 50 entries.",
      resumeTitle: "Resume after a crash",
      resumeOn: "On: interrupted conversations are resumed automatically after DSH restarts.",
      resumeOff: "Off (default): no message is ever injected automatically.",
      resumeRule: "Only interrupted turns are resumed; turns you canceled yourself never are; at most {max} attempts per session per {window}.",
      resumeScan: "Scan now",
      resumeScanning: "Scanning…",
      resumeScanDone: "Scan finished: {candidates} candidates, {resumed} resumed.",
      resumeScanDeferred: "Scan finished: {deferred} sessions are still inside the quiet period and will be retried.",
      resumeScanFailed: "Scan failed: {message}",
      resumeScanUnavailable: "Scan failed: {code}",
      resumeLastScan: "Last scan: {time}",
      resumeNever: "No scan has run yet",
      resumeLedger: "Resume ledger",
      resumeLedgerEmpty: "Nothing has been resumed yet",
      resumeLedgerItem: "{session} · turn {turn} · {cause} · {attempts} attempts · {time}",
      resumeCauseSelf: "interrupted itself",
      resumeCauseChild: "subagent interrupted",
      pluginTitle: "Plugin memory",
      pluginOn: "On: timers, event listeners and heap allocations are counted per plugin.",
      pluginOff: "Off: no plugin is inspected.",
      pluginInspectorMissing: "This environment cannot open an inspector session, so only handle counts are available; heap sampling is disabled.",
      pluginSamplingOff: "Periodic sampling is off. Use “Sample once” for a manual analysis.",
      pluginSamplingOn: "Periodic sampling: every {minutes} min, {seconds}s window.",
      pluginNeverSampled: "No sample has run yet",
      pluginLastSample: "Last sample: {time}",
      pluginNextSample: "Next sample: {time}",
      pluginSample: "Sample once",
      pluginSampling: "Sampling… ({seconds}s window; the UI may feel slower)",
      pluginSampleDone: "Sampled: {bytes} allocated in the window.",
      pluginSampleFailed: "Sampling failed: {message}",
      pluginSampleUnavailable: "Sampling failed: {code}",
      pluginExport: "Export heap profile",
      pluginExportDone: "Exported a .heapprofile ({bytes}).",
      pluginSnapshot: "Heap snapshot",
      pluginSnapshotRunning: "Writing a heap snapshot…",
      pluginSnapshotDone: "Heap snapshot written to {path} ({bytes})",
      pluginSnapshotFailed: "Heap snapshot failed: {message}",
      pluginHead: "plugin · allocated · share · growth · timers · listeners",
      pluginEmpty: "No plugin data yet",
      pluginRisk: { high: "likely leak", medium: "growing fast", low: "normal", unknown: "not enough data" },
      pluginNotSampled: "not sampled",
      pluginReason: { "bytes-growth": "byte growth", "handle-growth": "handle growth", "short-span": "short span", "not-enough-data": "too few windows" },
      pluginTotals: "window {bytes} · native {native} · process RSS {rss} · V8 heap {heap}",
      pluginCore: "DSH core {bytes}",
      pluginRadar: "Handle counts: {timers} timers · {listeners} listeners",
      pluginInventory: "{count} installed plugins found (versions resolved)",
      pluginAttributionOff: "Handle counts could not be attributed: {attributed} attributed, {unattributed} dropped.",
      pluginAdvice: "Reload just that plugin (disable and re-enable it in the plugin manager); restarting all of DSH is unnecessary.",
      pluginFoot: "Data lives in ~/.dsh/memory-watchdog/plugin-memory.json; a sample only counts objects allocated during its window that are still alive.",
      capabilityHints: {
        platform: "Automatic restart needs 64-bit Windows, which this environment is not. Monitoring and warnings still run.",
        powershell: "System PowerShell was not found, so automatic restart is unavailable. Monitoring and warnings still run.",
        job: "The helper runs inside a Windows Job Object and measured that new processes cannot leave it, so automatic restart fails closed here; monitoring, attribution and the crash timeline keep running. If that job comes from the launcher (DSH started from a terminal or an agent), launching DSH from the taskbar / Explorer (or at logon) avoids it; if DSH creates the job itself, changing the launch path does not help.",
        generic: "The helper capability check failed, so automatic restart is disabled. Monitoring and warnings still run.",
      },
      copyDiagnostics: "Copy diagnostics",
      copyDone: "Diagnostics copied to the clipboard.",
      copyFailed: "Copy failed. Please screenshot the card or export the events instead.",
      exportEvents: "Export events JSON",
      exportDone: "The events were exported as a JSON file.",
      exportFailed: "Export failed: {message}",
      toast: {
        "pressure.normal": "Memory pressure is back to normal.",
        "pressure.warning": "Commit memory entered the warning range: {pct}.",
        "pressure.critical": "Commit memory entered the critical range: {pct}. If automatic restart is on, it will run after idle is confirmed.",
        "pressure.unknown": "Memory samples are unavailable; automatic restart is paused.",
        "action.waiting": "Memory is critical, but a task is running. Waiting for idle.",
        "action.waitingReminder": "Still waiting for idle: {reason}",
        "action.confirming": "Idle confirmed. Preparing to restart DSH Desktop.",
        "action.confirmationCanceled": "A new task appeared during the grace period; the confirmation was canceled.",
        "action.canceled.recovered": "Memory pressure recovered; the pending restart was canceled.",
        "action.canceled.disabled": "Automatic restart was turned off; the pending action was canceled.",
        "action.canceled.user": "The pending restart was canceled.",
        "action.canceled.capability": "Automatic restart is unavailable; canceled: {reason}",
        "restart.attempt": "Preparing to restart DSH Desktop…",
        "restart.handoff": "Handoff started. DSH Desktop is about to restart.",
        "restart.failed": "Restart failed: {reason}",
        "restart.succeeded": "DSH Desktop restarted (PID {newPid}).",
        "capability.available": "The automatic-restart capability check passed.",
        "capability.unavailable": "Automatic restart is unavailable: {reason}",
        "collector.failed": "Memory sampling failed: {message}",
        "collector.malformed": "Sampler output was malformed; the sampler was restarted: {message}",
        "collector.recovered": "Memory sampling recovered.",
        "settings.autoRestart.on": "Automatic restart is now on.",
        "settings.autoRestart.off": "Automatic restart is now off.",
        "settings.thresholds": "Thresholds updated: warning {warningPct}, critical {criticalPct}, {confirmSamples} samples, {cooldownMinutes} min cooldown, {restartGatePct} gate.",
        "settings.resume.on": "Crash resume is now on.",
        "settings.resume.off": "Crash resume is now off.",
        "settings.plugins": "Plugin memory settings were updated.",
        "attribution.resident-growing": "Growth watch: {name} (PID {pid}) added {deltaMb} MB within {spanMinutes} minutes and now holds {mb} MB.",
        "action.skipped.external": "The commit pressure mostly comes from other software (DSH holds {sharePct}); this critical episode will not restart automatically.",
      },
      toastFallback: "Memory Guard event: {code}",
      cancelInProgress: "Canceling…",
    };

    // Host dictionaries are flat maps of dotted keys; nested groups are only a
    // convenience for this file and must be flattened before registration.
    function flattenCopy(source, prefix, out) {
      const target = out || {};
      for (const key of Object.keys(source)) {
        const value = source[key];
        const path = prefix ? prefix + "." + key : key;
        if (value && typeof value === "object") flattenCopy(value, path, target);
        else target[path] = value;
      }
      return target;
    }

    const zhCopy = flattenCopy(zh, "");
    const enCopy = flattenCopy(en, "");

    const GIB = 1024 * 1024 * 1024;

    function formatBytes(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      if (value >= GIB) return (value / GIB).toFixed(value >= 10 * GIB ? 1 : 2) + " GiB";
      if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1) + " MiB";
      if (value >= 1024) return (value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1) + " KiB";
      return Math.round(value) + " B";
    }

    function formatPct(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return value.toFixed(1) + "%";
    }

    function formatAge(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      if (ms < 1000) return Math.max(0, Math.round(ms)) + " ms";
      if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
      return Math.round(ms / 60000) + " min";
    }

    function formatDuration(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
      const total = Math.ceil(ms / 1000);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return hours + "h " + minutes + "m";
      if (minutes > 0) return minutes + "m " + seconds + "s";
      return seconds + "s";
    }

    function formatTime(value) {
      const ms = typeof value === "number" && Number.isFinite(value) ? value : null;
      if (ms === null || ms <= 0) return "—";
      try {
        return new Date(ms).toLocaleString();
      } catch {
        return String(ms);
      }
    }

    function interpolate(text, params) {
      if (typeof text !== "string") return "";
      if (params === null || typeof params !== "object") return text;
      return text.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      );
    }

    function safeT(t, key, params) {
      try {
        const value = typeof t === "function" ? t(key, params) : key;
        if (typeof value === "string" && value !== key) return value;
        return interpolate(key, params);
      } catch {
        return key;
      }
    }

    function gateKey(code) {
      if (typeof code !== "string") return "unknown";
      return code.indexOf("gate.") === 0 ? code.slice(5) : "unknown";
    }

    function adviceKey(code) {
      if (typeof code !== "string" || code.length === 0) return "unknown";
      return code.replace(/\./g, "-");
    }

    function labeled(t, prefix, code) {
      const key = prefix + "." + code;
      const text = safeT(t, key);
      return text === key ? String(code) : text;
    }

    function shortId(value) {
      const text = String(value || "");
      return text.length <= 8 ? text : text.slice(0, 8);
    }

    function formatMb(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      if (value >= 1024) return (value / 1024).toFixed(value >= 10 * 1024 ? 1 : 2) + " GiB";
      return Math.round(value) + " MiB";
    }

    function buildDiagnostics(status) {
      if (status === null || typeof status !== "object") return "dsh-memory-watchdog: no status";
      const lines = [];
      const push = (label, value) => {
        if (value === undefined || value === null || value === "") return;
        lines.push(label + ": " + value);
      };
      const plugin = status.plugin || {};
      lines.push("dsh-memory-watchdog " + (plugin.version || "?"));
      push("startedAt", formatTime(plugin.startedAt));
      push("hostPid", plugin.hostPid);
      const platform = status.platform || {};
      push("platform", (platform.platform || "?") + " " + (platform.arch || "?") + " supported=" + String(platform.supported));
      if (platform.reason) push("platformReason", platform.reason);
      const pressure = status.pressure || {};
      push(
        "pressure",
        pressure.state + " " + formatPct(pressure.pct) +
          " used=" + formatBytes(pressure.commitUsed) +
          "/" + formatBytes(pressure.commitLimit) +
          " available=" + formatBytes(pressure.availableCommit)
      );
      if (pressure.stale === true) push("sampleAge", formatAge(pressure.sampleAgeMs) + " (stale)");
      const collector = status.collector || {};
      if (Number(collector.staleBlips) > 0)
        push("collectorLag", "max=" + formatAge(collector.maxDeliveryLagMs) + " recoveredBlips=" + collector.staleBlips);
      const thresholds = (status.config && status.config.thresholds) || {};
      push(
        "thresholds",
        "warning " + thresholds.warningPct + "% critical " + thresholds.criticalPct + "% avail " + thresholds.criticalAvailMb +
          " MiB confirm " + thresholds.confirmSamples + " cooldown " + thresholds.cooldownMinutes + " min gate " + thresholds.restartGatePct + "%"
      );
      const autoRestart = status.autoRestart || {};
      push("autoRestart", autoRestart.enabled === true ? "on" : "off");
      const capability = autoRestart.capability || {};
      push("capability", capability.state + (capability.reason ? " - " + capability.reason : ""));
      const gate = status.gate || {};
      push("gate", gate.code + " share=" + formatPct(gate.sharePct) + " need=" + gate.gatePct + "%");
      const attribution = status.attribution || {};
      if (attribution.ok === true) {
        push("dshCommit", formatBytes(attribution.dshBytes) + " of " + formatBytes(attribution.systemCommitUsed) + " (" + formatPct(attribution.sharePct) + ")");
        const top = Array.isArray(attribution.top) ? attribution.top.slice(0, 5).map((row) => row.name + " " + formatBytes(row.bytes)) : [];
        if (top.length > 0) push("top", top.join(", "));
        const residents = status.residents || {};
        if (typeof residents.growMb === "number") push("growthThreshold", formatMb(residents.growMb) + " within " + formatDuration(residents.windowMs || 0));
        const alerts = Array.isArray(residents.alerts) ? residents.alerts.slice(0, 5).map((alert) => alert.name + " " + formatBytes(alert.bytes)) : [];
        if (alerts.length > 0) push("growing", alerts.join(", "));
      } else {
        push("attribution", "unavailable: " + (attribution.error || "unknown"));
      }
      const system = status.system || {};
      if (system.ok === true) {
        push("commit", formatBytes(system.commitUsed) + " / " + formatBytes(system.commitLimit) + " physical " + formatBytes(system.physicalTotal));
        const files = Array.isArray(system.pagefiles) ? system.pagefiles.map((file) => file.path + " " + formatMb(file.currentMb)) : [];
        push("pagefiles", files.length > 0 ? files.join(", ") : "none");
        push("advice", (Array.isArray(system.advice) ? system.advice : []).map((entry) => entry.code).join(", "));
      } else {
        push("system", "unavailable: " + (system.error || "unknown"));
      }
      const crashes = status.crashes || {};
      if (crashes.ok === true) {
        push("crashes", crashes.crashCount + " dsh, " + crashes.eventCount + " system events in " + crashes.days + " days");
        for (const item of (Array.isArray(crashes.items) ? crashes.items.slice(0, 8) : [])) {
          lines.push("  " + formatTime(item.at) + " " + item.code);
        }
      } else {
        push("crashes", "unavailable: " + (crashes.error || "unknown"));
      }
      const resume = status.resume || {};
      push("resume", resume.enabled === true ? "on" : "off");
      if (resume.lastScan) push("resumeLastScan", "resumed " + resume.lastScan.resumed + " of " + resume.lastScan.candidates + " candidates");
      const ledger = Array.isArray(resume.ledger) ? resume.ledger.slice(0, 5).map((entry) => shortId(entry.sessionId) + " x" + entry.attempts) : [];
      if (ledger.length > 0) push("resumeLedger", ledger.join(", "));
      const plugins = status.plugins || {};
      if (plugins.enabled === true) {
        const sampling = plugins.sampling || {};
        const totals = plugins.totals || {};
        const radar = plugins.radar || {};
        const inventory = plugins.inventory || {};
        push(
          "plugins",
          "windows=" + (totals.windows ?? 0) + " windowBytes=" + formatBytes(totals.totalBytes) +
            " native=" + formatBytes(totals.nativeBytes) +
            " installed=" + (inventory.count ?? 0) +
            " attributed=" + ((radar.debug && radar.debug.attributed) ?? 0) +
            " dropped=" + ((radar.debug && radar.debug.unattributed) ?? 0) +
            " sampling=" + (sampling.enabled === true ? (sampling.minutes ?? 15) + "min/" + (sampling.windowSeconds ?? 20) + "s" : "off")
        );
        for (const entry of (Array.isArray(plugins.packages) ? plugins.packages.slice(0, 5) : [])) {
          push(
            "plugin." + (entry.name || entry.key || "unknown"),
            formatBytes(entry.bytes) + " " + (entry.level || "unknown") +
              (entry.growthBytesPerHour === null || entry.growthBytesPerHour === undefined ? "" : " " + formatBytes(entry.growthBytesPerHour) + "/h") +
              " timers=" + (entry.timers ?? 0) + " listeners=" + (entry.listeners ?? 0)
          );
        }
      } else {
        push("plugins", "off");
      }
      if (status.lastError) push("lastError", (status.lastError.source || "unknown") + ": " + (status.lastError.message || ""));
      return lines.join("\n");
    }

    async function copyToClipboard(text) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      try {
        if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand ? document.execCommand("copy") : false;
        document.body.removeChild(area);
        return copied === true;
      } catch {
        return false;
      }
    }

    async function downloadEvents() {
      const response = await fetch(EVENTS_PATH, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const text = await response.text();
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "dsh-memory-watchdog-events.json";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function postResumeScan() {
      const response = await fetch(RESUME_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: "{}",
      });
      const data = await response.json().catch(() => null);
      return { ok: response.ok === true && data !== null && data.ok === true, data };
    }

    async function postPluginCommand(path) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: "{}",
      });
      const data = await response.json().catch(() => null);
      return { ok: response.ok === true && data !== null && data.ok === true, data };
    }

    async function downloadHeapProfile() {
      const response = await fetch(PLUGINS_EXPORT_PATH, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const text = await response.text();
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "dsh-memory-watchdog.heapprofile";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { bytes: text.length };
    }

    const STATE_COLORS = {
      normal: "var(--dsw-alias-state-success-primary, #1a7f37)",
      warning: "var(--dsw-alias-state-warn-primary, #b7791f)",
      critical: "var(--dsw-alias-state-error-primary, #c0392b)",
      unknown: "var(--dsw-alias-label-tertiary, #8b93a1)",
    };

    const POPOVER_EXIT_MS = 170;
    const MIN_REFRESH_FEEDBACK_MS = 600;
    const REFRESH_TIMEOUT_MS = 8000;
    const STYLE_ELEMENT_ID = "dsh-memory-watchdog-style";

    function ensureKeyframes() {
      if (typeof document === "undefined" || !document.head || !document.createElement) return;
      if (typeof document.getElementById === "function" && document.getElementById(STYLE_ELEMENT_ID)) return;
      const element = document.createElement("style");
      element.id = STYLE_ELEMENT_ID;
      element.textContent =
        "@keyframes dsh-mg-sweep{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}";
      document.head.appendChild(element);
    }

    function sleepMs(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    const poll = {
      status: null,
      error: null,
      updatedAt: 0,
      failures: 0,
      listeners: new Set(),
      timer: null,
      inflight: false,
    };

    function notifyListeners() {
      for (const listener of poll.listeners) {
        try {
          listener();
        } catch {}
      }
    }

    async function fetchStatus(force) {
      if (poll.inflight && !force) return;
      poll.inflight = true;
      try {
        const response = await fetch(STATUS_PATH, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        if (data === null || typeof data !== "object" || data.ok !== true) {
          throw new Error("invalid status payload");
        }
        poll.status = data;
        poll.error = null;
        poll.failures = 0;
      } catch (error) {
        poll.failures += 1;
        poll.error = error && error.message ? error.message : String(error);
      } finally {
        poll.updatedAt = Date.now();
        poll.inflight = false;
        notifyListeners();
      }
    }

    function ensurePolling() {
      if (poll.timer !== null) return;
      fetchStatus(true);
      poll.timer = setInterval(() => fetchStatus(false), POLL_MS);
      if (poll.timer && typeof poll.timer.unref === "function") poll.timer.unref();
    }

    function maybeStopPolling() {
      if (poll.listeners.size > 0 || poll.timer === null) return;
      clearInterval(poll.timer);
      poll.timer = null;
    }

    function subscribe(listener) {
      poll.listeners.add(listener);
      ensurePolling();
      return () => {
        poll.listeners.delete(listener);
        maybeStopPolling();
      };
    }

    function useGuardStatus() {
      const [, setVersion] = useState(0);
      useEffect(() => {
        let active = true;
        const unsubscribe = subscribe(() => {
          if (active) setVersion((value) => value + 1);
        });
        return () => {
          active = false;
          unsubscribe();
        };
      }, []);
      return poll;
    }

    function pressureOf(status) {
      return status && status.pressure ? status.pressure : null;
    }

    function stateKey(status) {
      const pressure = pressureOf(status);
      const state = pressure && typeof pressure.state === "string" ? pressure.state : "unknown";
      return Object.prototype.hasOwnProperty.call(STATE_COLORS, state) ? state : "unknown";
    }

    function actionKey(status) {
      const state = status && status.action && typeof status.action.state === "string" ? status.action.state : "observing";
      return ["observing", "waiting", "confirming", "handoff", "cooldown"].includes(state) ? state : "observing";
    }

    function capabilityLine(t, status) {
      const autoRestart = (status && status.autoRestart) || {};
      const capability = autoRestart.capability || {};
      const platform = (status && status.platform) || {};
      const text =
        capability.state === "checking"
          ? safeT(t, "capabilityChecking")
          : capability.ok === true
            ? capability.escape === "breakaway" || capability.escape === "silent-breakaway"
              ? safeT(t, "capabilityOkEscape", { escape: capability.escape })
              : safeT(t, "capabilityOk")
            : safeT(t, "capabilityUnavailable", { reason: capability.reason || platform.reason || "unknown" });
      const hint =
        capability.ok !== true && typeof capability.hint === "string"
          ? labeled(t, "capabilityHints", capability.hint.replace(/^capability\.hint\./, ""))
          : null;
      return { text, hint };
    }

    function activityLine(t, status) {
      const activity = (status && status.activity) || {};
      if (activity.idle === true) return safeT(t, "activityIdle");
      if (activity.idle === false) return safeT(t, "activityBusy", { reason: activity.reason || "busy" });
      return safeT(t, "activityUnknown");
    }

    function noticeText(t, notice) {
      if (notice === null || typeof notice !== "object") return "";
      const code = typeof notice.code === "string" ? notice.code : "unknown";
      let dictKey = code;
      if (code.indexOf("settings.") === 0 && notice.params && typeof notice.params.enabled === "boolean") {
        dictKey = code + (notice.params.enabled === true ? ".on" : ".off");
      }
      const params = notice.params && typeof notice.params === "object" ? { ...notice.params } : {};
      for (const key of Object.keys(params)) {
        if (key === "pct" || /Pct$/.test(key)) {
          params[key] = formatPct(typeof params[key] === "number" ? params[key] : Number(params[key]));
        } else if (key === "mb" || key === "deltaMb") {
          params[key] = formatMb(Number(params[key]) || 0);
        } else if (key === "spanMinutes" || key === "ageMin") {
          params[key] = formatDuration((Number(params[key]) || 0) * 60000);
        }
      }
      if (Object.prototype.hasOwnProperty.call(params, "newPid") && (params.newPid === null || params.newPid === undefined)) {
        params.newPid = "—";
      }
      const lookup = "toast." + dictKey;
      let text = safeT(t, lookup, params);
      if (text === lookup) text = safeT(t, "toastFallback", { code });
      return text;
    }

    function severityStyle(severity) {
      if (severity === "critical") return { borderColor: STATE_COLORS.critical, color: STATE_COLORS.critical };
      if (severity === "error") return { borderColor: STATE_COLORS.critical, color: STATE_COLORS.critical };
      if (severity === "warn") return { borderColor: STATE_COLORS.warning, color: STATE_COLORS.warning };
      return { borderColor: "var(--dsw-alias-border-l2, #e5e7eb)", color: "var(--dsw-alias-label-primary, #1f2328)" };
    }

    function ToastStack(props) {
      const t = props.t;
      const [toasts, setToasts] = useState([]);
      const guard = useGuardStatus();
      const seenId = useRef(0);
      const timers = useRef(new Map());

      useEffect(() => {
        const status = guard.status;
        if (status === null || !Array.isArray(status.notices) || status.notices.length === 0) return;
        const fresh = status.notices.filter((notice) => Number(notice.id) > seenId.current);
        if (fresh.length === 0) return;
        seenId.current = Math.max(...fresh.map((notice) => Number(notice.id) || 0));
        const items = fresh.map((notice) => ({
          key: String(notice.id) + "-" + String(notice.at) + "-" + String(notice.code),
          text: noticeText(t, notice),
          severity: notice.severity,
        }));
        setToasts((current) => current.concat(items).slice(-4));
        for (const item of items) {
          if (timers.current.has(item.key)) continue;
          const timer = setTimeout(() => {
            timers.current.delete(item.key);
            setToasts((current) => current.filter((entry) => entry.key !== item.key));
          }, 8000);
          if (timer && typeof timer.unref === "function") timer.unref();
          timers.current.set(item.key, timer);
        }
      }, [guard.status, guard.updatedAt]);

      useEffect(
        () => () => {
          for (const timer of timers.current.values()) clearTimeout(timer);
          timers.current.clear();
        },
        []
      );

      if (toasts.length === 0) return null;
      return h(
        "div",
        { style: { position: "fixed", right: 16, bottom: 64, display: "flex", flexDirection: "column", gap: 8, zIndex: 2147483001, pointerEvents: "none", maxWidth: 360 } },
        toasts.map((item) =>
          h(
            "div",
            {
              key: item.key,
              role: "status",
              style: {
                background: "var(--dsw-alias-bg-elevated, #ffffff)",
                border: "1px solid",
                borderRadius: "var(--dsw-radius-md, 8px)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.16)",
                padding: "10px 12px",
                fontSize: 13,
                lineHeight: "20px",
                ...severityStyle(item.severity),
              },
            },
            item.text
          )
        )
      );
    }

    function PopoverRow(props) {
      return h(
        "div",
        { style: { fontSize: 12, lineHeight: "18px", color: props.color || "var(--dsw-alias-label-secondary, #5c6570)", wordBreak: "break-word" } },
        props.label ? h("strong", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #1f2328)" } }, props.label + ": ") : null,
        props.children
      );
    }

    function popoverButtonStyle(enabled) {
      return {
        font: "inherit",
        fontSize: 12,
        padding: "4px 10px",
        borderRadius: "var(--dsw-radius-md, 8px)",
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        background: "transparent",
        color: enabled ? "var(--dsw-alias-label-primary, #1f2328)" : "var(--dsw-alias-label-dimmed, #b0b7c3)",
        cursor: enabled ? "pointer" : "default",
      };
    }

    function SummaryPopover(props) {
      ensureKeyframes();
      const t = props.t;
      const status = props.status;
      const guard = props.guard;
      const pressure = status.pressure || {};
      const state = stateKey(status);
      const action = actionKey(status);
      const autoRestart = status.autoRestart || {};
      const attribution = status.attribution || {};
      const gate = status.gate || {};
      const cooldown = status.cooldown || {};
      const collector = status.collector || {};
      const topRows = Array.isArray(attribution.top) ? attribution.top.slice(0, 3) : [];
      const maxBytes = topRows.reduce((max, row) => Math.max(max, Number(row.bytes) || 0), 0);
      const systemCommit = Number(attribution.systemCommitUsed) > 0 ? Number(attribution.systemCommitUsed) : null;
      const plugins = status.plugins || {};
      const pluginEnabled = plugins.enabled === true;
      const pluginTotals = plugins.totals || {};
      const pluginRadar = plugins.radar || {};
      const pluginEntries = Array.isArray(plugins.packages) ? plugins.packages.slice(0, 5) : [];
      const pluginMaxBytes = pluginEntries.reduce((max, row) => Math.max(max, Number(row.bytes) || 0), 0);
      const pluginRiskColors = {
        high: STATE_COLORS.critical,
        medium: STATE_COLORS.warning,
        low: STATE_COLORS.normal,
        unknown: STATE_COLORS.unknown,
      };
      const capabilityInfo = capabilityLine(t, status);
      const actionDetail = action !== "observing" ? safeT(t, "actionDetail." + action) : null;
      const lastEvent = status.lastEvent && typeof status.lastEvent === "object" ? status.lastEvent : null;
      const lastError = status.lastError && typeof status.lastError === "object" ? status.lastError : null;
      const [shown, setShown] = useState(false);
      const [refreshing, setRefreshing] = useState(false);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      useEffect(() => {
        if (props.open === false) {
          setShown(false);
          return undefined;
        }
        const timer = setTimeout(() => setShown(true), 0);
        return () => clearTimeout(timer);
      }, [props.open]);

      const onRefresh = async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
          await Promise.all([
            Promise.race([fetchStatus(true), sleepMs(REFRESH_TIMEOUT_MS)]),
            sleepMs(MIN_REFRESH_FEEDBACK_MS),
          ]);
        } finally {
          if (alive.current) setRefreshing(false);
        }
      };

      return h(
        "div",
        {
          ref: props.popoverRef,
          role: "dialog",
          "aria-label": safeT(t, "title"),
          style: {
            position: "fixed",
            right: 16,
            bottom: 44,
            zIndex: 2147483002,
            width: 360,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "min(70vh, 520px)",
            overflow: "hidden",
            background: "var(--dsw-alias-bg-elevated, #ffffff)",
            border: "0.5px solid var(--dsw-alias-border-l2, #e5e7eb)",
            borderRadius: "var(--dsw-radius-lg, 12px)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 0,
            pointerEvents: "auto",
            userSelect: "text",
            opacity: shown === false ? 0 : 1,
            transform: shown === false ? "translateY(8px)" : "translateY(0)",
            transition: "opacity 140ms ease-out, transform 140ms ease-out",
          },
          "aria-busy": refreshing,
        },
        refreshing
          ? h(
              "div",
              {
                style: {
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  height: 2,
                  overflow: "hidden",
                  borderRadius: "var(--dsw-radius-lg, 12px) var(--dsw-radius-lg, 12px) 0 0",
                  background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))",
                },
              },
              h("div", {
                style: {
                  width: "35%",
                  height: "100%",
                  background: STATE_COLORS.warning,
                  animation: "dsh-mg-sweep 900ms linear infinite",
                },
              })
            )
          : null,
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
              flex: "none",
              padding: "10px 12px 8px",
              borderBottom: "0.5px solid var(--dsw-alias-border-l2, #e5e7eb)",
            },
          },
          h("span", {
            style: { width: 8, height: 8, borderRadius: "50%", background: STATE_COLORS[state], display: "inline-block", flex: "none" },
          }),
          h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #1f2328)" } }, safeT(t, "state." + state)),
          h("span", { style: { fontSize: 12 } }, safeT(t, "action." + action)),
          pressure.stale === true ? h("span", { style: { fontSize: 11, color: STATE_COLORS.warning } }, safeT(t, "stale")) : null,
          h("span", { style: { flex: "1 1 auto" } }),
          h(
            "button",
            {
              type: "button",
              disabled: refreshing,
              onClick: onRefresh,
              style: { ...popoverButtonStyle(!refreshing), minWidth: 64 },
            },
            refreshing ? safeT(t, "refreshing") : safeT(t, "refresh")
          ),
          h(
            "button",
            { type: "button", onClick: props.onCollapse, style: popoverButtonStyle(true) },
            safeT(t, "collapse")
          )
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 5,
              padding: "8px 12px 10px",
              overflowY: "auto",
              flex: "1 1 auto",
              minHeight: 0,
            },
          },
        guard.error !== null ? h(PopoverRow, { color: STATE_COLORS.critical }, safeT(t, "offline", { message: guard.error })) : null,
        h(
          PopoverRow,
          { label: safeT(t, "pct") },
          formatPct(pressure.pct) +
            " · " +
            formatBytes(pressure.commitUsed) +
            " / " +
            formatBytes(pressure.commitLimit) +
            " · " +
            safeT(t, "available") +
            " " +
            formatBytes(pressure.availableCommit)
        ),
        Number(collector.staleBlips) > 0
          ? h(
              PopoverRow,
              { color: "var(--dsw-alias-label-tertiary, #8b93a1)" },
              safeT(t, "staleBlips", { count: collector.staleBlips, lag: formatAge(collector.maxDeliveryLagMs) })
            )
          : null,
        actionDetail ? h(PopoverRow, null, actionDetail) : null,
        cooldown.active === true ? h(PopoverRow, { label: safeT(t, "cooldownLabel") }, formatDuration(cooldown.remainingMs)) : null,
        h(PopoverRow, { label: safeT(t, "capabilityLabel") }, capabilityInfo.text),
        capabilityInfo.hint ? h(PopoverRow, { color: STATE_COLORS.warning }, capabilityInfo.hint) : null,
        h(PopoverRow, { label: safeT(t, "activityLabel") }, activityLine(t, status)),
        h(PopoverRow, null, safeT(t, autoRestart.enabled === true ? "enabledOn" : "enabledOff")),
        lastEvent
          ? h(PopoverRow, null, safeT(t, "lastEvent", { kind: lastEvent.kind || "unknown", time: formatTime(lastEvent.at) }))
          : null,
        lastError
          ? h(PopoverRow, { color: STATE_COLORS.critical }, safeT(t, "lastError", { source: lastError.source || "unknown", message: lastError.message || "" }))
          : null,
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 5, borderTop: "0.5px solid var(--dsw-alias-border-l2, #e5e7eb)", paddingTop: 8, marginTop: 3 } },
          attribution.ok === true
            ? h(
                PopoverRow,
                null,
                safeT(t, "attributionSummary", {
                  count: attribution.dshCount ?? "—",
                  bytes: formatBytes(attribution.dshBytes),
                  share: formatPct(attribution.sharePct),
                }) + safeT(t, "attributionAge", { age: formatAge(attribution.ageMs) })
              )
            : h(PopoverRow, { color: STATE_COLORS.warning }, safeT(t, "attributionNone", { error: attribution.error || "unknown" })),
          h(
            PopoverRow,
            { label: safeT(t, "gateLabel") },
            safeT(t, "gate." + gateKey(gate.code), { share: formatPct(gate.sharePct), gate: formatPct(gate.gatePct) })
          ),
          topRows.length > 0 ? h(PopoverRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "attributionTopLabel")) : null,
          topRows.map((row, index) =>
            h(ShareRow, {
              key: String(row.pid ?? index),
              label:
                (row.name || "unknown") + " · " + String(row.pid ?? "?") +
                (typeof row.ageMin === "number" ? " · " + formatDuration(row.ageMin * 60000) : ""),
              size: formatBytes(row.bytes),
              share: systemCommit === null ? "—" : formatPct(((Number(row.bytes) || 0) / systemCommit) * 100),
              pct: maxBytes > 0 ? ((Number(row.bytes) || 0) / maxBytes) * 100 : 0,
              color: row.dsh === true ? STATE_COLORS.warning : STATE_COLORS.unknown,
              highlight: row.dsh === true,
              tag: safeT(t, "attributionDshTag"),
            })
          )
        ),
        pluginEnabled
          ? h(PopoverRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "pluginHead"))
          : null,
        pluginEnabled
          ? h(
              PopoverRow,
              null,
              safeT(t, "pluginTotals", {
                bytes: formatBytes(pluginTotals.totalBytes),
                native: formatBytes(pluginTotals.nativeBytes),
                rss: formatBytes(pluginTotals.rss),
                heap: formatBytes(pluginTotals.heapUsed),
              })
            )
          : null,
        pluginEnabled
          ? h(
              PopoverRow,
              { color: "var(--dsw-alias-label-tertiary, #8b93a1)" },
              safeT(t, "pluginRadar", {
                timers: (pluginRadar.totals && pluginRadar.totals.timers) || 0,
                listeners: (pluginRadar.totals && pluginRadar.totals.listeners) || 0,
              })
            )
          : null,
        pluginEnabled
          ? pluginEntries.slice(0, 5).map((row, index) =>
              h(ShareRow, {
                key: "plugin-" + String(row.key || index),
                label: row.name || row.key || "unknown",
                size: Number(row.bytes) > 0 ? formatBytes(row.bytes) : Number(row.samples) > 0 ? formatBytes(0) : "—",
                share: Number.isFinite(row.share) ? formatPct(row.share) : "—",
                pct: pluginMaxBytes > 0 ? ((Number(row.bytes) || 0) / pluginMaxBytes) * 100 : 0,
                color: pluginRiskColors[row.level] || STATE_COLORS.unknown,
                highlight: row.level === "high",
                tag: Number(row.samples) > 0 ? safeT(t, "pluginRisk." + (row.level || "unknown")) : safeT(t, "pluginNotSampled"),
              })
            )
          : null,
        pluginEnabled && pluginEntries.some((row) => row.level === "high")
          ? h(PopoverRow, { color: STATE_COLORS.critical }, safeT(t, "pluginAdvice"))
          : null
        )
      );
    }

    function GuardOverlay(props) {
      const t = props.t;
      const guard = useGuardStatus();
      const [open, setOpen] = useState(false);
      const [render, setRender] = useState(false);
      const pillRef = useRef(null);
      const popoverRef = useRef(null);
      const closeTimer = useRef(null);

      const showPopover = () => {
        if (closeTimer.current !== null) {
          clearTimeout(closeTimer.current);
          closeTimer.current = null;
        }
        setRender(true);
        setOpen(true);
      };

      const hidePopover = () => {
        setOpen(false);
        if (closeTimer.current !== null) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => {
          closeTimer.current = null;
          setRender(false);
        }, POPOVER_EXIT_MS);
      };

      useEffect(
        () => () => {
          if (closeTimer.current !== null) clearTimeout(closeTimer.current);
        },
        []
      );

      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === "Escape") hidePopover();
        };
        const onMouseDown = (event) => {
          const target = event.target;
          if (popoverRef.current && popoverRef.current.contains(target)) return;
          if (pillRef.current && pillRef.current.contains(target)) return;
          hidePopover();
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onMouseDown);
        return () => {
          document.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("mousedown", onMouseDown);
        };
      }, [open]);

      if (guard.status === null && guard.error === null) return h(ToastStack, { t });
      const offline = guard.status === null || guard.error !== null;
      const state = stateKey(guard.status);
      const action = actionKey(guard.status);
      const pressure = pressureOf(guard.status);
      const pct = pressure ? formatPct(pressure.pct) : "";
      const label = offline
        ? safeT(t, "title")
        : safeT(t, "title") + " · " + pct + " " + safeT(t, "state." + state) + (action !== "observing" ? " · " + safeT(t, "action." + action) : "");
      return h(
        react.Fragment,
        null,
        h(ToastStack, { t }),
        render && !offline ? h(SummaryPopover, { t, status: guard.status, guard, popoverRef, open, onCollapse: hidePopover }) : null,
        h(
          "div",
          {
            ref: pillRef,
            role: offline ? undefined : "button",
            tabIndex: offline ? undefined : 0,
            "aria-expanded": offline ? undefined : open,
            title: offline ? safeT(t, "offline", { message: guard.error || "n/a" }) : label,
            onClick: offline ? undefined : () => (open ? hidePopover() : showPopover()),
            onKeyDown: offline
              ? undefined
              : (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    if (open) hidePopover();
                    else showPopover();
                  }
                },
            style: {
              position: "fixed",
              right: 16,
              bottom: 16,
              zIndex: 2147483000,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
              background: "var(--dsw-alias-bg-elevated, #ffffff)",
              color: "var(--dsw-alias-label-secondary, #5c6570)",
              fontSize: 11,
              lineHeight: "16px",
              boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
              opacity: offline ? 0.7 : 1,
              pointerEvents: offline ? "none" : "auto",
              cursor: offline ? "default" : "pointer",
              userSelect: "none",
            },
          },
          h("span", {
            style: {
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: offline ? STATE_COLORS.unknown : STATE_COLORS[state],
              display: "inline-block",
            },
          }),
          offline ? safeT(t, "title") : pct + " · " + safeT(t, "state." + state) + (open ? " ▴" : " ▾")
        )
      );
    }

    function Metric(props) {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
        h("div", { style: { color: "var(--dsw-alias-label-tertiary, #8b93a1)", fontSize: 11, lineHeight: "16px" } }, props.label),
        h("div", { style: { color: "var(--dsw-alias-label-primary, #1f2328)", fontSize: 13, lineHeight: "20px", fontVariantNumeric: "tabular-nums", wordBreak: "break-all" } }, props.value)
      );
    }

    function Section(props) {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6, paddingTop: 10, borderTop: "0.5px solid var(--dsw-alias-border-l2, #e5e7eb)" } },
        h("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary, #1f2328)" } }, props.title),
        props.children
      );
    }

    function TextRow(props) {
      return h(
        "div",
        { style: { fontSize: 11, lineHeight: "17px", color: props.color || "var(--dsw-alias-label-secondary, #5c6570)", wordBreak: "break-word" } },
        props.children
      );
    }

    function ShareRow(props) {
      const width = Math.max(0, Math.min(100, typeof props.pct === "number" ? props.pct : 0));
      return h(
        "div",
        { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 76px 62px", gap: 8, alignItems: "center", fontSize: 11, lineHeight: "16px" } },
        h(
          "div",
          { style: { minWidth: 0 } },
          h(
            "div",
            { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--dsw-alias-label-secondary, #5c6570)" } },
            props.label,
            props.highlight
              ? h(
                  "span",
                  { style: { marginLeft: 6, padding: "0 4px", borderRadius: 3, background: STATE_COLORS.normal, color: "#ffffff", fontSize: 10 } },
                  props.tag
                )
              : null
          ),
          h(
            "div",
            { style: { marginTop: 3, height: 4, borderRadius: 2, background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))", overflow: "hidden" } },
            h("div", { style: { height: "100%", width: width + "%", background: props.color } })
          )
        ),
        h("div", { style: { textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-secondary, #5c6570)" } }, props.size),
        h("div", { style: { textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-tertiary, #8b93a1)" } }, props.share)
      );
    }

    function Disclosure(props) {
      const t = props.t;
      const gate = typeof props.gatePct === "number" ? props.gatePct + "%" : "20%";
      return h(
        "div",
        { style: { margin: "0 16px 14px", padding: "10px 12px", borderRadius: "var(--dsw-radius-md, 8px)", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))", fontSize: 12, lineHeight: "19px", color: "var(--dsw-alias-label-secondary, #5c6570)", display: "flex", flexDirection: "column", gap: 4 } },
        h("div", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #1f2328)" } }, safeT(t, "disclosureTitle")),
        h("ul", { style: { margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 } },
          h("li", null, safeT(t, "disclosure1")),
          h("li", null, safeT(t, "disclosure2")),
          h("li", null, safeT(t, "disclosure3")),
          h("li", null, safeT(t, "disclosure4")),
          h("li", null, safeT(t, "disclosure5")),
          h("li", null, safeT(t, "disclosure6", { gate })),
          h("li", null, safeT(t, "disclosure7")),
          h("li", null, safeT(t, "disclosureQuit"))
        ),
        h("div", null, safeT(t, "external")),
        h("div", { style: { color: "var(--dsw-alias-label-tertiary, #8b93a1)" } }, safeT(t, "footnote"))
      );
    }

    function GuardCard(props) {
      const t = props.t;
      const guard = useGuardStatus();
      const [cancelState, setCancelState] = useState({ busy: false, message: null });
      const [busy, setBusy] = useState({ kind: null, message: null });
      const [pluginBusy, setPluginBusy] = useState({ kind: null, message: null });
      const status = guard.status;
      const offline = guard.error !== null && status === null;

      if (status === null) {
        return h(
          "div",
          { style: { border: "0.5px solid var(--dsw-alias-settings-card-stroke, #e5e7eb)", borderRadius: "var(--dsw-radius-lg, 12px)", maxWidth: 720 } },
          h(
            "div",
            { style: { padding: "14px 16px 10px", display: "flex", flexDirection: "column", gap: 4 } },
            h("div", { style: { fontSize: 15, fontWeight: 600 } }, safeT(t, "title")),
            h("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary, #8b93a1)" } }, safeT(t, "subtitle")),
            h("div", { style: { marginTop: 2, fontSize: 13, color: "var(--dsw-alias-label-tertiary, #8b93a1)" } }, offline ? safeT(t, "offline", { message: guard.error }) : safeT(t, "loading"))
          ),
          h(Disclosure, { t })
        );
      }

      const pressure = pressureOf(status) || {};
      const state = stateKey(status);
      const action = actionKey(status);
      const autoRestart = status.autoRestart || {};
      const capability = autoRestart.capability || {};
      const cooldown = status.cooldown || {};
      const activity = status.activity || {};
      const collector = status.collector || {};
      const plugin = status.plugin || {};
      const platform = status.platform || {};
      const thresholds = (status.config && status.config.thresholds) || {};
      const attribution = status.attribution || {};
      const gate = status.gate || {};
      const system = status.system || {};
      const crashes = status.crashes || {};
      const history = Array.isArray(status.history) ? status.history : [];
      const resume = status.resume || {};
      const resumeEnabled = resume.enabled === true;
      const topRows = Array.isArray(attribution.top) ? attribution.top.slice(0, 5) : [];
      const maxBytes = topRows.reduce((max, row) => Math.max(max, Number(row.bytes) || 0), 0);
      const systemCommit = Number(attribution.systemCommitUsed) > 0 ? Number(attribution.systemCommitUsed) : null;
      const pagefiles = Array.isArray(system.pagefiles) ? system.pagefiles : [];
      const advices = Array.isArray(system.advice) ? system.advice : [];
      const crashItems = Array.isArray(crashes.items) ? crashes.items.slice(0, 8) : [];
      const historyItems = history.slice(0, 6);
      const resumeLedger = Array.isArray(resume.ledger) ? resume.ledger.slice(0, 5) : [];
      const plugins = status.plugins || {};
      const pluginEnabled = plugins.enabled === true;
      const pluginInspector = plugins.inspector === true;
      const pluginSampling = plugins.sampling || {};
      const pluginTotals = plugins.totals || {};
      const pluginRadar = plugins.radar || {};
      const pluginInventory = plugins.inventory || {};
      const pluginDebug = pluginRadar.debug || {};
      const pluginAttributionBroken =
        (Number(pluginDebug.attributed) || 0) === 0 && (Number(pluginDebug.unattributed) || 0) > 0;
      const pluginEntries = Array.isArray(plugins.packages) ? plugins.packages.slice(0, 8) : [];
      const pluginMaxBytes = pluginEntries.reduce((max, row) => Math.max(max, Number(row.bytes) || 0), 0);
      const pluginWindowSeconds = Number(pluginSampling.windowSeconds) || 20;
      const pluginRiskColors = {
        high: STATE_COLORS.critical,
        medium: STATE_COLORS.warning,
        low: STATE_COLORS.normal,
        unknown: STATE_COLORS.unknown,
      };
      const residents = status.residents || {};
      const residentAlerts = Array.isArray(residents.alerts) ? residents.alerts.slice(-3) : [];
      const capabilityInfo = capabilityLine(t, status);
      const capabilityHint = capabilityInfo.hint;
      const capabilityText = capabilityInfo.text;
      const activityText = activityLine(t, status);

      const actionDetail = action !== "observing" ? safeT(t, "actionDetail." + action) : null;

      let restartText = safeT(t, "restartNone");
      const lastRestart = status.lastRestart;
      if (lastRestart && typeof lastRestart === "object") {
        if (lastRestart.status === "succeeded") {
          restartText = safeT(t, "restartSucceeded", { pid: lastRestart.newPid ?? "—" });
        } else if (lastRestart.status === "failed") {
          restartText = safeT(t, "restartFailed", { reason: lastRestart.reason || "unknown" });
        } else {
          restartText = String(lastRestart.status || "unknown");
        }
        const before = lastRestart.memoryBefore && lastRestart.memoryBefore.pct;
        const after = lastRestart.memoryAfter && lastRestart.memoryAfter.pct;
        if (typeof before === "number" && typeof after === "number") {
          restartText += " · " + safeT(t, "restartMemory", { before: formatPct(before), after: formatPct(after) });
        }
        restartText += " · " + formatTime(lastRestart.finishedAt);
      }

      const onCancel = async () => {
        if (cancelState.busy) return;
        setCancelState({ busy: true, message: null });
        try {
          const response = await fetch(CANCEL_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", Accept: "application/json" },
            body: "{}",
          });
          const data = await response.json().catch(() => null);
          if (response.ok && data && data.ok === true) {
            setCancelState({ busy: false, message: safeT(t, "cancelDone") });
            fetchStatus(true);
          } else {
            setCancelState({ busy: false, message: safeT(t, "cancelFailed", { message: (data && data.error) || "HTTP " + response.status }) });
          }
        } catch (error) {
          setCancelState({ busy: false, message: safeT(t, "cancelFailed", { message: error && error.message ? error.message : String(error) }) });
        }
      };

      const cancelable = status.action && status.action.cancelable === true;
      const dot = h("span", {
        style: { width: 8, height: 8, borderRadius: "50%", background: STATE_COLORS[state], display: "inline-block", flex: "none" },
      });

      const buttonStyle = (enabled) => ({
        font: "inherit",
        fontSize: 12,
        padding: "5px 12px",
        borderRadius: "var(--dsw-radius-md, 8px)",
        border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
        background: "transparent",
        color: enabled ? "var(--dsw-alias-label-primary, #1f2328)" : "var(--dsw-alias-label-dimmed, #b0b7c3)",
        cursor: enabled ? "pointer" : "default",
      });

      const onCopy = async () => {
        if (busy.kind !== null) return;
        setBusy({ kind: "copy", message: null });
        const copied = await copyToClipboard(buildDiagnostics(status));
        setBusy({ kind: null, message: copied ? safeT(t, "copyDone") : safeT(t, "copyFailed") });
      };

      const onExport = async () => {
        if (busy.kind !== null) return;
        setBusy({ kind: "export", message: null });
        try {
          await downloadEvents();
          setBusy({ kind: null, message: safeT(t, "exportDone") });
        } catch (error) {
          setBusy({ kind: null, message: safeT(t, "exportFailed", { message: error && error.message ? error.message : String(error) }) });
        }
      };

      const onResumeScan = async () => {
        if (busy.kind !== null) return;
        setBusy({ kind: "resume", message: null });
        try {
          const result = await postResumeScan();
          const data = result.data || {};
          let message;
          if (result.ok) {
            message =
              Number(data.deferred) > 0
                ? safeT(t, "resumeScanDeferred", { deferred: data.deferred })
                : safeT(t, "resumeScanDone", { candidates: data.candidates ?? 0, resumed: data.resumed ?? 0 });
          } else if (data.code === "resume-disabled") {
            message = safeT(t, "resumeScanUnavailable", { code: data.code });
          } else {
            message = safeT(t, "resumeScanFailed", { message: data.error || data.code || "unknown" });
          }
          setBusy({ kind: null, message });
          fetchStatus(true);
        } catch (error) {
          setBusy({ kind: null, message: safeT(t, "resumeScanFailed", { message: error && error.message ? error.message : String(error) }) });
        }
      };

      const onPluginSample = async () => {
        if (pluginBusy.kind !== null) return;
        setPluginBusy({ kind: "sample", message: safeT(t, "pluginSampling", { seconds: pluginWindowSeconds }) });
        try {
          const result = await postPluginCommand(PLUGINS_SAMPLE_PATH);
          const data = result.data || {};
          let message;
          if (result.ok) {
            message = safeT(t, "pluginSampleDone", { bytes: formatBytes(data.totalBytes) });
          } else if (data.code === "plugins-disabled") {
            message = safeT(t, "pluginSampleUnavailable", { code: data.code });
          } else {
            message = safeT(t, "pluginSampleFailed", { message: data.error || data.code || "unknown" });
          }
          setPluginBusy({ kind: null, message });
          fetchStatus(true);
        } catch (error) {
          setPluginBusy({ kind: null, message: safeT(t, "pluginSampleFailed", { message: error && error.message ? error.message : String(error) }) });
        }
      };

      const onPluginExport = async () => {
        if (pluginBusy.kind !== null) return;
        setPluginBusy({ kind: "export", message: null });
        try {
          const exported = await downloadHeapProfile();
          setPluginBusy({ kind: null, message: safeT(t, "pluginExportDone", { bytes: formatBytes(exported.bytes) }) });
          fetchStatus(true);
        } catch (error) {
          setPluginBusy({ kind: null, message: safeT(t, "pluginSampleFailed", { message: error && error.message ? error.message : String(error) }) });
        }
      };

      const onPluginSnapshot = async () => {
        if (pluginBusy.kind !== null) return;
        setPluginBusy({ kind: "snapshot", message: null });
        try {
          const result = await postPluginCommand(SNAPSHOT_PATH);
          const data = result.data || {};
          let message;
          if (result.ok) {
            message = safeT(t, "pluginSnapshotDone", { path: data.path || "heap snapshot", bytes: formatBytes(data.bytes) });
          } else if (data.code === "plugins-disabled") {
            message = safeT(t, "pluginSampleUnavailable", { code: data.code });
          } else {
            message = safeT(t, "pluginSnapshotFailed", { message: data.error || data.code || "unknown" });
          }
          setPluginBusy({ kind: null, message });
        } catch (error) {
          setPluginBusy({ kind: null, message: safeT(t, "pluginSnapshotFailed", { message: error && error.message ? error.message : String(error) }) });
        }
      };

      const resumeScanMessage =
        resume.lastScan && resume.lastScan.ok === true
          ? Number(resume.lastScan.deferred ? resume.lastScan.deferred.length : 0) > 0
            ? safeT(t, "resumeScanDeferred", { deferred: resume.lastScan.deferred.length })
            : safeT(t, "resumeScanDone", { candidates: resume.lastScan.candidates ?? 0, resumed: resume.lastScan.resumed ?? 0 })
          : resume.lastScan && resume.lastScan.ok === false
            ? safeT(t, "resumeScanFailed", { message: resume.lastScan.error || resume.lastScan.code || "unknown" })
            : null;

      return h(
        "div",
        { style: { border: "0.5px solid var(--dsw-alias-settings-card-stroke, #e5e7eb)", borderRadius: "var(--dsw-radius-lg, 12px)", background: "var(--dsw-alias-settings-card-fill, transparent)", maxWidth: 720 } },
        h(
          "div",
          { style: { padding: "14px 16px 10px", display: "flex", flexDirection: "column", gap: 4 } },
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
            h("span", { style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #1f2328)" } }, safeT(t, "title")),
            h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #8b93a1)" } }, safeT(t, "version", { version: plugin.version || "?" }))
          ),
          h("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary, #8b93a1)", lineHeight: "20px" } }, safeT(t, "subtitle")),
          guard.error !== null
            ? h("div", { style: { fontSize: 12, color: STATE_COLORS.critical, lineHeight: "18px" } }, safeT(t, "offline", { message: guard.error }))
            : null,
          platform.supported === false
            ? h("div", { style: { fontSize: 12, color: STATE_COLORS.warning, lineHeight: "18px" } }, safeT(t, "unsupported", { reason: platform.reason || "unsupported" }))
            : null
        ),
        h(
          "div",
          { style: { margin: "0 16px", borderTop: "0.5px solid var(--dsw-alias-border-l2, #e5e7eb)", padding: "12px 0", display: "flex", flexDirection: "column", gap: 12 } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            dot,
            h("span", { style: { fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary, #1f2328)" } }, safeT(t, "state." + state)),
            h("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #5c6570)" } }, safeT(t, "action." + action)),
            pressure.stale === true
              ? h("span", { style: { fontSize: 12, color: STATE_COLORS.warning } }, safeT(t, "stale"))
              : null
          ),
          actionDetail
            ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #8b93a1)", lineHeight: "18px" } }, actionDetail)
            : null,
          h(
            "div",
            { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px 16px" } },
            h(Metric, { label: safeT(t, "used"), value: formatBytes(pressure.commitUsed) }),
            h(Metric, { label: safeT(t, "limit"), value: formatBytes(pressure.commitLimit) }),
            h(Metric, { label: safeT(t, "pct"), value: formatPct(pressure.pct) }),
            h(Metric, { label: safeT(t, "available"), value: formatBytes(pressure.availableCommit) }),
            h(Metric, { label: safeT(t, "physical"), value: formatBytes(pressure.physicalTotal) + " / " + formatBytes(pressure.physicalAvailable) }),
            h(Metric, { label: safeT(t, "hostRss"), value: formatBytes(plugin.hostRss) }),
            h(Metric, { label: safeT(t, "sampleAge"), value: formatAge(collector.sampleAgeMs) }),
            h(Metric, { label: safeT(t, "cooldownLabel"), value: cooldown.active === true ? formatDuration(cooldown.remainingMs) : safeT(t, "cooldownNone") })
          ),
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, #5c6570)" } },
            h("div", null, h("strong", { style: { fontWeight: 600 } }, safeT(t, "capabilityLabel") + ": "), capabilityText),
            capabilityHint ? h("div", { style: { color: STATE_COLORS.warning } }, capabilityHint) : null,
            h("div", null, h("strong", { style: { fontWeight: 600 } }, safeT(t, "activityLabel") + ": "), activityText),
            h("div", null, safeT(t, autoRestart.enabled === true ? "enabledOn" : "enabledOff")),
            h("div", null, safeT(t, "lastRestart", { text: restartText })),
            status.lastEvent && typeof status.lastEvent === "object"
              ? h("div", null, safeT(t, "lastEvent", { kind: status.lastEvent.kind || "unknown", time: formatTime(status.lastEvent.at) }))
              : null,
            status.lastError && typeof status.lastError === "object"
              ? h("div", { style: { color: STATE_COLORS.critical } }, safeT(t, "lastError", { source: status.lastError.source || "unknown", message: status.lastError.message || "" }))
              : null
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h(
              "button",
              {
                type: "button",
                disabled: !cancelable || cancelState.busy,
                onClick: onCancel,
                style: {
                  font: "inherit",
                  fontSize: 12,
                  padding: "5px 12px",
                  borderRadius: "var(--dsw-radius-md, 8px)",
                  border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
                  background: "var(--dsw-alias-bg-layer-2, transparent)",
                  color: cancelable ? "var(--dsw-alias-label-primary, #1f2328)" : "var(--dsw-alias-label-dimmed, #b0b7c3)",
                  cursor: cancelable && !cancelState.busy ? "pointer" : "default",
                },
              },
              cancelState.busy ? safeT(t, "cancelInProgress") : safeT(t, "cancel")
            ),
            h(
              "button",
              {
                type: "button",
                disabled: busy.kind !== null,
                onClick: async () => {
                  if (busy.kind !== null) return;
                  setBusy({ kind: "refresh", message: null });
                  try {
                    await Promise.all([
                      Promise.race([fetchStatus(true), sleepMs(REFRESH_TIMEOUT_MS)]),
                      sleepMs(MIN_REFRESH_FEEDBACK_MS),
                    ]);
                  } finally {
                    setBusy({ kind: null, message: null });
                  }
                },
                style: {
                  font: "inherit",
                  fontSize: 12,
                  padding: "5px 12px",
                  borderRadius: "var(--dsw-radius-md, 8px)",
                  border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
                  background: "transparent",
                  color: busy.kind === null ? "var(--dsw-alias-label-secondary, #5c6570)" : "var(--dsw-alias-label-dimmed, #b0b7c3)",
                  cursor: busy.kind === null ? "pointer" : "default",
                  minWidth: 78,
                },
              },
              busy.kind === "refresh" ? safeT(t, "refreshing") : safeT(t, "refresh")
            ),
            h(
              "button",
              {
                type: "button",
                disabled: busy.kind !== null,
                onClick: onCopy,
                style: buttonStyle(busy.kind === null),
              },
              safeT(t, "copyDiagnostics")
            ),
            h(
              "button",
              {
                type: "button",
                disabled: busy.kind !== null,
                onClick: onExport,
                style: buttonStyle(busy.kind === null),
              },
              safeT(t, "exportEvents")
            ),
            h(
              "button",
              {
                type: "button",
                disabled: !resumeEnabled || busy.kind !== null,
                onClick: onResumeScan,
                title: resumeEnabled ? "" : safeT(t, "resumeOff"),
                style: buttonStyle(resumeEnabled && busy.kind === null),
              },
              busy.kind === "resume" ? safeT(t, "resumeScanning") : safeT(t, "resumeScan")
            ),
            !cancelable ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #8b93a1)" } }, safeT(t, "cancelIdle")) : null
          ),
          cancelState.message
            ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #5c6570)" } }, cancelState.message)
            : null,
          busy.message ? h(TextRow, null, busy.message) : null,
          h(
            Section,
            { title: safeT(t, "attributionTitle") },
            attribution.ok === true
              ? h(
                  TextRow,
                  null,
                  safeT(t, "attributionSummary", {
                    count: attribution.dshCount ?? "—",
                    bytes: formatBytes(attribution.dshBytes),
                    share: formatPct(attribution.sharePct),
                  }) + safeT(t, "attributionAge", { age: formatAge(attribution.ageMs) })
                )
              : h(TextRow, { color: STATE_COLORS.warning }, safeT(t, "attributionNone", { error: attribution.error || "unknown" })),
            h(
              TextRow,
              null,
              h("strong", { style: { fontWeight: 600 } }, safeT(t, "gateLabel") + ": "),
              safeT(t, "gate." + gateKey(gate.code), { share: formatPct(gate.sharePct), gate: formatPct(gate.gatePct) })
            ),
            topRows.length > 0
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 5 } },
                  h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "attributionTopLabel")),
                  topRows.map((row, index) =>
                    h(ShareRow, {
                      key: String(row.pid ?? index),
                      label:
                        (row.name || "unknown") + " · " + String(row.pid ?? "?") +
                        (typeof row.ageMin === "number" ? " · " + formatDuration(row.ageMin * 60000) : ""),
                      size: formatBytes(row.bytes),
                      share: systemCommit === null ? "—" : formatPct(((Number(row.bytes) || 0) / systemCommit) * 100),
                      pct: maxBytes > 0 ? ((Number(row.bytes) || 0) / maxBytes) * 100 : 0,
                      color: row.dsh === true ? STATE_COLORS.warning : STATE_COLORS.unknown,
                      highlight: row.dsh === true,
                      tag: safeT(t, "attributionDshTag"),
                    })
                  )
                )
              : null,
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 4 } },
              h(
                TextRow,
                { color: "var(--dsw-alias-label-tertiary, #8b93a1)" },
                safeT(t, "residentGrowLabel") + ": " +
                  (residentAlerts.length === 0
                    ? safeT(t, "residentNone", { grow: formatMb(Number(thresholds.residentGrowMb) || 0) })
                    : "")
              ),
              residentAlerts.map((alert, index) =>
                h(
                  TextRow,
                  { key: String(alert.pid) + "-" + String(alert.at ?? index), color: alert.dsh === true ? STATE_COLORS.warning : STATE_COLORS.critical },
                  safeT(t, alert.dsh === true ? "residentDsh" : "residentOther", {
                    name: alert.name || "unknown",
                    pid: alert.pid ?? "?",
                    span: formatDuration(Math.max(60000, Number(alert.spanMs) || 0)),
                    delta: formatMb(Math.round((Number(alert.growthBytes) || 0) / (1024 * 1024))),
                    mb: formatMb(Math.round((Number(alert.bytes) || 0) / (1024 * 1024))),
                    age: typeof alert.ageMin === "number" ? formatDuration(alert.ageMin * 60000) : "—",
                  })
                )
              ),
              residentAlerts.map((alert, index) =>
                alert.exePath
                  ? h(TextRow, { key: "exe-" + String(alert.pid) + "-" + String(index), color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "residentExe", { path: alert.exePath }))
                  : null
              )
            )
          ),
          h(
            Section,
            { title: safeT(t, "systemTitle") },
            system.ok === true
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h(TextRow, null, safeT(t, "commitUsed") + ": " + formatBytes(system.commitUsed) + " / " + formatBytes(system.commitLimit)),
                  h(
                    TextRow,
                    null,
                    safeT(t, "commitHeadroom") + ": " + formatBytes((Number(system.commitLimit) || 0) - (Number(system.physicalTotal) || 0)) +
                      " · " + safeT(t, "physical") + ": " + formatBytes(system.physicalTotal) + " / " + formatBytes(system.physicalAvailable)
                  ),
                  pagefiles.length > 0
                    ? h(
                        TextRow,
                        null,
                        safeT(t, "pagefileLabel") + ": " +
                          pagefiles.map((file) => safeT(t, "pagefileItem", { path: file.path, size: formatMb(file.currentMb) })).join(" · ")
                      )
                    : h(TextRow, { color: STATE_COLORS.warning }, safeT(t, "pagefileNone")),
                  advices.map((entry, index) =>
                    h(
                      TextRow,
                      {
                        key: String(entry.code ?? index),
                        color:
                          entry.severity === "warn"
                            ? STATE_COLORS.warning
                            : entry.severity === "critical"
                              ? STATE_COLORS.critical
                              : "var(--dsw-alias-label-secondary, #5c6570)",
                      },
                      safeT(t, "advice." + adviceKey(entry.code), {
                        suggestionMb: entry.suggestionMb ?? "—",
                        headroomMb: entry.headroomMb ?? "—",
                        code: entry.code ?? "unknown",
                      })
                    )
                  ),
                  h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "pagefileAction"))
                )
              : h(TextRow, { color: STATE_COLORS.warning }, safeT(t, "systemNone", { error: system.error || "unknown" }))
          ),
          h(
            Section,
            { title: safeT(t, "crashTitle", { days: crashes.days ?? 7 }) },
            crashes.ok === true
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  h(TextRow, null, safeT(t, "crashCounts", { crash: crashes.crashCount ?? 0, event: crashes.eventCount ?? 0 })),
                  crashItems.length === 0
                    ? h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "crashNone"))
                    : crashItems.map((item, index) =>
                        h(
                          TextRow,
                          {
                            key: String(item.at) + "-" + String(index),
                            color:
                              item.severity === "critical"
                                ? STATE_COLORS.critical
                                : item.severity === "warn"
                                  ? STATE_COLORS.warning
                                  : "var(--dsw-alias-label-secondary, #5c6570)",
                          },
                          formatTime(item.at) + " · " + labeled(t, "crashCodes", item.code) +
                            (item.detail ? " · " + item.detail : "") +
                            (Array.isArray(item.sources) && item.sources.length > 1 ? " · " + item.sources.join("+") : "")
                        )
                      )
                )
              : h(TextRow, { color: STATE_COLORS.warning }, safeT(t, "crashUnavailable", { error: crashes.error || "unknown" }))
          ),
          h(
            Section,
            { title: safeT(t, "historyTitle") },
            historyItems.length === 0
              ? h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "historyNone"))
              : h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 3 } },
                  historyItems.map((entry, index) =>
                    h(
                      TextRow,
                      { key: String(entry.at) + "-" + String(index) },
                      safeT(t, "historyItem", {
                        kind: labeled(t, "historyKinds", entry.kind || "unknown"),
                        pct: entry.pressure && typeof entry.pressure.pct === "number" ? formatPct(entry.pressure.pct) : "—",
                        time: formatTime(entry.at),
                      })
                    )
                  )
                ),
            h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "historyFoot"))
          ),
          h(
            Section,
            { title: safeT(t, "pluginTitle") },
            h(TextRow, { color: pluginEnabled ? STATE_COLORS.normal : "var(--dsw-alias-label-secondary, #5c6570)" }, safeT(t, pluginEnabled ? "pluginOn" : "pluginOff")),
            pluginEnabled && !pluginInspector ? h(TextRow, { color: STATE_COLORS.warning }, safeT(t, "pluginInspectorMissing")) : null,
            h(
              TextRow,
              { color: "var(--dsw-alias-label-tertiary, #8b93a1)" },
              pluginSampling.enabled === true
                ? safeT(t, "pluginSamplingOn", { minutes: pluginSampling.minutes ?? 15, seconds: pluginWindowSeconds })
                : safeT(t, "pluginSamplingOff")
            ),
            h(
              TextRow,
              null,
              pluginSampling.lastSampleAt
                ? safeT(t, "pluginLastSample", { time: formatTime(pluginSampling.lastSampleAt) })
                : safeT(t, "pluginNeverSampled")
            ),
            pluginSampling.enabled === true && pluginSampling.nextSampleAt
              ? h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "pluginNextSample", { time: formatTime(pluginSampling.nextSampleAt) }))
              : null,
            pluginSampling.lastError
              ? h(TextRow, { color: STATE_COLORS.warning }, safeT(t, "pluginSampleFailed", { message: pluginSampling.lastError }))
              : null,
            h(
              TextRow,
              null,
              safeT(t, "pluginTotals", {
                bytes: formatBytes(pluginTotals.totalBytes),
                native: formatBytes(pluginTotals.nativeBytes),
                rss: formatBytes(pluginTotals.rss),
                heap: formatBytes(pluginTotals.heapUsed),
              })
            ),
            h(TextRow, null, safeT(t, "pluginCore", { bytes: formatBytes(pluginTotals.coreBytes) })),
            h(
              TextRow,
              { color: "var(--dsw-alias-label-tertiary, #8b93a1)" },
              safeT(t, "pluginRadar", {
                timers: (pluginRadar.totals && pluginRadar.totals.timers) || 0,
                listeners: (pluginRadar.totals && pluginRadar.totals.listeners) || 0,
              })
            ),
            Number(pluginInventory.count) > 0
              ? h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "pluginInventory", { count: pluginInventory.count }))
              : null,
            pluginAttributionBroken
              ? h(
                  TextRow,
                  { color: STATE_COLORS.warning },
                  safeT(t, "pluginAttributionOff", {
                    attributed: (pluginDebug && pluginDebug.attributed) || 0,
                    unattributed: (pluginDebug && pluginDebug.unattributed) || 0,
                  })
                )
              : null,
            pluginEntries.length === 0
              ? h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "pluginEmpty"))
              : h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 5 } },
                  h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "pluginHead")),
                  pluginEntries.map((row, index) =>
                    h(ShareRow, {
                      key: String(row.key || index),
                      label: (row.name || row.key || "unknown") + (row.version ? " · " + row.version : ""),
                      size: Number(row.bytes) > 0 ? formatBytes(row.bytes) : Number(row.samples) > 0 ? formatBytes(0) : "—",
                      share: Number.isFinite(row.share) ? formatPct(row.share) : "—",
                      pct: pluginMaxBytes > 0 ? ((Number(row.bytes) || 0) / pluginMaxBytes) * 100 : 0,
                      color: pluginRiskColors[row.level] || STATE_COLORS.unknown,
                      highlight: row.level === "high",
                      tag: Number(row.samples) > 0 ? safeT(t, "pluginRisk." + (row.level || "unknown")) : safeT(t, "pluginNotSampled"),
                    })
                  ),
                  pluginEntries
                    .filter((row) => row.level === "high" || row.level === "medium")
                    .map((row, index) =>
                      h(
                        TextRow,
                        { key: "risk-" + String(row.key || index), color: pluginRiskColors[row.level] },
                        [
                          (Array.isArray(row.reasons) ? row.reasons : []).map((reason) => safeT(t, "pluginReason." + reason)).join(" · "),
                          row.growthBytesPerHour === null ? null : formatBytes(row.growthBytesPerHour) + "/h",
                          safeT(t, "pluginRadar", { timers: row.timers ?? 0, listeners: row.listeners ?? 0 }),
                          row.level === "high" ? safeT(t, "pluginAdvice") : null,
                        ]
                          .filter((part) => part !== null && part !== "")
                          .join(" · ")
                      )
                    )
                ),
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              h(
                "button",
                {
                  type: "button",
                  disabled: !pluginEnabled || !pluginInspector || pluginBusy.kind !== null,
                  onClick: onPluginSample,
                  title: pluginInspector ? "" : safeT(t, "pluginInspectorMissing"),
                  style: buttonStyle(pluginEnabled && pluginInspector && pluginBusy.kind === null),
                },
                pluginBusy.kind === "sample" ? safeT(t, "pluginSampling", { seconds: pluginWindowSeconds }) : safeT(t, "pluginSample")
              ),
              h(
                "button",
                {
                  type: "button",
                  disabled: !pluginEnabled || !pluginInspector || pluginBusy.kind !== null,
                  onClick: onPluginExport,
                  style: buttonStyle(pluginEnabled && pluginInspector && pluginBusy.kind === null),
                },
                safeT(t, "pluginExport")
              ),
              h(
                "button",
                {
                  type: "button",
                  disabled: !pluginEnabled || pluginBusy.kind !== null,
                  onClick: onPluginSnapshot,
                  style: buttonStyle(pluginEnabled && pluginBusy.kind === null),
                },
                pluginBusy.kind === "snapshot" ? safeT(t, "pluginSnapshotRunning") : safeT(t, "pluginSnapshot")
              )
            ),
            pluginBusy.message ? h(TextRow, null, pluginBusy.message) : null,
            h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "pluginFoot"))
          ),
          h(
            Section,
            { title: safeT(t, "resumeTitle") },
            h(TextRow, { color: resumeEnabled ? STATE_COLORS.normal : "var(--dsw-alias-label-secondary, #5c6570)" }, safeT(t, resumeEnabled ? "resumeOn" : "resumeOff")),
            h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "resumeRule", {
              max: resume.maxAttempts ?? 2,
              window: formatDuration(resume.windowMs ?? 12 * 60 * 60 * 1000),
            })),
            h(TextRow, null, resume.lastScanAt ? safeT(t, "resumeLastScan", { time: formatTime(resume.lastScanAt) }) : safeT(t, "resumeNever")),
            resumeScanMessage ? h(TextRow, null, resumeScanMessage) : null,
            h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "resumeLedger")),
            resumeLedger.length === 0
              ? h(TextRow, { color: "var(--dsw-alias-label-tertiary, #8b93a1)" }, safeT(t, "resumeLedgerEmpty"))
              : h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 3 } },
                  resumeLedger.map((entry, index) =>
                    h(
                      TextRow,
                      { key: String(entry.sessionId) + "-" + String(index) },
                      safeT(t, "resumeLedgerItem", {
                        session: shortId(entry.sessionId),
                        turn: entry.lastTurn ?? "—",
                        cause: entry.lastCause === "child" ? safeT(t, "resumeCauseChild") : safeT(t, "resumeCauseSelf"),
                        attempts: entry.attempts ?? 0,
                        time: formatTime(entry.at),
                      })
                    )
                  )
                )
          )
        ),
        h(Disclosure, { t, gatePct: typeof thresholds.restartGatePct === "number" ? thresholds.restartGatePct : 20 })
      );
    }

    const name = "dsh-memory-watchdog-client";
    const inject = ["slots", "locale"];

    function apply(ctx) {
      try {
        const namespace = "settings.memory-watchdog";
        ctx.effect(() => ctx.locale.register(namespace, { zh: zhCopy, en: enCopy }), "dsh-memory-watchdog: settings copy");
        const t = ctx.locale.bind(namespace);

        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.config",
              key: "dsh-memory-watchdog",
              locale: namespace,
              inject: () => ({ t }),
            },
            (ownerProps = {}) => (ownerProps.view === "summary" ? null : h(GuardCard, { t }))
          )
        );

        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            {
              name: "shell.overlay",
              id: "dsh-memory-watchdog.overlay",
              locale: namespace,
              inject: () => ({ t }),
            },
            (ownerProps = {}) => h(GuardOverlay, { t: ownerProps.t || t })
          )
        );
      } catch (error) {
        console.error("[dsh-memory-watchdog] client UI failed to load (host monitoring is unaffected):", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    exports.buildDiagnostics = buildDiagnostics;

    return module.exports;
  },
});
