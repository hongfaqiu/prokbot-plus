# ProkBot Plus 维护交接

[English](HANDOFF.en.md) · [部署与恢复](AI-INSTALL.md) · [架构与接口](ARCHITECTURE.md) · [版本表](../README.md#client-versions)

## 从哪里接手

交接基线：2026-11-16。上游 ProkBot 基于 `3e9fe8c`。下表列出可以下载的版本；之后的改动用 `git log v1.2.1..main` 和 `git status --short` 核对。

| 层级 | 内容 |
| --- | --- |
| Plus Release `v1.2.1` | Android 旧版 WebView 兼容：`android/client/compat.js` 补齐官方界面直接调用的较新函数，页面没有启动时显示说明（[#3](https://github.com/ferretgeek/prokbot-plus/issues/3)）。其余与 `v1.2.0` 相同。 |
| Plus Release `v1.2.0` | 五个平台工具 ZIP 和 `SHA256SUMS.txt`。Windows 补丁接受官方 1.1.0：`windows/tools/desktop-recipes/` 生成 recipe，`mac/clients/desktop/` 增加按边注册、听写、搜索转接等 1.1.0 接口；0.71.2 输入移到 `windows/patchers/desktop/0.71.2/` 供 Android 使用。Host：`host/deploy.py`、`host/release/` 的备份、镜像识别和恢复；`host/runtime/` 的三种模型协议、流式响应和工具顺序；`host/server/`、`host/tools/host-admin.mjs` 的管理页和 CLI；`host/bench/` 容量测量。 |
| Plus Release `v1.1.0` (`43c6d59`) | 客户端工具发布，没有升级 Host；Windows 补丁仍要求 0.71.2。 |

Windows x64 补丁输入是 **1.1.0**；Mac ARM64 是 **0.71.2**；iOS 是 **1.16.0 (23152)**；自开发 Android 外壳是 **1.1.0 (10100)**，使用 Windows 0.71.2 界面。Host 输入为 `d0a4baa`，执行桌面为 `9d2ac1b`（`linux/amd64`）。截至 2026-11-14 的官方桌面版本是 **1.1.0**；Mac 1.1.0 尚未适配。

## 修改入口

| 工作 | 源码及联动 |
| --- | --- |
| Host、模型、管理页 | 部署入口是 `host/deploy.py`；`host/deploy/` 是容器内代码。`host/runtime/model-session.mjs` 按接口分派，`host/server/models.mjs` 保存配置。运行时代码改动须重建镜像。应用开发指南 `host/server/application-guide.md` 和 `host/runtime/teach-skill/SKILL.md` 由运行时读取。 |
| 桌面与 Android | Windows 和 Mac 主进程共用 `mac/clients/desktop/`；Windows 和 Android 共用 `windows/patchers/desktop/original.mjs`，Android 的 Windows 输入在 `windows/patchers/desktop/0.71.2/`。Android 网页桥接在 `android/client/`，Kotlin 在 `android/shell/`；仅改网页桥接不需重编外壳。改 Kotlin 后运行 `node android/shell/release-shell.mjs`，核对 `android/dist/` 与清单摘要。 |
| 更新官方输入 | 桌面 `*/patchers/desktop/supported.json` 和同目录 `recipes/manifest.json`；Android `android/patchers/supported.json`；iOS `ios/recipes/ios/manifest.json`；Host `host/recipes/host/manifest.json`。候选 recipe 与生产清单分开，逐文件核对原始和输出摘要。Windows recipe 由 `windows/tools/desktop-recipes/build.mjs` 按 `spec.mjs` 生成，加 `--check` 核对已提交文件可逐字节重现。 |

## 如何验证

完整源码仓库中，使用 Node.js 22.12+、Python 3.10+。以下检查无需启动现有服务器；每条测试命令单独运行。

```sh
node ci/check-inputs.mjs
node ci/homepage-versions.mjs
python -B host/deploy.py --help
node --test --test-concurrency=1 "host/tests/*.test.mjs"
node --test --test-concurrency=1 "windows/tests/*.test.mjs"
node --test --test-concurrency=1 "mac/tests/*.test.mjs"
node --test --test-concurrency=1 "android/tests/*.test.mjs"
```

本机在 Git 忽略的 `inputs/` 保有固定原包。Windows PowerShell 可在运行上面四套测试前设置可选的 Android 输入；否则依赖厂商制品的用例会跳过。Windows 和 Android 现在使用不同的原包。其他机器按相同清单准备各自的原包。

```powershell
$env:PROKBOT_ANDROID_TEST_SOURCE = (Resolve-Path 'inputs/windows/Grok_Bot_0.71.2_Setup.exe').Path
$windows = (Resolve-Path 'inputs/windows/Grok_Bot_1.1.0_Setup.exe').Path
node windows/patchers/desktop/patch.mjs --source $windows --verify-only
node windows/tools/desktop-recipes/build.mjs --source $windows --check
node android/patchers/patch.mjs --source $env:PROKBOT_ANDROID_TEST_SOURCE --verify-only
```

2026-11-16 发布 `v1.2.1` 前复验：Host 132 项通过、1 项仅限 Linux 的符号链接用例跳过；Windows 27/27（删除了两项 1.1.0 研究回放测试，新增 recipe 生成测试）、共享桌面 58/58、Android 56/56（含 0.71.2 原包和 4 项旧版 WebView 兼容测试）、CI 工具 45/45。旧版 WebView 在 Android 11 模拟器（WebView 83）和删除了较新函数的 Android 15 模拟器（WebView 124）上验证，没有鸿蒙「卓易通」真机。Host 的部署用例需要 Windows 自带的 `tar.exe`；在 Git Bash 中运行时，PATH 里的 `/usr/bin/tar` 会让两项用例失败，应把 `C:\Windows\System32` 放在前面。生成的 1.1.0 便携版已在 Windows 11 上连接自部署 Host 验收，范围见[桌面版本与兼容性](ARCHITECTURE.md#desktop-compatibility)。仍未验收：真实语音识别、实时语音连接真实 Host、对真实 Host 的断网重连（只用本地模拟 Host 验证），以及用安装包覆盖升级真实的 0.71.2 安装（只验证了复制的 0.71.2 配置目录）；Mac、iPhone 和 iPad 没有本轮真机验收。

## 运维与发布

- **部署：**新装用 `doctor → init → up → status`。已有实例沿用原 `--home`、`--project` 和拓扑，再运行 `update`。`--host-only` 是分机部署的 Host 半边；聊天还需要模型配置和启用的 amd64 执行节点。详见[部署手册](AI-INSTALL.md#split-host)。
- **恢复：**卷备份不含实例 `.env`、Docker 镜像或宿主机。`v1.1.0` 及更早版本的 `host/release/backup.py restore` 只恢复卷；`v1.2.0` 起有 `host/deploy.py recover --directory`，它记录不可变镜像 ID，停止旧身份，在新项目恢复并用原设备验证；切勿让旧镜像直接使用可能已迁移的卷。步骤见[卷备份与恢复](AI-INSTALL.md#volume-recovery)。
- **容量：**`host/bench/bench.py selftest` 是离线自检；`validate` 检查一轮，`compare` 比较同机型、同负载的基线和候选。分机要采两台整机。首页的最低（2 核 4 GB）和推荐（4 核 8 GB）配置来自 2C4G、4C8G 的功能记录和生产实例的实际占用，只针对个人使用；2C2G 两次限时诊断未达标；多客户端的一小时三轮持续负载还没测。见[容量证据](ARCHITECTURE.md#capacity-evidence)。
- **交付：**在已推送的干净提交运行 `python -B ci/release-packages.py --help`，以该提交打五个工具包并生成摘要。各包独立解压，Windows 包用 1.1.0、Android 包用 0.71.2 的固定 Windows 原包做 `--verify-only`；按仓库根目录 `AGENTS.md` 的发布流程核对标签、GitHub 首页和制品。Android 覆盖升级沿用原签名密钥；厂商程序和签好成品不在工具包内。
- **本地资料：**原包与测试签名位于 `inputs/`；2026-11-14 至 15 日的测试、基准数据和复验脚本在 `.cache/acceptance/receipts-20261115.zip`，内附逐项 `SHA256SUMS.txt`。访问资料、签名和归档均不随源码或 Release 分发。
