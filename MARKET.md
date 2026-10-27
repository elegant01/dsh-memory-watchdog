# DSH Memory Guard — Market 说明

## 一句话

Windows 提交内存看门狗：持续监控、给出**谁在吃内存**的归因、分页文件只读建议与 7 天崩溃时间线；**自动重启默认关闭**、**崩溃后自动续接默认关闭**。

## 基本信息

| 项 | 内容 |
| --- | --- |
| 插件名 | `dsh-memory-watchdog` |
| 显示名 | DSH Memory Guard / DSH 内存守护 |
| 支持平台 | Windows x64 |
| DSH 版本 | `>=0.2.0-rc.1 <0.3` |
| 默认状态 | 监控 / 归因 / 时间线开启；自动重启与崩溃续接**关闭** |
| 网络 | 无网络请求、无遥测 |
| 安装依赖 | 无服务、无计划任务、无原生 addon、无安装脚本 |

## 功能

- 每 5 秒采样 Windows commit charge、commit limit、物理内存与可用量，本机单次约 7 ms。
- 连续样本确认（默认 3 个）+ 迟滞；显示已提交、上限、百分比、可用 commit、物理内存、Host RSS、冷却与最近重启记录。
- **阈值可配**：预警 / 危险百分比、危险可用量、确认样本数、冷却分钟、重启门限占比，全部即时生效并带范围夹取。
- **提交内存归因**：每 30 秒统计 DSH 进程树占系统提交的比例与 Top 5 进程（进程名 + PID + commit），只读，不使用 WMI/CIM。
- **重启门限（默认 20%）**：DSH 不是主要占用者、或归因数据缺失/过期时**不重启**（fail closed），避免白重启一次。
- **分页文件只读建议**：检测没有分页文件、提交上限只比物理内存多不到 2 GiB、分页文件全在系统盘等情形；插件**不改任何系统设置**。
- **崩溃时间线**：最近 7 天的 DSH `crash-*.log`（renderer OOM / host 退出 / 启动失败）与 Windows 系统日志 2004 / 26 / 41 事件合并展示；同一事故的多份日志自动合并。
- **事件历史与导出**：保留最近 50 条事件，面板可见、一键导出 JSON、一键复制脱敏诊断文本（不含日志正文与完整会话 id）。
- 页面内 toast 与右下角状态胶囊提示预警、危险、恢复、错误与设置变更；点击胶囊就地展开摘要浮层（压力、动作、能力自检、活动检测、DSH 占比与门限结论、占用最高的进程），Esc 或点外部收起；DSH 未提供系统通知 API，因此**不提供系统级通知**。
- 开启自动重启后：危险压力下等待任务空闲，连续 3 次空闲检查 + 1.5 秒宽限期；忙碌时最多每 5 分钟提醒一次。
- 冷却可配（默认 30 分钟），持久化；每个 critical episode 最多尝试一次；失败不自动重试。
- **崩溃后自动续接（默认关闭）**：只续 `interrupted` 的 turn，`aborted`（你手动停止）永不续；12 小时窗口、20 秒静置、每会话每小时最多 2 次；requestId 可推导所以重复扫描不会二次注入；子代理被打断时只唤醒父会话一次。
- 采集输出有界解析；畸形数据、进程退出与 stderr 可见；异常重启使用有上限退避。
- 重启使用两阶段交接；未收到 `go`、Host 提前退出或用户取消时，helper 不结束任何进程。
- 旧实例未退出或端口未释放时**不拉起**新实例；新实例未在限定时间内监听原端口时本次重启记为失败，不会误报成功。

## 开启自动重启的明示代价

- 重启对象是**整个 DSH Desktop**（Electron 主进程及其全部子进程），不是只刷新界面。
- **可能丢失未发送的草稿**。
- 交接**绕过 Electron 壳的原生退出确认框**；profile/会话数据仍由 Host 的优雅 shutdown 落盘。
- 若提交内存压力来自其他软件，**重启可能无效**（重启门限即为应对此情形）。
- 冷却期内最多一次；重启过程可能持续数十秒，期间 DSH Desktop 不可用。
- 开启崩溃续接后，插件会**代你向会话注入消息**并让 agent 继续执行，续接的 turn 拥有该会话原有工具与权限。
- 不承诺防止 OOM、闪退或数据丢失。

## 权限行为

- 以隐藏窗口运行固定系统路径的 Windows PowerShell 采集只读信息；仅在单次进程内使用 `-ExecutionPolicy Bypass`，**不永久修改**执行策略。
- 四个 PowerShell 资源全部只读（性能计数 / 进程 commit 归因 / 分页文件与提交上限 / 崩溃日志 + `Get-WinEvent`），不使用 WMI、CIM 或 `wmic`。
- 读取目标进程可执行文件路径、创建时间、命令行并校验 Host/Electron 主进程父子关系。
- 仅在交接时处理已校验身份的 Electron 主进程、Host 及事先记录的相同 executable 子进程；不使用宽泛 `taskkill /IM`，不按内存占用结束无关软件。
- 崩溃续接只调用 DSH `sessionController` 的 `list` / `inspect` / `prompt`（`mode: 'queue'`），不使用任何进程创建 API。
- 通过 DSH 带认证的 `connection.fetch` 暴露状态 / 事件 / 取消 / 立即扫描接口；响应禁止缓存；客户端不能传入 PID、路径、命令行、脚本路径或 helper 参数，也不能改配置。
- 数据仅写入 `$DSH_HOME/memory-watchdog/`（默认 `~/.dsh/memory-watchdog/`），不发起网络请求。

## 资源开销

- 常驻采集 PowerShell：工作集约 62–70 MB，commit 约 49 MB。
- 归因一轮约 1.9 s（每 30 秒）、分页信息约 1.8 s（每 5 分钟）、崩溃时间线约 1.6 s（每 10 分钟）；都是短命进程，用完即退。
- helper 只在真正交接时启动，不常驻。

## 已知边界

- Host 完全卡死或 OOM 时插件无法继续工作。
- renderer 先死亡时页面通知不可用，依赖下次加载时展示本地事件、时间线与重启记录。
- 归因只能打开当前用户有权限的进程（本机约 320 个中 197 个可读），DSH 占比是下界估计。
- 续接无法知道中断前那个 turn 已经做完多少，因此注入文本强制要求先核对状态；这降低风险但不是零风险。
- 活动检测降低误重启概率，但不消除所有并发时序竞争。
- 真实重启、不同启动方式与长期稳定性需按发布检查清单单独验证。

## 卸载

卸载会清理定时器、取消待执行动作并停止采集进程；`$DSH_HOME/memory-watchdog/` 下的历史记录需手动删除。**交接已开始时不要卸载**，detached helper 可能仍会完成本次重启。

## 许可证

MIT。

---

## English listing summary

Windows commit-memory watchdog for DSH Desktop. Monitoring, commit attribution, pagefile advice, the crash timeline and in-page warnings are always on; **automatic restart and resume-after-crash are both off by default**. Thresholds (warning/critical percentages, available commit, confirmation samples, cooldown, restart gate) are configurable and apply immediately. Attribution shows how much of the commit charge the DSH process tree holds plus the top consumers, and the restart gate (20% by default) blocks a restart when DSH is not the main committer or attribution data is missing — fail closed. Read-only pagefile advice never changes system settings. The 7-day timeline merges DSH `crash-*.log` entries with Windows virtual-memory events. When restart is enabled by the user, it restarts the entire DSH Desktop only after critical commit pressure is confirmed by consecutive samples, the gate passes and the desktop is confirmed idle; restarting can discard unsent drafts and bypasses the Electron shell's native quit confirmation, while profile/session data is still flushed by the Host's graceful shutdown. When resume is enabled, only turns marked interrupted (never ones you canceled) get one injected "verify the state, then continue" message, rate-limited and idempotent, and a resumed turn keeps that session's tools and permissions. No network access or telemetry. Windows x64, DSH `>=0.2.0-rc.1 <0.3`. MIT.
