# ProkBot Plus Host Patch

自建 Grok Bot 服务端。Host 支持 Linux amd64 / arm64 构建；官方执行桌面仅有 amd64。ARM 可用独立 amd64 节点或同机模拟（实验）。需要 Python 3.10+ 和 Docker Compose v2。

完整的部署步骤见 [AI 部署手册](../docs/AI-INSTALL.md)，实现原理见[技术文档](../docs/ARCHITECTURE.md)。[整机基准](#capacity-benchmark)仅用于获准的非生产虚拟机；它不是整机备份工具，也不提供硬件最低配置。

[English](README.en.md)

## 使用

```sh
python3 deploy.py doctor
python3 deploy.py init
python3 deploy.py up
```

以上在 `host/` 目录运行；新装默认回环地址。自定义访问地址在 `init` 时指定，参数见 `python3 deploy.py init --help`。已有实例用 `update`，不要重新 `init`。首次设置、模型和配对见部署手册。

## 离线构建

构建工具默认从固定来源下载原版文件，并严格校验，版本见 `recipes/host/manifest.json` 和 `release/build-docker.py`。已有原版文件时：

```sh
python3 deploy.py up --host-archive /path/to/host.tgz --box-archive /path/to/box.tar.gz
```

Box 归档校验通过后会被标记为 `grokbot-box-input:9d2ac1b`，Compose 直接使用这个本地镜像。Docker 29 新安装默认用 containerd 镜像存储，此时镜像 ID 是固定的清单摘要，构建工具同样接受；离线归档按其中的配置摘要校验，与存储方式无关。

先用 `init` 选定实例；已有实例把 `up` 换成 `update`。只想构建镜像不启动时，`release/build-docker.py` 接受相同的归档参数。这些参数只替代原版下载；全离线还要预缓存基础镜像、系统包、npm 依赖，ARM 同机还需要 amd64 的 `busybox:1.37`。ARM 独立 Host 不传 `--box-archive`；amd64 Host 仍用 Box 作基底。

`release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` 可以单独生成 Host 文件并记录补丁耗时。生成过程只做固定的字节复制和新增规则，不调用 AI，也不反编译。

## 数据与备份

同机部署备份 `host-data`、`box-home`、`box-workspace`；独立 Host 只有 `host-data`，另一台执行节点需单独备份 `gateway-data` 和两个桌面卷。备份目录只含卷归档与校验清单，**不含镜像、实例目录的 `.env`、宿主机系统或其他磁盘内容**。卷里的配对身份、模型凭据、聊天与工作区数据属于私密资料，备份不要公开。

手动备份会暂停正在运行的项目容器，结束后恢复原状态。`update` 先构建候选，再停止旧服务并备份，使构建期间写入的数据也在卷归档里。未纳入备份的嵌套挂载（例如 `/data/uploads`）会使操作中止。分机部署不是跨主机原子快照：需由操作者协调两端停止写入，并分别保存两台机器的归档。

```sh
python3 deploy.py backup < /dev/null
```

**恢复并启动一个新实例。** 分开保管卷备份、原实例 `.env`、对应代码版本和镜像。`serviceImages` 只是当时容器实际使用的完整镜像 ID；目标 daemon 必须已有这些精确镜像，旧 Host 的 `prokbot-recovery` 本地标签不能代替镜像备份。先确认原实例及其他机器上的同一身份均已停机。不要对原项目运行 `down -v`。

在 `host/` 下运行。以下是回环地址的同机示例。新目录、项目名和备份目录按实际替换；需要原有配对继续可用时，用 `init` 的 `--listen`、`--port`、`--public-url` 重现原地址，并将原有时区等设置补到新 `.env`。独立 Host 在 `init` 前加 `--host-only`，后续会记住模式。不要覆盖原实例的 `.env`：

```sh
python3 deploy.py --home "$HOME/grokbot-restored" --project grokbot-restored init < /dev/null
python3 deploy.py --home "$HOME/grokbot-restored" recover --directory /path/to/backup < /dev/null
python3 deploy.py --home "$HOME/grokbot-restored" status < /dev/null
```

`recover` 校验所有卷的校验值、项目名、拓扑和本地镜像 ID，只往新项目解包；启动时只挂已恢复的卷、只用记录的镜像，不构建或拉取，也不改原卷。它会核实启动后的镜像和挂载。再用原设备读回旧对话和工作区文件。若启动失败，新项目的卷保留，原实例不会自动重启；若提示未确认停机，先检查服务，不要启动第二份身份。

若旧清单不能证明 Host 身份的来源或缺少完整 `serviceImages`、精确镜像不在本机，不能自动恢复上线，也不要用 `:local` 猜版本。只有旧卷而没有原容器时，也不能据此推断旧镜像。只恢复数据可用 `python3 release/backup.py restore --project grokbot-data-only --directory /path/to/backup --image <本地已核实的镜像ID> < /dev/null`；它不启动服务，独立执行节点也用这个入口。找回可信镜像和配置，核实没有冲突的实例身份后再安排启动。

同一个 Docker daemon 上，`prokbot-operation-<项目名>` 防止项目并发修改，`prokbot-lineage-operation-<原项目名>` 防止同源恢复副本重复上线，`prokbot-image-publication-lock` 串行发布共享镜像标签。换 `--home` 或端口不能绕开这些锁。**不同 daemon 不共享锁，也不能互查实例状态**；手工启动容器也不受部署工具的锁约束。由操作者确认同一身份只运行一份。崩溃后可能留锁，先核实服务、卷、备份和操作进程，不要把删锁当成常规恢复步骤。带 `<项目名>_restore-in-progress` 的项目不是完整恢复，不能启动；保留现场，选择另一个空项目重试。

## 分开部署执行电脑

Host 机器使用 `python3 deploy.py --host-only init` 再 `python3 deploy.py up`。在另一台 **amd64 Linux** 机器的 `host/` 目录部署执行节点：

```sh
python3 release/build-docker.py --box-only
# 设置至少 32 位的随机 GROKBOT_NODE_TOKEN；离线镜像可在上一条命令加 --box-archive
docker compose -f release/compose.execution.yaml up -d --build
```

然后在 Host 管理页填写执行节点的地址和密钥并启用它。`--host-only` 模式的聊天核心须先配置模型并启用远端节点才启动。没有节点时，管理页仍能打开、容器也可能显示健康；这不是可独立聊天的配置。

- 局域网访问：设置 `GROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0`，端口默认 18443。
- 内嵌网络：设置 `GROKBOT_TAILCAT_ENABLED=1`；高级选项是 `GROKBOT_TAILCAT_RELAY` 和 `GROKBOT_TAILCAT_DERP_MAP_URL`。

<a id="capacity-benchmark"></a>
## 整机基准

[采样器](bench/guest.py)只观察获准的专用非生产 Linux VM。操作者另行构建、启动、施加负载。禁用生产服务、卷及凭据；前后用同版采样器。

| `--mode` | 角色、架构和 Compose 服务 |
| --- | --- |
| `x86-local` | 原生同机：amd64 `host` 采 `host` + `box`。 |
| `arm-split` | 分机：arm64 `host` 采 `host`；另一台 amd64 `desktop` 采 `gateway` + `box`。两端分别报告。 |
| `arm-emulated` | 模拟同机（实验）：arm64 `host` 采原生 `host` + 模拟 amd64 `box`，验证实际桌面。 |
| `host-only` | amd64/arm64 仅 `host`，只作设置/空闲诊断。缺节点保留失败和缺测；回执全成功也不评容量。接节点后测分机两端。 |

需 `systemd-detect-virt --vm` 认可的 VM、Python 3.10+、`/proc`、cgroup v2（CPU/内存/swap/cpuset），能读本地 Docker CLI/套接字 `/var/run/docker.sock`、数据根目录及目标进程。排除裸机、WSL、容器、远程 Docker 和 rootless/自定义套接字。

**采样。** 在客体的 `host/` 运行。预建仓库外私有轮次目录，使用准确的本机 Compose 项目标记和新文件。分机两端用 `--mode arm-split` 和同一 `--run-id`，桌面端换 `--role desktop`、执行项目名及 `desktop.jsonl`。

```sh
R=/path/to/private-bench
python3 -B bench/bench.py sample --isolated-guest --mode x86-local --role host \
  --project benchdemo --run-id before-1 --out "$R/BEFORE/1/host.jsonl" --interval 5 --duration 5400
```

驱动端、客户端及 VM 同步 UTC。各角色 stderr 报 `sampling-ready` 才开始构建/启动，首末阶段外各留一拍。时长覆盖实际负载；5400 秒仅示意，30 秒只够诊断。根和 Docker 数据盘自动采；独立 containerd、缓存、数据或输入盘重复传 `--disk LABEL=/existing/directory`，同盘不累加。

**每轮输入。** `run.json`、`actions.jsonl`、`host.jsonl`；仅分机加 `desktop.jsonl`。见[校验器](bench/evidence.py)及[字段样例](tests/benchmark_checks.py)（`fixture` 非实测）。

| `run.json` 必填字段 | 填什么 |
| --- | --- |
| `schema`, `runId`, `mode`, `revision` | `1`、每轮唯一公开代号、上表模式、部署版本的 40/64 位小写十六进制标识。未提交候选用可复现的源码树/产物 SHA-256。 |
| `origin`, `modelKind` | `measured` / `probe` / `synthetic`；`external-api` / `local-inference` / `mock` / `none`。只有 `measured` + `external-api` 可送审，本地推理另测。 |
| `workloadSha256`, `datasetSha256`, `limitsSha256`, `modelConfigSha256` | 依次哈希计划（冷缓存、空闲、并发、频率、期限）、起始数据、VM 配置/服务限额、无密钥的模型/端点/参数。只重置获准的临时状态。 |
| `provisioned`, `phases` | 各角色填 VM 分配的 `vcpus`、`ramBytes`（非容器限额），留存 CPU/加速、内存气球、swap、磁盘及校时记录；各阶段填不重叠的 Unix UTC 毫秒 `startMs`、`endMs`。 |
| `traceSha256`, `actionLogSha256` | 采样成功退出后用 `sha256sum` 取各角色原始采样摘要（按角色映射）和完整动作日志摘要。缺角色/结束记录、断档或摘要不符均不通过。 |

`actions.jsonl` 每次尝试一行：`runId`、`phase`、`check`、唯一 `id`、稳定匿名 `client`、阶段内 `startMs`/`endMs`、布尔 `ok`、`source`、脱敏原件摘要 `evidenceSha256`。构建用 `build-log`，其余用 `real-client`；`fixture` / `probe` / `synthetic` 仅诊断。送达超时即记 `ok:false` 并保留错误，迟到不改判，重试另记。聊天的 `upstreamMs` 是上游等待（含重试）的区间并集时长，未知填 `null`；其余含客户端、网络、工具和调度，不是 Host 耗时。

| 阶段（依次） | 真实回执与条件 |
| --- | --- |
| `build`（可选） | 含获取和构建；各角色交 `pinned-inputs`、`image-ready`，`client` 填角色名。省略则构建未测。 |
| `cold` | 从服务均停止/不存在开始；各端所需服务各干净启动一次后，已配对客户端才完成 `client-ready`。从阶段起点计时，进程/健康检查不算。 |
| `idle` | 至少 60 秒无负载，客户端固定低频检查 `idle-healthy`。 |
| `chat` | 同一客户端先获 `chat-reply`，再获依赖前文的 `context-reply`。 |
| `desktop` | 可用画面 `desktop-frame` 和无害输入的可见效果 `desktop-input`，握手不算。仅 `host-only` 禁用，其余必测。 |
| `restart` | 仅手动重启 Host 容器一次。观测 `die` 再 `start`、代次改变后，原配对的上下文聊天客户端才开始 `identity-restored`、`history-restored` 读回。别名不证明身份。 |
| `soak` | 每轮真实负载至少 1 小时；含首尾，成功 `chat-reply` 间隔 ≤60 秒（可每 30 秒调度），可加桌面检查。空等不算。 |
| `concurrent`（推荐档需测） | ≥2 个不同客户端的成功 `chat-reply` 重叠。各 VM 只计窗口内 ≥3 个完整相邻采样间隔、合计 ≥60 秒，每段最多计一拍。`overlapHeadroom`：最低 `MemAvailable` ≥10%，p95 非空闲 CPU ≤90%；通过不自动定档。 |

**离线比较。** 控制端在 `host/` 设置私有目录 `R`。先跑完 `BEFORE/1`、`BEFORE/2`、`BEFORE/3`…，再跑相同编号的 `AFTER`；至少三对独立轮次，失败留存，不跳号或复用。环境、分配、限额、数据、模型和计划一致，按阶段匹配每个客户端的尝试分布；条件不同另分组。部署版本和观测到的运行中 Host 镜像摘要均须不同。

```sh
python3 -B bench/bench.py validate "$R/BEFORE/1" > "$R/round-report.json"
python3 -B bench/bench.py compare --before "$R/BEFORE" --after "$R/AFTER" > "$R/comparison.json"
```

两者均可加 `--evidence-dir "$R/sources"`：组外私存脱敏的客户端、桌面、构建及读回原件，以 SHA-256 命名，无扩展名。缺失/不符不通过；不加只核采样、日志及摘要引用。哈希只核字节，仍须查操作、构建来源、端点、频率和期限。

退出码：`0` 单轮/至少三对可复核，非硬件认证；`1` 可读但失败、不完整、模拟或轮数不足，保留指标和原因，无对照差值；`2` 输入无效或条件不匹配，查 stderr 或保留可读轮次的 `invalidEvidence`，用 `validate` 定位。合格才报两侧中位数及逐对「候选减基线」差值。

[指标计算](bench/telemetry.py)见 `summarize`：整机 CPU 百分比≠容器核数，整机内存≠容器内存或 RSS。采样峰值是下界，磁盘含系统写入，边界可能带入相邻一拍。OOM 或目标容器意外启停整轮失败，OOM 不跨层相加；应用内恢复另看回执/日志。披露 swap 容量、使用及换页增量；零容量却换页也失败，声称无需 swap 须关闭后重测。

首页[服务器要求](../README.md#server-requirements)的最低和推荐配置只针对个人使用；它依据的两次 2C2G 超时、2C4G/4C8G 功能观察和历史 A1 记录，以及[同盘补丁耗时](../docs/ARCHITECTURE.md#host-patch-measurement)，都不是容量对照。离线自检：`python3 -B bench/bench.py selftest`；选项：`sample --help`；回归：`node --test "tests/benchmark*.test.mjs"`。

## 应用开发

管理页的「应用」统一管理远程 MCP 服务、带代码的应用和附带的技能。一个应用就是一个 `grokbot-app` JSON 包；旧版插件 JSON 也能导入。

- 内置的「编写应用」提供开发指南、格式校验和提交工具。Bot 提交后，用户在客户端原有的「连接应用」里添加并授权。
- 导入、导出都是单个 JSON，包含代码、图标、说明和技能；已保存的配置和授权凭证不会导出。
- 代码应用通过现有执行电脑上的 MCP 进程运行，不额外部署容器，和这台电脑上的其他任务共享用户权限、文件和网络。
- OAuth 支持 PKCE、一次性 state 和过期刷新。开发者声明授权地址、Token 地址和 scopes；用户填写 Client ID/Secret，再从客户端打开服务商的授权页。
- 复杂的编码工作会调用已连接电脑上的 Codex，沿用那台电脑上的模型设置和登录。
- 应用版本不可覆盖，升级后可以恢复到上一个版本。

完整的包格式、可运行示例和 OAuth 示例见 [server/application-guide.md](server/application-guide.md)（英文，Bot 写应用时读的就是这份）。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助生成。
