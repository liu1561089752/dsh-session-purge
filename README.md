# Session Purge — 彻底删除工作区

给 DSH Web GUI 加一个**独立的**删除入口：确认后把一个工作区连同它的**会话记录、投影缓存、工作区注册、相关附件、以及项目文件夹本身**一起**永久删除**。

官方列表里的「删除工作区」保持原样（只移除列表项、保留全部会话记录）；本插件不碰它。

---

## 为什么需要它

DSH 的设计是"只增不减"：`dsh-session-persistence-jsonl` 的 README 明确写着 *"Nothing deletes session files … the seam has no deletion API"*，官方 `workspace.delete` 也只删注册记录、保留目录与会话。想真正清干净，只能由插件绕过这条缝自己做。

## 安装

```powershell
git clone https://github.com/liu1561089752/dsh-session-purge.git
dsh plugin --profile web add "link:<刚 clone 的目录绝对路径>"
```

例如 `dsh plugin --profile web add "link:D:\code\dsh-session-purge"`。

安装会通过 pnpm 建立链接，并把包名自动加进 profile 的 `dsh.profile.bundles`（`reconcile`）。**然后重启 `dsh web`**：宿主侧改动与新 bundle 的客户端产物都要重新加载。

卸载：`dsh plugin --profile web remove @local/dsh-session-purge`，再从 profile 的 bundles 列表里去掉该名字。

> 包名里的 `@local` 是 DSH bundle 标识的一部分（表示"本机自有 bundle"），不是 npm 上的组织名。

## 使用

1. 侧栏底部出现一个**新增的**按钮「彻底删除工作区」（窄侧栏时只显示图标）。
2. 打开对话框 → 选一个工作区（显示会话数、占用体积、已归档数、正在运行数）。
3. 预检：列出将删除的会话数/字节、投影缓存数、项目文件夹的文件数与体积、顶层条目，以及**安全护栏的判定结果**。
4. 勾选是否回收附件；如果要求手输确认，就**逐字敲出文件夹名**解锁红色按钮。
5. 点「永久删除」。**没有回收站，DSH 也撤销不了。**

## 删除范围

| # | 对象 | 说明 |
|---|---|---|
| 1 | 该工作区的全部会话目录 | 含历史世代；`rm -rf` |
| 2 | 每个会话的投影缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` |
| 3 | 工作区注册记录 | `workspaceRegistry.delete(id)` |
| 4 | 归档墓碑 | **本次保留**，由启动自愈清理（当场清掉会让内存里的 live 条目变成点不开的幽灵行） |
| 5 | 空的 `--<projectKey>--` 目录 | 删空 |
| 6 | 附件 | 全局 mark-and-sweep，**默认勾选**；只删"没有任何剩余会话引用"的对象 |
| 7 | **项目文件夹** | `workspace.path`，递归删除 |

会话的归属是**按 cwd 归组**（`sessionPersistence.list()` 的 `header.cwd` 与工作区路径相等）并与注册表的 `sessionIds` 取并集——因为注册表的 getter 会**静默过滤**掉 cwd 解析失败的会话，只用它当唯一来源会漏删。

## 安全护栏（任一命中即拒绝）

1. 路径为空/非绝对
2. `realpath ≠ 记录路径`（符号链接或 junction）
3. 路径层级过浅（`F:\` 这类；`minFolderDepth` 默认 2）
4. UNC 网络共享（`allowRemoteVolume` 默认关）
5. 目标包含受保护位置：用户主目录、`DSH_HOME`、profile 目录、会话存储根、进程 cwd、系统目录、临时目录
6. **目标等于或包含当前对话的 cwd** → 强制拒绝（提示先切换会话）
7. 目标里**嵌套着其它已注册工作区**（如 `F:\monorepo` 套着 `F:\monorepo\pkg-a`）
8. 目标里**有子目录被其它会话当作 cwd**

另外：无 `sessionId` 且目录里有活跃会话时，必须先显式确认（`live-sessions-unacknowledged`）；项目文件夹删除前默认要求**手输文件夹名**。

## 附件为什么只能全库扫

`attachments/v1/{objects,file-objects,files}` 是 sha256 内容寻址、**跨会话去重、无引用计数**，所以"某个工作区的附件"这个概念不存在。唯一安全的做法是：读**所有剩余会话**的日志，收集它们提到的 64 位十六进制串（文件名即哈希），只删从未被提到的对象。

读取走的是 `sessionPersistence` **服务契约内的公开 API**：`open(id, 'read')` 拿句柄，再**分页** `read(offset, length)`（每页 1000 条事件），读完 `close()`。`read` 句柄不夺所有权、不加锁，所以扫描活跃会话是安全的。

注意 `resolveCurrentLog` / `readStoredLog` 是 JSONL **后端内部**方法、不在服务契约里（`SessionPersistence` 抽象类只公开 `create/open/stat/list`）。因此本插件：路径发现优先用 `resolveCurrentLog`，取不到就回退 `DSH_HOME/sessions` + 一次目录扫描；**日志正文只走 `open()`**。

**旧格式（v0）会话的字节级兜底**：`open()` 被后端拒绝时（实测 `unsupported descriptor version 2`），改为扫描该会话目录下**全部日志世代**的原始字节，把其中所有 64 位十六进制串都算作引用（zstd 帧先解压；无法识别的二进制直接判为阻塞，绝不"扫不出就当通过"）。该兜底**只对非活跃会话生效**——活跃会话的最新事件可能还在内存里，漏标记会误删。

保守策略：**任何一个会话日志读取失败就放弃整次 GC**（宁可留垃圾，绝不误删），并在结果里给出 `blocked` 明细与按原因聚合的 `reasons`（干跑同样会报）。附件回收因此放在最后一步，不影响会话与目录的删除。

## 配置

在 profile 的 `cordis.patch.yml` 里按 row id `session-purge` 覆盖：

```yaml
- id: session-purge
  config:
    deleteProjectFolder: true          # 是否连项目文件夹一起删
    requireFolderNameConfirm: true     # 删文件夹前是否要求手输文件夹名
    deleteAttachments: true            # 附件 mark-and-sweep 的默认勾选状态
    startupSweep: true                 # 启动时清墓碑/孤儿缓存/空目录
    allowRemoteVolume: false           # 允许 UNC 目标（不推荐）
    allowNonLoopback: false            # 仅在没有 Connection 服务时生效的兜底校验
    minFolderDepth: 2                  # 可删路径的最小层级
    pruneEmptyProjectDirs: true        # 删除后清理空的 --<projectKey>-- 目录
```

## HTTP 接口

固定前缀 `/api-ext/session-purge`（`/api` 属于 client-connection RPC）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/list` | 工作区列表 + 插件配置回显 |
| POST | `/preview` | 只读预检：清单、体积、护栏判定 |
| POST | `/execute` | `{ workspaceId, sessionId?, attachments?, folderName?, dryRun?, confirm, acknowledgeLive? }` |
| POST | `/sweep-attachments` | 独立附件回收：`{ dryRun? }` 或 `{ confirm: true }`；不涉及任何工作区 |

鉴权与官方 API 路由一致：先过 `connection.requestRejection`（Host/Origin 围栏 + 浏览器会话 cookie，未认证返回 401），在没有 Connection 服务的组合里退化为插件自身的 loopback + 同源校验。请求体上限 16 KB，只接受 JSON 对象。

## 独立回收无引用附件

对话框列表步骤里还有一个「**回收无引用附件**」：进入后先自动跑一次**只读预检**（告诉你会回收多少、保留多少、有没有会话读不到），再点「开始回收」才真正删除。它**不删除任何会话或工作区**，是"你从不删工作区、但想清理附件垃圾"时的入口。任何会话读不到都照旧放弃整次回收。

## 自检

```powershell
cd <本仓库目录>
node --test
```

47 个用例：路径与护栏（19）、真实文件系统上的完整编排与附件语义（16）、路由与请求围栏（12）。

## 已知限制

- **删除不可逆**：没有回收站（这是刻意的设计选择），所以预检、手输文件夹名与残留报告是必须项。
- 附件 GC 会读完所有剩余会话（本机 200 MB 级，几十秒到两分钟），期间不能取消；一次回收要跑两遍全库扫描（预检一遍、执行前再确认一遍，避免复用过期标记）。
- 大目录递归删除是同步请求；极大项目可能耗时较长。
- 首个真实使用建议先在**实验性工作区**上跑一遍。
- 插件的删除动作走 `node:fs`，因此绕过 DSH 的 `fs-sandbox`：可删路径已被收敛到"会话根 / 投影缓存 / 工作区 `path` / 附件根"四处，并被上面的护栏约束。
- 受保护路径里可选的"DSH 运行时目录"通过环境变量 `DSH_RUNTIME` 声明（不设则跳过），因此仓库里不含任何本机绝对路径。
- 尚未提供：agent 工具（`ctx.tools.register`）、斜杠命令、单会话删除入口。

## 兼容性

针对 DSH `0.2.0-rc.2` 与 JSONL 会话后端开发与实测。插件**只 import `node:*`**，不引用任何 `@deepseek-ai/dsh-*` 运行时模块，因此 DSH 发补丁版本不会因模块内部结构变化而加载失败。

## 结构

```
index.js            插件入口：路由装配、请求围栏、启动自愈
client.js           浏览器半边：侧栏按钮 + 对话框（零构建 ModuleLoader 工厂）
lib/paths.js        路径归一化与目录测量（纯函数）
lib/guards.js       13 条护栏（纯函数）
lib/harness.js      对 workspaceRegistry / sessionPersistence / sessions 的只读适配 + 预检计划
lib/execute.js      破坏性编排（顺序：归档→删文件→删缓存→摘归属→删注册→删文件夹）
lib/attachments.js  附件 mark-and-sweep
lib/sweep.js        启动自愈：墓碑、孤儿缓存、空目录
lib/http.js         响应封装、来源校验、请求体解析
test/               单元 + 集成 + 路由测试
```
