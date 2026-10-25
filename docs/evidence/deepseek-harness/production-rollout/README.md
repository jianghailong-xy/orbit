# DeepSeek Harness 生产上线记录（总览）

项目「DeepSeek Harness 生产上线」（34b78EQPNkVF8kM3ki7Ch），协调会话 34b78GE7Ud2aXWq8H1JsU。
上线的成果是项目 34ZurCP3bv9yLXGVyUGnx「DeepSeek Harness 原生接入（核心首版）」：dsh 的全部代码自 `99aba5994`（2026-10-06T03:11Z）起已在 main，合并提交 `25c3233c7` 补了运维文档、演练记录和一个测试修复。
操作依据是 [deepseek-harness-rollout.md](../../../deepseek-harness-rollout.md)（下称运维文档）与 [deepseek-harness-runtime-environment.md](../../../deepseek-harness-runtime-environment.md)；测试环境的演练记录见 [p7-drill](../p7-drill/README.md)。

本目录由上线记录任务 34bU21Lso7mbt1kJHBIvs 汇总。来源是下表四个任务的核对记录评论与完成证据，各篇末尾列出了出处；只收录这些记录里有据可查的事实。
时间一律为 UTC。全文不含任何 Key、Key 密文或令牌；会话、任务、请求和证据只写 id。

授权：账号所有者于 2026-10-06 授权部署上线，顺序为「先上 HPC，然后再上其他」，客户端也要发版。

## 分批记录

| 批次 | 记录 | 任务（项目判据） | 时间 | 版本 / 提交 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 批次 0：生产服务端 | [batch-0.md](batch-0.md) | 34bU203Yom9UZ0tdhcFCf（判据 1） | 2026-10-07 00:19–00:57Z；upgrade 00:31:54–00:34:35Z | 部署提交 `86203ffb0`（含 `25c3233c7`）；迁移最新 0392，本次没有新迁移 | 通过：没有任何 runner 安装 dsh；以 `deepseek-harness` 新建会话返回 409 `DSH_NOT_INSTALLED`；旧引擎续聊正常 |
| 批次 1：HPC 金丝雀 | [batch-1-hpc.md](batch-1-hpc.md) | 34bU20PaiYqeJGFp1cHqD（判据 2） | 2026-10-07 00:57–01:43Z；01:16:58Z 起 HPC 已装 dsh | runner 0.1.219（构建 `25cfa3b72`）；dsh 0.2.0-rc.2 | 通过：真实 Key 冒烟三轮 end_turn，恢复续聊 `resumed:true`、ACP id 不变；同时段其他 runner 都未安装；旧引擎复核通过 |
| 批次 2：其余 runner | [batch-2.md](batch-2.md) | 34bU211JgZyyUgzJcnZMp（判据 3） | 2026-10-07 01:42Z – 10-09 03:39Z；wikova 10-07 07:08–07:11Z 切换、10-08 13:31Z 起已装；workstation 10-09 03:16–03:18Z 切换、03:21Z 起已装 | 两台 runner 0.1.225；服务 PATH 换用 Node v26.10.0；dsh 0.2.0-rc.2 | wikova、workstation 已上线；Mac 未上线（`DSH_PLATFORM_UNSUPPORTED`） |
| 客户端发版 | [client-release.md](client-release.md) | 34bU21E5NHgp4MfVAFhmj（判据 4） | 2026-10-07 01:42–03:52Z；03:32:32Z 打标签 | `v0.1.2-beta.188` → `ceaf27657`（含 `25c3233c7`） | 已发布：release.yml 37567236040 的 macOS 签名公证 DMG 与 iOS TestFlight 都 success |

顺序与授权一致：HPC 在 2026-10-07T01:16:56Z 的心跳第一个上报 dsh 已安装，批次 1 期间另外三台 runner 四次核对都未安装；wikova、workstation 在批次 1 通过后才切换和安装；客户端标签打在批次 1 判为 DONE（01:42:15Z）之后。

批次 0 之后，生产服务端又被其他会话部署过多次（不属于本项目），记录里提到的有：`38b8f366b`（runner 0.1.220，10-07 03:37Z 起在 /dl）、`721e48275`（10-08 15:32Z）、`3369ee1e0`（10-08 21:39Z）。

## 回退

### 执行情况

全程没有执行过一级或二级回退，所以没有运维文档第 4 节检查清单的结果可附。

- 批次 0：前三次运行被派到 provider opencode，启动即失败，0 轮、没有执行任何命令，没有动过生产栈，不需要回退。
- 批次 1：任务第 9 步（出问题时回退）没有触发；`deepseek-harness` 一直是 enabled；没有手动重启 HPC 的 runner 服务。
- 批次 2：回退条件（原生模块加载失败、runner 起不来、会话恢复异常）都没有触发。唯一一次「恢复」是 workstation 第一次切换命令的自我保护：复读 `/dl/version.json` 时 Python urllib 被 Cloudflare 回了 HTTP 403，脚本判为不一致，把 runner 二进制恢复为原来的构建；没有放 drop-in，也没有重启，状态与改动前一致。
- 客户端发版：构建一次成功，「失败时最多自行重跑一次」没有用上。

### 可用的回退目标

| 级别 | 做法 | 目标与核对 |
| --- | --- | --- |
| 一级（优先） | 停用 `deepseek-harness` 配置：以账号身份 `PATCH /api/providers/mine/<id> {"enabled":false}`，或在 Web 上停用。不换二进制，不重启 | 配置 `deepseek-harness`（id 01a10ee3-31dd-73ad-b11d-2ab3c8fcb834，runtime dsh，preset deepseek-harness），账号下 runtime 为 dsh 的配置只有这一条。最近一次只读复读在 2026-10-09 workstation 安装 dsh 之前：enabled，updated_at 仍为 2026-10-06T01:45:32.893Z |
| 二级 | 在出问题的 runner 上换回 0.1.211 二进制，用 systemd drop-in 给该 runner 的服务设 `ORBIT_NO_SELFUPDATE=1`，然后重启；回退后按第 4 节检查清单核对并附结果 | HPC 上的 `/root/.orbit/rollback/orbit-0.1.211-linux-x64`：版本 0.1.211，sourceSha `728c3feb45a67b7e61e2922e79927fafb508d626`，sha256 `b8b10ce73e6232f3dce52d4dbd4f995c9f32d0b985bcb40c8b36b77d98655639`，13602976 字节。批次 1 于 2026-10-07T00:58:33–00:59:01Z 核对 sha256、`version`、`capabilities --json` 的 sourceSha 三项一致，01:38:01Z 复核 sha256 仍一致 |

- 运维文档第 4 节对两级的预期：一级之后新建 dsh 会话返回 400 `provider not available`，已有会话的新消息排队、PENDING，不派发也不改走 Claude，重新启用后在原 ACP 会话继续；二级之后该 runner 不再声明 provider:dsh，新建 dsh 会话返回 409 升级提示，已有会话 PENDING。两级都在测试环境演练过（[p7-drill](../p7-drill/README.md)），生产上没有执行过。两级都不删除 provider 配置、`dsh-sessions/` 和 `engines/dsh/`。
- 二级在 HPC 上的逐步做法（含第 4 节检查清单要用的冒烟会话与 ACP id）见 [batch-1-hpc.md](batch-1-hpc.md#3-hpc-二级回退步骤只记录未执行)。作业指导：真要在某台 runner 上执行二级回退，就换回该二进制，并用 systemd drop-in 给该 runner 的服务设 `ORBIT_NO_SELFUPDATE=1` 后重启，否则它会在 10 分钟内自更新回最新版。728c3feb 的 selfupdate.go:143 支持这个变量（批次 1 核对）。
- 同一构建（sha256 相同）的 0.1.211 曾是 workstation 的 runner 二进制（文件 mtime 2026-10-05T22:34:07Z），一直连着生产服务端执行 FineWeb 的回合，到 2026-10-08T17:54Z 才在空闲时自更新为 0.1.225（批次 2 记录）。
- 汇总时复核（2026-10-09T03:44:31Z，本任务会话 3xxe9UF6Pk8zdFXlzVvcpc，在 HPC 上只读，没有执行该二进制）：文件仍在，13602976 字节，sha256 一致。

### 批次 2 Node 改动的回退

- wikova、workstation：删除 `/etc/systemd/system/orbit-runner-root.service.d/10-node26-path.conf`，`systemctl daemon-reload`，在没有进行中回合时重启。unit 原文副本：wikova 的 `/var/tmp/orbit-b2/rollback/wikova-orbit-runner-root.service`，workstation 的 `/var/tmp/orbit-b2/rollback/workstation-orbit-runner-root.service`（sha256 `753b4729…cbf2`）。
- 作业指导写的是「删掉 drop-in、daemon-reload、用 Node 22 按 lockfile 重装 wikova 依赖、空闲时重启」。批次 2 没有重装 wikova 的依赖（切换后 lockfile 的 sha256 核对未变，node_modules 的 mtime 仍为 2026-04/05/06），所以回退时也不需要重装。
- workstation 还留有切换前的 runner 二进制 `/var/tmp/orbit-b2/rollback/orbit-before-switch2`（0.1.225，构建 `721e48275`，sha256 `6b127daa…`）。它声明 provider:dsh，不是二级回退的目标。
- 两台都没有设 `ORBIT_NO_SELFUPDATE`，自更新照常。

## Runner 盘点

账号下共 4 台 runner，各次盘点时都在线。最终盘点为 2026-10-09T03:26:54.824Z 的 `GET /api/runners`（HTTP 200）。

| runner | 平台 | 批次 0 时（2026-10-07 00:44Z） | 最终（2026-10-09 03:26Z） | 首个 installed:true 心跳 | 上线情况 |
| --- | --- | --- | --- | --- | --- |
| workstation-gpu（HPC，主机名 workstation）34P34HcKKoFRn2j9KitgJ | linux | 0.1.219，声明 provider:dsh，`DSH_NOT_INSTALLED` | 0.1.225，ONLINE，installed:true，0.2.0-rc.2 | 2026-10-07T01:16:56Z | 已上线（批次 1 金丝雀） |
| wikova（主机 vmi3129740）33aHx39nnWbvJhYO2blSk | linux | 0.1.219，声明 provider:dsh，`DSH_NODE_UNSUPPORTED` | 0.1.225，ONLINE，installed:true，0.2.0-rc.2 | 2026-10-08T13:31:13Z | 已上线（批次 2） |
| workstation（另一台机器，登记主机名 gateway）33yiv1Y24wrKHcVCo8Fk5 | linux | 0.1.211，不声明 provider:dsh，`DSH_NODE_UNSUPPORTED` | 0.1.225，ONLINE，installed:true，0.2.0-rc.2 | 2026-10-09T03:21:37Z | 已上线（批次 2） |
| longdeMac-mini.local 349tsNoHC7biW3WXF1ddp | darwin | 0.1.213，不声明 provider:dsh，`DSH_PLATFORM_UNSUPPORTED` | 0.1.225，ONLINE，声明 provider:dsh，installed:false，`DSH_PLATFORM_UNSUPPORTED` | — | 未上线：dsh 不支持 macOS；没有调用 install，没有派发 dsh 会话，没有需要回退的改动 |

生产 DB 的 runner 表另有 4 行属于其他账号，不在本次上线范围内（批次 2 记录）：

| runner | 状态 | 最近心跳 |
| --- | --- | --- |
| vmi3129740（与 wikova 同主机，非 root，orbit-runner-husong.service） | 0.1.210，ONLINE，本次没有动 | 在线 |
| codex-steer-smoke | OFFLINE | 2026-08-21 |
| laotan | OFFLINE | 2026-08-03 |
| e2e-workdir | OFFLINE | 2026-06-16 |

## 与运维文档、作业计划不一致之处及决定

1. 「未声明 dsh」不再可控，金丝雀改以安装为界。
   - 运维文档：第 3 节批次 0 要求所有 runner 的 capabilities 都没有 provider:dsh，批次 1 靠升级金丝雀 runner 的二进制让它声明 dsh。
   - 生产实际：发布指针 runner-release.json 为 rolloutPercent 100，runner 在没有进行中回合时会自更新到生产 /dl 的最新版；0.1.214 起的 runner 都声明 provider:dsh，生产 /dl 上已没有不声明 dsh 的版本。HPC 在 2026-10-06T11:03Z 已自更新到 0.1.219。批次 0 时 wikova 与 HPC 都已声明 dsh，对 HPC 新建 dsh 会话得到的是 409 `DSH_NOT_INSTALLED`，不是升级提示；没有对未声明 dsh 的 runner 测过升级提示。
   - 决定：金丝雀以「安装 dsh」为界。dsh 默认不自动安装，服务端对已声明但未安装的 runner 回 409 `DSH_NOT_INSTALLED`、不派发。项目验收判据 1、2 按此修订为第 2 版，账号所有者 2026-10-06T23:47Z 批准。
2. 生产 /dl 退不到 ≤ 0.1.211，二级回退要留存二进制并暂停自更新。
   - 运维文档：第 4 节二级回退为「把 runner 换回上一个发布版（≤ 0.1.211）并重启」。
   - 生产实际：2026-10-07 时生产 /dl 为 0.1.219，/dl/previous 已是 0.1.217（声明 dsh），发布指针退不到 ≤ 0.1.211；之后 /dl 继续前进（10-07 03:37Z 起为 0.1.220，10-09 时为 0.1.225）。换回旧二进制而不停自更新，runner 会在 10 分钟内自更新回最新版。
   - 决定（协调会话 2026-10-07）：一级回退不需要换二进制，优先使用；二级回退的目标是 HPC 上留存的 0.1.211 二进制（批次 1 已放好并核对），执行时用 systemd drop-in 设 `ORBIT_NO_SELFUPDATE=1` 后重启，回退后按第 4 节检查清单核对并附结果。
3. beta.185 / 186 早于金丝雀。
   - 计划：客户端在批次 1 冒烟通过后发版。
   - 实际：v0.1.2-beta.185（`86c6d2d4d`，2026-10-06 10:11Z 打标签）与 beta.186（`51f0cdfee`，10-06 15:42Z）由其他会话在金丝雀之前打出，都包含 `25c3233c7`，release.yml 的两个任务都 success。beta.187（`6c6528dbb`，10-06 23:47Z）由另一项目的任务 34b6gj4DZ8BJhmxRBO9Bw 打出，同样早于金丝雀。
   - 决定：如实写进上线记录，不复用；批次 1 之后没有别人打出新标签，客户端发版任务在 2026-10-07T03:32:32Z 新打 v0.1.2-beta.188。
4. 生产 apiserver 2026-10-06 23:14Z–23:43Z 曾无响应。
   - 实际：发生在批次 0 之前，约半小时。批次 0 统计 apiserver 日志，Prisma 事务超时集中在 23:20–23:50Z，之后回落。上一次部署 `a3b4753d6` 的 upgrade.sh 跑在 23:13:06–23:17:57Z，只覆盖这段时间的开头，后面约 25 分钟不是 upgrade.sh 本身造成的。10-07 00:27Z 主机 swap 几乎用满（8187.7 / 8192 MiB），僵尸进程 1536 个。
   - 决定：协调会话要求批次 0 部署前后都看 apiserver 日志和健康状态，异常就停下报告。批次 0 部署前 health 为 ok、错误率已回落，照常部署；部署后到 00:50Z 没有事务超时。原因没有调查，本项目也没有为它建任务。
5. `resumed:true` 只出现在新起的 dsh 进程里。
   - 运维文档：第 3 节批次 1 第 5 步为「续聊时 `resumed:true`、ACP 会话 id 不变」。
   - 实际（批次 1）：init 只在 dsh 进程启动时发，同一个 warm 进程内的续聊没有新的 init；warm 进程空闲 4 小时或被 LRU 回收后，续聊才冷启动并带 `resumed:true`。
   - 决定：协调会话 2026-10-07T01:30Z 选方案 A，用 session_end 加 resumeIfEnded 补一轮冷启动续聊（得到 `resumed:true`，ACP id 不变）；批次 2 不再要求同一进程内的续聊出现 `resumed:true`；列入已知限制。
6. wikova、workstation 的服务 PATH 中是 Node 22。
   - 运维文档：第 1、2 节要求服务 PATH 中为 Node 26。
   - 实际：批次 0 实测两台的 `engines[dsh]` 都报 `DSH_NODE_UNSUPPORTED`；workstation 的 runner 停在 0.1.211，自 10-05 起一直有进行中回合，不自更新。
   - 决定：账号所有者 2026-10-07T00:58:34Z 在 ask_owner 34bVbpt27vgsugOmz7mmq 中选择「两台都改」：为两台的 runner 服务换用独立安装的 Node 26（systemd drop-in，只改 runner 服务的 PATH），把 workstation 的 runner 升级到最新，空闲时各重启一次。
7. wikova 仓库依赖与 Node 版本。
   - 实际：批次 2 只读核对（10-07 01:54Z）发现 wikova 仓库的 CI 用 Node 20、Dockerfile 用 node:22，wikova 上两个主目录装着含原生模块的依赖，命中停止条件；两台都没改，报告了协调会话（请求 34bWxt4krBtDDcogRftrw）。
   - 决定：账号所有者 03:26:52Z 在 ask_owner 34bZCiT7ADYUXoTBCRnwq 中选择「照改并重装 wikova 依赖」。协调会话 03:52Z 核对后在授权范围内收窄：适用于本机平台（linux-x64 glibc）的 10 个原生模块都是 N-API 预编译件，在 Node 22 和 26 下都能加载，所以不重装依赖，改为切换后在新 runner 环境里复测（复测 10/10 成功）；workstation 的 /root/wikova 没有 node_modules，不需要重装。
8. workstation 没有无回合窗口。
   - 实际：workstation 运行着 FineWeb（项目 01a02d83）的 WARC 流水线，自 10-05 起没有过无回合的时刻。
   - 决定：账号所有者 2026-10-07T04:03:45Z 在 ask_owner 34bZsuanb5Xf6ue22DACP 中选择「暂停 FineWeb 派发」；FineWeb 于 10-08T15:08:51Z 暂停（paused_reason OWNER）。workstation 10-09T03:17Z 切换后，03:20:34Z 通知协调会话可以恢复派发；恢复由账号所有者在 Web 上操作，到 03:25:35Z 仍是暂停。
9. wikova 重启的空闲判定漏了集成作业。
   - 实际：守门脚本只看会话和 bg 作业。2026-10-07T07:08Z 的重启在 runner 进程 stop 超时（180 秒）后被 SIGKILL，打断了集成作业 0d3afadd（LAND_TASK，项目 01a0f53a）的合并前检查；它被重新认领后从头重跑，以超时记为 CHECK_FAILED，所属项目与任务都已 DONE。
   - 决定：10-08T13:36:48Z 报告协调会话（请求 34cNZloTXxZIoOTlZwGSz）；没有再去唤醒那个已结束项目的协调会话；workstation 的空闲判据补上了「没有未结束的集成作业」。
10. 批次 1 安装前的磁盘门槛。
    - 实际：HPC 根分区可用 1.1G，低于安装前至少 5G 的要求。
    - 决定：协调会话先等、不降门槛、不删任何东西，并发出 ask_owner 34bVjfC1OHDtXIt5vkkWP；账号所有者 2026-10-07T01:03:27Z 选择「照上次清缓存和闲置目录」（一次性授权），安装门槛调为 ≥ 2.5G。清理了缓存和 2616 个闲置的 /tmp 顶层目录（28.61 GiB），可用空间升到 31G。
11. 执行用的 provider。
    - 实际：批次 0 前三次运行在未指定 provider 时被派到 opencode，启动即失败；workstation 上 Claude Code 未登录，在那里建 claude 会话返回 409 `ENGINE_SIGNED_OUT`。
    - 决定：账号所有者 2026-10-07 选择所有任务固定用 provider claude；workstation 的旧引擎复核改用旧 deepseek。2026-10-08 账号所有者指示「全部上线就好」后，协调会话把批次 2 任务的 provider 改为 anthropic-2。

## 已知限制

项目作业指导列出的已知限制（不阻断上线）：

1. dsh 只在 Linux x64 / Node 26 上验证过；macOS/Windows 的 runner 会返回 `DSH_PLATFORM_UNSUPPORTED`。生产上的 Mac runner 正是这样上报的，记为未上线。
2. `DSH_VERSION_INCOMPATIBLE` 没有客户端修复卡；runner 首次引擎探测前，Web/macOS 状态显示 ready。
3. 安装目录事后被删除时，最多约 5 分钟加 25 秒内可能领取后失败。
4. 没有全局 dsh 开关：账号级回退要靠回退 runner（第 4 节二级）。
5. dsh 会话日志上传默认已关闭；请求头中的随机会话 ID 无法关闭。
6. `resumed:true` 只出现在新起的 dsh 进程里；同一进程内的续聊不会产生新的 init（批次 1 实测，运维文档第 3 节第 5 步的写法与之不符）。

上线过程中新发现或确认的：

1. dsh 的 effort：dsh 模型目录只提供 off / low / high / max 四档。runner 还没上报 dsh 模型目录（`engines[dsh].dsh.modelCatalogReadable` 为 false）时，目录以外的 effort（如工作区默认的 xhigh）会原样下发，会话在启动时失败（workstation 第一次冒烟）；install 不会触发目录刷新。规避办法是建 dsh 会话时显式选 high 或 max。协调会话的决定：列为已知限制；修复属于产品侧改进，不在本项目范围，已作为待办候选报给账号所有者。
2. /dl 以同一版本号 0.1.225 重建过多次，自更新只比较版本号，三台 Linux runner 跑着不同构建（wikova `29f49af63`，workstation `3369ee1e0`，HPC 未核对）。协调会话的决定：本项目不另做动作，下一次换版本号的发版后自然收敛。
3. 未选模型时，首轮 session 行的 model 为空字符串（运维文档第 6 节第 6 条，F3；批次 1 实测）。
4. 安装后机器探针上报的 credentialPresent、modelCatalogReadable 为 false，requestValidation、auth 为 unknown：探针没有会话 Key，与 runtime-environment 文档一致。HPC 与 wikova 之后上报了 modelCatalogReadable true。
5. dsh 进程恢复后，第一次 edit 因「先读后改」状态被重置而失败一次，模型重读后成功（批次 1）。
6. 结束会话后立刻带 resumeIfEnded 发消息会得到 409「the session is ending」，要等 runner 确认结束（批次 1 约等了 26 秒）。
7. 生产上没有做 Default 模式写文件的审批卡和 EXECUTABLE 任务冒烟：批次 1 用 auto；批次 2 用 default，但只问只读问题，没有出现审批卡。
8. macOS/iOS 客户端只有 CI 构建与模拟器证据，尚未在真实 Harness 会话和实机上操作过（已写进 Release 说明）；TestFlight 只确认到上传成功，DMG 的 codesign / spctl、启动和 Sparkle 更新没有在 Mac 上核对。
9. upgrade.sh 即使 apiserver 的构建全部命中缓存也会重建它，部署窗口内 `/api/health` 有约 30–45 秒的 502（批次 0）。

## 遗留事项

- FineWeb 派发的恢复由账号所有者在 Web 上操作；到 2026-10-09T03:25:35Z 仍是暂停。
- 2026-10-06 23:14–23:43Z apiserver 无响应的原因没有调查。
- dsh effort 的修复已作为待办候选报给账号所有者。
- workstation 上 nvm Node 22 全局包里的 27 个 .node 文件没有在 Node 26 下测；workstation 的 codex 切换前就因缺可选依赖不可用。
- HPC 根分区紧张（批次 1 收尾时可用 28G），主要占用方不属于本项目。

## 来源与证据

| 任务 | 完成证据 | 核对记录（任务评论） | 其他评论 |
| --- | --- | --- | --- |
| 批次 0 34bU203Yom9UZ0tdhcFCf | 5TT2CwyxVKJyZUB4q8sQp9（2026-10-07T00:55:08Z） | 34bVUtZhZJKPg5vaNEraQ、34bVVZniyRQhTZsaycMVi | 判断会话 34bUm2gmhaole2TfcL5D2、34bVBk663JQQc3UX7L60p、34bVE1TPZyB8isNhTi0dT |
| 批次 1 34bU20PaiYqeJGFp1cHqD | 2ceKYThqt026vUSBriEg8U（2026-10-07T01:41:48Z） | 34bWJSRaLccPfwGzg9zn3、34bWQekNxe7R7UuCzP3xL、34bWcqMdtdwnVSQHOlIKK | 判断会话 34bVE6H14zNbue2Xz5s7v |
| 批次 2 34bU211JgZyyUgzJcnZMp | 2lP1zWUB41fWNg8TumoKL6（2026-10-09T03:39:32Z） | 34bZxZ91vgYrRhq0T3AHN、34cNf7D2aAnIixVqzT2KO、34cNg4PMS0fOW2LxgzBZV、34ci68TpcntdwuSXxhL3U、34ci7YnI3A0pTfEJwUReI、34ciATVGSeq9k6YNykzBb | 协调会话 34baBgx9kiCI7Bpe9kufy、34cNFOWfjcF5uL15VLPaY；判断会话 34cQJXQrC2YgEnyTY1ggO、34cQcXPmNuSTVwbo4q3Ur、34cSSFOXGIXDcpbLPSW36 |
| 客户端发版 34bU21E5NHgp4MfVAFhmj | 6HSuRjBz4IbCVAdEkHvgLp（2026-10-07T03:49:49Z） | 34bZo5EyfjBtEuETTvrYI | 判断会话 34bUm84qjhHNgxUU8DzF6 |

项目目标、验收判据和作业指导（「生产现状」「回退准备」「已知限制」三节）取自项目 34b78EQPNkVF8kM3ki7Ch 本身。

## 去敏

- 本目录只写会话、任务、请求、证据、提交的 id，以及公开文件的哈希；没有 Key、Key 密文、令牌、签名值或私钥。
- 各批记录贴出前已按 API Key 与 JWT 的字符形态扫描过；本目录提交前做了同样的扫描。
- 需要用户身份的接口用的是在 apiserver 容器内签发、有效期 1 小时的令牌，存在 /dev/shm（0600），没有打印；批次 0、批次 1 记录了用后删除。客户端发版用本机已登录的 gh，命令和输出里都没有令牌。
