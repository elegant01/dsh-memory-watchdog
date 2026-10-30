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

## 门禁

```sh
npm test          # node:test，189 项
npm run preflight # 包内容 + 安全规则（禁 WMI/CIM、禁宽泛 taskkill、PowerShell 必须 ASCII、开关必须默认关闭等）
npm pack          # 产出不需要消费者构建的 tarball
```

## 插件内存模块

- `lib/heap-sampler.js`：`packageFromUrl`（URL → `node_modules/<包名>`，覆盖 npm / `@scope` / `app.asar/dsh` / `.dsh-src`）、`siteFile`（帧 URL → 短文件路径，剥 `node_modules/<包>` 前缀，`node:` 返回 null）、`aggregateProfile`（无 JS 帧的节点向上继承最近的 JS 帧，native 不摊给任何插件；每个包另有 `top` 分配点，按 `url:line:functionName` 去重累加后取前 5）、`sampleHeap`（`HeapProfiler.startSampling` + 窗口，`stopSampling` 之前强制 `collectGarbage`，返回 `gcApplied/gcMs/gcReclaimedBytes`）、`takeHeapSnapshot`。
- `lib/plugin-inventory.js`：`scriptPath`（帧 URL → 小写路径）、`ownDirectory()`（从 `import.meta.url` 反推自己装在哪，源码树下为 null）、`profileDirectoryOf`、`scanInstalledPlugins`（扫 profile 的 `node_modules`，只收 `package.json` 带 `dsh` 字段的包，含 `@scope/`）、`loadPluginInventory`。表格的行来自这份清单，所以没采样也能看到装了什么。
- `lib/plugin-radar.js`：包装 `setInterval`/`clearInterval` 与 `EventEmitter` 的注册/注销方法，`attributeStack` 按已安装插件目录做最长前缀匹配，跳过本插件自己的帧、`node:` 内置与框架/本地脚本帧，只把直接调用者记到插件名下；`snapshot()` 带 `owners` 与 `debug{attributed,unattributed,byUrl,samples}`；`uninstall()` 原样还原全局函数。
- `lib/plugin-memory.js`：`normalizePluginConfig`（clamp）、`growthSlope`（最小二乘，单位字节/小时）、`assessPlugins`（风险分级）与 `PluginMemory`（调度、账本 `plugin-memory.json`、窗口上限 48、快照保留 2 份）。
- 对应测试：`test/heap-sampler.test.js`、`test/plugin-inventory.test.js`、`test/plugin-radar.test.js`、`test/plugin-memory.test.js`、`test/crash-history.test.js`。
- 采样默认开（`pluginSampling` 缺省为 true），启动约 45 秒后跑一次基线窗口；窗口历史上限 24。
- 崩溃模块来自 `lib/resources/crash-history.ps1` 的 `faults`（Application 日志 1000/1001/1002），由 `lib/crash-history.js` 的 `FAULT_CODES`/`readFaults`/`moduleName` 解析成 `crash.application-fault` 或 `crash.application-hang`，并带 `module`/`exception` 字段。

## 本机验证过的取数口径

- 归因/分页/崩溃三个探针脚本可直接手动跑，确认字段与耗时：

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File lib/resources/top.ps1 -HostPid <dsh-main-pid> -TopN 10
powershell -NoProfile -ExecutionPolicy Bypass -File lib/resources/system-info.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File lib/resources/crash-history.ps1 -Days 7 -Limit 20
```

- helper 若报 `helper is inside a job that keeps its child processes`：DSH 是从带 Windows 作业对象的父进程（终端、agent）里启动的，而且 `escape.ps1` 实测新建进程仍留在作业对象内，自动重启会一直 fail closed。只有当这个作业是启动器带进来的（从终端 / agent 拉起 DSH）时，改从任务栏/资源管理器启动才能恢复；DSH 自己给进程树建作业时就换启动方式无效（本机 0.2.1 实测：从一个 `inJob=False` 的 shell 里拉起 DSH，主进程仍然 `inJob=True`、`escape=silent-breakaway`）。能力自检通过但 `capability.json` 里 `escape` 为 `silent-breakaway` / `breakaway` 时，说明是靠脱离作业对象才可用，重启会走 `relaunch.ps1`（带 `CREATE_BREAKAWAY_FROM_JOB`）。
- 判定「作业允许不允许脱离」只能看子进程落点，不能看错误码：本机（Win10 19045）实测作业没开 `JOB_OBJECT_LIMIT_BREAKAWAY_OK` 时，带 `CREATE_BREAKAWAY_FROM_JOB` 的 CreateProcess **不会**报 `ERROR_ACCESS_DENIED`，而是照旧成功、孩子仍留在作业里。另外 `CreateProcessW` 的 `lpCurrentDirectory` 传 NULL 在本机会直接 `ERROR_INVALID_NAME(123)`，两个探针脚本都必须显式给工作目录。自测办法：`CreateJobObjectW` + `SetInformationJobObject`（LimitFlags 依次给 `0x2000` / `0x2800` / `0x3000`）+ `CREATE_SUSPENDED` + `AssignProcessToJobObject`，再把 helper 以 `--capability` 跑进这个作业，能一次复现「失败关闭 / breakaway / silent-breakaway」三种结论。
