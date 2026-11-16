# 更新记录 / Changelog

版本号从 ProkBot Plus 1.0.0 开始。上游 ProkBot 的版本记录附在后面，供参考。

Versions start at ProkBot Plus 1.0.0. Upstream ProkBot releases are listed at the end for reference.

## 未发布 / Unreleased

- **主页 / Homepage**：中英文 README 重写，改成直白的说明，并写明服务器的最低配置（2 核、4 GB 内存、30 GB 硬盘）和推荐配置（4 核、8 GB、50 GB），依据是 2C2G 失败、2C4G 和 4C8G 的功能实测，以及生产实例的实际占用；只针对个人或家庭使用，多人负载未测。版本表的说明也改成直白的话。部署手册、技术文档、交接文档和 Host 说明随之更新，链接改到新锚点 `#server-requirements`（旧锚点保留）。只改文档，程序不变。Both READMEs were rewritten in plain language and now state the server minimum (2 cores, 4 GB RAM, 30 GB disk) and recommendation (4 cores, 8 GB, 50 GB), based on the failed 2C2G runs, the 2C4G and 4C8G functional runs and the production instance's actual usage; they cover one person or a household, and multi-user load is untested. The version table wording is plainer too. The deployment guide, technical documentation, handoff and Host README were updated to match and link to the new `#server-requirements` anchor (the old anchors still work). Documentation only; no program changes.

## ProkBot Plus 1.2.1 (2026-11-16)

Android 修复：在较旧的 Android System WebView 上（例如鸿蒙「卓易通」等兼容环境），配对成功后界面一直白屏（[#3](https://github.com/ferretgeek/prokbot-plus/issues/3)）。其他平台和 Host 与 1.2.0 相同。

Android fix: on older Android System WebView builds (for example in compatibility layers such as HarmonyOS 卓易通), the interface stayed blank after pairing ([#3](https://github.com/ferretgeek/prokbot-plus/issues/3)). Other platforms and the Host are unchanged from 1.2.0.

- **旧版 WebView / Older WebView**：官方界面直接调用比系统 WebView 新的函数（`URL.canParse`、`toSorted`、`findLast`、`Object.hasOwn`、`at`、`crypto.randomUUID`、`showPopover` 等），WebView 89 到 119 上渲染出错，React 卸载整个界面，只剩白屏。新增的 `android/client/compat.js` 在界面和配对页之前补齐缺少的函数，不替换已有实现。WebView 低于 89 时，配对页和界面会显示 WebView 版本、错误信息和需要更新的组件，而不是白屏或空表单。APK 外壳仍是 1.1.0 (10100)；用新的 Android 工具包重新生成后覆盖安装即可。The official interface calls built-ins newer than the system WebView without checking for them (`URL.canParse`, `toSorted`, `findLast`, `Object.hasOwn`, `at`, `crypto.randomUUID`, `showPopover` and others). On WebView 89 to 119, rendering threw, React unmounted the interface and the page stayed blank. The new `android/client/compat.js` runs before the interface and the pairing page and adds missing functions without replacing existing ones. Below WebView 89, both pages show the WebView version, the error and what to update instead of a blank page or an empty form. The APK shell is still 1.1.0 (10100); rebuild with the new Android tools and install over the existing app.
- **验证 / Validation**：Android 15 模拟器（WebView 124）在页面脚本运行前删除这些函数后，不加载 `compat.js` 时白屏并报 `Object.hasOwn is not a function`，与 #3 的现象一致；加载后工作区、Bot 列表和带图片的历史对话正常显示，没有错误。Android 11 模拟器（WebView 83）上，配对页和界面都显示说明。没有在鸿蒙「卓易通」真机上验证。On an Android 15 emulator (WebView 124) with these functions removed before any page script, the interface stayed blank with `Object.hasOwn is not a function` without `compat.js`, matching #3; with it, the workspace, the Bot list and a history with images displayed without errors. On an Android 11 emulator (WebView 83), the pairing page and the interface showed the explanation. Not verified on a HarmonyOS 卓易通 device.

## ProkBot Plus 1.2.0 (2026-11-16)

Windows 补丁跟进官方 1.1.0；Mac 和自开发 Android 外壳仍使用 0.71.2 界面，Android APK 不变。Windows 用户需用官方 1.1.0 安装包重新生成客户端，已有的 Host 无需为此升级。本版同时包含 1.1.0 之后的客户端修复，以及 Host 的部署、备份与恢复、模型接口和管理页改动；这些 Host 改动要按[部署手册](docs/AI-INSTALL.md)更新服务端后才生效，更新前先备份。

The Windows patch follows official 1.1.0. Mac and the unofficial Android shell keep the 0.71.2 interface, and the Android APK is unchanged. Windows users need the official 1.1.0 installer to build the client again; existing Hosts do not need an upgrade for it. This release also contains the client fixes made after 1.1.0 and the Host's deployment, backup and recovery, model adapter and admin changes. The Host changes take effect only after updating the server as described in the [deployment guide](docs/AI-INSTALL.en.md); back up first.

### Windows 1.1.0 支持 / Windows 1.1.0 support

- **Windows 客户端跟进官方 1.1.0 / Windows client follows official 1.1.0**：补丁改为只接受未经修改的官方 Windows x64 1.1.0 安装包，即官方稳定通道的当前版本。17 条 recipe 由新的 `windows/tools/desktop-recipes/` 从官方安装包生成：每处修改以原文件中唯一的文本为锚点，未改动的原文全部是复制区间，`--check` 可逐字节重现。传入 0.71.2 安装包时，工具说明这是不兼容的官方旧版。The patcher now accepts only the unmodified official Windows x64 1.1.0 installer, the current stable release. The new `windows/tools/desktop-recipes/` generates the 17 recipes from the official installer: every edit is anchored to text that is unique in its original, unchanged bytes are copy ranges, and `--check` reproduces them byte for byte. A 0.71.2 installer is named as an incompatible older official release.
- **桌面主进程 / Desktop main process**：适配 1.1.0 按 `desktop-mount`、`main`、`spotlight` 三条边声明的 RPC 方法和窗口可见性事件；全局搜索转到 Host 的搜索接口；听写把 16 kHz 录音作为 WAV 交给 Host 的语音识别；补齐 1.1.0 启动时读取的默认值（Microsoft Teams、云端 Bot 文件、存储设置等）；实时语音凭据失败不再被界面当成额度用尽。Adapted to the 1.1.0 RPC declarations on the `desktop-mount`, `main` and `spotlight` edges and to window visibility events. Global search uses the Host's search; dictation sends 16 kHz recordings as WAV to the Host's speech recognition; startup defaults read by 1.1.0 (Microsoft Teams, cloud Bot files, storage settings) are answered; a failed real-time voice credential is no longer shown as a usage limit.
- **界面 / Interface**：1.1.0 界面保留此前补丁的修改：Host 账户与连接设置、本地版本页、Bot 电脑的远程桌面、连接应用的 Host 分类、语音设置，去掉开发标记和崩溃上报。Bot 资料库对话框新增「上传文件」按钮（原版只能拖入）。The 1.1.0 interface keeps the earlier patch's changes: Host account and connection settings, the local version page, the Bot computer's remote desktop, the Host category for connected apps and voice settings, without development labels or crash reports. The Bot library dialog gains an Upload files button (the original only accepts dropped files).
- **Android**：仍从 Windows 0.71.2 安装包生成，APK 不变；其 Windows 输入和 recipe 移到 `windows/patchers/desktop/0.71.2/`。Still built from the Windows 0.71.2 installer with an unchanged APK; its Windows inputs and recipes moved to `windows/patchers/desktop/0.71.2/`.
- **验收 / Validation**：2026-11-16 在 Windows 11 上用生成的 1.1.0 便携版连接自部署 Host，完成配对（Host 返回不同地址时拒绝配对）、两轮聊天、全局搜索、附件上传并读回、本机命令审批与执行、强制结束后重启并读回历史，以及通知判断；0.71.2 客户端的配置目录无需重新配对即可沿用；本地模拟 Host 断线恢复后，客户端重新连接并只补上一次断线期间的新回复。听写只验证到 Host（测试 Host 未配置语音识别）；实时语音只用本地模拟中继验证；Mac 仍为 0.71.2。On November 16, 2026, a generated 1.1.0 portable build on Windows 11 completed pairing against a self-hosted Host (refusing a Host that returned a different address), a two-turn chat, global search, an attachment read back by the Bot, local command approval and execution, a restart after a forced exit with history read back, and notification decisions. A 0.71.2 client's profile carried over without pairing again, and after a local mock Host dropped and restored its connections the client reconnected and showed the reply written during the outage once. Dictation was verified only up to the Host, which has no speech recognition configured; real-time voice only against a local mock relay. Mac remains on 0.71.2.
- **清理 / Cleanup**：删除 `windows/tools/compat/1.1.0/` 的研究回放及其两项测试。Removed the research replays in `windows/tools/compat/1.1.0/` and their two tests.

### 客户端修复 / Client fixes (2026-11-14)

- 首页和补丁工具区分「已知不兼容的官方版本」与「来源不明的文件」，不从文件名猜版本；现在用来识别旧的 0.71.2 安装包。The homepage and patcher distinguish a known incompatible official release from an unknown file without trusting its name; this now identifies the older 0.71.2 installer.
- 修复桌面连接状态、重复握手及关闭窗口后的请求；自开发 Android 网页桥接同步修复。桌面设置按序保存、失败保留原文件，「关于」页读取实际应用版本。补丁输入未变。 Fixed desktop connection-state notifications, duplicate ready replies and requests surviving window shutdown; the unofficial Android bridge has the same fixes. Desktop preferences are saved in order without replacing a damaged profile, and About reports the running app version. Production pins are unchanged.

### Host、部署与工具 / Host, deployment and tools

- **iOS 工具测试 / iOS tool tests**：打包后的补丁命令回归显式以 UTF-8 写入和读取子进程诊断；中文目录名和 Windows 本地代码页不再导致测试解码失败。这不是 iOS 真机验收。Packaged CLI regressions explicitly write and read UTF-8 diagnostics, including Chinese directory names on Windows. This is portable tool coverage, not an iOS device test.
- **发布包 / Release archives**：新增流式归档校验，覆盖嵌套 ZIP、APK 和 gzip 内容，核对原生辅助程序与自开发 Android 空壳摘要；遇到私钥、接入笔记或禁止分发的程序即拒绝，不在错误中回显敏感值。The archive verifier checks nested ZIP, APK and gzip content, pins native helpers and the Android shell, and refuses private keys, access notes and disallowed client programs without echoing sensitive values.

- **Windows 卸载 / Windows uninstall**：临时卸载进程切换到自己的临时目录，避免用户从安装目录内运行卸载器时锁住空目录。文件归属和删除规则不变。The uninstall worker switches to its own temporary directory so a launch from inside the installation cannot keep the empty installation directory locked. File ownership and deletion checks are unchanged.
- **验收 / Validation**：Android 重连判定分别核对两轮持久消息和界面顺序。整机基准拒绝把单独 Host、容器、与零交换空间冲突的换页数据，或客户端负载分配不同的轮次当成完整容量对照。Android chat recovery checks both persisted turns and visible order. Whole-machine benchmarks reject Host-only evidence as a full deployment, containers as VMs, paging inconsistent with zero swap, and mismatched per-client workloads.

- 存在来源不明的离线 Host 副本时，继续升级运行中的原实例会在停机前提示：若候选接管后失败，在本 daemon 上只能离线还原。失败提示包含实际备份目录和旧镜像，不再要求执行必定被拒的自动恢复。An upgrade that can continue alongside an unknown detached Host copy now warns before stopping services. If the candidate fails after takeover, the message identifies the snapshot, prior image and data-only restore path; it no longer directs users to a blocked automatic recovery.

- **部署挂载 / Deployment mounts**：启动、升级和恢复前拒绝漏备份或遮蔽数据目录的挂载；即使卷名相同，也不接受用卷内子目录冒充整个数据卷。备份已有容器时同样检查，不会先暂停旧服务。数据目录以外的临时文件系统仍可用。Deployment preflight rejects extra or shadowing mounts and requires the actual managed volume roots. Backups of existing containers check for volume subdirectories before pausing services. Temporary filesystems outside managed data paths remain permitted.

- **模型错误响应 / Model error responses**：三种模型接口最多缓冲 64 KiB 的 HTTP 错误正文。超限即停止读取并保留 HTTP 状态码和 `Retry-After`；不记录截断的正文，也不限制正常回答。All three adapters bound HTTP error bodies to 64 KiB, cancel an oversized body, and retain the status and retry delay without logging partial content. Successful model output is not subject to this limit.

- **聊天界面 / Chat UI**：宽屏中的表格可用普通回复右侧的空间；设置弹窗不再用 Ctrl/Cmd+Enter 误发后台草稿；在应用目录的空搜索框按 Escape 可直接关闭目录。Windows、Mac 共用桌面样式和按键代码，Android 从同一份文件构建。固定 0.71.2 Android 界面的桌面宽度测试不等于原生 Mac 或 iOS 验收。Wide reply tables use spare horizontal space. A dialog no longer sends the background draft via Ctrl/Cmd+Enter; Escape in an empty app-catalog search dismisses that dialog. Desktop clients and the unofficial Android shell share these changes. Browser tests of the pinned Android renderer are not native Mac or iOS acceptance.

- **重复回复 / Repeated replies**：一次 Android 实验中，模型在收到成功工具结果后仍反复生成同一条纯文本发送请求。三种模型适配器现在在这种连续重发执行前报不可重试错误，保留已送达的消息、历史和用量；新提问可收到同文答案。三种协议回归及历史检查点回放通过，修复后 Android 端到端尚未验收。In an Android lab session the model repeatedly requested the same plain-text delivery after a successful tool result. All three adapters now stop this immediate loop before another send, preserving history and usage. A new user request can receive the same answer. Protocol tests and saved-checkpoint replay passed; a post-fix Android end-to-end run is still outstanding.

- 备份只查询所选项目的来源。非 Host 卷和工具自己的锁不阻塞无关部署；来源不明的恢复卷不能自动上线。容量报告不再把构建窗口外的样本或聊天中未解释的进程代次变化计为通过。 Backups look up only the selected project's origin. Unrelated Compose volumes and the tool's own locks do not block deployment; restored identities of unknown origin still cannot start automatically. Capacity comparisons reject builds without an in-window sample interval and service generations inconsistent with Docker start events.

- **Windows 并行安装 / Windows side-by-side installs**：安装器保留了旧版，但新客户端首次启动仍会改写旧的开始菜单快捷方式和 `grokbot-local:` URL 关联。现在保留已占用的入口，并行安装和隔离 QA 启动均不注册这两项。The installer preserved the legacy copy, but first launch could still replace its Start menu shortcut and URL handler. Occupied entries are now preserved; side-by-side and isolated QA launches register neither.
- **分机模型状态 / Split Host model status**：仅保存模型、未启用执行节点时，管理页曾一直等待，CLI 三分钟后报错。现在概览的「配置节点」打开「执行环境」设置，CLI 明确报告模型已保存、尚未应用。With a saved model but no enabled execution node, the console used to wait indefinitely and the CLI timed out after three minutes. Overview now opens the Execution settings and the CLI reports saved, not applied.

- **部署与恢复 / Deployment and recovery**：候选先构建，拒绝漏备份的挂载，核对 Host 和桌面镜像。备份只含受管卷和清单，不含镜像、实例 `.env` 或宿主机系统；`recover` 使用目标 daemon 已有的精确镜像和新卷。跨 daemon 由操作者保证互斥及同一身份只运行一份。Build before stopping services, reject omitted mounts and verify the running images. Backups contain managed volumes and a manifest, not images, the instance `.env` or the host OS. Recovery uses fresh volumes and exact images already on the target daemon. Across daemons the operator must serialize operations and prevent duplicate active identities.
- **模型与补丁性能 / Streaming and patch performance**：三种模型流检查结束事件、取消、损坏数据与重复工具调用；并发访问合并设备活跃时间写入。Host 补丁复用源摘要、流式写输出。[同盘复测](docs/ARCHITECTURE.md#host-patch-measurement)记录冷、热输入页的墙钟和补丁进程 RSS；不作为整机容量数据。All three adapters check completion, cancellation, invalid data and duplicate calls. Concurrent device activity shares a disk write; the patcher reuses source hashes and streams verified outputs. The [same-disk comparison](docs/ARCHITECTURE.en.md#host-patch-measurement) reports wall time and patch-process RSS for cold and warm input pages, not whole-guest capacity.
- **后台记忆 / Background memory**：模型连接在回合结束后的记忆提取中断开时，保留已完成的聊天，记录该次提取失败，不再因无人读取的结果 Promise 退出 Host；其他未处理异常仍按原规则报错。A failed post-turn memory request is reported without terminating the Host or losing the completed reply. Unrelated unhandled errors are not suppressed.
- **客户端与管理页 / Clients and admin**：Windows 安装器按文件归属升级与卸载，可并行迁移无收据旧版。桌面和 Android 修复短流重连及分块上传；Android 生成失败保护旧输出，iOS 从固定清单读取版本。管理页显示真实断线状态，CLI 在发送请求前拒绝无效选项。Windows tracks owned files and supports side-by-side legacy migration. Desktop and Android fix reconnect and upload handling; Android protects existing outputs and iOS reads its version pins from the manifest. Admin status no longer remains ready after disconnect and the CLI rejects invalid flags before making requests.
- **验收与文档 / Verification and documentation**：两次 2C2G 候选诊断均未通过。2C4G、4C8G 分别记录了新装构建、真实模型对话、取消和原设备重启后读回；仅为功能观察，不是容量或前后对照。各包的双语手册区分这些结果与历史验证；没有最低或推荐配置。Both isolated 2C2G candidate diagnostics missed a deadline. Separate 2C4G and 4C8G VMs recorded fresh builds, real-model chat, cancellation and post-restart readback by the original device. These are functional observations, not capacity tests or before/after comparisons. The shared bilingual guides distinguish them from historical tests. There is still no minimum or recommended hardware rating.
- **首页与 CI / Homepage and CI**：首页注明由 6.2Astra 和 Opus5.5 一起维护。Windows 安装器的 GitHub Actions 验收与回归模板一样放在 `ci/`（`ci/installer-native.yml`），默认不运行。The homepage names 6.2Astra and Opus5.5 as maintainers. The Windows installer's GitHub Actions acceptance is an inactive template in `ci/installer-native.yml`, like the regression template.

## ProkBot Plus 1.1.0 (2026-11-14)

客户端工具发布。自开发 Android 外壳 `1.1.0 (10100)`；界面固定 Windows `0.71.2`。保存的设备凭据只可在原 Host 地址重试。Windows、Mac 和 Android 校验模式实际回放固定补丁。本次不升级现有服务器。见[已发布的完整记录](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/CHANGELOG.md)。

Client tools release. The unofficial Android shell is `1.1.0 (10100)` with the pinned Windows `0.71.2` renderer. A saved device credential can only be retried against its original Host origin. Desktop and Android verification replay the pinned recipes. No existing server upgrade is required. See the [published changelog](https://github.com/ferretgeek/prokbot-plus/blob/v1.1.0/CHANGELOG.md).

### 1.1.0 之前的主分支变更 / Main-branch changes before 1.1.0

- **ARM64 与部署**：Host 可原生构建在 ARM64 Linux 上；官方桌面仍为 amd64，可放独立节点，或在同机经预检后模拟（实验）。新增统一部署入口，记住项目和模式，更新前备份；双语安装手册改为一条流程。维护者可离线核对固定版本、补丁和外壳摘要。
- **ARM64 and deployment**: build the Host natively on ARM64 Linux. The original amd64 desktop runs separately or under local emulation after a preflight (experimental). A single operator command remembers the project and topology and backs up before upgrading. Both install guides now follow one route; maintainers can check pinned inputs, recipes and shell digests offline.
- **历史 A1 真机验证 / Historical A1 hardware test**：当时的 ARM64 Host 搭配独立 amd64 桌面通过两轮聊天、VNC 操作及旧版数据读取。A1 未安装 Docker，不是本轮的镜像、Compose 升级或容量验收。The earlier native ARM64 Host and separate amd64 desktop passed two-turn chat, VNC input and readback of existing data. Docker was not installed on the A1; this did not verify this round's images, Compose upgrade or capacity.

- **Android 主页截图**：中英文 README 分别展示在 Android App 中实际发送的两轮对话和模型回复，配对页截图移至安装说明。
- **Android screenshots**: each README now shows a real two-turn conversation in its own language; pairing screenshots are in the Android installation guide.

- **客户端与 Host 修复**：Windows 安装和卸载前校验目录归属；Windows、Android 对显式提供的官方 EXE 校验整包及内层摘要；仅校验时清理临时目录，Windows 构建失败不覆盖已有 ZIP。Android 正确报告保存失败、释放重连监听器、限制网关连接数和握手时间，后台通知不再漏掉同一毫秒的不同事件。新版 Host 区分 Android 和 Windows；新配对的 Android 设备没有桌面执行权限。模型请求不跟随重定向；消息排序等待不会因 Node 提前退出而丢失。
- **验证与主页**：加入可选的三平台 CI 模板（默认未启用）、Windows 安装器测试，以及 Android 15 干净演示环境的中英文实拍截图，明确 Android App 由项目自开发、不是官方版本。

English: Windows checks directory ownership before installation or removal. Both builders verify explicit EXEs and their payloads; Windows verification cleans up, and failed ZIP builds preserve existing output. Android reports save failures, releases reconnect listeners, bounds gateway connections and handshakes, and keeps distinct notifications with identical timestamps. Updated Hosts distinguish Android from Windows and withhold desktop execution privileges from newly paired Android clients. Model requests refuse redirects, and ordered messages retain their timeout even on an otherwise idle Node process. The optional three-platform CI template is inactive by default. Installer tests and clean Android 15 screenshots are included.

- **新增 Android 客户端**（`android/`）：
  - 界面用官方桌面版的界面，取自用户自己下载的官方 Windows 0.71.2 安装包，套在本项目编写的 Android 外壳里（官方 Android 版带防篡改保护，不做修改）；
  - 生成工具 `android/patchers/patch.mjs` 在 Windows、macOS、Linux 上都能运行，用为用户单独生成的密钥签名（APK 签名方案 v2）；
  - 功能：对话、Bot 电脑的实时画面和远程操作（触摸和软键盘）、附件上传和保存、后台通知（不依赖 Google 推送）、深色模式、返回键；Android 9 及以上；
  - 照官方手机版的样子重新排版：Bot 列表和对话分成两屏，圆形悬浮按钮、消息气泡、配色和 XVF 字体都按官方手机版，列表每行显示 Bot 的最后活动时间，市场入口移到账户菜单；详情、设置、市场和搜索全屏打开，菜单和对话框从底部弹出，看图和电脑大画面黑底全屏；旧版 WebView 上 Bot 电脑画面也能正确定位；
  - 配对时自动把中文输入法打出的全角字符转换为半角。
- **Windows 补丁**：解压官方安装包的代码移到 `windows/patchers/desktop/original.mjs`，供 Android 共用。
- **文档**：
  - 技术说明、功能细节、待办和手动安装说明合并为[技术文档](docs/ARCHITECTURE.md)；
  - Host 的离线构建、备份、分开部署和应用开发并入 `host/README.md`，iOS 签名说明并入 `ios/README.md`；
  - 删除没有用到的截图；
  - 部署手册补充更新客户端的步骤和 Android 的故障排查；贡献说明、PR 和问题模板、安全建议加上 Android；技术文档补充 iOS 网络层测试；
  - 新增 `AGENTS.md`：给接手本仓库的 AI 看的项目概览，`CLAUDE.md` 引用它。
- **清理**：删除没有程序读取、内容也已过时的文件清单 `host/source-files.json`。

English: **new Android client** (`android/`). It runs the official desktop interface, taken from the user's own download of the official Windows 0.71.2 installer, inside an Android shell written for this project (the official Android app carries tamper protection and is not modified). The builder `android/patchers/patch.mjs` runs on Windows, macOS and Linux and signs the APK (scheme v2) with a key created for the user. It supports conversations, the live view and remote control of the Bot's computer (touch and on-screen keyboard), uploading and saving attachments, background notifications without Google push, dark mode and the back gesture, on Android 9 and later; the interface is rearranged after the official phone app (the Bot list and a conversation are separate screens with its round floating buttons, message bubbles, colors and XVF typeface; each Bot row shows when the Bot was last active; the marketplace moves into the account menu; details, settings, the marketplace and search open full screen; menus and dialogs slide up from the bottom), the computer view is positioned correctly on older WebView builds, and pairing converts full-width characters typed by Chinese input methods. The Windows patcher's installer extraction moved to `windows/patchers/desktop/original.mjs` for sharing.

English: the technical notes, feature details, to-do list and manual install notes are merged into the [technical documentation](docs/ARCHITECTURE.en.md); the Host deployment, backup and app notes are merged into `host/README.en.md` and the iOS signing notes into `ios/README.en.md`; unused screenshots are removed; the deployment guide adds steps for updating the clients and Android troubleshooting; the contributing guide, pull request and issue templates and security advice cover Android; the technical documentation lists the iOS network test; `AGENTS.md` adds a project overview for AI agents. The unused and outdated file list `host/source-files.json` is removed.

## 1.0.0（2026-11-10）

基于 ProkBot v2026.11.05（提交 `3e9fe8c`）。

**新增**

- **Windows x64 客户端**：基于官方 Grok Bot 0.71.2 Windows 版生成，提供便携版和安装包（装在当前用户目录，不需要管理员权限）。
  - 功能：对话、托盘、系统通知、附件、Tailcat、本机命令（PowerShell）、Codex 委派。
- **模型接口**：新增 Anthropic Messages 和 OpenAI Responses，与 OpenAI Chat 并列。
  - 三种格式都支持图片、文件、工具调用、思考强度和多轮推理接续；
  - 思考强度新增 `minimal`；
  - 连接测试和自动审查也支持三种格式。
- **命令行管理工具** `host/tools/host-admin.mjs`：初始化管理员、列出模型、配置并测试模型、生成配对码。
- **AI 部署手册** `docs/AI-INSTALL.md`：每一步都有「应该看到」和「如果失败」，开头先让 AI 告诉用户需要准备什么。

**修复**

- **Windows**：
  - Bot 生成的图片和截图在客户端里一直显示加载中；
  - 中文 Windows 上本机命令的输出乱码。
- **联网工具**：
  - 新版 Claude 不接受强制工具调用，导致联网失败；
  - 并行搜索中有一路超出次数时，整次搜索被判失败。
- **图片生成**：
  - 指定画面比例时 OpenAI 图片接口报错；
  - 带参考图修图时报错。
- **消息顺序**：同一次回复里的多条消息可能乱序送达。
- **自动审查**：模型偶尔返回格式不对的结果时，直接拒绝操作且不留日志。现在重试一次，失败会记日志。
- **构建**：Docker 29 默认的 containerd 镜像存储下，构建报 `Unsupported Box image identity`。
- **Tailcat**：代码从 Windows 上传到服务器时，Tailcat 程序会丢掉可执行权限，导致服务端无法开启 Tailcat。现在构建镜像时会补上这个权限。
- **测试**：Mac 测试在中文系统下失败（断言只认英文报错）。

**English summary**

- **New**:
  - Windows x64 client (portable build and per-user installer);
  - Anthropic Messages and OpenAI Responses model formats next to OpenAI Chat, with `minimal` effort and reasoning replay;
  - `host/tools/host-admin.mjs` admin CLI;
  - step-by-step AI deployment guide.
- **Fixed**:
  - Windows: Host images stuck loading; garbled command output on Chinese Windows.
  - Web tools: failed with current Claude models; parallel searches failed when one call hit its limit.
  - Image tools: errors on aspect ratios and on reference images.
  - Message order: messages from one reply could arrive out of order.
  - Auto review: failed silently on malformed classifications.
  - Build: broke with Docker 29's containerd image store.
  - Tailcat: failed to start on the server when the code was uploaded from Windows (lost executable bit); the image build now sets it.
  - Tests: a Mac test failed on Chinese systems.

---

## 上游 ProkBot 版本 / Upstream ProkBot releases

来自 https://gitee.com/ahaduoduoduo/ProkBot ，仅作记录。

- **v2026.11.05**：Mac 修复 Bot 置顶、分组及折叠状态的保存。
- **v2026.11.02**：iOS 修复锁屏后 Tailcat 持续重连；回到前台时自动恢复连接。
- **v2026.11.01**：首个公开版本。可以用自己的 Host 和模型，并保留 Grok Bot 的 Mac 和 iOS 界面；提供 Mac、iOS、Host 三个补丁工具。
