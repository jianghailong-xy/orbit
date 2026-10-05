# Antigravity Google 登录：真实账号端到端验证

任务 `34Zogl1Sal7LyMPd2KcsT`（项目「Antigravity 支持 Google 账号登录」第 5 步），对应项目验收条目 3（`1c20Fd28SknYGalQD5smdG`）。验证在 HPC runner `workstation-gpu`（`34P34HcKKoFRn2j9KitgJ`）上完成，2026-10-05。

**结论一句话**：Google 账号登录本身在真实机器上跑通了（登录、额度、两轮对话、`--conversation` 恢复、并发、每会话凭据副本、凭据移走/移回、泄露检查零命中全部成立），**但「用一个登录后才有的模型跑一轮」这一项到本文件第二版为止仍未通过**：控制面最初把 Google 模式特有的 Claude / GPT-OSS 模型静默换成默认的 `gemini-3.8-flash`（§6）；修复 `b5b99caa4` 之后不再替换了，但模型**根本送不到 runner**（agy argv 里没有 `--model`，详见 §10）。

脱敏规则：本文件、本次提交和所有截图里不出现 token、cookie、授权码或账号邮箱。下面每条命令的输出都先经过一个脱敏过滤器（邮箱、`4/0` / `ya29.` / `1//` 前缀的长串、JWT、长 blob 一律换成占位符，命中数只在计数里出现，行内容一律不打印）。凭据文件始终只做 stat（大小/权限/时间），从不读取内容。

## 1. 前提核对

| 前提 | 结果 | 依据 |
| --- | --- | --- |
| runner 新版已发布 | ✅ `0.1.210` | `https://orbitd.io/dl/version.json`（`last-modified: 2026-10-05 06:21:22Z`） |
| 本机 runner 已升级 | ✅ | `/usr/local/bin/orbit` = 0.1.210，`/proc/1243/exe` 与磁盘二进制同一 inode；二进制含 `antigravity-google-login/v1`、`1. Google OAuth`、`antigravity-oauth-token` |
| web 已部署含客户端登录入口 | ✅（重新部署后） | 首次核对时 orbitd.io 的入口 bundle（构建于 06:16:54Z）不含 `Sign in with Google` / `googleLogin` / `authSource`，而客户端交付落到项目分支是 07:52:39Z、并入 main 是 08:00:46Z；协调会话按 main `3f6c181a8` 重新部署后，入口 bundle 构建于 08:31:06Z，三个串分别命中 1 / 7 / 12 次 |
| agy 与本轮契约一致 | ✅ | agy 当天 06:36:17Z 被 runner 自动升到 1.2.17（契约录制是 1.2.16），因此重跑真实 agy 的契约测试 `AntigravityGoogleContract*` / `AntigravityGoogleSessionContract*`：5 条全部 PASS，退出码 0 |

## 2. owner 在产品内完成 Google 授权

owner 通过 Orbit web 的 HPC runner 卡片点「用 Google 登录」，在浏览器授权后把授权码贴回 Orbit 的登录框。授权码没有经过对话、评论或本会话。

- 凭据落在 `/root/.orbit/antigravity/google/antigravity-cli/antigravity-oauth-token`：`1678 bytes  mode 600`，时间戳 `2026-10-05 16:52:40 +0800`。
- runner 日志里登录中继没有任何输出（设计如此：PTY 输出不进日志），泄露检查一节单独验证。

## 3. 登录状态与额度（runner 侧探测）

用 runner 自己的探测方式复核（同一命令、同一套净化环境：`HOME`/`XDG_*` 指向私有临时目录、`DBUS_SESSION_BUS_ADDRESS` 指向不存在的 socket、不继承任何 API key 类环境变量、stdin 是空管道、`--log-file` 落在临时目录）：

```
agy --gemini_dir=/root/.orbit/antigravity/google --print=/usage --output-format stream-json
```

`result.status = SUCCESS`，四个额度桶都是 100%：

| 分组 | 窗口 | 剩余 | 重置 |
| --- | --- | ---: | --- |
| Gemini Models | weekly | 100% | 2026-10-10T17:31:03Z |
| Gemini Models | five hour | 100% | 2026-10-05T13:53:40Z |
| Claude and GPT models | weekly | 100% | 2026-10-12T08:53:40Z |
| Claude and GPT models | five hour | 100% | 2026-10-05T13:53:40Z |

「Claude and GPT models」这一组只在 Google 登录模式下出现（API key 模式没有），是登录生效的直接旁证。

## 4. Google 模式才有的模型

```
agy --gemini_dir=/root/.orbit/antigravity/google models
```

比 API key 模式多出：`claude-opus-5-5-{low,medium,high}`、`claude-sonnet-5-5-{low,medium,high}`、`gpt-oss-120b-medium`。这些模型在本机确实**能跑**——用私有副本凭据目录直接驱动真实 agy：

```
agy --gemini_dir=<私有副本> --print="…" --model claude-sonnet-5-5-medium --output-format stream-json
```

`init.model` 回显 `claude-sonnet-5-5-medium`，`result.status = SUCCESS`，退出码 0（副本用完即 shred + 删除）。

## 5. Google 模式会话

runner 日志对每个会话都打印认证来源，这一行是本轮的关键证据：

```
antigravity: <runner 内部 session id>: starting agy, auth source google
```

| 验证项 | 会话 | 结果 |
| --- | --- | --- |
| 两轮对话 | [E2E-google-A](orbit-session:34aYcc6wXRYuFZQW7IbBg) | 第 1 轮「法国的首都是巴黎。」；第 2 轮「这座城市最著名的地标是埃菲尔铁塔。」（接得上第 1 轮的话题） |
| 并发 | [E2E-google-B](orbit-session:34aYccSIAEwiUwFU4TK4d) | 与 A 并发：A 的 agy 16:54:10 起、B 的 16:54:12 起，两个进程同时在跑，两条 `auth source google` |
| 中断后恢复（`--conversation`） | [E2E-google-A](orbit-session:34aYcc6wXRYuFZQW7IbBg) | 见 §5.1 |

### 5.1 中断与 `--conversation` 恢复

1. 让 A 执行一轮很长的任务（从 1 逐行数到 5000），在其**运行中**调用会话中断。
2. runner 日志：`antigravity: error: interrupted`（16:57:19）→ 下一个 turn 立刻 `antigravity: <session>: starting agy, auth source google`（16:57:20）——进程被换掉，不是复用旧进程。
3. 新进程 argv 里带着 `--conversation bbaebf8f-bebb-424b-89f6-dda97e1277b6`，与 `meta.json` 里第一轮就写下的 `runtimeSessionId` 完全相同：

```
agy --gemini_dir=/root/.orbit/runs/01a10b45-39e3-…/antigravity --print= --input-format stream-json \
    --output-format stream-json --disable-slash-commands --print-timeout=0s \
    --conversation bbaebf8f-bebb-424b-89f6-dda97e1277b6 --model … --effort high --log-file=…
```

4. 行为上也接得上：被中断时数到 1518，新进程回答「我刚才在逐行从 1 数到 5000，数到了 1518。1519 1520 1521 1522 1523」。

（第一次中断没落在运行中的 turn 上——那时数到 200 那轮已经结束，进程被复用，所以没有换进程；补做时才拿到上面的证据。）

### 5.2 每会话凭据副本

Google 模式会话不共用凭据目录：runner 给每个会话自己的 `--gemini_dir`，把 token 复制进去（`mode 600`），进程退出后副本被删掉。

```
/root/.orbit/runs/<session>/antigravity/antigravity-cli/antigravity-oauth-token  1678 bytes  mode 600   (每个在跑的会话一份)
```

复核两件事：

1. 全机扫描（`find /root/.orbit /root/.claude /tmp -name antigravity-oauth-token`）：token 只出现在凭据目录和**在跑的会话目录**里，没有任何游离副本。
2. 副本随进程退出被删除：把其中一个会话（`34aYkNiZ3Au5fLQ9ujuUs`）结束掉，它的副本在秒级内消失，同一目录下只剩 agy 自己的运行文件；此后全机再扫，剩余副本全部属于仍有 agy 进程在跑的会话（STALE = 0）。

## 6. 缺陷：登录后才有的模型跑不起来

**现象**：登录成功后，通过产品建一个指定 Google 模式模型的会话，模型被静默换成 `gemini-3.8-flash`。

| 会话 | 请求的模型 | 落到的模型 |
| --- | --- | --- |
| [C](orbit-session:34aYcsa38j5gCtzEs6TJ4) / [E](orbit-session:34aYiqW2vkMHvYCbGEG2w) / [G](orbit-session:34aYkNiZ3Au5fLQ9ujuUs) | `claude-sonnet-5-5-medium` | `gemini-3.8-flash` |
| [H](orbit-session:34aYlFwqdkRNJjMaTCUUo) | `claude-sonnet-5-5` | `gemini-3.8-flash` |
| [F](orbit-session:34aYjujKAnc0axsWArsnO)（对照） | `gemini-3.1-pro` | `gemini-3.1-pro`（原样保留） |

对照组成立即说明 API 参数确实传到了：被丢弃的是**按 id 前缀**判定的非 `gemini-` 模型。

**根因**：`src/shared/src/models.ts:157-161`

```ts
// agy's model space is the `gemini-…` slugs `agy models` lists (contract §9) and nothing else:
const isAntigravityModel = model.startsWith('gemini-');
if (provider === AgentProvider.ANTIGRAVITY) return isAntigravityModel ? model : fallback;
```

这条规则来自 API key 时代（契约 §9），在 Google 模式下已不成立（§16.7：登录后的目录多出 Claude / GPT-OSS），而它作用在**派发/认领**路径上（`src/apiserver/src/queue/queue.service.ts:686` 的 `resolveProviderExec` → `modelForProvider`；改配置路径 `src/apiserver/src/sessions/sessions.service.ts:8046` 同理）。行为还被一条现存的用例钉住：`src/shared/src/models.spec.ts:117-120` 断言 `modelForProvider(ANTIGRAVITY, 'claude-opus-5') === ''`。

**影响**：选择器只要拿到 Google 目录就会列出 Claude Sonnet 5.5 / Opus 5.5 / GPT-OSS（`modelOptionsForProvider` 不按前缀过滤），用户选中却跑在 `gemini-3.8-flash` 上——静默降级。这正是本项目招牌能力「登录后才有的模型」。

**不是账号或 agy 的问题**：§4 已用真实 agy 在私有凭据副本上跑通 `claude-sonnet-5-5-medium`。

## 7. 凭据移走与移回

1. 把 `/root/.orbit/antigravity/google/antigravity-cli/antigravity-oauth-token`（1678 bytes / 0600）**移动**到一个 0700 的私有临时目录（不复制、不读内容）。
2. 移走后的实测（两种形态都能看到，取决于控制面手上那份 runner 健康报告是否已经刷新）：
   - **控制面已经知道未登录时**：新建内置 Antigravity 会话被 **409 `ENGINE_SIGNED_OUT`** 直接拒在建会话这一步，响应里带着客户端渲染登录按钮要用的 `signIn` 负载：
     `Antigravity has no Google sign-in or Gemini API key on runner "HPC". Sign in with Google from the Providers page …`
   - **控制面还拿着旧的「已登录」健康报告时**：会话被建出来、随即失败，0 轮、没有起 agy（runner 日志里连一条 `starting agy` 都没有），错误原文就是错误卡那段文案：
     `Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one — set GEMINI_API_KEY in the runner's environment or give the session a Gemini API key — or, on a Linux runner, sign in to Google from Orbit.`（[J](orbit-session:34aYpMpdk4cdPDPIzXelq)）
   - runner 卡片侧：移走后 `antigravityGoogleSignInSaved()` 为假、runner 进程环境里也没有 `GEMINI_API_KEY`（只查了变量名，未打印值），runner 报告给控制面的认证来源随之回到未登录，卡片恢复登录入口。
   - **有 key 时回到 key 模式**：[K](orbit-session:34aYpoxwuvfSYbfhPDBba)（provider = 已配置的 Gemini provider）正常跑完，runner 日志 `antigravity: 01a10b4d-2c51-…: starting agy, auth source session_key`。
3. 移回：文件从 0700 私有目录移回原路径、`chmod 600`，私有目录删除；恢复后同一条路径 1678 bytes / 0600，父目录仍是 0700/700。

### 7.1 恢复

移回后控制面手上那份健康报告要等下一轮探测（≤5 分钟）才翻回已登录，所以在窗口内第一次建会话仍被 409 `ENGINE_SIGNED_OUT` 拒绝——那次拒绝正好把「控制面已知道未登录」这一形态也记了下来（见 §7.2）。约 6 分钟后重试：

- [L](orbit-session:34aZThwwxGi5wZEkIhkJH)：建会话不再被拒，正常回答「八加八等于十六。」
- runner 日志 `2026-10-05T09:29:04Z`：`antigravity: 01a10b65-2c66-778a-837d-71cfe7b9cc6b: starting agy, auth source google` —— 认证来源回到 Google 账号。
- 凭据文件回到原路径且属性不变：`1678 bytes  mode 600`，父目录仍是 0700（`/root/.orbit/antigravity`、`.../google`、`.../google/antigravity-cli`）；临时私有目录已删除。

### 7.2 未做到的一点

`env_key` 这一支（runner 自己的环境里有 `GEMINI_API_KEY`）没有实测——runner 是 systemd 起的长驻进程，改它的环境只能重启 runner，而重启会打断本会话与机器上其它会话。同一判定分支已由 `antigravitySessionAuth` 的 `session_key`（K）覆盖；`env_key` 与 `session_key` 在判定表里是相邻的两支。

### 7.3 截图缺口

「未登录状态」的卡片截图没能拿到：owner 在窗口开的 20 分钟里没有回话（窗口上限 20 分钟是我的选择——不让凭据长期离开凭据目录），到点先把凭据移回并验证了恢复。这一条的错误卡**数据**是齐的（§7 的两段拒签文案 + `ENGINE_SIGNED_OUT` 的 `signIn` 负载），缺的只是浏览器里那一张图。若需要，我可以再把窗口开一次、按 owner 方便的时间重做。

## 8. 泄露检查

按 `4/0`、`ya29.`、`1//` 三个前缀搜索，**只输出命中计数**：

| 范围 | `4/0` | `ya29.` | `1//` |
| --- | ---: | ---: | ---: |
| runner 日志（本机 `journalctl -u orbit-runner-root`，2026-10-05 全天 3701 行） | 0 | 0 | 0 |
| 三个会话各自的 agy 日志 `orbit-google.log` | 0 | 0 | 0 |
| 四个 E2E 会话的 `run_event`（生产库，只读 SQL，由协调会话在 wikova 执行） | 0 | 0 | 0 |

### 8.1 命令

```bash
# 1) runner 日志（本机，整份 journal）
journalctl -u orbit-runner-root --since "2026-10-05 00:00:00" --no-pager -o cat > /tmp/journal-today.txt   # 3701 行
for p in '4/0' 'ya29.' '1//'; do printf "%s: %s\n" "$p" "$(grep -o -F "$p" /tmp/journal-today.txt | wc -l)"; done

# 2) 每个会话私有的 agy 日志（只计数）
for f in /root/.orbit/runs/01a10b45-*/antigravity/antigravity-cli/orbit-google.log; do
  printf "%s -> 4/0:%s ya29.:%s 1//:%s\n" "$f" \
    "$(grep -o -F '4/0' "$f" | wc -l)" "$(grep -o -F 'ya29.' "$f" | wc -l)" "$(grep -o -F '1//' "$f" | wc -l)"
done

# 3) 四个 E2E 会话的 run_event（生产库只读查询，由协调会话在 wikova 执行；payload 是 jsonb）
SELECT '4/0' AS prefix, count(*) FROM run_event WHERE session_id IN ('01a10b45-39e3-…','01a10b45-3abe-…','01a10b45-62ce-…','01a10b46-3eee-…') AND payload::text LIKE '%4/0%'
UNION ALL SELECT 'ya29.', count(*) … AND payload::text LIKE '%ya29.%'
UNION ALL SELECT '1//',   count(*) … AND payload::text LIKE '%1//%';
-- → 4/0=0, ya29.=0, 1//=0
```

### 8.2 更宽查询的命中属于检查本身，不属于被检查的会话

同日 08:50Z 之后所有会话的同形查询三个前缀各命中 15 次。三个不同前缀拿到几乎相同的计数，是同一段文本同时提到这三个字面量的特征，因此请协调会话改用**只回 `session_id` 与计数、不回内容**的分组查询定位：

| 命中的 session_id | `4/0` | `ya29.` | `1//` | 说明 |
| --- | ---: | ---: | ---: | --- |
| `bdd161c8-9fcd-5d46-b0a2-83db2153d81d` | 21 | 20 | 20 | 本 E2E 执行会话自己的 run_event：它跑过泄露检查命令、也在评论里列过这三个前缀 |
| `01a1048e-5652-733d-9e52-cde4227c5ddb` | 7 | 7 | 7 | 协调会话：它执行了这条 SQL 并在消息里写了同样的前缀 |

**四个被检查的 E2E 会话（`01a10b45-39e3`、`01a10b45-3abe`、`01a10b45-62ce`、`01a10b46-3eee`）一个都没有出现在命中里**——它们的内容里三个前缀各 0 次。也就是说：宽查询的 15 次命中的是被检查文本自身（检查命令与讨论），不是任何 token 泄露。查询全程只返回计数与 session_id，没有读取或返回任何 payload 内容。

## 10. 修复后重跑：结论「修复后仍不生效」

协调会话确认模型修复已并入并通过（修复提交 `b5b99caa4`），要求基于修复后的控制面重跑「登录后才有的模型跑一轮」，并给出实际 init/runtime model **未被降级**的可验证记录。重跑结果：**控制面那一半生效了，模型仍然到不了 runner，这一轮没通过。**

| 会话 | 请求模型 | 控制面 session 行 | runner 里 agy 的 argv | 实际运行 |
| --- | --- | --- | --- | --- |
| [M](orbit-session:34aa9li2Vsjrc6nAVrnBU) | `claude-sonnet-5-5` | `claude-sonnet-5-5` ✅ | **无 `--model`** | agy 自带默认模型 |
| [O](orbit-session:34aaBAqHzJYTM2GvgOSGC) | `claude-sonnet-5-5` | `claude-sonnet-5-5` ✅ | **无 `--model`** | 同上 |
| [P](orbit-session:34aaZDXE7oE0CvyZejgKy)（目录刷新之后） | `claude-sonnet-5-5` | `claude-sonnet-5-5` ✅ | **无 `--model`** | 同上 |
| [N](orbit-session:34aaApZg1dqufhNCg9HPu)（对照） | `gemini-3.1-pro` | `gemini-3.1-pro` | `--model gemini-3.1-pro --effort high` ✅ | gemini-3.1-pro |

对比旧行为（§6）：修复前 control plane 会把 id **换成** `gemini-3.8-flash`；修复后 session 行保留了 `claude-sonnet-5-5`（这一半确实修好了），但模型**根本没送到 runner**。

判据链（每一步都实测排除）：

1. **不是 runner 的透传问题。** `src/runner-go/antigravity_models.go` 的 `antigravityModelArgs` 对目录里没有的模型是**原样透传**（`--model <model>`），只有 `model` 为空才返回 `nil`。所以 argv 里完全没有 `--model` ⇒ 控制面把模型解析成了空值，而不是 runner 丢掉了它。
2. **不是 runner 的目录旧。** 18:01:37 把凭据移到 0700 私有目录、18:07:53 移回，制造一次签入；18:11:47 runner 确实执行了 **Google 模式**的目录拉取：
   `agy --gemini_dir=/root/.orbit/antigravity/google --log-file=/dev/null models`
   且**没有回退到 API key 那一版**——`/root/.orbit/antigravity/catalog/antigravity-cli/log/` 里最新一份仍是 `cli-20261005_155720.log`（15:57:21），`journalctl` 全天没有任何 `model list is unavailable` / `model catalog refresh failed` / `agy models listed no models`。也就是说 runner 手上这份目录里现在有 Google 行。
   （这条同时也是「签入触发目录重读」路径 `engineHealth.onSignIn` 的实测证据。）
3. **剩下两种可能都在控制面侧**：(a) 控制面存的那份 `runner.model_catalog` 仍没有 Google 行（上报/落库这一段）；(b) 修复的「目录驱动判定」对**没有 level 后缀的 Google id**（`claude-sonnet-5-5` 这类 base row）匹配不上。区分二者只需要一条只读查询 `SELECT name, model_catalog::jsonb->'antigravity' FROM runner WHERE name='workstation-gpu'`——本机做不到：HPC 上 `wikova` 在 DNS 里不解析、没有 ssh、没有 psql 客户端，本机 postgres 容器只有 agy 测试库，所以这条只能由有生产库访问权的协调会话执行。

**给下游的结论**：这条验收项需要的「agy 实际 `--model` = 请求的 Google 模式模型 + 正常回答」目前拿不到；修复 `b5b99caa4` 只修掉了「静默换成 gemini-3.8-flash」，没有让模型到达 runner。

### 10.1 判别结果：目录里有 Google 行，问题在派发侧的匹配

协调会话在生产 `orbit-postgres` 上跑了上面那条只读查询（`runner.model_catalog -> 'antigravity'`，`name='workstation-gpu'`）：

```
n = 7
ids = claude-opus-5-5, claude-sonnet-5-5, gemini-3.1-pro, gemini-3.6-flash, gemini-3.7-flash, gemini-3.8-flash, gpt-oss-120b
```

所以 §10 判据链第 3 步的两种可能里，**(a) 被排除**：控制面手上这份目录**确实有** `claude-sonnet-5-5`（以及 `claude-opus-5-5`、`gpt-oss-120b`）。剩下的就是 **(b)：修复后的派发侧判定对目录里已经存在的 Google id 仍然匹配不上，于是回退成「不传模型」**——症状因此从「静默换成 gemini-3.8-flash」变成「静默用 agy 默认模型」，用户可见的结果一样。修复任务已按这条实测 reopen/返工，定位方向是派发目录匹配与部署树。

在修复落地前不再重复「签出/签入」触发（同一条手段已用过一次且无效），等待修复结果后重跑并提交下一版证据。

## 9. 截图


**这一项没拿到**：本轮执行会话在本机上没有任何 owner 作用域的凭据（唯一的本地 token 是本会话的 runner-orchestration JWT，用户 API 一律 401），卡片和会话页面的截图只能由 owner 的浏览器出。owner 在凭据移走窗口开放的 20 分钟里没有回话，窗口到点关闭，因此：

- 登录态 runner 卡片（Google 账号 + 额度）：**未提供**
- 三个会话页面：**未提供**
- 凭据移走后的未登录卡片：**未提供**（原因见 §7.3）

作为替代，本文件给出了这些状态**背后的数据与行**：额度四个桶及重置时间（§3）、Google 模式目录（§4）、每个会话的 runner 日志认证来源行与恢复用的 `--conversation` argv（§5）、凭据移走/移回两个方向的判定与原文（§7）、以及会话链接本身。需要截图时我可以把窗口再开一次或请 owner 补。
