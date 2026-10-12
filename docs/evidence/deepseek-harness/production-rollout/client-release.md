# 客户端发版：v0.1.2-beta.188（macOS 签名公证 DMG 与 iOS TestFlight）

任务 34bU21E5NHgp4MfVAFhmj，对应项目验收判据 4。总览见 [README.md](README.md)。
执行工作区 orbit-prod（runner wikova），执行会话 5ETox8UyQQ3Pw3KH2lN4B5（2026-10-07 01:42:23–03:52:39Z）。
做法：用 .claude/skills/release 的 release.sh；按该工作区既有做法，在临时 detached worktree 里对 origin/main 打显式版本，没有用 `next`。第 1 步的运行查询用匿名 GitHub API；派发、跟踪和编辑 Release 用本机已登录的 gh（账号 jianghailong-xy），命令和输出里都没有令牌。
时间一律为 UTC，未注明日期的是 2026-10-07。

## 概要

| 项 | 值 |
| --- | --- |
| 标签 | `v0.1.2-beta.188`（标签对象 `6746d63d5f498ffdd0bb7338f6cf8fe2b0724f12`） |
| 提交 | `ceaf2765721180d0bceeffba8280b370e835e518`（打标签时的 origin/main，包含 `25c3233c7`） |
| 打标签时间 | 03:32:32Z，晚于批次 1 判为 DONE 的 01:42:15Z |
| 编译门禁 | client.yml 运行 37566586399（`ceaf27657`），四个任务都 success |
| release.yml | 运行 37567236040，03:32:38–03:43:11Z，success，没有重跑 |
| macOS · signed + notarized DMG | job 112617626440，success |
| iOS · TestFlight | job 112617626351，success，0.1.2 (5436) Upload succeeded |
| Release 资产 | Orbit-v0.1.2-beta.188-arm64.dmg、Orbit-v0.1.2-beta.188-arm64.zip |
| Release 说明 | 已写明 macOS/iOS 的证据范围 |
| 回退 | 没有执行 |
| 结论 | 已发布 |

## 1. 现状：最近的 v* 标签

首次核对 01:43–01:45Z，03:24:47Z 复核（作业 bgj_6a47d83fd90c）；182–184 的运行在 03:46:15Z 补查（作业 bgj_c15420b427e5）。

| 标签 | 标签对象 → 提交 | 打标签时间 | 提交时间 | 含 `25c3233c7` | release.yml 运行 | macOS DMG | iOS TestFlight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v0.1.2-beta.187 | 4f553692e → `6c6528dbb3de9595ba10bc9dfe026e2ca78c3ca5` | 10-06 23:47:41Z | 10-06 23:26:18Z | 是 | 37548504179 success | success | success |
| v0.1.2-beta.186 | d250bd127 → `51f0cdfeeb9e91573fe3f85c5e6473195ea9498f` | 10-06 15:42:52Z | 10-06 15:18:06Z | 是 | 37489835174 success | success | success |
| v0.1.2-beta.185 | 707e02f9c → `86c6d2d4df03f541a9ef6b5c57bf2ee0e365c181` | 10-06 10:11:29Z | 10-06 10:02:55Z | 是 | 37448135841 success | success | success |
| v0.1.2-beta.184 | 35163f9c8 → `1ea8051f0c699a7030c56bee7a7d536262bdee02` | 10-06 07:48:37Z | 10-06 07:40:10Z | 否 | 37432001352 success | success | success |
| v0.1.2-beta.183 | 6dd726be1 → `5344e6cdfa4f3288cce35368572ca5e014d42677` | 10-06 07:04:27Z | 10-06 06:52:59Z | 否 | 37427427860 success | success | success |
| v0.1.2-beta.182 | 0eba626ad → `88a23acfa6b61b5cd0df239c459bc5b168e49c54` | 10-06 01:21:36Z | 10-06 01:05:02Z | 否 | 37398761034 success | success | success |

金丝雀之前已有三个包含 `25c3233c7` 的标签，如实列出：

- beta.185：资产 Orbit-v0.1.2-beta.185-arm64.dmg（14609574 字节）和 .zip（14630029 字节），prerelease。
- beta.186：资产 Orbit-v0.1.2-beta.186-arm64.dmg（14730007 字节）和 .zip（14747311 字节），prerelease。
- beta.187：由另一个项目的任务 34b6gj4DZ8BJhmxRBO9Bw「R · Wiki 新首页上线：部署与 TestFlight」打出，TestFlight 为 0.1.2 (5433)；资产 Orbit-v0.1.2-beta.187-arm64.dmg（14986933 字节）和 .zip（15001011 字节）。它在 `6c6528dbb` 上的 client.yml 门禁（运行 37546826932）没有通过：macOS 任务的「Test OrbitKit (macOS)」失败（ConfirmationStyleWiringTests 发现 SettingsAdminView、SettingsSheet 直接用了 confirmationDialog），「Build OrbitApp」因此被跳过；这个问题之后由 main 上的 `86203ffb0` 修复。

## 2. 判定

- 批次 1 的完成时间：批次 1 任务 34bU20PaiYqeJGFp1cHqD 的证据在 01:41:48Z 提交，01:42:15Z 判为 DONE（取任务的 updatedAt，task_get 没有单独的完成时间字段）；本任务会话随即在 01:42:23Z 自动启动。
- 上面三个包含 `25c3233c7` 的标签都打在这之前，不满足「标签在批次 1 冒烟通过之后打出」，不能复用（判断会话评论 34bUm84qjhHNgxUU8DzF6 也指出了 beta.187 这一点）。
- 01:42Z 之后，直到 03:30:27Z 打标签前最后一次核对，origin 上都没有新的 v* 标签。
- 结论：没有可复用的标签，需要新打。

## 3. 编译门禁：client.yml，在 main 上 workflow_dispatch

- 第一次，运行 37558718203（作业 bgj_180a1c0f1247）：01:46:03Z 派发，headSha `db69d833b63f2c679dd32cdb9b343b4b518748f5`；01:51:57Z 结束，结论 success，macOS (build + test)、iOS (generate + build)、Navigation、Font tokens 四个任务都 success。
- 中断：执行会话随后中断了约 1.5 小时（01:52–03:23Z，任务提示被重新投递），这段时间没有任何发版动作。期间 main 前进到 `ceaf2765721180d0bceeffba8280b370e835e518`（03:17:43Z 落地，含 OrbitKit / OrbitApp 的 AutoRetry 改动），所以第一次门禁的结果不能沿用。
- 第二次，运行 37566586399（作业 bgj_7398d2fbb1f7）：03:24:18Z 在 main 重新派发，headSha `ceaf27657…`；03:29:53Z 结束，结论 success，四个任务都 success。

## 4. 打标签（作业 bgj_573c3c7b7ee9）

- 打之前（03:30:27Z 起）：`git fetch --tags` 后最新的 v* 标签仍是 v0.1.2-beta.187，origin 上没有 v0.1.2-beta.188；origin/main 为 `ceaf27657`，等于门禁通过的提交，并且包含 `25c3233c7`；临时 detached worktree 的 HEAD 是 `ceaf27657`，落后 origin/main 0 个提交。
- 03:32:27Z 运行 `.claude/skills/release/release.sh 0.1.2-beta.188`（显式版本），注释标签已创建并推送。tagger 为 T14 simulation（与 185–187 相同），时间 03:32:32Z。
- origin 上 refs/tags/v0.1.2-beta.188 指向标签对象 `6746d63d…`，解引用后为提交 `ceaf2765721180d0bceeffba8280b370e835e518`。打完后 origin/main 仍是 `ceaf27657`，临时 worktree 已删除。

## 5. release.yml：运行 37567236040（作业 bgj_3367e0ca0e0f）

event push，ref v0.1.2-beta.188，headSha `ceaf2765721180d0bceeffba8280b370e835e518`，attempt 1；03:32:38Z 开始，03:43:11Z 结束，结论 success，没有重跑。

| 任务 | job id | 结论 | 时间 | 日志要点 |
| --- | --- | --- | --- | --- |
| macOS · signed + notarized DMG | 112617626440 | success | 03:32:45Z → 03:40:56Z | 公证 status: Accepted；"The staple and validate action worked!"；创建了 GitHub Release；appcast 已生成并发布 |
| iOS · TestFlight | 112617626351 | success | 03:32:47Z → 03:43:11Z | MARKETING_VERSION 0.1.2，CURRENT_PROJECT_VERSION 5436；ARCHIVE SUCCEEDED、EXPORT SUCCEEDED、"Upload succeeded" |

## 6. Release 资产与 appcast

GitHub Release v0.1.2-beta.188：prerelease=true（标签带 -beta，与流程规定一致），draft=false，03:40:47Z 发布。

| 资产 | 大小（字节） | sha256（作业 bgj_39716b2746dd 下载后本地计算） |
| --- | --- | --- |
| Orbit-v0.1.2-beta.188-arm64.dmg | 14989032 | `f7dd3c0854033fa0ea50b0ea7900f615b2c2387ffa9c03fdfea158ee6eab2f48` |
| Orbit-v0.1.2-beta.188-arm64.zip | 15004455 | `dd15d7c2b4cf5079576c339d5c395f293415e91968d323feb943198edd9fcb93` |

- 发布方没有提供 SHA256SUMS。上面的 sha256 只是本地审计值，不能证明发布者身份。
- 发布后核对（03:44:59Z，作业 bgj_39716b2746dd）：appcast 中有 beta.188 条目，channel beta，sparkle:version 5436，shortVersionString 0.1.2-beta.188；enclosure 指向本 Release 的 ZIP，length 15004455，与资产大小一致；条目带 EdDSA 签名（本记录不抄录签名值）。
- 构建号 5436 等于 `git rev-list --count ceaf27657`，也与 iOS 的 CURRENT_PROJECT_VERSION 一致。

## 7. Release 说明（作业 bgj_5aea9c3e5989）

- 03:44:32Z 用 `gh release edit` 改写说明：保留自动生成的部分（Full Changelog v0.1.2-beta.187...v0.1.2-beta.188），在后面追加一节「DeepSeek Harness：macOS / iOS 证据范围」。
- 这一节的正文是：「DeepSeek Harness 在 macOS/iOS 首版只有 CI 构建与模拟器证据，尚未在真实 Harness 会话和实机上操作过。」后面附一句意思相同的英文。
- 读回核对：这句话在已发布的说明里出现 1 次；prerelease=true、draft=false 都没有变。

## 8. /dl/version.json（03:34:08Z，作业 bgj_5b062bb6d8c5；01:46Z 首次核对结果相同）

`GET https://orbitd.io/dl/version.json` 返回 HTTP 200，last-modified 为 Wed, 07 Oct 2026 00:57:19 GMT，version 0.1.219；顶层字段包括 assets、runsAssignedRelease、schemaRevision 等。assets 覆盖四个平台，sha256 都是 64 位小写十六进制：

| 平台 | 文件 | sha256 | 下载大小（字节） |
| --- | --- | --- | --- |
| darwin-arm64 | orbit-darwin-arm64.gz | `020463f1d54e22987c174c45b346dea65ac8d481bd6c128918c0525fbac09537` | 5078064 |
| darwin-x64 | orbit-darwin-x64.gz | `470828695a2272115ac09c6b9ac30eb6b583e8d6fc3845582fee3b87c4705eb1` | 5552427 |
| linux-arm64 | orbit-linux-arm64.gz | `87ab7a485c32c96c6aae456dbd0db8620fa96ecec9ea8d5045db57e9ef308d1e` | 4937573 |
| linux-x64 | orbit-linux-x64.gz | `77df2a8214f3c7adc0c58972fce86ff6961ceab62df784f45d1bce5efd2aedfd` | 5515998 |

- 四个 .gz 下载后（不解压、不执行）用 `sha256sum -c` 核对，全部 OK。macOS App 注册 runner 要用的 darwin-arm64、darwin-x64 两项都在。
- /dl/previous/version.json 为 0.1.217，同样带四个平台的 assets。

## 回退

- 本任务没有执行回退：构建一次成功，「失败时最多自行重跑一次」没有用上。
- 发版记录里没有客户端的回退方案；运维文档第 4 节的两级回退只针对 dsh 配置和 runner。

## 剩余限制

1. TestFlight 只确认到上传成功（0.1.2 build 5436）。App Store Connect 的处理状态、出口合规、测试员可用性都没有核对（该工作区不能访问 App Store Connect），也没有在实机上登录或跑小任务。
2. macOS 只有 CI 日志里的公证 Accepted 和 staple 通过。DMG 的 codesign / spctl 核对、启动和 Sparkle 更新都需要在 Mac 上做，本次没有做。
3. DeepSeek Harness 在 macOS/iOS 上只有 CI 构建与模拟器证据，没有在真实 Harness 会话和实机上操作过（已写进 Release 说明）。
4. 门禁只覆盖 client.yml，即 OrbitKit 的 swift test、OrbitApp 的 swift build 和 iOS 模拟器构建；release.yml 本身不跑测试。docs/release-process.md「Before tagging」里的其他检查（JS / PG / Go 测试、Compose 干净机安装等）和 Discussions 公告不在本任务要求之内，本次没有做，这与此前的 beta 发版做法相同。

## 来源

- 发版记录：任务评论 34bZo5EyfjBtEuETTvrYI（03:48Z）。
- 判断会话评论 34bUm84qjhHNgxUU8DzF6（00:23Z，beta.187 早于金丝雀、不能复用）。
- 完成证据 6HSuRjBz4IbCVAdEkHvgLp（03:49:49Z，9 条引用，均为上文列出的后台作业）。
