# P7 分批启用与回退演练记录（摘要）

任务：P7（34ZvIEYA65e0h1SG2cmfD）。运维说明见 [deepseek-harness-rollout.md](../../../deepseek-harness-rollout.md)。
演练分两轮，都在 HPC 上的隔离测试栈中进行，生产 Orbit 没有被改动。本目录不含任何 API Key 或 Key 密文。

- **第 1 版**（2026-10-06 03:48–04:00 UTC，候选 `5e5bfca23`）：完整的 S0–S5。
- **第 2 版**（05:23–05:42 UTC，最终候选 `a5d3d20d7`）：在新版本上补演 S3、EXECUTABLE 任务，以及二级回退与恢复，其余步骤沿用第 1 版。

## 环境与版本

| 项 | 值 |
|---|---|
| 主机 | HPC，Linux x64，Node v26.10.0，Go 1.27.1，Postgres 16（docker，tmpfs） |
| 栈 | gateway 127.0.0.1:2886，apiserver :3886，Postgres :5986（`stack/`） |
| 最终候选 | `a5d3d20d7c9e8ac8cf3f5c96419a93367e2a00e8`（项目分支尖端，含 D3 `1aa2a21c8`、F-P7-1 `b201b71a4`） |
| 部署与提交一致 | `setup.sh verify`：`git archive a5d3d20d7` 与部署源码做 `diff -rq`（排除依赖和构建产物），结果无差异 |
| 第 1 版候选 | `5e5bfca23`（P6 已验收）；与 P6 测试部署 `/var/tmp/p6-stack/src` 做 `diff -rq`，结果无差异 |
| runner 候选二进制 | a5d3d20d7：sha256 `79e223c5…c73929`；5e5bfca23：sha256 `5dd6a50a…17ac1`；两者都声明 `claude,codex,opencode,antigravity,dsh` |
| runner 旧版二进制 | 复制自 HPC 生产 runner 0.1.211：sha256 `b8b10ce7…55639`，声明 `claude,codex,opencode,antigravity` |
| dsh | 0.2.0-rc.2，`lib/bin.js` sha256 `1a03dee1…f307f`（两台 runner 一致，与 P0/P6 一致） |
| 数据 | P6 测试栈 DB 的 pg_dump 恢复（含 P6 的 dsh 配置 `deepseek-harness-2` 和历史 dsh 会话）。旧 `deepseek` 配置（runtime claude）在栈上通过 SQL 插入，Key 复用该栈中已加密存储的 Key，只在 apiserver 内解密 |
| runner | A：沿用 P6 runner 的身份和 `dsh-sessions/`（金丝雀）；B：新注册，第 1 版开始时未安装 dsh |

## 操作顺序与观察

R0–R4 为第 2 版（a5d3d20d7），S0–S5 为第 1 版（5e5bfca23）。

| 步骤 | 操作 | 观察 |
|---|---|---|
| S0 / R0 基线 | 两台 runner 都用 0.1.211 | capabilities 中没有 `provider:dsh`。新建 dsh 返回 409 升级提示（配置停用时为 400）。Claude A/B 新建和续聊、旧 deepseek（`claude -p --model deepseek-flash`）续聊均成功，runtime id 不变 |
| S0 | 入口关闭时给 P6 历史 dsh 会话发消息 | 消息被接受，会话 PENDING，错误为 `Provider is unavailable…`；没有被领取，进程 argv 中 dsh id 计数为 0 |
| S1 / R1 金丝雀 | 只升级 A | A 声明 `provider:dsh`，B 不声明。A 上的 Claude 会话被 reclaim 后续用原 id。R1：已有 dsh 会话 6cc29892 在 a5d3d20d7 上 `resumed:true` |
| S2 开放入口 | 启用 `deepseek-harness-2` | 在 A 上新建 dsh 会话：真实 deepseek-v4-flash 写入了文件，end_turn。旧版 B 返回 409。入口关闭期间暂留的 P6 会话消息在原 ACP id 98f42b24 上恢复执行 |
| **R2 S3**（a5d3d20d7） | B 升级到候选版，dsh 安装目录移走后重启 | B 声明 `provider:dsh`，但 `engines[dsh].installed=false`。新建 dsh 返回 **409 `DSH_NOT_INSTALLED: …install it from Providers, then try again`**。已有 B 会话 789127e0 的续聊被接受，**PENDING** 并显示同一提示；argv 中计数为 0，未被领取 |
| R2 S3 | `POST /runners/:id/install {engine:dsh}` | 约 30 秒后变为 installed 0.2.0-rc.2，CLI 哈希一致。暂留的续聊自动派发：`resumed:true`，**原 ACP id 789127e0**，回答 P7-WREN |
| S3（第 1 版，旧行为） | 同样的场景，在 5e5bfca23 上 | 会话被领取后才 FAILED（`DSH_NOT_INSTALLED`），即 F-P7-1；已由 b201b71a4 修复 |
| **R2 EXECUTABLE** | 任务 34b2tWfcTGqWG3eoTNqWK，provider `deepseek-harness-2`，验收命令 `python3 -c "import calc; assert calc.modulo(7, 3) == 1"` | 任务会话为 Default 模式：dsh 以只读文件策略启动，写文件出审批卡，Approve 后写入。turn_end 之后，runner 在工作区以 shell 运行验收命令（`isError:false`），任务被**机械判定为 DONE**（会话 SUCCEEDED，没有人工写状态） |
| S4a 一级回退 | 停用配置 | 新建 dsh 返回 400。已有会话 PENDING，错误为 `Provider is unavailable…`。argv 中计数为 0 |
| S4b / **R3 二级回退** | 两台 runner 都换回 0.1.211，入口保持开启 | capabilities 不再含 dsh。新建 dsh 返回 409。6cc29892 和 789127e0 的续聊都 PENDING 并显示升级提示。4 个 dsh ACP id（含任务会话 843de367）在 argv 中计数为 0。Claude A 续聊、旧 deepseek 续聊成功。`dsh-sessions` 指纹回退前后**逐字节一致**（第 1 版 12 个会话目录，第 2 版 13 个） |
| S5 / **R4 恢复** | 两台再换成候选版 | 暂留的消息自动执行：6cc29892 `resumed:true` 回答 P7-KESTREL；789127e0 `resumed:true` 回答 P7-WREN。旧 deepseek 续聊（共第 8 轮，id 399db662 不变）、B 上新建 Claude 均成功 |
| 审计 | `stack/audit.sql` | runtime≠dsh 的会话中，init sessionId 等于某个 dsh 会话 runtime_session_id 的次数：两轮都是 **0** |

## 失败分支

| 分支 | 触发方式 | 结果 | 恢复 |
|---|---|---|---|
| 配置停用 | PATCH enabled=false | 新建返回 400；续聊 PENDING | 重新启用，在原 ACP 会话续聊 |
| runner 是旧版 | 换回 0.1.211 | 新建返回 409；续聊 PENDING，不会落到 Claude | 升级 runner，在原 ACP 会话续聊 |
| 已声明但未安装 | 候选 runner 上没有 dsh 安装目录 | 新建返回 409 `DSH_NOT_INSTALLED`；续聊 PENDING | 安装 API，在原 ACP 会话续聊 |
| 审批未处理 | Default 模式的任务会话写文件 | 会话停在 RUNNING，等待审批 | Approve 后完成，任务判定 DONE |

无效 Key、429、断网、坏 SSE、max_tokens、SIGKILL 由 P6 用真 dsh 覆盖，本演练没有重做。

## 用量

| 轮次 | 真实 DeepSeek（dsh） | 旧 deepseek（Claude Code 估算） | Claude |
|---|---|---|---|
| 第 1 版 | 5 轮 | 5 轮，$0.606 | 7 轮，$0.672 |
| 第 2 版 | 5 轮（含 EXECUTABLE 任务） | 3 轮，$0.044 | 3 轮，$0.307 |

dsh 不报告费用，所以 dsh 那一列没有金额。旧 deepseek 一列是 Claude Code 按 Anthropic 价格的估算，不是 DeepSeek 账单。

## 复现

```
cd stack
CANDIDATE=<commit> bash setup.sh source && bash setup.sh build && bash setup.sh verify
bash setup.sh db                     # 需要 P6 栈的 p6-stack-pg 容器和 secrets.env
bash run-api.sh & bash run-gw.sh &
STACK_PASSWORD=… bash setup.sh login && bash setup.sh runners
bash run-runner.sh a|b legacy|candidate &          # 换二进制再重启，就是升级 / 回退
python3 drill.py state|new|turn|wait|enable|install|procs <acp-id…>|dshhome
python3 wait-task.py <taskId>
docker exec -i p7-stack-pg psql -U orbit -d orbit -AF ' | ' < audit.sql
```

`setup.sh` 中的 `REPO` 指向执行会话的工作区；换机器复现时请改成本地仓库路径。
`run-gw.sh` 使用 P6 栈的 `gateway.mjs`，本目录也附有一份。

## 未验项

- 生产部署；macOS/iOS 上的启用和回退操作；真实多主机 runner（两台 runner 在同一主机上，各自使用独立的 ORBIT_HOME）。
- Web 界面上的启用和停用操作：本次走 API（Web 入口链路已由 P5/P6 实测）。
- 已发布安装目录在运行中被删除的 5 分钟窗口（限制 1）：本次没有在运行中删除，而是删除后重启 runner，因此首次探测即报告未安装。
- `DSH_VERSION_INCOMPATIBLE` 的客户端提示、首次探测前 Web/macOS 显示 ready（限制 2、3）：没有实际演示。
- 平台不准入的提示未在真实 macOS runner 上实测（限制 4）。
- 旧 deepseek 续聊用的是栈上新建的会话；10-02 之前的生产历史会话已由 P6 在生产续聊验证。
