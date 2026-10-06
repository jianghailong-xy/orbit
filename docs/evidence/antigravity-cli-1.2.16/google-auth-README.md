# agy 1.2.16：Google 账号登录实测记录

本组记录对应 [`antigravity-runtime-contract.md` §16](../../antigravity-runtime-contract.md#16-google-账号登录agy-12162026-10-04)。
实测日期为 2026-10-04（Asia/Shanghai），Linux x86_64；agy 版本固定为 **1.2.16**。
本目录原有的 `README.md`、`s_*.json`、`drive.py` 和 `hook.py` 属于人工审批实验，不是本次 Google 登录的记录。

已完成 owner 本人的真实 OAuth 登录和一轮无 TTY 对话。另完成同账号三个进程各三轮的 9/9 成功结果、
真实刷新令牌、额度查询和模型列表比较。**本任务仍按 FAILED 处理**：一次原会话工具结果包含可拼接的
PTY 授权码回显碎片，违反敏感值不得进入会话记录的验收要求。提交到本目录的样本已删除整个授权输入渲染区间；
这不能撤销原会话记录中的暴露。下文不包含该授权码、令牌、cookie 或账号邮箱。

## 实验方法

- 使用官方安装脚本的 `--dir` 安装到私有临时目录，设置 `AGY_CLI_DISABLE_AUTO_UPDATE=true`；版本、安装脚本及二进制摘要见环境记录。
- 每次探测使用隔离的 HOME、XDG 目录和 `--gemini_dir`，工作目录为空，只发送要求固定短答且不读文件、不用工具的提示词。
- `DBUS_SESSION_BUS_ADDRESS` 指向不存在的临时 socket，系统 Secret Service 无法被实验进程访问。没有启用或写入系统钥匙串。
- 清除继承的 API key 和 OAuth 环境变量；API 模式的模型列表探测只使用无效占位 key，没有进行真实 API 推理。
- 普通管道和带 SSH 环境的管道先验证无 TTY 行为；真实登录使用私有 PTY 和 SSH 环境，由 owner 在浏览器授权，授权码经私有文件回填。
- 登录后凭据文件只在私有临时目录内复制给各探测目录。这些副本代表同一个账号，不能作为不同账号同时登录的证据。
- 所有真实对话设置 `useG1Credits=false`。记录用占位符替代临时路径、动态 OAuth 查询参数和敏感身份字段；凭据记录只保留字段类型。
- PTY 输入会分段回显，并包含退格等控制序列。脱敏不能只替换完整授权码；本组提交样本整体删除从授权输入提示到 `Signing in...` 的输入渲染区间。

## 录制索引

| 记录 | 实测范围与结果 |
| --- | --- |
| [环境](google-auth-environment.json)、[帮助](google-auth-help.txt) | agy 1.2.16、隔离环境、安装摘要和公开参数。 |
| [无 TTY](google-auth-no-tty-real.json)、[SSH 无 TTY](google-auth-ssh-no-tty-real.json)、[保持 SSH stdin 开启](google-auth-held-ssh.json) | 普通启动仍需要 TTY；SSH 环境本身不能解决 Bubble Tea 的 TTY 错误。 |
| [未登录 stream-json](google-auth-stream-no-login-real.json)、[保持 stream stdin 开启](google-auth-held-stream.json) | 没有缓存凭据时要求先交互登录，未输出可供 runner 中转的 OAuth 链接。 |
| [登录初始界面](google-auth-owner-login-initial.json)、[登录完成](google-auth-owner-login-final.json) | 真实 PTY 登录的菜单、链接、代码回填框及授权完成；输入渲染区间整段脱敏。 |
| [隔离跟踪](google-auth-isolation-trace.json)、[凭据文件](google-auth-credential-file.json) | 未登录探测的文件系统调用；真实登录后在隔离 `gemini/antigravity-cli/antigravity-oauth-token` 写入 mode 0600 文件。记录未保存凭据值。 |
| [真实一轮](google-auth-real-one-turn.json) | 缓存真实 Google 凭据，无 TTY `stream-json` 对话返回 `SUCCESS`，进程退出 0。 |
| [并发 1](google-auth-concurrency-1.json)、[并发 2](google-auth-concurrency-2.json)、[并发 3](google-auth-concurrency-3.json) | 同账号三个独立进程、三个隔离目录同时运行，各三轮全部 `SUCCESS`，均退出 0；未遇到限流。 |
| [强制过期](google-auth-forced-expiry.json) | 仅把私有副本的 expiry 置于过去，保留真实 refresh token；请求成功，access token 变化且新 expiry 保存到文件。 |
| [无效刷新占位值](google-auth-invalid-refresh.json) | 私有副本的 access/refresh token 改成无效占位值并过期；启动返回 `result.status=ERROR`、`authentication failed or timed out`，退出 1。这不是服务端撤销授权实验。 |
| [用量](google-auth-print-usage.json) | `--print=/usage --output-format stream-json` 非交互返回 `command_result`；`groups[].buckets[]` 含 `remaining_fraction`、`window` 和 `reset_time`。未报告固定绝对 token/请求上限。 |
| [credits](google-auth-print-credits.json) | `--print=/credits` 非交互查询成功，`remaining_credits=0`；这不表示账号的订阅额度为零。 |
| [实验后额度](google-auth-usage-after-concurrency.json) | 并发及续期实验后 Gemini weekly 约剩 99.39%、5h 约剩 98.90%；没有耗尽额度或触发限流。 |
| [未登录 Google 模型](google-auth-google-models.json)、[已登录 Google 模型](google-auth-signedin-models.json)、[API 模型](google-auth-api-models.json) | 未登录 Google 查询退出 1；已登录列出 18 行，API 模式列出 11 行。Google 多出 Claude Opus/Sonnet 5.5 各三档及 GPT-OSS 一行；列表不证明每个模型的推理可用。 |
| [二进制分析](google-auth-binary-analysis.md) | 闭源二进制的符号与字符串辅助分析；钥匙串 service 等结论标为推断，不能代替成功调用钥匙串的实测。 |

`google-auth-held-stream.json`、`google-auth-held-ssh.json` 是保持 stdin 开启的对照；
同名 `*-real.json` 是普通管道探测。不能把未登录的失败输出与真实登录后的成功输出混为一组。

## 登出与清理

[`--print=/logout`](google-auth-print-logout.json) 明确拒绝并退出 2。
[私有 PTY `/logout`](google-auth-logout-real-one-turn.json) 在普通输入框执行后，凭据文件删除；该录制的 header 确认账号为 Google AI Pro，邮箱已脱敏。
首次 onboarding 的数据 checkbox 取消后需 Tab、Tab、Enter 选 Done，再确认信任空目录；在这些菜单里发送 `/logout` 不能证明登出。
[同目录登出后 probe](google-auth-post-logout.json) 返回认证要求、`result ERROR`、退出 1。

[批量登出](google-auth-logout-batch.json) 对另外 10 个私有有效凭据目录逐个执行官方命令，全部 token 消失；加上上述目录共 11 个。
唯一剩余文件属于无效 refresh 占位值实验，启动已拒绝认证，清理前删除该不可用文件，没有把它当作有效登录。
[最终清理](google-auth-cleanup.json) 确认安装目录、所有 HOME/XDG/凭据副本、早期空临时目录和辅助脚本已移除，自己的宿主进程均已退出；用户 `/root/.gemini` 始终不存在。
本地登出不代表撤销 Google 服务器的 app grant，原会话隐私缺口也不会随临时文件删除而消失。

## 证据边界与未完成项

- 隐私验收未通过：一次原会话工具结果含可拼接授权码回显碎片。未向本目录记录令牌或账号邮箱值。
  已提交样本整段去掉输入渲染，但 Orbit 当前未发现单条原工具结果的官方精确脱敏入口；隐藏分享视图或清理临时文件不能消除原记录。
- 只有一个 owner 选择的 Google 账号；未验证两个不同账号并行，Free/Ultra 的实际计划额度也未验证。
- 真实刷新成功只验证客户端自动续期；无效占位 refresh 只验证认证失败。没有服务端撤销授权、长时间自然过期或正在对话时失效的样本。
- 并发九轮没有触发限流，未确立限流错误文本、重试等待或并发上限；没有耗尽额度来制造该错误。
- 未启动真实 Secret Service，所以未验证临时钥匙串的成功存取及两个账号在钥匙串下的隔离。
- 模型列表差异已验证；仅短提示词的默认模型完成真实推理，没有逐个验证列表中的模型。
- 使用条款与计划数据使用的依据是契约 §16.8 引用的官方页面，抓取日期为 2026-10-04；技术上跑通不能证明 Google 允许 Orbit 使用个人 OAuth 额度。

证据信封的标准有一项来源差异：本任务 `projectId=null`、没有绑定项目 criterion；
`discoveredFromProjectId` 指向来源项目，其已有六条验收并非本次任务的四条标准。
服务端对此类任务匹配的是任务自身 `acceptanceCriteria`。提交应采用本任务 ID 和自身标准原文，
并明确该差异，不能把无关项目条目当作本任务的验收授权。
