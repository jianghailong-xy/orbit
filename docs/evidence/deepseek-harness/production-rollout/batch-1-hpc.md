# 批次 1：HPC 金丝雀

任务 34bU20PaiYqeJGFp1cHqD，对应项目验收判据 2。总览见 [README.md](README.md)。
执行工作区 orbit-develop，即 HPC：runner workstation-gpu（34P34HcKKoFRn2j9KitgJ），主机名 workstation，系统服务 orbit-runner-root.service。
执行会话 7coQ2gzzMpTcKBRwVy1yR9（2026-10-07 00:57:21–01:43:23Z）。需要用户身份的接口和生产 DB 的只读 SQL，由 orbit-prod 会话 34bVfsM0LGvLeHDhFhg8U 代办。
时间一律为 UTC，日期都是 2026-10-07。

## 概要

| 项 | 值 |
| --- | --- |
| runner | 0.1.219；构建 sourceSha `25cfa3b72e748cc52d6142a9be170d769035340b`（包含 `25c3233c7` 与 `99aba5994`）；二进制 sha256 `b425ce087b0064e0124b727cbf9baa938e941ac1d7769e60251eab7cbe850c5d` |
| 服务 PATH 中的 Node | v26.10.0（/usr/local/bin/node） |
| dsh | 0.2.0-rc.2。01:16:13.796Z 调用 install，01:16:58.808Z 起服务端为 installed:true；安装在 /root/.orbit/engines/dsh/0.2.0-rc.2，`lib/bin.js` sha256 `1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f` |
| 入口 | 现有配置 `deepseek-harness`，沿用现有 Key，enabled |
| 冒烟 | 会话 34bW9GrXCTtz5LJylOaE1：三轮 end_turn，结束后恢复的续聊为 `resumed:true`，ACP 会话 id 始终不变 |
| 同时段其他 runner | 四次核对都不是 installed:true |
| 旧引擎 | Claude 新建与续聊、Claude 样本续聊、旧 deepseek 续聊都成功，runtimeSessionId 不变 |
| 回退准备 | 0.1.211 二进制已放到 /root/.orbit/rollback/，三项核对一致；HPC 的二级回退步骤已写明，未执行 |
| 回退 | 没有执行 |
| 结论 | 通过 |

## 1. 前提（00:58:00–00:58:08Z）

- `/usr/local/bin/orbit version` 为 0.1.219，等于 `https://orbitd.io/dl/version.json` 的 version（/dl/previous 为 0.1.217），不需要等自更新。
- `readlink /proc/1243/exe`（1243 为服务的 MainPID）的结果是 /usr/local/bin/orbit，没有 (deleted)。
- 来源：journal 记录 2026-10-06T11:03:24Z「orbit 0.1.219 update available and no turn in flight」，随后「orbit 0.1.211 -> 0.1.219 … restarting」，同一个 PID 原地 re-exec。
- 00:33Z 生产 /dl 的 linux-x64 包已由 `86203ffb0` 重编（批次 0），但版本号没变，runner 只比较版本号，所以 HPC 仍在运行 `25cfa3b72` 构建的 0.1.219，这是预期状态。
- 服务 PATH 中 `node --version` 为 v26.10.0。
- `df -h /` 可用 3.5G（00:58:00Z），之后降到 1.1G，低于安装前至少 5G 的要求，见第 4 节。

## 2. 回退准备（00:58:33–00:59:01Z）

- 把 /var/tmp/p7-stack/bin/orbit-legacy（sha256 与 [p7-drill](../p7-drill/README.md) 记录的 runner 旧版二进制相同）复制到 `/root/.orbit/rollback/orbit-0.1.211-linux-x64`：目录权限 0700，文件 0755，13602976 字节，`cmp` 与源文件相同。
- 三项核对全部一致：
  - sha256：`b8b10ce73e6232f3dce52d4dbd4f995c9f32d0b985bcb40c8b36b77d98655639` ✓
  - `version`：0.1.211 ✓
  - `capabilities --json` 的 sourceSha：`728c3feb45a67b7e61e2922e79927fafb508d626` ✓（cliVersion 0.1.211）。已读 728c3feb 的源码确认，这条命令只在本地构造输出，不联网。
- 728c3feb 的 selfupdate.go:143 支持 `ORBIT_NO_SELFUPDATE`。
- 01:38:01Z 复核 sha256，仍然一致。
- 汇总时复核（2026-10-09T03:44:31Z，上线记录任务会话 3xxe9UF6Pk8zdFXlzVvcpc，只读，没有执行该二进制）：文件仍在，13602976 字节，sha256 仍为 `b8b10ce7…98655639`；HPC 上没有 orbit-runner-root.service 的 drop-in；`/usr/local/bin/orbit version` 为 0.1.225。

## 3. HPC 二级回退步骤（只记录，未执行）

执行前提：

- 先做一级回退（停用 `deepseek-harness`），只有 runner 侧故障才走二级。
- 二级要重启 orbit-runner-root.service，本机所有会话（包括协调会话）都会被 reclaim。执行时间由协调会话或账号所有者决定。

步骤：

1. 留存当前二进制：`cp --preserve=mode,timestamps /usr/local/bin/orbit /root/.orbit/rollback/orbit-0.1.219-linux-x64-25cfa3b72`。批次 1 时 HPC 是 0.1.219；到 2026-10-09 已自更新到 0.1.225，执行时文件名按当时的版本和构建写。
2. 核对回退件：`sha256sum /root/.orbit/rollback/orbit-0.1.211-linux-x64` 应为 `b8b10ce7…`，`/root/.orbit/rollback/orbit-0.1.211-linux-x64 version` 应为 0.1.211。
3. 关闭自更新（批次 1 时没有任何 drop-in）：`install -d /etc/systemd/system/orbit-runner-root.service.d`，写入下面的 `/etc/systemd/system/orbit-runner-root.service.d/10-rollback-no-selfupdate.conf`，然后 `systemctl daemon-reload`。

   ```ini
   [Service]
   Environment=ORBIT_NO_SELFUPDATE=1
   ```

4. 原子替换二进制：`install -m 0755 /root/.orbit/rollback/orbit-0.1.211-linux-x64 /usr/local/bin/orbit.rollback && mv -f /usr/local/bin/orbit.rollback /usr/local/bin/orbit`。
5. 重启：`systemctl restart orbit-runner-root.service`。unit 为 `ExecStart=/usr/local/bin/orbit run`、`KillMode=mixed`、`TimeoutStopSec=180`，runner 会先 drain。
6. 核对 runner 本身：`/usr/local/bin/orbit version` 为 0.1.211；`readlink /proc/$(systemctl show -p MainPID --value orbit-runner-root.service)/exe` 不带 (deleted)；该 PID 的环境含 `ORBIT_NO_SELFUPDATE=1`；过 10 分钟，journal 里没有出现「update available … stopping claims」。
7. 按运维文档第 4 节检查清单核对：
   - `GET /api/runners` 中 HPC 的 capabilities 不再含 provider:dsh，同时看 `engines[dsh]` 和 `deepseek-harness` 的 enabled；
   - 对冒烟会话 34bW9GrXCTtz5LJylOaE1 发一条消息，应停在 PENDING 并显示升级提示；
   - `ps -eo args | grep a068effa-91bd-4ef4-9949-cd7e5d095546` 没有进程；
   - [audit.sql](../p7-drill/stack/audit.sql) 第二条的计数为 0；
   - Claude 新建、Claude 续聊、旧 deepseek 续聊都成功。
8. 不删 /root/.orbit/dsh-sessions/ 和 /root/.orbit/engines/dsh/，不删任何 provider 配置。

恢复：删掉 drop-in 并 daemon-reload，换回第 1 步留存的二进制（或者删掉 drop-in 后让自更新拉最新版），重启；确认 `engines[dsh]` 为 installed:true 后再启用配置。

## 4. 磁盘与清理（账号所有者授权）

授权经过：

- 01:01Z 用 project_send 报告协调会话：根分区可用 1.1G，安装要求至少 5G。
- 协调会话决定先等、不降门槛、不删任何东西，并发出 ask_owner 34bVjfC1OHDtXIt5vkkWP。
- 账号所有者 01:03:27Z 选择「照上次清缓存和闲置目录」，这是一次性授权，由协调会话转达；同时把安装门槛调为 ≥ 2.5G。

清理过程：

- 清理前（01:06:15Z）：`df -B1G /` 可用 1G（915G 盘，已用 906G）。
- 缓存（01:06:15–01:06:16Z）：`go clean -cache` 清掉 /root/.cache/go-build 1.9G；`uv cache clean` 76.3MiB；`pip3 cache purge` 0 个文件；`docker builder prune -a -f` 0B。
- /tmp 顶层目录共 4450 个（01:06:21Z 现场重算）。跳过 48 小时内有改动的 1818 个、正被占用的 11 个（依据 /proc 下各进程的 cwd、exe、fd、maps，unix socket 路径和 docker 容器挂载）、系统目录 5 个；被 /tmp 以外的符号链接指着的目录也排除在外。最终候选 2616 个。
- 01:08:45–01:09:33Z 删除：每个目录删除前重新核对占用和 48 小时内有无改动，再 `rm -rf --one-file-system`。2616 个全部删除，共 30003856 KiB（28.61 GiB），跳过 0 个。
- 清理后（01:09:33Z）可用 31G（已用 875G，97%）。
- 没有动的：/var/tmp（包括 p6-stack、p7-stack、p23b1、p0drift）、/root/.cache/huggingface、vllm、/root/.orbit/worktrees、/root/.npm、docker 镜像和数据卷。
- 删除清单在 HPC 的 /root/hpc-cleanup/2026-10-07-batch1/：deleted.tsv（sha256 `da7b45e91a9026f0682f00422f1c68aa92a49a02e977371407570f3ca9418ddf`）、plan.tsv（含跳过原因，sha256 `6ac7a8e792a3a79e765631c05c7183094890889a3e687693ca7963fd87fd0087`）、脚本 cleanup-b1.sh 和各步日志。

## 5. 服务端视角，安装前（01:02:32Z）

orbit-prod 调用 `GET /api/runners`，HTTP 200，共 4 台，都是 ONLINE。

| runner | 版本 | 心跳 | 含 provider:dsh | selfUpdate | engines[dsh] |
| --- | --- | --- | --- | --- | --- |
| workstation-gpu（HPC）34P34HcKKoFRn2j9KitgJ | 0.1.219 | 01:02:26.186Z | 是 | enabled，/usr/local/bin | installed:false，`DSH_NOT_INSTALLED` |
| wikova 33aHx39nnWbvJhYO2blSk | 0.1.219 | 01:02:09.377Z | 是 | enabled，/usr/local/bin | installed:false，`DSH_NODE_UNSUPPORTED` |
| workstation 33yiv1Y24wrKHcVCo8Fk5 | 0.1.211 | 01:02:08.247Z | 否 | null | installed:false，`DSH_NODE_UNSUPPORTED` |
| longdeMac-mini.local 349tsNoHC7biW3WXF1ddp | 0.1.213 | 01:02:18.402Z | 否 | null | installed:false，`DSH_PLATFORM_UNSUPPORTED` |

- 四台的 `engines[dsh].dsh` 相同：versionCompatible、credentialPresent、modelCatalogReadable 都是 false；requestValidation、sandboxEnforcement、auth 都是 unknown。
- 只读 SQL：runtime 为 dsh 的配置只有 `deepseek-harness`（01a10ee3-…，preset deepseek-harness，enabled=true，updated_at 2026-10-06T01:45:32.893Z）；provider 为 deepseek-harness 或 dsh 的会话为 0 个。
- 判定：HPC 声明 provider:dsh 且未安装 ✓；其他 runner 都不是 installed:true ✓。

## 6. 安装 dsh

- 安装前（01:10:21Z）：可用空间 31G，高于 ≥ 2.5G 的门槛；服务 PATH 中的 npm 为 11.19.1，registry 为 `https://registry.npmjs.org/`；`npm view @deepseek-ai/dsh@0.2.0-rc.2 version` 返回 0.2.0-rc.2。
- orbit-prod 以账号所有者身份调用 `POST https://orbitd.io/api/runners/34P34HcKKoFRn2j9KitgJ/install`，body 为 `{"engine":"dsh"}`。01:16:13.796Z 发出，返回 HTTP 201 `{"status":"pending","engine":"dsh","command":null,"message":null,"mode":"install"}`。只调了这一次，没有对其他 runner 调用。
- 每 15 秒读一次 `GET /api/runners`：
  - 01:16:28.814Z、01:16:43.807Z：installed:false，`DSH_NOT_INSTALLED`，HPC 的 install 状态为 installing（`npm ci --prefix <Orbit-managed staging directory> --no-audit --no-fund (@deepseek-ai/dsh@0.2.0-rc.2)`）。
  - 01:16:58.808Z（HPC 心跳 01:16:56.181Z）：安装后的第一个心跳就上报了，在 30 秒以内，原文为 `{"auth":"unknown","dsh":{"credentialPresent":false,"modelCatalogReadable":false,"requestValidation":"unknown","sandboxEnforcement":"unknown","versionCompatible":true},"engine":"dsh","installed":true,"version":"0.2.0-rc.2"}`。同一次读取中，其他三台仍是 installed:false。
- 本机核对（01:17:44Z）：/root/.orbit/engines/dsh/0.2.0-rc.2 存在（01:16:44Z 发布，权限 0700，509M；旁边的 npm-cache 126M）；`node_modules/@deepseek-ai/dsh/lib/bin.js` 的 sha256 为 `1a03dee1…f307f` ✓；package.json 为 @deepseek-ai/dsh 0.2.0-rc.2。安装没有重启 runner，MainPID 仍是 1243。
- 判定：服务端 `engines[dsh]` 为 installed:true、version 0.2.0-rc.2、versionCompatible:true ✓；本机目录与哈希 ✓。

## 7. 入口

- 账号所有者 00:58:32Z 在 ask_owner 34bVbcD3RRrrmOIOm3ewQ 中选择「沿用现有 Key」，由协调会话转达。没有新建第二条 dsh 配置，也没有改动现有配置。
- 冒烟前复读（只读 SQL，01:19:08.432Z）：`deepseek-harness` enabled=true，updated_at 仍是 2026-10-06T01:45:32.893Z。同一时刻 HPC 心跳 01:18:56.186Z，installed:true。

## 8. 冒烟

会话 34bW9GrXCTtz5LJylOaE1（UUID 01a113f1-eec1-77dc-b73f-d222d66a53e5），工作区 p6-dsh-smoke（HPC，/var/tmp/p6/smoke-repo），provider `deepseek-harness`，permissionMode auto，模型未指定。
全部 67 条 run_event 都由 workstation-gpu 摄入；payload 里的 runtimeSessionId 只有一个值 a068effa-91bd-4ef4-9949-cd7e5d095546；error 事件 0 条。

| 轮次 | 时间 | dsh 进程 | init | turn_end | 改动与验证 |
| --- | --- | --- | --- | --- | --- |
| 1 新建 | 01:19:44.8–01:19:55.6Z | pid 3189922（父进程 runner 1243） | seq 2：provider dsh，runtime acp，cliVersion 0.2.0-rc.2，sessionId a068effa-…，resumed:false | seq 27：completed / end_turn | 给 calc.py 加 multiply，验证输出 `ok 42` |
| 2 同进程续聊 | 01:20:24.5–01:20:33.6Z | 仍是 3189922 | 没有新的 init（init 只在进程启动时发） | seq 43：completed / end_turn，runtimeSessionId a068effa-… | 没读文件，凭记忆复述了第 1 轮；加 subtract，输出 `ok 6` |
| 3 结束后恢复 | 01:32:26–01:32:39.3Z | 新进程 3355807（父进程 1243） | seq 45（01:32:28.652Z）：provider dsh，cliVersion 0.2.0-rc.2，sessionId a068effa-…，resumed:true | seq 67：completed / end_turn | 凭记忆复述了前两轮；加 power，输出 `ok 1024` |

第 3 轮的经过：

- 01:24:26Z，runner 的 warm 池回收了这个 dsh 引擎，journal 记为「interactive engine 01a113f1-… recycled (session remains resumable)」，同一时段共回收了 8 个引擎；pid 3189922 随之退出。
- 协调会话 01:30Z 决定（方案 A）：用 session_end 加 resumeIfEnded 补一轮冷启动续聊。
- 01:31:12–01:31:39Z 执行 session_end，没有删除会话。紧接着第一次带 resumeIfEnded 的 session_send 返回 409「the session is ending」，因为 runner 还没确认结束。01:31:56Z runner 把会话记为 CANCELLED；结束过程没有起 dsh 进程，也没有写 run_event；DSH_HOME 保留着全部 25 项，台账里的 runtimeSessionId 没变。
- 01:32:26Z 再次带 resumeIfEnded:true 发送，返回 revived:true。新进程的 launch 事件（seq 44）与第 1 轮相同：同一个 executable、dshHome、configHash（`de775efd…ab0a`）和 argv。
- 第 3 轮里有 1 条 tool_result 为 isError（seq 50，edit 工具，内容是 `file has not been read — read the file, then retry`）：恢复后 dsh 的「先读后改」状态被重置，模型随后先读文件，再改成功。这条不是 error 事件，这一轮正常结束。

工作区与会话最终状态：

- calc.py 里有 add、multiply、subtract、power 四个函数，都没有提交（git status 为 `M calc.py`，另有未跟踪的 `__pycache__/`），HEAD 仍是 7a9aafa seed。
- 冒烟会话保留，状态 AWAITING_INPUT，没有删除。

进程与审计：

- 第 3 轮之后（01:33:09Z）：argv 带 a068effa-… 的进程 0 个，claude 带 `--resume` 或 `--session-id` 的 0 个；dsh 进程只有 3355807，它的 argv 里只有 Orbit 会话目录。
- orbit-prod 01:35:01Z 跑 audit.sql 第二条，结果为 0；dsh 系会话仍是 1 个。
- 01:35:23.555Z 的 `GET /api/runners`：HPC 为 installed:true、0.2.0-rc.2；wikova、workstation 为 false（`DSH_NODE_UNSUPPORTED`）；Mac 为 false（`DSH_PLATFORM_UNSUPPORTED`）。

判定 ✓：经账号所有者授权的 `deepseek-harness` 在 HPC 上完成了小代码改动和续聊；init 为 provider dsh、cliVersion 0.2.0-rc.2；三轮都是 completed / end_turn；结束后恢复的那一轮为 `resumed:true`；ACP 会话 id 三轮都没变。

## 9. 旧引擎复核

三个会话都在 HPC 的 p6-dsh-smoke 工作区，事件都由 workstation-gpu 摄入。

| 会话 | runtime_session_id | 本次 init（sessionId） | 本次 turn_end | 结果 |
| --- | --- | --- | --- | --- |
| claude 样本 34bUt0YKOjfafxUOxg5Ft | adea2757-dfc3-4c28-b0cb-5cf95be5ce35 | 01:21:40.084Z，与 00:28Z、00:44Z 两轮相同 | 01:21:56.934Z success | 没读文件，凭记忆复述了首问及答案「# P6 smoke repo」 |
| 旧 deepseek 34bUt3zW8ppuYt3Hmgpuh（runtime claude，deepseek-flash） | a6ce7e14-9508-4681-9b3e-2e5b780bead4 | 01:21:39.095Z，与前两轮相同 | 01:21:41.663Z success | 同上 |
| 新建 claude 34bWCAqlNeL65wbgdIwRx（plan） | 8d17ef99-8a7a-4dc7-8788-f9fc3de1e406 | 01:21:41.535Z 和 01:22:13.069Z，都是 8d17ef99-… | 01:22:04.856Z 和 01:22:17.201Z，都是 success | 首轮答「# P6 smoke repo」，续聊凭记忆答对 |

- 进程（01:22:14–01:22:57Z）：claude 样本和旧 deepseek 的进程 argv 分别是 `--resume adea2757-…` 和 `--resume a6ce7e14-…`，都是原 id。按 dsh ACP id 扫描全部进程的 argv，结果 matches=0，其中 claude 带 `--resume` 或 `--session-id` 的为 0。dsh 进程（pid 3189922，父进程 runner 1243）的 argv 里只有 Orbit 会话目录 /root/.orbit/dsh-sessions/01a113f1-eec1-77dc-b73f-d222d66a53e5，没有 ACP id。
- 交叉审计（orbit-prod，01:27:02Z）：audit.sql 第二条原样执行，「claude-runtime inits carrying a dsh ACP id」的计数为 0；子查询里的 dsh ACP id 只有 a068effa-…。
- 旧 deepseek 每条 init 后都有一条 stderr 事件 `[claude-code:unrecognized_model] {"model":"deepseek-flash","query_source":"sdk"}`，批次 0 的两轮也有，不是这次新出现的。
- 判定 ✓：在 HPC 上，Claude 新建与续聊、Claude 样本续聊、旧 deepseek 续聊都成功，runtimeSessionId 不变。

## 10. 同一时段的其他 runner

| 读取时间（GET /api/runners） | HPC | wikova | workstation | longdeMac-mini.local |
| --- | --- | --- | --- | --- |
| 01:02:32Z | installed:false，`DSH_NOT_INSTALLED` | false，`DSH_NODE_UNSUPPORTED` | false，`DSH_NODE_UNSUPPORTED` | false，`DSH_PLATFORM_UNSUPPORTED` |
| 01:16:58Z | installed:true | false | false | false |
| 01:27:16.902Z | installed:true（0.2.0-rc.2，versionCompatible true） | false，`DSH_NODE_UNSUPPORTED` | false，`DSH_NODE_UNSUPPORTED` | false，`DSH_PLATFORM_UNSUPPORTED` |
| 01:35:23.555Z | installed:true | false | false | false |

判定 ✓：同一时段其他 runner 都不是 installed:true。本批没有对它们实际发起 dsh 会话；依据是它们都未安装，以及批次 0 已实测未安装时服务端返回 409、不派发。

## 11. 回退

任务第 9 步（出问题时回退）没有触发：

- 没有执行一级或二级回退，`deepseek-harness` 一直是 enabled=true。
- 没有删除任何 provider 配置、dsh-sessions/ 或 engines/dsh/。
- 没有手动重启 orbit-runner-root.service，MainPID 从头到尾都是 1243（01:38:01Z 复核）。

## 与运维文档的偏差

- 运维文档第 3 节批次 1 第 5 步写的是「续聊时 `resumed:true`、ACP 会话 id 不变」。实际上 `resumed:true` 只出现在新起的 dsh 进程里：`src/runner-go/dsh_acp.go:649` 的 init 只在进程启动时发一次，resumed 的含义是「启动时已带 runtimeSessionId，走 session/resume」。同一个 warm 进程内的续聊不会产生新的 init，本批第 2 轮就是这样；warm 进程要空闲 4 小时（warmEngineTTL）或被 LRU 回收之后，续聊才会冷启动并带 `resumed:true`。本批按协调会话 01:30Z 的决定（方案 A）补了第 3 轮。
- 结束会话后马上带 resumeIfEnded 发消息会得到 409「the session is ending」，要等 runner 确认结束之后再发，本批大约等了 26 秒。

## 剩余限制

1. 冒烟只用了 auto 模式。Default 模式的审批卡，以及运维文档第 3 节第 6 步可选的 EXECUTABLE 任务冒烟，本批都没有做。
2. 没有指定模型，用的是运行时默认；session 行的 model 为空字符串，即运维文档第 6 节第 6 条（F3）。
3. `engines[dsh]` 的 credentialPresent 和 modelCatalogReadable 安装后仍是 false，requestValidation 和 auth 为 unknown。机器探针没有会话 Key，这与 runtime-environment 文档「目录与健康状态」一节的描述一致。
4. 恢复后的第一次 edit 因为「先读后改」状态被重置而失败了一次，模型自己重读后成功；对用户来说表现为多了一次工具调用。
5. HPC 根分区仍然紧张：清理后 31G，01:38Z 为 28G。主要占用方（/var/tmp/p23b1 49G、p0drift 16G 等）不属于本项目，交给账号所有者处理。
6. 旧 deepseek 会话每一轮都有 `[claude-code:unrecognized_model]` stderr 事件，批次 0 起就有，不影响结果。
7. 本批建的会话：冒烟会话 34bW9GrXCTtz5LJylOaE1 保留；新建的 claude 复核会话 34bWCAqlNeL65wbgdIwRx 在 01:37Z 前后用 session_end 结束，没有删除；批次 0 的两个样本会话保留，没有结束；orbit-prod 转交会话 34bVfsM0LGvLeHDhFhg8U 的核对记录在 wikova 的 /var/tmp/orbit-b0/（b1-*）。用户身份的令牌文件已在 01:35:23.852Z 删除。

## 来源

- 核对记录：任务评论 34bWJSRaLccPfwGzg9zn3（1/3：前提、回退准备、二级回退步骤、磁盘清理）、34bWQekNxe7R7UuCzP3xL（2/3：服务端视角、安装、入口、旧引擎、同时段其他 runner）、34bWcqMdtdwnVSQHOlIKK（3/3：冒烟、文档偏差、结论、剩余限制）。
- 判断会话评论 34bVE6H14zNbue2Xz5s7v（00:42Z，开工前的磁盘提示）。
- 完成证据 2ceKYThqt026vUSBriEg8U（01:41:48Z，37 条引用）。
