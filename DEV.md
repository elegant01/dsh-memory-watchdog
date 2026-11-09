# 开发循环

这份文档只解决一件事：**改完插件代码后，怎样不靠「退出 DSH → 重开 → 点开卡片验证」就能看到效果**。流程与 `dsh-codearts` 一致。

| 改的是 | 生效方式 | 要重启 DSH 吗 |
| --- | --- | --- |
| `lib/*.js`（宿主侧：状态机、归因、续接、路由） | `npm run deploy` 原地覆盖 → `dsh-hmr` 监听部署目录并热重载该插件条目 | 不需要（首次打开监听时要重启一次） |
| `lib/client/index.js`（设置页卡片、右下角胶囊） | `dsh-client-hmr` 轮询客户端产物并重新执行 | 不需要，也不用刷新页面 |
| `package.json` 的 `dsh.*` 清单、版本号、增删插件条目 | 宿主只在启动时读这些 | **需要** |

## 命令

```sh
npm run deploy      # 把工作树同步进 profile（默认 ~/.dsh/profiles/desktop）
npm run hmr:on      # 往 profile 的 cordis.patch.yml 写入 dsh-hmr 覆盖行（幂等、无 BOM、带备份）
npm run hmr:status  # 看当前监听状态
npm run hmr:off     # 撤掉我们那一条 root，回到基础配置
node scripts/deploy.mjs --prune-legacy   # 顺带清掉旧名 dsh-memory-guard 的安装痕迹
```

部署是**原地覆盖**，不删目录重建：`dsh-hmr` 只处理 chokidar 的 `change` 事件，`rm -rf lib` 再拷只会产生 unlink+add，热重载不触发；只有保持同一路径、改内容（mtime 变）才会被捕获。内容逐字节相同的文件不动，免得白刷一次重载。profile 的 manifest 只在语义真的变化时才写，写之前先备份。

## 为什么覆盖行必须写全两个字段

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: false
  config:
    root:
      - node_modules/dsh-memory-watchdog
    ignored: []
```

- `root` 默认为空（`dsh-base` 的 patch 里写 `root: []`）⇒ 只监听 profile 配置文件、不监听模块，所以不改它就必须重启。
- `ignored` 的默认值里有一条排除 `node_modules` 的 glob，而插件恰好装在 `node_modules/dsh-memory-watchdog` 下，正被默认排除；它是相对 base 目录做 picomatch 匹配的，所以必须显式写成空表。
- patch 是**整份 `config` 替换**，不是字段合并 ⇒ `root` 与 `ignored` 要一起给全；`hmr:on` 会保留别的插件已经写在 `root` 里的条目（例如 `node_modules/dsh-codearts`）。

## ⚠️ 开着模块监听就别用插件管理器/npm 升级本插件

宿主会为热重载监视 `node_modules/dsh-memory-watchdog`，目录被占用时 pnpm 换版本会失败。要升级先发版、再 `npm run hmr:off`、最后走 `dsh plugin add`。

## 发布

`.github/workflows/release.yml` 一次跑三路，触发条件是 `push main`、GitHub Release 发布、或手动 `workflow_dispatch`：

| 去处 | 触发 | 说明 |
| --- | --- | --- |
| GitHub Packages | push / release | 临时改名成 `@elegant01/dsh-memory-watchdog` 后发布，仓库页面侧栏的 Packages 卡片来自这一路 |
| npmjs | push / release | 走 Trusted Publisher（OIDC），`npm publish --provenance`，不需要 token |
| Release 附件 | release 发布 / 手动补挂 | `npm pack` 出的 tarball 挂到该 Release 上 |

所以发版的完整动作就是：改 `package.json` 的 `version`（以及 CHANGELOG）→ 提交 → `git push`。两路发布都先查「这个版本是不是已经在那儿了」，在就跳过，重复 push 不会报 `E409`/`EPUBLISHCONFLICT`。

补挂历史 Release 的 tarball（例如某个 tag 当时没挂上）：

```sh
gh workflow run release.yml -f tag=v0.9.0   # 检出该 tag、校验版本号一致、npm pack、gh release upload --clobber
gh workflow run release.yml -f dryRun=true  # 只跑门禁，不发布
```

`workflow_dispatch` 补挂要求 tag 与 `package.json` 的版本号严格对应（`v0.9.0` ↔ `0.9.0`），否则 job 直接失败，免得把 main 的 HEAD 打成旧 tag 的附件。

**本机没有 `gh` CLI**（`where.exe gh` 无结果、winget/choco/scoop 都没装）。要么先装，要么直接用 REST API 发同一个 dispatch，两者等价：

```sh
curl -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/elegant01/dsh-memory-watchdog/actions/workflows/release.yml/dispatches \
  -d '{"ref":"main","inputs":{"tag":"v0.9.0","dryRun":"false"}}'
```

token 可以从 `git credential fill` 取（`protocol=https` + `host=github.com`），实测该 token 有 `repo`/`workflow` scope，够用。

> 现状（2026-11-09）：v0.2.0–v0.6.0 缺失的 Release 附件**已全部补齐**，现在每个 Release 都挂着对应版本的 tarball。补挂时有个坑：`release.yml` 有 `concurrency: group: publish-package`，同组最多 1 running + 1 pending，**一次性并发提交多个补挂会被取消**，必须等上一个 run 结束后再发下一个。
>
> 另外 **0.7.0 从未单独发版**——没有 `v0.7.0` tag，npm 与 Release 都跳到 0.8.0，其改动包含在 0.8.0 里（见 `CHANGELOG.md` 的 0.7.0 节）。
>
> 发版顺序（0.9.0 实测走通）：`git tag -a vX.Y.Z` → push tag → `POST /repos/elegant01/dsh-memory-watchdog/releases`（`tag_name` 必须是已推送的 tag；**PowerShell 建 body 时要用 `UTF8.GetBytes()`，否则中文乱码**）→ Release 事件触发 `Publish Package`，三路一起跑完。npm 有几分钟的 processing 延迟，job 成功后立刻查 registry 可能还是旧数据，别误判。

## 门禁

```sh
npm test          # node:test，305 项
npm run preflight # 包内容 + 安全规则（672 checks：禁 WMI/CIM、禁宽泛 taskkill、PowerShell 必须 ASCII、开关必须默认关闭等）
npm pack          # 产出不需要消费者构建的 tarball
```

## 插件内存模块

- `lib/heap-sampler.js`：`packageFromUrl`（URL → `node_modules/<包名>`，覆盖 npm / `@scope` / `app.asar/dsh` / `.dsh-src`）、`siteFile`（帧 URL → 短文件路径，剥 `node_modules/<包>` 前缀，`node:` 返回 null）、`aggregateProfile`（无 JS 帧的节点向上继承最近的 JS 帧，native 不摊给任何插件；每个包另有 `top` 分配点，按 `url:line:functionName` 去重累加后取前 5）、`sampleHeap`（`HeapProfiler.startSampling` + 窗口，`stopSampling` 之前强制 `collectGarbage`，返回 `gcApplied/gcMs/gcReclaimedBytes` 与窗口前后的 `process.cpuUsage()` 差值 `cpu{userMs,systemMs,totalMs,pct}`）、`takeHeapSnapshot`。
- `lib/plugin-inventory.js`：`scriptPath`（帧 URL → 小写路径）、`ownDirectory()`（从 `import.meta.url` 反推自己装在哪，源码树下为 null）、`profileDirectoryOf`、`scanInstalledPlugins`（扫 profile 的 `node_modules`，只收 `package.json` 带 `dsh` 字段的包，含 `@scope/`）、`loadPluginInventory`。表格的行来自这份清单，所以没采样也能看到装了什么。
- `lib/plugin-radar.js`：包装 `setInterval`/`clearInterval` 与 `EventEmitter` 的注册/注销方法，`attributeStack` 按已安装插件目录做最长前缀匹配，跳过本插件自己的帧、`node:` 内置与框架/本地脚本帧，只把直接调用者记到插件名下；`snapshot()` 带 `owners` 与 `debug{attributed,unattributed,byUrl,samples}`；`uninstall()` 原样还原全局函数。
- `lib/plugin-memory.js`：`normalizePluginConfig`（clamp）、`growthSlope`（最小二乘，单位字节/小时）、`assessPlugins`（风险分级）、`summarizeSamplingCost`（CPU/commit 增长 → `intrusive` 与 `reasons`）、`recentSnapshots(limit)`（按 mtime 取最近的 `.heapsnapshot`）与 `PluginMemory`（调度、账本 `plugin-memory.json`、窗口上限 48、快照保留 2 份、`sampling.lastCost`）。
- `lib/snapshot-diff.js`：`diffHeapSnapshots(olderPath, newerPath, {timeoutMs,maxBytes,top})`。用 1 MiB 分块的 `ByteReader` 流式解析，只读 `snapshot.meta` + `nodes`（name/self_size/type）与 `strings`，跳过 `edges`；先聚合旧文件再解析新文件，峰值只留一份节点数组。按构造器名汇总 `self_size`，过滤 hidden/synthetic 与 `(` 开头的内部名，按差值绝对值取前 10，返回 `top[]`、总字节/节点差与耗时。错误码 `snapshot-missing` / `snapshot-too-large` / `snapshot-format` / `snapshot-timeout` / `snapshot-unreadable`；`GuardRuntime.diffSnapshots()` 串行化（`snapshotDiffBusy`）并映射为 `.snapshot-diff` POST。
- 对应测试：`test/heap-sampler.test.js`、`test/plugin-inventory.test.js`、`test/plugin-radar.test.js`、`test/plugin-memory.test.js`、`test/crash-history.test.js`、`test/snapshot-diff.test.js`。
- 采样默认开（`pluginSampling` 缺省为 true），启动约 45 秒后跑一次基线窗口；窗口历史上限 48。
- 崩溃模块来自 `lib/resources/crash-history.ps1` 的 `faults`（Application 日志 1000/1001/1002），由 `lib/crash-history.js` 的 `FAULT_CODES`/`readFaults`/`moduleName` 解析成 `crash.application-fault` 或 `crash.application-hang`，并带 `module`/`exception` 字段。

## 黑匣子与运行时信号模块

- `lib/blackbox.js`：`createBlackbox({ dir, now, intervalMs, points })` → `{ path, load, push, flush, dispose, status }`。`push` 按 `BLACKBOX_MIN_GAP_MS`（4 秒）节流并 `writeJsonAtomic` 写 `blackbox.json`；`load()` 读到 **同 pid** 的文件返回 null（插件热重载不算崩溃），异 pid 则作为 `previous = { pid, startAt, endAt, samples }`；文件损坏时 `load()` 返回 null 并把错误放进 `status().error`。运行时由 `GuardRuntime.recordBlackbox(sample, at)` 从采集样本喂入（带 `pct`/`rss`/`heapUsed`/`heapTotal`/`external`/`arrayBuffers`/`state`），`startSignals()` 在建完 `tickTimer` 后 `await load()`。
- `lib/heap-watch.js`：`createHeapWatch` 维护最近样本与 60 秒一个的外部内存标记，`status()` 给出 `nearLimit`（连续 3 样本 ≥90%，<85% 复位）、`ratioPct` 与 `externalRateMbPerHour`（跨度 ≥30 分钟才算）；`classifyCrashTrail(trail)` 按末点分 `oom-heap` / `oom-external` / `oom-system`。`GuardRuntime.status()` 用它生成 `heap` 与 `crashes.items[].oom`。
- `lib/crash-history.js` 的 `attachCrashTrail(items, previous, {windowMs, points})`：把异 pid 黑匣子尾部挂到 2 分钟内最近的崩溃条目，返回克隆数组；纯时间对齐，不改输入对象。
- `lib/signals.js`：`createSignals({ now, intervalMs, points })` → `{ install, uninstall, snapshot, sample, installed }`（注意 `installed` 是函数）。监听 `process.on('warning')` 与 `process.on('uncaughtExceptionMonitor')`，**刻意不监听 `unhandledRejection`**（加监听器会改变 Node 的致命默认行为）；句柄用 `process.getActiveResourcesInfo()` 每 5 秒记一次（`timer.unref()`），事件循环用 `monitorEventLoopDelay({ resolution: 20 })` 每 5 秒读一次直方图再 `reset()`。
- 热重载 A/B 在 `lib/plugin-memory.js` 的 `watchReloads()`：雷达句柄数 >0→0 记 open（`beforeBytes` 取账本 lastBytes），回到 >0 时写入 `{ at, resolvedAt, key, name, beforeBytes, afterBytes, retainedBytes, gapMs }`，上限 `PLUGIN_RELOAD_ITEMS`（10）；由 `sampleNow()` 与 `GuardRuntime.tick()`（每 5 秒）调用，`status()` 输出 `reloads` / `openReloads`。
- 对应测试：`test/blackbox.test.js`、`test/signals.test.js`，以及 `test/plugin-memory.test.js` 里的 `watchReloads` 用例。

## 健康评分、建议清单、渲染进程堆与崩溃转储

- `lib/health.js`：纯函数，无 IO。`HEALTH_WEIGHTS = { pressure: 30, growth: 20, crashes: 15, plugins: 15, loop: 10, renderer: 10 }`（合计 100）；`computeHealth({ status, renderer, thresholds })` → `{ score, grade, penalties, components, weights }`。六个组件各返回 `{ available, value, penalty, detail, weight }`，`gradeOf(score)` 给出 good ≥90 / fair ≥75 / poor ≥50 / bad。**硬规则：`available: false` 的组件 penalty 必须为 0**——缺数据当成满分或零分都是在撒谎，preflight 的 `health:missing-is-not-a-penalty` 会盯着这条。增长项要 ≥2 个 `n > 0` 的小时桶且跨度 ≥30 分钟才给斜率，否则不给结论。
- `lib/advice.js`：纯函数。`buildAdvice({ status, renderer })` 合并十一路来源（分页文件、压力、重启门限、插件高占用、堆接近上限、外部内存增长、崩溃次数、事件循环延迟、进程警告、进程驻留增长、渲染进程堆）→ 按 `key` 去重 → 按 severity（critical/warn/info/ok）排序 → 截断到 `ADVICE_MAX_ITEMS`（8），返回 `{ items, total, truncated, actionCount }`。每条形如 `{ key, code, severity, kind, source, why, how, value, text }`；`kind` 只取 `advice`（只读建议）或 `action`（可执行动作）。`text` 是 `adviceTexts.<text>` 的翻译 key，默认等于 `key`，但插件条目 key 是动态的（`plugin-<name>`）而句子是共享的，所以必须能独立命名。**分页文件建议现在只由这里渲染**——client 里 `systemTitle` 区那段旧渲染已删除，否则同一句会出现两次。
- `lib/renderer-heap.js`：`createRendererHeap({ now })` → `{ report, status, reset }`。Host 读不到 renderer 的堆，所以由 client 读 `performance.memory` 后经 `POST /api/memory-watchdog.renderer` 上报。`report()` 节流 `RENDERER_REPORT_MIN_INTERVAL_MS`（30 秒）、拒收 >`RENDERER_SANITY_MAX_BYTES`（64 GiB）与非法值、把数组也算 `invalid-body`；`{ available: false }` 记为「不支持」（`reason: 'unsupported'`），并在 `status()` 里让 `available` 永久为 false、`stale` 永久为 false——浏览器没有这个 API 是持久状态，不该随时间变成「过期」。超过 `RENDERER_STALE_MS`（120 秒）无新读数则 `available: false` 但**保留最后数值**，绝不跳成 0。
- `lib/crashpad.js`：`resolveCrashpadDir(env)` 试四个候选（`%LOCALAPPDATA%`/`%APPDATA%` × `@deepseek-ai\dsh-desktop\Crashpad\reports`、`Crashpad`）；`parseMinidump(path)` 只读 32 字节头（`MDMP` 魔数 `0x504d444d`）、流目录、`ModuleListStream(4)`、`ExceptionStream(6)`、`MemoryInfoListStream(16)`，**不读完整内存流**。上限 `CRASHPAD_MAX_FILE_BYTES`（512 MiB，只看 stat 大小）、`CRASHPAD_MAX_MODULES`（500）、`CRASHPAD_MAX_MEMORY_ENTRIES`（200000）；模块名用单次 64 KiB 窗口读。`inspectCrashpad({ env, limit })` 一次最多 `CRASHPAD_STATUS_FILES`（5）份，串行、坏一份不影响其余。**绝不写、改、删任何文件**，preflight 的 `crashpad:read-only` 会扫 `writeFile|unlink|rm(`。
- 接入点：`GuardRuntime.status()` 里 `health`/`advice` **必须从同一个 snapshot 派生**（先构造 snapshot 再算，否则分数与卡片上的数值互相矛盾），另有 `renderer` 与 `minidumps` 两个字段；`lib/routes.js` 因此从 10 条变成 12 条路由；`lib/bundle.js` 的 `statusSummary()` 白名单加了 `health`/`advice`/`renderer`（分数单存无用，必须带组件与扣分明细）。
- `lib/attribution.js` 的 `sampleAttribution` 参数已扩到六项：`-HostPid <n> -MainPid <n> -TopN <n> -GroupTopN <n> -MemberLimit <n>`，`top.ps1` 按程序名返回 `groups`（每个程序带 count/bytes/members），client 用 `ShareRow` 渲染可展开的分组行。
- 对应测试：`test/health.test.js`、`test/advice.test.js`、`test/renderer-heap.test.js`、`test/crashpad.test.js`（后者在测试里自建真实 minidump 二进制，不依赖本机有没有 dump）。

## 本机验证过的取数口径

- 归因/分页/崩溃三个探针脚本可直接手动跑，确认字段与耗时：

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File lib/resources/top.ps1 -HostPid <dsh-main-pid> -TopN 10
powershell -NoProfile -ExecutionPolicy Bypass -File lib/resources/system-info.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File lib/resources/crash-history.ps1 -Days 7 -Limit 20
```

- helper 若报 `helper is inside a job that keeps its child processes`：DSH 是从带 Windows 作业对象的父进程（终端、agent）里启动的，而且 `escape.ps1` 实测新建进程仍留在作业对象内，自动重启会一直 fail closed。只有当这个作业是启动器带进来的（从终端 / agent 拉起 DSH）时，改从任务栏/资源管理器启动才能恢复；DSH 自己给进程树建作业时就换启动方式无效（本机 0.2.1 实测：从一个 `inJob=False` 的 shell 里拉起 DSH，主进程仍然 `inJob=True`、`escape=silent-breakaway`）。能力自检通过但 `capability.json` 里 `escape` 为 `silent-breakaway` / `breakaway` 时，说明是靠脱离作业对象才可用，重启会走 `relaunch.ps1`（带 `CREATE_BREAKAWAY_FROM_JOB`）。
- 判定「作业允许不允许脱离」只能看子进程落点，不能看错误码：本机（Win10 19045）实测作业没开 `JOB_OBJECT_LIMIT_BREAKAWAY_OK` 时，带 `CREATE_BREAKAWAY_FROM_JOB` 的 CreateProcess **不会**报 `ERROR_ACCESS_DENIED`，而是照旧成功、孩子仍留在作业里。另外 `CreateProcessW` 的 `lpCurrentDirectory` 传 NULL 在本机会直接 `ERROR_INVALID_NAME(123)`，两个探针脚本都必须显式给工作目录。自测办法：`CreateJobObjectW` + `SetInformationJobObject`（LimitFlags 依次给 `0x2000` / `0x2800` / `0x3000`）+ `CREATE_SUSPENDED` + `AssignProcessToJobObject`，再把 helper 以 `--capability` 跑进这个作业，能一次复现「失败关闭 / breakaway / silent-breakaway」三种结论。
