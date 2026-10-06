# A13 Providers / Skills 对应表

开发组合 HEAD：`afb311c3becdf940ea728fcc859d9a96cb342cbf`（父任务记录初始 SHA 和普通 merge 来源；此切片未移动分支）。固定输入是该组合中的 Swift/API/shared；不把 A01 静态盘点称为 iOS 安装冻结。

输入身份：`src/shared/src/dto.ts` blob `67520fc4858ae9b937bb2bf5440421ef8a98953c`；`providers.controller.ts` blob `1e5b88716774c9f07e464dbb7b2505b2fa05c008`；`shared-pools.service.ts` blob `d0ff1da1ce7b4ca8874d5979f1528c7836fa8859`；`ProviderPoolViews.swift` blob `e0a87227d8c178952c02db27a3d53baa8aa9fc88`。

| 固定基线 | Android 接线 | API / 决策来源 |
| --- | --- | --- |
| `ProvidersOverviewForm`：runners、自己的池、共享池、个人 keys | `ProviderManagement` 同组展示，runner 行调用入口回调 | GET `runners`, `providers/pools`, `providers/shared-pools`, `providers/mine` |
| 个人 API keys 添加/更改在 web | label/defaultModel/停用态只读；Open providers on web 打开当前实例 | `ProvidersOverview.editOnWeb`；不新增原生 BYOK CRUD |
| Codex pool：accounts、keys、谁可使用、退出 | `ProviderPoolScreen`，自己的 Codex 池同样 GET access 视图；无 access 则无写按钮 | GET `providers/shared-pools/:id`，`viewerRole` / `people.you` / `creator` |
| ChatGPT device flow | 远程服务器 start / check / cancel，打开 verificationUrl 和显示验证码、过期时间；RESUMED 且 PENDING 时每 3 秒轮询，禁止重复 start | POST/GET/DELETE `providers/pools/:id/codex-login`；手机不运行 CLI |
| 账户过期、退出与重新登录 | 显示 state/lastError 提醒、credential expiry、usageUnavailable；贡献者可重新登录，贡献者和池管理员可移除 | DELETE `providers/pools/:id/codex-login/account?fingerprint=…`，与 Swift `SharedPoolPage` 相同 |
| Account/key 临时暂停 | 30 min / 2 hours / resume（显式 JSON null）；显示 pausedUntil | POST `providers/pools/:id/members/:memberId/pause`；登录账户 memberId 保留 `login:` 前缀 |
| 添加 key / 更换 INVALID key / 删除 / 开关 | 密码式输入、不读取存储 secret；key label + whole USD monthly cap；删除确认 | POST keys、PUT keys/:id/secret、DELETE keys/:id、PATCH enabled |
| 用量与 next | 显示服务端 `next`、窗口 utilization/reset、月度 othersCostUsd / shareCap、拒绝/停用/未知状态 | 不根据手机排序另算 next，不把缺 usage 当 0%；贡献者自身用量不受 shareCap 限制 |
| Share / Just me / role / remove | 新增现有 Orbit email 为 MEMBER；Just me 逐项移除、部分失败要求刷新；共享池允许调整角色 | `shared-pools/:id/people` POST/PATCH/DELETE；owner/creator 不可降级或移除；自己的池不新增管理员 |
| Keys/accounts contribution rules / own-key-first | 显示服务端规则，管理员写后重读 | PATCH `shared-pools/:id` 的 `membersCanAdd`, `membersCanAddAccounts`, `ownKeyFirst` |
| Delete pool / Leave pool | owner delete、MEMBER leave，均确认；非 owner ADMIN 告知需先降为 MEMBER | DELETE `shared-pools/:id` / POST `leave`；API 自己拒绝 ADMIN leave，手机不扩大权限 |
| Claude account pool | members/state/next/usage/pause；编辑说明在 web | GET `providers/pools/:id`；Swift `AccountPoolPageView` 同范围 |
| SkillsView / SkillsLogic | `SkillsManagement` 只读、搜索 name/description、workspace 分组、Shared 最后、runner 名称/离线状态 | GET `runners` + GET `agents`；无本地安装/执行 skills |
| 生命周期 / 陈旧 / 撤权 | ON_PAUSE 使可写状态失效；ON_RESUME/revision 重读；所有写之前重读 pool 权限；过时响应不能恢复 fresh | 401/403/404 清除旧敏感资料，其它失败保留有标识的旧数据并禁写；服务器仍做最终鉴权 |

模型偏好、工作区 default model/provider/account、会话 Automatic/Usage 的写契约由父任务与 Runner/Workspace 切片接线。本切片不修改 `ComposerModel`、`ComposerData`，也不改变 A07 的 account 选择或 usage ownership。

## 权限矩阵

这里的 ADMIN 是 API 返回的 **pool viewerRole**，不借用实例 ADMIN 身份。服务端未给出已知 MEMBER/ADMIN 时所有角色能力 fail closed。

| 操作 | MEMBER / 非贡献者 | MEMBER / 贡献者 | pool ADMIN | owner |
| --- | --- | --- | --- | --- |
| 看池与已脱敏账户/keys | API 允许 | API 允许 | API 允许 | API 允许 |
| 新增 key | 依 membersCanAdd | 同左 | 允许 | 允许 |
| 新增 account | 依 membersCanAddAccounts | 同左 | 允许 | 允许 |
| key enabled | 禁止 | 允许 | 仅自己的 | 仅自己的 |
| replace/remove/pause key | 禁止 | 允许 | 允许 | 允许 |
| account sign-in-again | 禁止 | 自己且新增账户规则允许 | 仅自己的 | 仅自己的 |
| account sign-out/pause | 禁止 | 允许 | 允许 | 允许 |
| people/rules | 禁止 | 禁止 | 允许；creator/own-pool role 受限 | 允许 |
| exit | leave | leave | 非 owner 先降级 | delete |

## 本地验证与证据边界

`ProviderManagementTest` 覆盖未知 role fail closed、贡献者和管理员差异、creator 保护、未知 quota、月度 cap 对贡献者豁免、Swift skills 分组搜索、403 清旧数据、后台中断 preflight 禁止写。其 MockWebServer 测试通过真实 `OkHttpTransport` + `AuthSession` 验证 bearer、权限撤销后只有 GET 无 PATCH、replacement PUT、login: 路径编码和 resume 的显式 null。运行及结果由父任务统一门禁记录；本文不预先声称通过。

fixture 源对照是 `OrbitKit/Tests/OrbitKitTests/PoolAccessBoards.swift` / `SharedPoolsTests.swift` / `SkillsLogicTests.swift` 与 `src/shared/src/planUsage.spec.ts`。本地合成账户、loopback HTTP 和内存 transport 不是真实业务/iOS 跨端结果，未访问生产资源进行任何写入。

## 差异和待补

- Android 使用 Compose 页面与按钮，未复制 Swift 的 swipe 操作和图形 gauge；信息与管理 endpoint 在表内逐项列出。
- device flow 自动轮询在后台/离页/取消/完成时停止，浏览器返回后恢复。第 9 条受控测试验证 PENDING 保留、重复 start 不发 POST、恢复后 CONFIRMED；真实 OAuth device flow 仍需验证服务端超时、外部浏览器返回、取消结果。
- 实际 Android 手机 / iOS 同数据、真实部署 MEMBER / ADMIN / pool owner / contributor、真实受控 Runner 和 OAuth 帐户均未因本次 fixture 获得。必须在专用测试实例创建隔离池，分别以 owner、member、admin 登录两端，记录 read、key contribution、account ownership、权限撤销、离线/恢复和注销后的响应；不要使用生产池或凭据做删除/退出验证。
- 服务器已经接受写入但最终 refresh 失败时，页面明确禁写并要求刷新；不自动重放有副作用的 POST。
- 所有设备流程仍必须由父任务持有 `/var/lib/orbit/android/ui.lock` 独占完成；本切片未操纵设备或运行 Gradle。

本切片实际新增路径：`app/src/main/kotlin/io/orbitd/android/management/ProviderAccess.kt`、`ProviderManagement.kt`、`SkillsManagement.kt`；`app/src/test/kotlin/io/orbitd/android/management/ProviderManagementTest.kt`；本文件。其它普通 merge 继承文件不计入本切片改动。
