# CHANGELOG

本文件记录 `dsh-memory-watchdog` 的可见变化。版本号跟着 `package.json` 走。

## Unreleased

- 修复：开机时提交内存已经在预警/危险区间，胶囊会永远停在「未知」——旧规则只允许 `unknown` 在「连续 3 个样本 `<75%`」时离开，热区间既进不了 warning 也进不了 critical，于是既不告警、又因为「unknown 永不自动重启」在最需要的时候失效。现在 `unknown` 按区间离开：连续 3 个样本 `<75%` 回 normal，`>=80%`/余量不足进 warning，`>=90%` 且余量不足或 `>=95%` 进 critical；「单个有效样本不清空 unknown」这条原意保留不变。

- 新增：摘要浮层与设置页卡片的「刷新」现在有加载态——按钮变「刷新中…」并禁用、整块内容降到 60% 不透明度、根节点带 `aria-busy`；本机到本地端口的请求只要几毫秒，所以反馈最短会保留 600ms，免得一闪看不见。
- 新增：浮层进出场动画。进场从 `opacity 0 / translateY(8px)` 过渡到可见，退场先淡出再卸载（170ms），进出对称。

## 0.3.0

- 变更：样本过期判定 `STALE_AFTER_MS` 从 15 秒放宽到 30 秒（采样间隔 5 秒，即连着 6 个样本没送到才算过期）。之前 Host 忙 15～45 秒就会 unknown↔normal 来回翻，右下角成对弹「内存采样不可用」+「已恢复正常」。
- 新增：因样本延迟（`stale-sample`）进入 unknown 时，toast 延迟 2 分钟（`STALE_NOTICE_DELAY_MS`）才弹；期间恢复则两条提示都不弹，只在事件流留记录并累加 `collector.staleBlips` 计数，摘要浮层与诊断文本显示「采样延迟 N 次（最大滞后 X）」（`collector.maxDeliveryLagMs` 记录观测到的最大送达滞后，用来区分采集器停了还是 Host 没读）。非延迟原因（采集器报错、样本非法、真死）仍立即提示。
- 变更：重启门限对样本新鲜度的要求随 `STALE_AFTER_MS` 一起变成 30 秒——判定用的样本最多可以比原来旧 15 秒。
- 新增：右下角状态胶囊可点击，就地展开摘要浮层——压力百分比与已提交/上限、当前状态与下一步动作、自动重启能力（含脱离方式与作业对象提示）、活动检测、自动重启开关、最近事件与错误、DSH 进程树占比、重启门限结论、占用最高的三个进程，底部带「刷新」与「收起」。再点胶囊、Esc 或点浮层外部都收起；浮层与设置页卡片读同一份轮询状态，不额外起采集。
- 变更：胶囊不再是点击穿透层（原来 `pointerEvents: none`），它现在能接收点击与键盘（Enter / 空格展开，`aria-expanded` 标注）；DSH 取不到状态时胶囊退回只读、不可点击。
- 新增：能力自检不再因为「helper 位于 Windows 作业对象（Job Object）内」就一律关闭自动重启。helper 改用 `escape.ps1` 实测「新建进程能否脱离作业对象」：先不带标记、再带 `CREATE_BREAKAWAY_FROM_JOB` 各启动一个立刻自行退出的空转子进程，用 `IsProcessInJob` 看它落在哪个作业里——Windows 10 上作业不允许脱离时 CreateProcess 并不报错（不会给 `ERROR_ACCESS_DENIED`），子进程只是仍留在作业内，所以判定只看落点、不看错误码。子进程天然脱离判为 `silent-breakaway`，带标记才脱离判为 `breakaway`，两种情况自动重启照常可用并在面板标注脱离方式；仍留在作业内才失败关闭，`capability.json` 附 `jobProbe` 记下两次探测的落点与错误码。探测只新建空转子进程，不结束任何进程。
- 新增：脱离方式为 `breakaway` 时，重启改由 `relaunch.ps1` 以 `CREATE_BREAKAWAY_FROM_JOB` 启动 DSH Desktop，命令行按原 argv 逐参数转义，环境变量块沿用当前环境并剔除 `ELECTRON_RUN_AS_NODE`，工作目录取原进程的工作目录；`silent-breakaway` 继续走原来的 spawn 路径。
- 变更：`capability.json` 与面板的能力状态多带一个 `escape` 字段（`none` / `silent-breakaway` / `breakaway`），作业对象相关的提示文案改为说明真实阻塞点。

## 0.2.1

- 变更：无功能改动。本版只用来验证 npm Trusted Publisher（GitHub Actions OIDC）的免密发布链路——`release.yml` 直接 `npm publish --provenance`，不再需要 token、也不再需要验证码。

## 0.2.0

- 新增：提交内存归因（DSH 进程树占比 + 占用最高的进程，带可执行文件路径与进程存活时长），每 30 秒一轮。
- 新增：重启门限 `restartGatePct`（默认 20%）。DSH 不是主要占用者、或归因数据缺失/过期时**不重启**（fail closed）。
- 新增：可配阈值 `warningPct`、`criticalPct`、`criticalAvailMb`、`confirmSamples`、`cooldownMinutes`，全部即时生效并带范围夹取。
- 新增：增长盯梢 `residentGrowMb`（默认 512 MiB / 5 分钟窗口）。哪个进程在持续爬升会被点名，同一进程 30 分钟内只提醒一次；只报警，不结束任何第三方进程。
- 新增：分页文件与提交上限的只读建议（没有分页文件、提交余量过小、分页文件全在系统盘、系统自动管理）。不修改任何系统设置。
- 新增：最近 7 天崩溃与内存事件时间线（DSH `crash-*.log` + 系统日志 2004 / 26 / 41），同一事故的多份日志自动合并。
- 新增：事件历史保留 50 条、面板导出 JSON、一键复制脱敏诊断文本（不含日志正文与完整会话 id）。
- 新增：能力自检失败时给出可读原因与处置办法（例如 helper 继承了 Windows 作业对象时，改从任务栏/资源管理器启动 DSH）。
- 新增：崩溃后自动续接（**默认关闭**）。只续 `interrupted` 的 turn，`aborted` 永不续；12 小时窗口、20 秒静置、每会话每小时最多 2 次、requestId 幂等、子代理中断只唤醒父会话一次。
- 变更：包名与插件 id 从 `dsh-memory-guard` 改为 `dsh-memory-watchdog`（npm 上 `dsh-memory-guard` 属于另一位作者的同名不同功能插件，且导出同名插件 id，会互相冲突）。状态目录随之变为 `~/.dsh/memory-watchdog/`。
- 变更：开发流程对齐 `dsh-codearts`：`npm run deploy` 原地覆盖部署进 profile，`npm run hmr:on` 打开宿主模块热重载，改代码不必重启 DSH。

## 0.1.0

- 首个版本：Windows 提交内存采样、预警/危险状态机（迟滞 + 连续样本确认）、两阶段交接的可选自动重启、活动检测（agent 队列与 job 状态）、冷却与事件落盘、设置页卡片与右下角状态胶囊。
