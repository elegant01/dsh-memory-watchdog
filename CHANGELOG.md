# CHANGELOG

本文件记录 `dsh-memory-watchdog` 的可见变化。版本号跟着 `package.json` 走。

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
