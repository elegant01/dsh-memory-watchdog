# 安装

## 从 DSH Market 安装

在 DSH Desktop 的插件市场里搜 `dsh-memory-watchdog`（显示名 DSH Memory Guard），安装后重启一次 DSH 即可。装完 **自动重启** 和 **崩溃后自动续接** 都是关闭状态，只有监控、归因、分页文件建议、崩溃时间线与插件内存雷达会运行（周期采样默认也关）。

## 从 npm 安装

```sh
dsh plugin add dsh-memory-watchdog
```

DSH 的 profile 会把插件钉在当时的精确版本上，发新版不会自动升级；要升级就再执行一次上面那条命令并指定版本，例如 `dsh plugin add dsh-memory-watchdog@0.2.1`。

## 从本地源码安装（开发用）

见 [DEV.md](./DEV.md)：`npm run deploy` 会把当前工作树原地同步进 `~/.dsh/profiles/desktop/node_modules/dsh-memory-watchdog`，并写好 profile 的 `dependencies` / `dsh.profile.bundles` / `.modules.yaml`。

## 升级与卸载

- 升级：换版本后重启 DSH；旧版本的状态文件保留在 `~/.dsh/memory-watchdog/`，不会自动清理。
- 卸载：插件会清掉自己的定时器、取消待执行的重启动作、停止采集子进程。`~/.dsh/memory-watchdog/` 下的历史记录要手动删。
- **不要在重启交接已经开始时卸载**：helper 已独立运行，可能仍会完成本次重启。
- 从 0.1.x 的 `dsh-memory-guard` 迁移：先卸载旧包再装新包，否则两个看门狗会同时常驻（两份采集进程、两枚状态胶囊）。旧目录 `~/.dsh/memory-guard/` 可以自行删除。
