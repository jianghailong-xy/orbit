# agy 1.2.16 Google 认证：二进制静态分析

分析日期：2026-10-04。对象是任务安装的 Linux amd64 `agy` 1.2.16：

```text
SHA512 fa4de3267ad38d4baaa217010757d9cadce9b4bd94ab995b81b34399ca1577758067bc9892ce498ce76345671142e3a6c949df38b07f1b3d4e2cf4cf46cf3044
SHA256 a759ce7c7a235d9b6c281a25ead97cbbf2e92314a3ffd224e2f9144f3fae7a86
```

**本文件全部是二进制推断，不是登录实测。** 分析者没有运行 `agy`、登录 Google、读取用户凭据或访问用户钥匙串。它只能说明此版本包含哪些实现分支，不能证明真实 OAuth、无 TTY 输入、跨进程并发续期、撤销后的流事件或额度行为。真实运行样本见同目录的 `google-auth-*.json`。

## 分析方法与证据边界

这是移除了普通符号表的 ELF64 PIE。系统现有 Go 安装缺少 `nm` 工具；用现有 Go 源码在 `/tmp` 构建的 `nm` 也报告无符号表。随后只读解析 ELF、Go `pclntab` 和相对重定位，恢复函数地址，以 `objdump` 查看目标函数。下文地址是该二进制的 ELF 虚拟地址；函数名来自 `pclntab`，字符串按调用点的明确长度读取，省略相邻无关只读数据。

可复核原始指令，例如：

```sh
sha512sum /tmp/orbit-agy-google-a7avxwap/bin/agy
objdump -d --no-show-raw-insn --start-address=0x830fc00 --stop-address=0x830fee0 /tmp/orbit-agy-google-a7avxwap/bin/agy
objdump -d --no-show-raw-insn --start-address=0x7690a60 --stop-address=0x7691000 /tmp/orbit-agy-google-a7avxwap/bin/agy
```

这里没有提交完整反汇编、OAuth 客户端常量或任何认证实例值。以下伪代码是对所列指令的解释，不是 Google 公布的源码。

## 正常 CLI 的凭据存储与隔离

`auth.NewCLITokenStorage`（`0x830fc00`）接收 keyring 用户名、`appDataDir` 和产品名。正常消费者产品在 `backend.NewServerBackend`（`0x831c340`）中选择 `antigravity`，keyring 用户名也选择 `antigravity`；另有内部产品 `jetski` / 用户名 `jetski-cli` 分支。

正常 CLI 的默认 `appDataDir` 是 `<gemini_dir>/antigravity-cli`（也与既有运行契约的目录观测一致）。构造函数拼出：

```text
文件存储：<appDataDir>/antigravity-oauth-token
超时标记：<appDataDir>/cache/antigravity-keyring-unavailable
```

最小证据：

```text
0x831c6ad..0x831c6c8  将 appDataDir、产品名和 keyring 用户名传入
0x831c6cd             call auth.NewCLITokenStorage
0x830fcdf             lea "-oauth-token", %rdi
0x830fce6             mov $0xc, %esi
                       runtime.concatstring2，随后 filepath.join
```

keyring service 是固定的 `gemini`，用户键是上面的 `antigravity`。`KeyringTokenStorage.LoadStoredToken`、写入和删除都使用同一对参数。Linux Secret Service 实现的 `findItem`（`0x6ac7a20`）搜索 login collection，属性名是 `service` 和 `username`。这里确认的是搜索属性，不是运行中 item 的可见 label。

```text
0x76afbb7..0x76afbbc  从 receiver 读取用户键
0x76afbd0             lea "gemini", %rbx
0x76afbd7             mov $0x6, %ecx
0x76afbdc             call keyring-provider.Get
0x76b009a             lea "gemini", %rbx
0x76b00a1             mov $0x6, %ecx
0x76b00a6             call keyring-provider.Delete
```

因此，**`--gemini_dir` 只改变文件路径，不能单独隔离正常系统钥匙串中的账号**。HOME / XDG 改动也没有改变这两个固定 keyring 参数；必须确认该进程走文件模式或使用真正独立的 Secret Service。

`codeassistclient.NewCompositeTokenStorage`（`0x768ebc0`）有强制文件、环境探测、近期 keyring 超时标记三个文件分支。正常 CLI 构造调用未设置强制文件参数。可识别字符串包括：

```text
Using file-based token storage because the caller requested it
Using file-based token storage because %s detected
Using file-based token storage because a keyring timeout was recorded within the last %v
Failed to save token to keyring, falling back to file: %v
Keyring SaveToken timed out after %v, falling back to file storage
Keyring LoadToken timed out after %v, falling back to file storage
```

静态确认的探测器：

| 探测器 / 地址 | 触发条件 |
| --- | --- |
| `sshDetector.Detect` / `0x76a3020` | `SSH_TTY`、`SSH_CLIENT`、`SSH_CONNECTION` 任一非空 |
| `containerDetector.Detect` / `0x76a2e20` | `/.dockerenv` 存在，或 `/proc/1/cgroup` 包含 `docker`、`containerd`、`kubepods` |
| `dbusDetector.Detect` / `0x76a2f40` | 空、`none:`、`disabled:` 的 `DBUS_SESSION_BUS_ADDRESS` 会继续检查会话总线 socket；未找到时绕过 keyring |

非空的其他 D-Bus 地址不等于服务实际可用；操作错误仍可能触发文件 fallback。文件 fallback 由 composite storage 实现，底层不支持的平台 keyring provider 本身只返回错误。

`cliFileTokenStorage.updateStoredToken`（`0x830fee0`）通过 JSON 读改写保存。目录创建参数为 `0755`（`0x83100b1`），文件写入参数为 `0600`（`0x8310168`）；宿主应先创建 `0700` 的私有父目录。此函数使用 `os.WriteFile`，未见原子 rename 或跨进程锁。两个账号使用不同文件目录具有静态隔离依据；同账号在多进程间的 refresh 并发安全不能据此成立。

## 普通交互登录与超时

`oauthMethod.StartInteractive`（`0x830c9a0`）生成 PKCE verifier / S256 challenge、随机 state，授权请求带 `prompt=consent`；redirect URI 常量是 `https://antigravity.google/oauth-callback`。它检查 `SSH_CLIENT`、`SSH_TTY`、`SSH_CONNECTION`，任一非空就跳过自动打开浏览器；该函数里未找到以 TTY 存在与否选择此分支的判断。

`AuthModel.renderFullView`（`0x87978c0`）的人工回填提示是：

```text
Open the URL below in your browser:
After authenticating, copy the code displayed in the browser and paste it below:
```

自动浏览器分支的提示是：

```text
Your browser should open automatically. If not:
If you aren't automatically redirected, paste the authorization code below:
```

`oauthMethod.SubmitAuthorizationCode`（`0x830ce20`）和 `completeOAuth`（`0x830cf40`）存在，UI 等待分支处理 Enter / Escape。**这些函数不能证明 pipe stdin 能驱动登录**；普通输入桥接应由实际无 TTY 样本判断。

`ServerBackend.resolveIsInteractive`（`0x8325d40`）读取 `AGY_CLI_NONINTERACTIVE_HEADLESS`、`AGY_CLI_INTERACTIVE_HEADLESS` 和 `headless` 输入格式。这是后端交互模式的内部开关，不能当成已经验证的登录命令。

本次静态检查未确定整个人工授权过程的最长等待时间，也未确定 Google 授权码的有效期。可精确确认的局部超时如下，不能互相替代：

| 路径 | 时长 | 最小证据 |
| --- | --- | --- |
| `shouldBypassKeyring` 环境探测 | 500 ms | `0x1dcd6500` 纳秒传入 timer |
| composite 的 keyring Save / Load / Remove | 5 s | 全局 `0xaec3748` 初值 `0x12a05f200` 纳秒；Remove 在 `0x7690b29` 读取后调用 `time.NewTimer` |
| `keyringAuth.TryAuth` | 10 s | `0x2540be400` 纳秒传入 timer；超时日志 `keyringAuth: timed out after %v, skipping keyring auth` |
| 隐藏 CDE 的已存凭据验证 | 15 s | `0x8313195 movabs $0x37e11d600, %rcx`；`0x83131a0 call context.WithTimeout` |

## 自动续期与认证错误标识

`auth.savingTokenSource.Token`（`0x830db60`）持有进程内 mutex，调用包裹的 TokenSource，发现 access token 改变时调用当前 storage 的 SaveToken。二进制也包含 OAuth2 `tokenRefresher.Token`（`0x64091c0`）及其 `retrieveToken` 调用。由此可推断它实现了自动续期与保存；没有实测 token 到期、Google 撤销或跨进程同时刷新。

```text
token refreshed, new expiry=%v
Failed to save refreshed token: %v
token refresh failed due to network error: %v
token refresh failed: %v
```

`savingTokenSource.Token` 在续期失败时只用 `go_utils.IsNetworkError` 选择两种日志，随后返回原错误和 nil token；在这一函数里未见专门的 revoked / invalid_grant 流事件映射。保存新 token 失败会记录警告，此成功刷新分支仍返回拿到的 token。

另一个函数 `auth.ValidateStoredToken`（`0x8311240`）会强制验证 refresh token：缺少 refresh token 时返回 `%w: no refresh token`；OAuth 错误的 HTTP status 在 400–499 范围且不等于 429 时，返回 `%w: %v`。所包装的 error sentinel 原文为 **`credentials rejected`**（全局 error interface `0xab688b0`，对应只读字符串长度 20）。其他错误原样返回。

```text
0x8311463  lea -0x190(%rdx), %r8  # status - 400
0x831146a  cmp $0x64, %r8        # 100
0x831146e  jae 0x831154a         # 不在 400..499：原错误
0x8311480  cmp $0x1ad, %rdx      # 429
0x8311487  je 0x831154a          # 429：原错误
0x8311500  call fmt.errorf       # "%w: %v"，包装 credentials rejected
```

这提示状态探测应区分认证被拒、网络失败与限流。**不能把该内部 sentinel 宣称为 `stream-json` 的已验证事件、错误字段或退出码**；还需要真实过期 / 撤销样本。

## 正常 Logout 的顺序及删除范围

`ChainedAuth.Logout`（`0x830c420`）遍历各认证方法的 Logout 并清空当前认证状态。OAuth 方法（`0x830d1c0`）先 Cancel，再调用其 token storage 的 RemoveToken；删除失败只记录 `%sOAuth: failed to remove token: %v`。该路径未见 Google revoke HTTP 调用，因此本地登出不能等同远端撤销授权。

composite Remove（`0x7690a60`）的顺序为：

1. 若 `isUseFileStatic` 为真，直接调用文件 Remove（`0x7690f8a..0x7690fa0`），不调用 keyring Remove。
2. 否则异步调用 keyring Remove，最多等 5 秒（`0x7690aa8..0x7690d1e`）。无论该操作成功、失败或超时，之后都调用文件 Remove（`0x7690d2b..0x7690d37`）。
3. 两者都失败才返回 `failed to remove token from both keyring (%v) and file (%v)`；仅一者失败会记警告，但最终返回 nil。因此“Logout 已返回”不能单独证明两个存储都清掉。

默认 OAuth 消费者对应的删除目标仍是 `service=gemini / username=antigravity` 和 `<gemini_dir>/antigravity-cli/antigravity-oauth-token`，不是任意扫描整个用户钥匙串或 `.gemini`。

两个 Remove 实现有相同的 metadata 保留分支：

| 条件 | 文件 `RemoveToken`（`0x8310da0`） | keyring `RemoveToken`（`0x76b0000`） |
| --- | --- | --- |
| 读到非空 `WIFProvider` 或 `SavedWIFProvider` | 清空 StoredToken 全部字段，只保留 `SavedWIFProvider`，通过 updateStoredToken 重写 JSON | 同样清空并重写该 item |
| 无上述字段、读取失败或无记录 | `os.Remove` 指定 token 文件；不存在视成功 | provider.Delete 指定 service / username；不存在视成功 |

字段名来自 `StoredToken` 的 Go 反射描述（`0xa47fbd0`）：`WIFProvider` 位于 `0x28`、`SavedWIFProvider` 位于 `0x38`，JSON tag 分别是 `wif_provider`、`saved_wif_provider`。Remove 优先保留原 SavedWIFProvider，空时保留原 WIFProvider；其 closure 将 `0x0..0x87` 清零后仅写回 `0x38/0x40`。所以 OAuth token / ID token /账号相关 tier / project 等字段会被清空，但带 WIF 元数据时 token 文件或 item 可以合法留下；必须核验认证字段清空，不能只用文件是否存在判断登出。

## 隐藏 CDE 入口：不可直接当作 doctor 契约

`main.main`（`0x892d100`）在常规参数解析之前检查 `AGY_CLI_CDE_AUTH_ACTION`。只有环境变量非空且 `len(os.Args) <= 1` 才调用 `RunAuthActionWithOptions` 然后退出：

```text
0x892d15e  lea "AGY_CLI_CDE_AUTH_ACTION", %rax
0x892d16a  call os.Getenv
0x892d172  je 0x892d285                 # 空：常规 CLI
0x892d178  cmpq $0x1, 0xac6a758         # os.Args.len
0x892d180  jg 0x892d285                 # 有任意参数：常规 CLI
0x892d27a  call auth.RunAuthActionWithOptions
0x892d280  call os.Exit
```

**添加 `--gemini_dir` 就会跳过该隐藏入口。** 本任务要求每次实验都带这个隔离 flag，因此没有运行该入口。

入口接受 `check` / `login`，未知 action 静态返回 2，login/check 成功返回 0、失败返回 1。`check` 设置检查模式，调用已有凭据的验证 closure，不打开登录页面；handler 的 check 失败分支没有主动打印 `Authentication failed`。成功时能静态确认的文本为：

```text
Already authenticated as <REDACTED_ACCOUNT>.
Already authenticated.
```

前者的原始格式常量是 `Already authenticated as %s.\n`，值来自 ID token claims，必须先脱敏。缺凭据的内部错误为 `not authenticated: no stored credentials found`；验证失败会包为 `stored credentials are invalid or expired: %w`。这些是内部错误/格式常量，未实测其完整 stdout / stderr。

隐藏 login 的成功格式是 `Successfully authenticated as %s.\n` 或 `Successfully authenticated.`；错误 handler 格式为 `Authentication failed: %v\n`；未知 action 为 `Unknown AGY_CLI_CDE_AUTH_ACTION: %q (supported: check, login)\n`。

更关键的是，该无参数入口未传普通 CLI token storage；`RunLogin` 在 storage=nil 时调用 `defaultTokenStorage`（`0x830e940`）。后者构造的文件存储（`NewFileTokenStorage` / `0x76b0100`）使用 `os.UserHomeDir`，路径为 **`$HOME/.gemini/jetski-standalone-oauth-token`**，keyring 仍是 `gemini / antigravity`。这与普通 CLI 的 `<gemini_dir>/antigravity-cli/antigravity-oauth-token` 不同。隐藏 login 还走 BrowserTokenAcquirer 的 localhost callback，包含 `ANTIGRAVITY_OPEN_URL: %s\n` 输出常量；它不能作为普通 SSH 人工授权路径的证据。

因此，即使忽略参数限制，也不能把 CDE check 的退出码直接当成 Orbit 正常隔离会话“同一个账号已登录”的判断。需要先验证相同存储 / provider，不能仅因为名字含 `check` 就接入 doctor。

## 尚未由本文件确立的事实

人工 OAuth 回填在无 TTY 的 stdin 下能否完成、授权 URL 的实际形状与最长等待时间、两个 Google 账号同时登录并对话、跨进程续期安全、撤销后 stream-json、Google 实际额度及限流，以及 Google 条款许可，均不能由以上静态分析确定。相应结论必须引用真实运行记录或官方条款。
