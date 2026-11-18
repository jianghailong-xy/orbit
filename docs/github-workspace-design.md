# 从 GitHub 仓库建 workspace：设计方案

> 状态：已定稿，2026-11-11。所有者按推荐定了方案（§12）和设计图；实现按 §11 分期进行。
> 设计图：[`docs/mocks/github-workspace/`](mocks/github-workspace/README.md)（已确认）。
> 代码基线：`10d2f6649`。

## 0. 一句话

用户在设置里连上 GitHub（一个由部署管理员注册的 **GitHub App**）。在机器的设置卡上选 **From GitHub**，挑一个仓库，
发出第一条消息。Orbit 把 workspace、会话和第一条消息一起建出来，runner 把仓库 clone 到 `<reposRoot>/<repo>`。
clone 完成之前会话不派发。clone、fetch 和落地 push 用的是 Orbit 现签的短期 token：只对这一个仓库有效，1 小时过期。
这个 token 不写进磁盘，也不进 agent 的 shell。

## 1. 现状

| 事实 | 位置 | 对方案的影响 |
|---|---|---|
| `POST /sessions` 带 `newWorkspace: { workDir } \| { newFolder }`，一个事务里建 workspace、会话和第一条消息 | `src/apiserver/src/sessions/new-workspace.ts`，`docs/first-workspace-contract.md` §3 | clone 是第三种来源：`{ github }` |
| `newFolder` 的 workspace 带 `autoCreateWorkDir`，runner 在引擎启动前 `mkdir -p`，只允许在 reposRoot 里面 | `src/runner-go/create_workdir.go` | clone 沿用同一套路径校验 |
| runner 自己的网络 git 先清空凭据助手，再挂上 `orbit git-credential-readonly`，由它转问机器上原有的凭据 | `src/runner-go/network_git.go:102` | token 从这个助手发，remote URL 里不写 token |
| 落地会 push 到 `origin` | `worktree.go:2064`、`integrate.go:1158`、`merge_recovery.go:278` | 走同一个助手，所以托管 runner 也能推回 GitHub |
| `Workspace.repoUrl` 由目录探测从 `origin` 回填，项目的 Codebase 绑定读它 | `schema.prisma` Workspace | clone 出来的 workspace 建好时就填上 URL，项目那边不用改 |
| 心跳带着目录探测结果（`workDirExists`、`workDirIsGit`） | Workspace 的 `workDir*` 列 | clone 状态随同一个心跳回报 |
| 管理员配置的第三方凭据加密存库（Google 登录、飞书） | `docs/google-sign-in-design.md` §7.1、`AdminIntegrationsPage.tsx` | GitHub App 配置用同一种做法 |
| 用户自己的集成放在 Settings → Integrations（飞书） | `SettingsPage.tsx` `IntegrationsCard` | GitHub 加一行 |
| 托管 runner（Docker 或 Kubernetes）上没有用户的 git 凭据 | `docs/managed-runner-design.md` | 托管 runner 上只能用 token，所以必须由 Orbit 来签 |
| agent 和 runner 跑在同一个 OS 用户下 | `docs/design/owner-request-secrets.md` §5.3 | agent 只要能触发助手就能读到 token，所以不给它触发（§7） |

## 2. 目标与非目标

**目标（v1）**

1. 用户连接自己的 GitHub，从自己有权限、并且装了 App 的仓库里挑一个（含私有仓库），在任意机器上建 workspace。
   托管 runner 和自托管 runner 都支持。
2. clone、fetch 和落地 push 都能用，不需要用户在机器上配凭据。
3. clone 慢或失败时，用户能看到进度和原因，并且可以重试。

**非目标**：创建或评审 PR、webhook 同步、Issues 导入、用 GitHub 账号登录 Orbit、GitLab 和 Bitbucket、
把已有的 workspace 改绑到别的仓库。数据模型里留出 `provider` 维度，以后再加。

## 3. 为什么用 GitHub App

| | GitHub App（选定） | OAuth App | 粘贴 PAT |
|---|---|---|---|
| 授权范围 | 用户在 GitHub 上勾选仓库 | `repo` scope，能访问所有私有仓库 | 由用户自己决定 |
| token | installation token 可以限定到**一个仓库**和 `contents:write`，1 小时过期 | 长期有效 | 长期有效 |
| 组织仓库 | 组织管理员装一次 | 要组织批准 OAuth App | 要 fine-grained 审批 |
| 部署成本 | 每个部署由管理员注册一次 App | 注册一次 | 无 |

两种 token 的分工：

- **user-to-server token**（用户授权得到，8 小时过期，带 refresh token）只用来回答"这个用户能看到哪些装了 App 的仓库"。
- **installation token**（用 App 私钥签 JWT 去换）只用来做 git 操作，每次都限定到一个仓库。

## 4. 数据模型（一次迁移，编号落地时按惯例扫 main、project/* 和已推送的 orbit/*）

```prisma
/// 每个部署一行，由管理员在管理区填写。密钥用 providers/provider-crypto.ts 加密，只写不读。
model GithubAppConfig {
  id              String   @id @default("github")
  enabled         Boolean  @default(false)
  appId           BigInt
  slug            String            // 拼安装链接 https://github.com/apps/<slug>/installations/new
  clientId        String
  clientSecretEnc String
  privateKeyEnc   String            // PEM
  updatedById     String?  @db.Uuid
  updatedAt       DateTime @updatedAt
  @@map("github_app_config")
}

/// 一个 Orbit 用户连接的 GitHub 账号，最多一个。
model GithubConnection {
  id               String   @id @default(uuid(7)) @db.Uuid
  ownerId          String   @unique @db.Uuid
  githubUserId     BigInt
  login            String
  accessTokenEnc   String
  refreshTokenEnc  String
  accessExpiresAt  DateTime @db.Timestamptz(3)
  refreshExpiresAt DateTime @db.Timestamptz(3)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@map("github_connection")
}

// Workspace 增加以下列（都可为空；一个 workspace 不是从 GitHub 来的，这几列全为 NULL）：
githubRepoId         BigInt?   // 以仓库 ID 为准，仓库改名或转移后依然有效
githubInstallationId BigInt?
cloneRef             String?   // 不填表示默认分支
cloneState           String?   // PENDING | CLONING | READY | FAILED，由 CHECK 约束
cloneError           String?   // FAILED 时的原因（英文，已脱敏）
cloneStartedAt       DateTime?
cloneFinishedAt      DateTime?
```

- `repoUrl` 在建的时候就写成 `https://github.com/<owner>/<name>.git`，探测不会覆盖已有的 URL。
- 这几列 v1 只在建的时候写一次，之后不能改（PATCH 拒绝），所以不需要加入 workspace write card 的字段表。
  例外是 Retry：它把 `FAILED` 改回 `PENDING`。
- 删除 GitHub 连接时不删 workspace。已经 clone 好的目录照常能用；需要 token 的操作会失败，并提示重新连接。

## 5. 接口

### 5.1 管理员

| 接口 | 说明 |
|---|---|
| `GET /admin/integrations/github` | `{ enabled, appId, slug, clientId, secretSaved, keySaved, secretUnreadable, callbackUrl, connectedUsers }` |
| `PUT /admin/integrations/github` | 写入配置。密钥字段留空表示不改；保存时用 JWT 调 `GET /app` 核对 appId 和 slug，核对失败就拒绝保存 |

`callbackUrl` = `${PUBLIC_ORIGIN}/api/integrations/github/callback`，页面上带复制按钮。

### 5.2 用户

| 接口 | 说明 |
|---|---|
| `GET /integrations/github` | `{ available, connected, login, installations: [{ id, account, type, repositorySelection }] }`。`available=false` 表示管理员没配 |
| `GET /integrations/github/start?return=<path>` | 302 到 GitHub 授权页。state 和 PKCE 存服务端，10 分钟过期，只能用一次 |
| `GET /integrations/github/callback` | 换 token，写 `GithubConnection`，302 回 `return`。同一个 GitHub 账号已经连在别的 Orbit 账号上时，拒绝并说明 |
| `DELETE /integrations/github` | 删连接，并调 GitHub 吊销 user token |
| `GET /integrations/github/repos?q=&cursor=` | 搜索用户能选的仓库：`{ id, fullName, private, defaultBranch, installationId, pushedAt }`，按最近 push 排序。服务端缓存 60 秒 |
| `GET /integrations/github/repos/:id/branches?q=` | 分支补全，只在用户展开 Branch 时调用 |

权限：浏览器会话可以直接调；PAT 要有 `workspaces:write` scope。

### 5.3 建 workspace

`POST /sessions` 的 `newWorkspace` 可以是 `{ workDir }`、`{ newFolder }` 或
`{ github: { repoId, ref?, folder? } }`，三选一。`folder` 默认取仓库名，规则沿用 `newFolder` 的正则。

服务端按以下顺序拒绝，拒绝时什么都不写：

| 答复 | 条件 |
|---|---|
| 400 | 形状不对，或 `folder` 不合规 |
| 409 `GITHUB_NOT_CONNECTED` | 没连接，或 refresh token 过期 |
| 403 `GITHUB_REPO_FORBIDDEN` | 用 user token 现查，这个用户看不到这个仓库 |
| 409 `CLONE_UNSUPPORTED` | runner 没报 `reposRoot`，或者没声明 `clone-workdir/v1` |
| 其他 | 和 `newFolder` 一样（引擎未登录、提示词过长……） |

写入（一个事务）：和 `newFolder` 一样，另外再写

- `workDir = <reposRoot>/<folder>`；
- `autoCreateWorkDir = false`；
- `githubRepoId`、`githubInstallationId`、`cloneRef`、`repoUrl`；
- `cloneState = PENDING`。

文件夹重名的问题由客户端先用现有的 dir-probe 查一次（和 `newFolder` 一样），runner 在 clone 时再兜底（§6）。

`POST /workspaces/:id/clone/retry`：只能在 `FAILED` 时调用，把状态改回 `PENDING`，清空 `cloneError`。

### 5.4 Runner

| 接口 | 说明 |
|---|---|
| 心跳答复 `cloneRequests: [{ workspaceId, workDir, url, ref }]` | 列出这台 runner 上所有 `PENDING` 和 `CLONING` 的 workspace。这是全量对账，runner 收到后幂等地处理 |
| 心跳上报 `cloneReports: [{ workspaceId, state, error?, progress? }]` | 由服务端推进状态。进度只是 git 输出的百分比，不落库，只转发给客户端 |
| `POST /runner/git-credential`（RunnerAuthGuard） | 请求体 `{ workspaceId, host, path }`，答复 `{ username: "x-access-token", password, expiresAt }` |

`/runner/git-credential` 只在以下条件都满足时才签：workspace 属于这台 runner；`host` 是 `github.com`；`path`
和 workspace 的仓库一致（先用 repoId 反查当前的 fullName，所以仓库改名后也能用）；owner 的连接仍然有效，
并且最近 10 分钟内核对过这个用户仍能访问这个仓库。签出的 installation token 带 `repository_ids: [repoId]` 和
`permissions: { contents: write, metadata: read }`。同一个仓库的 token 在过期前 5 分钟内复用缓存，缓存只放内存，不落库。

## 6. Runner 端（`clone-workdir/v1`，需要发一版 runner）

1. 收到 `cloneRequest` 后先做路径校验，用 `orbitWorkDirTarget` 那一套：只能在 reposRoot 里面，不能带 `..`，要解析软链接。
2. 目标已经存在时：如果是同一个仓库的 git 目录（`origin` 一致），直接报 `READY`；其他情况都报 `FAILED`，
   原因写 `"<path> already exists on <machine>"`。
3. 执行 `git clone --origin origin [--branch <ref>] <url> <tmp>`，在 reposRoot 里的临时目录中进行，完成后 rename 到目标位置。
   这样做的原因是中途失败不会留下半个仓库，之后的重试也是干净的。不加 `--depth`，因为落地和 merge-base 需要完整历史。
4. 凭据走 `networkGitArgs` 的助手，顺序是：先问机器上原有的凭据（自托管 runner 优先用它）；没有答复，或者 clone 因认证
   失败，就向 `/runner/git-credential` 要 token 再试一次。用的是哪种凭据（`machine` 或 `github-app`）随报告上送，
   设置页可以据此显示。
5. 超时：30 分钟没有进展（git 的进度输出停止更新）就判定失败。runner 重启后，`CLONING` 的 workspace 会在下一次对账时
   重新开始，临时目录会先清掉。
6. 结果随下一次心跳上报，同时立刻重跑一次目录探测，让 `workDirIsGit` 跟着更新。

**派发门槛**：`cloneState` 不为 NULL 也不为 `READY` 时，这个 workspace 的会话留在队列里，原因是
`WORKSPACE_CLONING`；`FAILED` 时原因是 `WORKSPACE_CLONE_FAILED`。这个门槛和磁盘、配额门槛放在同一层，所以
会话页的"没开始"卡能把原因说出来。

## 7. 安全边界

- **token 不进 agent 的 shell**。助手只挂在 runner 自己执行的 git 命令上（`networkGitArgs` 的 `-c credential.helper`），
  checkout 的 `.git/config` 里不写助手，remote URL 里不写 token，引擎的环境变量里也没有它。
  后果是 agent 自己执行 `git fetch` 或 `git push` 时，在托管 runner 上会因为没有凭据而失败（在自托管 runner 上，
  它会用机器自己的凭据，这和今天一样）。改动经由 Orbit 的落地推回 GitHub。这个限制写进 agent 的系统提示：
  "This checkout's GitHub credential is Orbit's: land your work to push it."
- 即使这样，同一个 OS 用户下的 agent 依然可能读到 runner 进程的内存或网络流量。这个限制和
  owner-request-secrets §5.3 相同，文档和设置页都不承诺做不到的事。
- token 进日志之前先脱敏：`secret-redaction.ts` 已经能识别 `ghs_` 前缀，runner 端的 `integration_output_upload.go`
  也已经列出了 `GH_TOKEN`。
- installation token 只有单仓库和 `contents:write` 权限，泄露后的影响限于这一个仓库，最长 1 小时。
- 安装或卸载 App 由用户在 GitHub 上操作。卸载后签 token 会失败，提示是
  "Orbit's GitHub App is no longer installed on owner/repo. Install it again or pick another repository."

## 8. 客户端

界面文案全部英文。设计图见 [`docs/mocks/github-workspace/`](mocks/github-workspace/README.md)。

- **Settings → Integrations**：在 Feishu 下面加一行 GitHub。未连接时是 *Connect*，已连接时显示 `@login · N repositories`
  和 *Manage*。Manage 页：账号、各个安装（*Configure on GitHub* 链接）、*Disconnect*。
- **管理区 → Integrations**：在 Feishu bots 下面加一张 GitHub App 卡片：开关、App ID、Client ID、Client secret、
  私钥（只写），回调地址带复制按钮，以及在 GitHub 上注册 App 的步骤和需要勾选的权限。
- **设置卡（`MachineSetupCard`）的 Folder 步骤**：在 "Where you ran orbit register / A new folder / Another folder"
  后面加 **From GitHub**。
  - 部署没配 App：不显示这个选项。
  - 未连接：显示 *Connect GitHub*（跳去授权，回来时停在这张卡上，选项保持选中）。
  - 已连接：显示仓库搜索框，最近 push 的仓库排在前面；带 Private 标记；有可选的 Branch；下面写出文件夹路径
    `<reposRoot>/<name>`，可以改名。列表里找不到仓库时，给出 *Add repositories on GitHub*。
  - 选好以后的完成行是 `owner/repo → ~/orbit-repos/repo · cloned before the session starts`。
- **会话第一行**：clone 进行中时显示 *Cloning owner/repo on machine… 42%*；完成后显示今天的 *Created workspace …*，
  后面加 `owner/repo` 链接；失败时显示原因和 *Retry*、*Settings*。
- **机器页 Add workspace**、iOS、macOS 和 Android 等 Web 定稿后跟进，结构相同。

## 9. 与在途工作的衔接

- **项目 Codebase 绑定**：读 `repoUrl`，无需改动。
- **workspace write card 规则**：新列在建好后就不能改，MCP 的 `agent_create` 和 `agent_update` v1 也不提供 GitHub
  来源，所以不需要加卡。以后开放时，按规则加入 `WORKSPACE_WRITE_CARD_FIELDS`。
- **托管 runner**：这是最直接的受益者。托管 runner 默认的 workspace 不变；用户可以在托管机器上再建 GitHub workspace。

## 10. 测试与验收

- apiserver pg spec：三种来源互斥；拒绝码按顺序生效；事务回滚；token 只签给自己的 workspace、自己的仓库和自己的 runner
  （租户隔离普查加上这几行）；clone 状态机；派发门槛。
- runner go test：路径校验、目标已存在、临时目录和 rename、认证失败后换 token 重试、重启后恢复。
- 真机验收：用一个真的 GitHub App（测试组织），在托管 runner 上 clone 一个私有仓库，跑一次会话并落地，在 GitHub 上
  看到 commit；在自托管 runner 上走机器凭据。
- copyLanguage 测试保持绿色：新文案全部英文。

## 11. 落地顺序

| 期 | 内容 | 依赖 |
|---|---|---|
| P0 | 迁移；管理员配置接口和页面；用户连接流程；仓库列表 | — |
| P1 | `newWorkspace.github`；`/runner/git-credential`；心跳对账；派发门槛 | P0 |
| P1r | runner `clone-workdir/v1` 发版（bump + runner-release.json） | P1 的协议 |
| P2 | Web：设置卡 From GitHub、clone 状态行、Settings 和管理区 | P1、设计图确认 |
| P3 | iOS、macOS、Android | P2 |

## 12. 所有者决定（2026-11-11：按推荐）

1. 用 **GitHub App**，不做 PAT 粘贴后备。
2. agent **不能**直接拿 token push，改动经 Orbit 落地推回（§7）。
3. 托管和自托管 runner **都支持**；自托管 runner 优先用机器自己的凭据。
4. v1 就支持**私有仓库**。

设计图上的四项界面细节也已定（2026-11-11，按推荐），见 [`docs/mocks/github-workspace/README.md`](mocks/github-workspace/README.md)。
