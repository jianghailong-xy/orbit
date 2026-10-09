# Provider 与 Engine 解耦：实现契约

**状态**：T1 交付（2026-10-09），项目「Provider 与 Engine 解耦」（`34ccMg4EoSorpVooMC4kg`）T2–T9 共用。
设计决定以项目作业指导为准，本文把它写成实现必须遵守的数据形状、判定规则和接口；两者冲突时以作业指导为准，在任务评论里交协调会话裁决。
**代码基线**：main `caea4729b`，下文的文件与行号都指这一版。兼容表只在 [`src/shared/src/providerEngines.ts`](../src/shared/src/providerEngines.ts) 实现一次，服务端直接调用，Swift/Kotlin 镜像。

## 0. 一页结论

- **engine** 是 runner 上实际执行、产生 `runtimeSessionId` 的 CLI，取值为 `AgentProvider` 的六个值。会话的 engine 写在 `Session.engine`，写入后不再改变；换 engine 就是开新会话。
- **provider** 只表示凭据来源，仍存 slug：runner 登录（slug 即 engine 名）、账号池、key（`ModelProvider` 行）、OpenCode 自身配置。凭据可以在会话 engine 兼容的 provider 之间切换。
- `ModelProvider.runtime` 只表示 key 的协议方言，不再决定 engine。迁移后不再有 `dsh` 值；`deepseek-harness` 配置并入 DeepSeek key，旧 slug 成为别名，解析为对应 key + `dsh`。
- 所有入口共用一个解析函数，把 (engine?, provider?, model?) 解析成确定的 (engine, provider, model)。只给 provider 的旧调用得到解耦前的 engine。
- 派发、续聊、meta、effort、权限模式、fast、slash、审批记忆一律读会话 engine，不读原始 slug。engine 为空时按旧规则推导（§5.4），但不再把找不到的凭据当成 Claude。
- 旧 API 副本不认识 engine：领取和续租事务要声明 `orbit.claim_reads_session_engine`，否则触发器不让它领取或续租任何已记录 engine 的会话（§5）。

| 词 | 本文的含义 |
| --- | --- |
| engine | 执行会话的 CLI；代码里是 `AgentProvider` 值：`claude`、`codex`、`kimi`、`antigravity`、`opencode`、`dsh` |
| CLI 名称 | `ENGINE_CLI_NAMES`：Claude Code、Codex、Kimi Code、Antigravity CLI、OpenCode、DeepSeek Harness，与 Web 现有的 `ENGINE_CLI_NAME`（`src/web/src/lib/runnerEngines.ts`）相同 |
| provider、凭据 | 会话花的凭据从哪来；`Session.provider`、`Task.provider` 里的 slug |
| key | 一行 `ModelProvider`：一把厂商 API key 和它的 endpoint |
| 方言 | key 的 endpoint 说的协议，即 `ModelProvider.runtime` 列（列名不改） |
| DeepSeek key | `isDeepSeekKey` 为真的 key（§2.1） |
| 旧规则 | 解耦前从 slug、key 行 runtime、池 engine 推出 engine 的规则（§5.4） |
| 新形态会话 | 已记录 engine 的会话；旧副本按旧规则执行它们可能选错 engine，例如 DeepSeek key 上的 `dsh` 会话（§5.3） |

## 1. 数据模型

### 1.1 `Session.engine`

- 列：`session.engine TEXT NULL`，Prisma `engine String?`。约束 `session_engine_check`：`engine IS NULL OR engine IN ('claude','codex','kimi','antigravity','opencode','dsh')`。schema 里所有 provider/engine 列都是 TEXT，没有枚举类型，这一列也一样。
- 含义：产生（或即将产生）这个会话 `runtimeSessionId` 的 engine。新代码在 INSERT 时写入。
- 不可改：`BEFORE UPDATE OF "engine"` 触发器 `session_engine_immutable` 在 `OLD.engine IS NOT NULL AND NEW.engine IS DISTINCT FROM OLD.engine` 时报 `check_violation`（约束名 `session_engine_immutable`）。从 NULL 写成某个值是允许的（回填、首次领取补写）。
- 可空期间 NULL 只有两种来源：旧 API 副本写入的行（它不认识这一列），以及回填无法确定的行（§7.1 的 `UNRESOLVED`）。
  - 读到 NULL 时按旧规则推导（§5.4），结果只用于本次判断。
  - 新副本领取 NULL 行时写回推导结果。领取语句选行时还算不出它，所以在同一事务里紧接一条 `UPDATE "session" SET "engine" = $derived WHERE "id" = $id AND "engine" IS NULL`，`$derived` 由 `legacySessionEngine`（§5.4）算出。这样一个会话最晚在其 runtime 第一次运行时就有了记录的 engine。
  - 会改变推导依据的写入，要先把推导结果写下，否则下一次推导会按新凭据算，把会话换到另一个 engine：
    - 改一个 NULL 行会话的 `provider` 或 `providerBuiltin` 时，在同一事务里先用旧凭据推导并写入 engine，再改 provider。推导为未知时按 §3.5。
    - 改 key 的方言或 baseUrl、换 key 时，先给引用这把 key、engine 为 NULL 的会话补上 engine（§3.6）。
  - 推导结果为「未知」（凭据已不存在）时不写回；这类会话的处理见 §3.5。
- 何时改成 NOT NULL：所有副本都是新版本、T4 的应用层迁移已执行、`UNRESOLVED` 行已处理之后，另起迁移。不在本项目内。
- 接口读出的 `engine`：列有值时给列值，列为 NULL 时给推导值，推导为未知时为 `null`。

### 1.2 `Task.engine`

- 列：`task.engine TEXT NULL`，约束 `task_engine_check`，值域同上。
- 含义：engine pin，和 `Task.provider`（凭据 pin）、`Task.model` 一起决定下一次运行：

| `engine` | `provider` | 下一次运行 |
| --- | --- | --- |
| 有 | 有 | 固定 (engine, provider)，写入时已校验兼容 |
| 有 | 空 | 只固定 engine：派发时按「只给 engine」解析凭据（§3.2） |
| 空 | 有 | 按「只给 provider」取默认 engine（§3.2）。来源：旧副本写入、回填未解决，或用户只清了 engine pin（§3.5） |
| 空 | 空 | 不固定：用工作区种子（§3.4） |

- 新代码写入 provider pin 时总把 engine 一起写入。只给 provider 的写入把默认 engine 写进 `Task.engine`（§3.5）。
- 改 engine pin 或 provider pin，效果与现在改 provider pin 相同。`planWorkspaceRun`（`tasks.service.ts`）按 pin 判断能否续用持有执行权的会话，改为比较 (engine, provider) 对（§3.5 的占用冲突）。
- Task 没有 `providerBuiltin` 列。派发时按 §3.1 的顺序判定 slug 的类别，与会话新建一致。

### 1.3 `Session.provider`：四类凭据来源

| 类别 | `provider` | `providerBuiltin` | 可用 engine | 补充 |
| --- | --- | --- | --- | --- |
| runner 登录 | `claude`、`codex`、`kimi`、`antigravity` | true | 同名 engine | 账号取 `Session.<engine>Account`（`claudeAccount`、`codexAccount`、`kimiAccount`、`antigravityAccount`），为空时取工作区同名列 |
| 账号池 | `ProviderPool.slug` | false | 池的 engine | 自有池为 `claude` 或 `codex`，共享池为 `codex`（`provider_pool_engine_check`）；领取时选成员 |
| key | `ModelProvider.slug` | false | 兼容表（§2） | 经别名解析到的 key，存 key 自己的 slug |
| OpenCode 自身配置 | `opencode` | true | 仅 `opencode` | runner 上 OpenCode 自己的 provider 配置 |

- 旧编码只在读取时兼容，新写入不再产生：
  - `provider='dsh' AND providerBuiltin`：engine `dsh` + 该用户的默认 DeepSeek key（§3.3）。今天这类会话派发时服务端不注入 key，只有工作区 env 里手写了 `ORBIT_DSH_API_KEY` 才能运行，否则在 runner 上以 `DSH_CREDENTIAL_MISSING` 失败；解耦后由默认 key 补上。
  - `provider='opencode'` 且 `model='orbit-<slug>/<model>'`：engine `opencode` + key `<slug>` + 模型 `<model>`。
- `providerBuiltin` 保持现有含义：区分内置的 `kimi`、`dsh` 与同名的配置身份。
  - 0077 把旧的 `kimi` 配置行改了名，并禁止再用这个 slug；但旧副本的陈旧写入仍可能带着它。
  - 0377 保留了已经叫 `dsh` 的配置行和池。
- 池的成员列（`poolMemberProviderId`、`poolKeyId`、`poolCodexAccountId`）不变。

### 1.4 `ModelProvider.runtime` 只表示协议方言

| `runtime` | 协议方言 | 原生 engine |
| --- | --- | --- |
| `claude` | Anthropic Messages | `claude` |
| `codex` | OpenAI Responses | `codex` |
| `kimi` | Moonshot 原生 API | `kimi` |
| `antigravity` | Gemini API | `antigravity` |
| `dsh`（迁移前遗留） | Anthropic Messages | `dsh` |

- 列名不改。`keyDialect()`（`src/shared/src/openCodeKeys.ts`）是方言的唯一映射。
- 写入不再产生 `dsh`：旧客户端以 `runtime: 'dsh'` 或 preset `deepseek-harness` 新建时存为 DeepSeek key（§3.6）；PATCH 把 `runtime` 改成 `dsh` 返回 `PROVIDER_RUNTIME_DSH_RETIRED`（§3.7）。
- 读路径继续接受遗留值：T4 迁移之前，`runtime='dsh'` 的行按 DeepSeek key 对待，默认 engine 仍是 `dsh`，不改变任何旧调用的结果。
- 给 engine 注入哪种环境变量由 engine 决定，不由 runtime 决定（§4.2）。
- preset `deepseek-harness` 留在 `PROVIDER_PRESETS` 里，直到所有部署都跑过 T4 迁移：它还承载未迁移行的读取（`isDeepSeekKey`、模型目录）。Providers 页不再显示它（T6）。

### 1.5 别名表 `provider_slug_alias`

T3 建表并扩展守卫，解析时读它；T4 的迁移写入数据。

```sql
CREATE TABLE "provider_slug_alias" (
  "slug"        TEXT PRIMARY KEY,
  "provider_id" UUID NOT NULL REFERENCES "model_provider"("id") ON DELETE CASCADE,
  "engine"      TEXT NOT NULL CHECK ("engine" = 'dsh'),
  "reason"      TEXT NOT NULL CHECK ("reason" IN ('MERGED', 'RENAMED')),
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "provider_slug_alias_provider_id_idx" ON "provider_slug_alias" ("provider_id");
```

- 每行是一个已不再属于任何行的旧 `deepseek-harness` slug。
  - `MERGED`：那一行并入了同一用户的另一把 DeepSeek key。
  - `RENAMED`：那一行原地转成 DeepSeek key，并换了 slug（§7.2）。
  - `engine` 是旧 slug 运行的 engine。本项目只有 `dsh`，以后可以放宽 CHECK。
- 不单独存 owner：别名对谁可用，看目标 key 对谁可用（`usableProviderScope`）。
- 删除 key 时级联删除它的别名，slug 随之释放，与删除普通 key 释放 slug 一致。会话 engine 不受影响（§3.6）。
- 纳入 0265 的 slug 命名空间守卫：
  - `provider_dispatch_slug_guard()` 改为检查三张表（`CREATE OR REPLACE`）。新增 holder 文案 `a retired provider name`。错误不变：`unique_violation`，`CONSTRAINT = 'provider_dispatch_slug_key'`，到 Prisma 是 P2002。
  - 别名表上加同一函数的 `BEFORE INSERT OR UPDATE OF "slug"` 触发器。
  - advisory lock 键不变（`'provider-dispatch-slug:' || slug`），三张表之间的竞争和现在两张表一样。
  - `ProvidersService.freeSlug` 同时读三张表，`withFreeSlug` 的重试不变。
- 别名只在解析时出现：任何列表都不列别名；会话、任务等存储的总是 key 自己的 slug。

### 1.6 其它存 provider slug 的位置

| 位置 | 现状 | 解耦后 |
| --- | --- | --- |
| `Workspace.modelRoutingProviders` | 已是 engine 名（`@IsIn(MODEL_ROUTING_ENGINES)`） | 不变 |
| `ManagedRunner.initialProvider` | 内置 engine 名 | 不变；种子的 engine 与 provider 都取它 |
| `WikiSpace.settings.maintenance.provider` | Claude 方言 key 的 slug | 不变；运行的 engine 固定为 `claude`（§3.5） |
| `User.preferences.defaultModels` | 键为 provider 选项 | 新键 `<engine>:<provider>`，旧键继续读取（§6.5） |
| `Workspace.providerFallbacks`（`[{provider, model?}]`） | 只存储，派发不读 | T4 把旧 DSH slug 改写为 key 的 slug（§7.3） |
| `Agent.defaultProvider`、`Agent.providerFallbacks` | 只存储，派发不读 | 不改写；以后若有读取方须经别名解析 |
| `TaskRouteDecision.provider`、`baseline`、`task_run_request.target/result`、run event | 历史记录 | 保持原样，读取时经别名解析（§6.4） |

## 2. 兼容表与模型空间

### 2.1 兼容表

| 凭据 | 可用 engine（第一个为默认） |
| --- | --- |
| runner 登录 `<e>` | `<e>` |
| 账号池 | 池的 engine |
| OpenCode 自身配置 | `opencode` |
| Anthropic 方言 key（非 DeepSeek） | `claude`、`opencode` |
| DeepSeek key（Anthropic 方言） | `claude`、`opencode`、`dsh` |
| 遗留 `runtime='dsh'` 行 | `dsh`、`claude`、`opencode` |
| Claude 订阅 token（`sk-ant-oat…`） | 只有 `claude`；方言不是 Anthropic 时没有可用 engine |
| OpenAI Responses key | `codex`、`opencode` |
| Moonshot key | `kimi`、`opencode` |
| Gemini key | `antigravity`、`opencode` |
| 方言未知的行 | 无 |

- DeepSeek key 的判定与 `isDeepSeekAccountRow`（`src/apiserver/src/providers/deepseek-balance.ts`）相同：
  - 有 preset 的行看 preset：`deepseek` 或 `deepseek-harness`。
  - 自定义行看 `baseUrl` 主机名是否为 `api.deepseek.com`，不分大小写；URL 解析失败即否。
  - T2/T3 把 `isDeepSeekAccountRow` 改为调用共享的 `isDeepSeekKey`，余额和兼容表从此用同一规则。
- 订阅 token 的判定需要解密 key（`trim()` 后以 `sk-ant-oat` 开头），只能在服务端做。共享模块接收调用方给的布尔值；客户端从接口的 `engines` 字段读取结果（§6.3）。
- 订阅 token 的规则优先于遗留行的默认：持有订阅 token 的遗留 `runtime='dsh'` 行只能跑 `claude`，默认 engine 也是 `claude`。
- 停用不影响兼容性：停用的 key 仍然「兼容」，只是不可用（§3.6）。

共享模块 `src/shared/src/providerEngines.ts` 从包入口导出：

```ts
export const ALL_ENGINES: readonly AgentProvider[];          // claude, codex, kimi, antigravity, opencode, dsh
export const ENGINE_CLI_NAMES: Readonly<Record<AgentProvider, string>>;
export function isEngine(value: unknown): value is AgentProvider;
export type EngineCredential =
  | { kind: 'login'; engine: LoginEngine }
  | { kind: 'pool'; engine: AgentProvider }
  | { kind: 'key'; runtime: string | null; presetSlug: string | null; baseUrl: string; subscriptionToken: boolean }
  | { kind: 'opencode' };
export function isDeepSeekKey(row: { presetSlug: string | null; baseUrl: string }): boolean;
export function credentialEngines(credential: EngineCredential): AgentProvider[]; // 默认在前，其余按 ALL_ENGINES
export function defaultEngineOf(credential: EngineCredential): AgentProvider | null;
export function isEngineCompatible(engine: string, credential: EngineCredential): boolean;
```

- 遗留的内置 `dsh` 不是凭据，不进这张表：解析时先换成默认 DeepSeek key（§3.3）。
- Swift（OrbitKit）和 Kotlin 镜像以上导出；单测用例要与 `providerEngines.spec.ts` 的用例逐条一致。
- 客户端拿 key 的 engines 一律读接口字段，不自己判断 DeepSeek 或订阅 token。

### 2.2 模型空间

模型目录按 (engine, 凭据) 计算：

| engine | 凭据 | 模型目录（picker 与派发同源） | 默认模型 |
| --- | --- | --- | --- |
| `claude` | 登录、Claude 账号池、preset `anthropic` 的 key | runner 上报的 Claude CLI 目录 | `runtimeDefaultModels.claude` → 目录第一行 → `DEFAULT_MODEL_BY_PROVIDER.claude` |
| `claude` | 其它 Anthropic 方言 key | key 厂商的模型表：preset 目录（含 models.dev 合并）或行自己的 `models` | preset 默认或行 `defaultModel` |
| `codex` | 登录、Codex 池、preset `openai` 的 key | runner 上报的 Codex 目录 | runtime 默认 → 目录第一行 |
| `codex` | 其它 Responses key | 行自己的 `models` | 行 `defaultModel` |
| `kimi` | 登录 | runner 上报的 Kimi 目录 | runtime 默认 |
| `kimi` | Moonshot key | moonshot preset 目录 | preset 默认 |
| `antigravity` | 登录、preset `gemini` 的 key | runner 上报的 agy 目录（按基础模型折叠） | 目录第一行 |
| `opencode` | OpenCode 自身配置 | runner 上报的 OpenCode 目录（`provider/model`） | 空，由 OpenCode 自选 |
| `opencode` | 任一可用 key | 该 key 在其原生 engine 上的模型表 | 那张表的默认 |
| `dsh` | DeepSeek key | runner 上报的 DSH ACP 目录（不透明值），没有静态回退 | `runtimeDefaultModels.dsh` → 目录第一行；目录到达前为空 |

- 存储一律是裸模型 id。OpenCode 用 key 时，派发才拼成 `orbit-<slug>/<model>`（§4.2）。
- 退役判断（`retiredPin`）、`modelForProvider`、`runnerCatalogRow` 的 runtime 参数都传 engine。DeepSeek key 上的 `claude` 会话用 key 厂商的表；同一把 key 上的 `dsh` 会话用 ACP 目录。

### 2.3 effort、权限模式、fast、slash、审批记忆

以下判断的参数一律传会话 engine，不传 provider slug：

- 服务端：`normalizeEffortForProvider`、`normalizeBuiltinPermissionMode`（`src/apiserver/src/common/runtime-provider.ts`）、standing grant 的 `standingGrantCovers`。
- `@orbit/shared`：`derivePermissionSemantics`、`runtimeApprovalSupport`、`autoAvailable`（`permissionSemantics.ts`），`fastModeAvailable`（`models.ts`），`supportsMidTurnSteer`（`providerTransport.ts`），`DSH_PERMISSION_MODES`（`enums.ts`）。
- Web、Swift、Android 的同类函数也一样。

只有两处要看凭据：

- `claude` engine 上，key 行声明的 `reasoningLevels`（`declaredReasoningLevels`）把 effort 映射到该模型接受的级别。
- `autoAvailable` 的 `customProvider` 参数为「凭据是 key」。

## 3. 统一解析

所有入口调用同一个服务端函数（建议 `src/apiserver/src/providers/engine-provider.ts` 的 `resolveEngineProvider`）：

- 入口：会话 create、resume、config、retry-message，任务 create、createMany、update、batch-pin，wiki 维护设置，提及投递的种子复核。
- 输入：`{ ownerId, engine?, provider?, model?, workspaceId?, session? }`。
- 输出：`{ engine, provider, providerBuiltin, model, credential }`，`credential` 带解析到的行、池或别名。
- 错误：只用 §3.7 列出的码和文案。

### 3.1 slug 的类别

给了 provider 时，按下面的顺序判定它是什么：

1. `claude`、`codex`、`kimi`、`antigravity`：runner 登录。`opencode`：OpenCode 自身配置。都是 `providerBuiltin = true`。
   - 与现在一致：明确传入的 `kimi` 不查同名配置行。
2. 用户可用（`usableProviderScope`）的同 slug key 行：
   - 停用的行不能被选用，沿用该入口现在的文案：会话新建为 `provider not available: "<slug>"`，任务 pin 与切换目标为 `provider not available`。
   - 续聊或改配置时留在已停用的当前 provider 上，返回 `provider is disabled`。从它切到别的 provider 是允许的：key 停用或删除后，会话就靠这条路恢复（§3.6）。
   - 共享行而用户不是管理员时，返回 `adminOnlyProviderRefusal`。
3. 同 slug 的账号池（`accountPoolRuntime` 的范围），并检查 `assertUsablePool`。
4. 别名表中目标 key 可用的同 slug 别名：解析到目标 key，并带出别名的 engine。
5. `dsh`：前面都没有命中时，是遗留的内置 `dsh`（§3.3）。同名配置行、池、别名优先，与现在的 `SessionsService.create` 一致。
6. 都没有：`provider not available: "<slug>"`，或 admin-only 拒绝。

### 3.2 四种组合

| 给了什么 | 结果 |
| --- | --- |
| engine + provider | 校验 `isEngineCompatible`，不兼容返回 `PROVIDER_ENGINE_INCOMPATIBLE`，并列出该 provider 可用的 engines。别名只提供 key；显式 engine 优先于别名的 engine |
| 只有 provider | 用默认 engine：登录取同名 engine；key 取方言原生 engine；遗留 `runtime='dsh'` 行取 `dsh`；池取池的 engine；别名取别名的 engine（`dsh`）；遗留内置 `dsh` 取 `dsh`。默认 engine 为空（方言未知、订阅 token 配非 Anthropic 方言）时返回 `PROVIDER_ENGINE_INCOMPATIBLE`，用不点名 engine 的文案（§3.7） |
| 只有 engine | 登录类 engine 用 runner 登录（provider = engine 名）；`opencode` 用自身配置；`dsh` 用默认 DeepSeek key（§3.3），没有则返回 `DEEPSEEK_KEY_REQUIRED` |
| 都没有 | 工作区种子（§3.4） |

- engine 不在六个值内时，由解析函数返回 `ENGINE_UNKNOWN`；DTO 只校验它是字符串（§6.2）。
- 「只有 provider」保证所有旧调用（API、CLI、MCP、旧版 App）得到解耦前的 engine。别名使旧 DSH slug 继续得到 `dsh`。

### 3.3 旧编码、内置 dsh 与别名

- **OpenCode 旧编码**：`provider='opencode'` 且 `openCodeKeyOf(model)` 不为空，按 engine `opencode`、provider `<slug>`、model `<model>` 解析。
  - 其中 `<slug>` 再按 §3.1 解析，允许是别名。
  - 写入时规范化成新形态。读取（领取、回执、偏好）继续兼容旧编码。
  - 规范化后，key 不可用于 OpenCode（订阅 token）时返回 `PROVIDER_ENGINE_INCOMPATIBLE`。key 不存在或已停用时，保留旧文案 `provider not available on OpenCode: "<slug>"`。
- **默认 DeepSeek key**：该用户可用（`usableProviderScope`）、`enabled`，且 `isEngineCompatible('dsh', …)` 为真（DeepSeek key、Anthropic 方言、不是订阅 token）的 key 中排第一的一把。
  - 顺序：`position` 升序（空值在后）、`createdAt`，再按 `id` 打破平局。`/providers` 今天只按前两项排，T3 让它也加上 `id`，两处一致。
  - 遗留 `runtime='dsh'` 行也算，因为它的 preset 是 `deepseek-harness`。
- **内置 `dsh`**（`provider='dsh'`，§3.1 第 5 步）：
  - 新写入一律换成 (engine `dsh`, provider = 默认 DeepSeek key 的 slug, `providerBuiltin = false`)；没有这样的 key 时返回 `DEEPSEEK_KEY_REQUIRED`。
  - 已存在的此类会话由 T4 改写为 (默认 DeepSeek key, `dsh`)（§7.3）。没有 key 而保留下来的，领取时按 §4.1 处理。
- **别名**：解析出目标 key 和别名的 engine，存储时写 key 自己的 slug。

### 3.4 工作区种子

- `workspaces/workspace-provider.ts` 的种子由 `{provider, providerBuiltin}` 改为 `{engine, provider, providerBuiltin}`。
  - `lastProviderByWorkspace` 的 LATERAL 查询同时取 `s.engine`；engine 为 NULL 时按旧规则推导。
  - managed runner 的 `initial_provider` 同时作为 engine 和 provider。
  - 默认值为 `{claude, claude, true}`。
- `withProviderSeed` 给工作区 payload 增加 `lastEngine`，保留 `lastProvider`、`provider`、`providerBuiltin`。
- 种子在新建时复核：
  - 凭据不存在或已停用：沿用现在的拒绝（`provider not available: "<slug>"`）。
  - 凭据还在，但已不兼容种子的 engine（例如 key 的方言在没有未结束会话时被改过）：改用该 provider 的默认 engine，与「只有 provider」相同。
- 种子不带模型，与现在相同。

### 3.5 各入口

#### 会话 create（`POST /sessions`；agent 派生的子会话走同一个 `create`）

- 按 §3.2 解析，写入 `engine`、`provider`、`providerBuiltin`、`model`。
- 预生成会话 id、effort 规范化、权限模式校验、root 拒绝、DSH 能力与安装检查、登录预检（`ENGINE_SIGNED_OUT`），全部以解析出的 engine 为准。
- 只有 engine 是 `claude`、`codex`、`kimi`、`antigravity` 且凭据是登录时，才用 `bringsOwnCredentials = false` 做登录预检。key 和池都自带凭据。

#### 会话 resume、PATCH config、retry-message

- engine 固定为 `session.engine`，`resolveProviderSwitch` 改为以下规则：
  - 请求带 `engine` 且不等于会话 engine：返回 `ENGINE_IMMUTABLE`。
  - 只带 provider（包括旧客户端）就是切换凭据：按 §3.1 解析目标后，校验与会话 engine 兼容；不兼容返回 `PROVIDER_ENGINE_INCOMPATIBLE`。现在的 `a ${from} session cannot switch to a provider that runs on ${to}` 随之退役。
  - 别名目标只取它的 key，不取别名的 engine。旧编码同 §3.3。
  - 账号部分（`accountOnProviderSwitch`）只在目标是 runner 登录时适用，文案不变。
- 会话 engine 为 NULL 而能推导时，切换在同一事务里先把推导结果写入 `engine`（§1.1），再写新的 provider，然后照上面校验。
- engine 为 NULL 且推导为未知的会话（凭据已不存在）：
  - 没有 `runtimeSessionId`（从未运行）：当作新会话，engine 取切换目标的默认 engine，与这次写入一起记录。
  - 有 `runtimeSessionId`：返回 `SESSION_ENGINE_UNKNOWN`（409），不猜 engine。
- resume 的 effort 规范化改用会话 engine（今天用 `normalizeRuntimeProvider(slug)`，把 key 上的 codex/kimi/agy 会话当成 Claude）。
- 任务占用冲突（`TASK_RUN_PIN_CONFLICT`、`TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED`）改为比较 (engine, provider) 对，不再只比 slug。文案模板不变，占位处写 `<slug>`；两边 slug 相同而 engine 不同时写 `<slug> on <CLI 名称>`。

#### 任务 create、createMany、update、batch-pin

- 请求增加 `engine`。update 和 batch-pin 用三态：省略为不改，`null` 为清除，值为设置。
- 写入规则：
  - engine + provider：校验兼容后两者都写。
  - 只有 provider：写入 provider 和它的默认 engine。旧客户端改 provider pin，得到的 engine 与解耦前相同。
  - 只有 engine：写 engine，provider 保持（update）或为空（create）。provider 保持非空时要校验兼容。
  - `provider: null` 只清 provider pin。`engine: null` 只清 engine pin，provider pin 留着时按「空 + 有」处理。
- batch-pin（`TasksService.pinMany`）今天不校验 provider。它分块 UPDATE，一次可能多达十万行，所以不逐行调解析函数：
  - engine + provider，或只给 provider：结果与各任务现有的 pin 无关，写入前校验一次。
  - 只给 engine（provider 保持）：先扫一遍选中任务现有的 provider 并去重，逐个校验兼容。有一个不兼容就整批拒绝，body 带出不兼容的 provider 和对应的任务数。
  - 每个分块的 UPDATE 再带上「provider 属于已校验集合」的条件，挡住扫描之后被并发改掉的行。
- 文案 `provider not available` 保持不带 slug（`assertUsableProvider` 现状）。
- model 的处理不变：写入时只做旧编码规范化，派发时按 (engine, 凭据) 的模型空间校正（§2.2）。

#### wiki 维护设置

- `settings.maintenance.provider` 仍是一把 key 的 slug，运行的 engine 固定为 `claude`。
- `wikiMaintenanceProviderProblem` 改为判定 `isEngineCompatible('claude', key)`，文案不变。
- 维护任务创建时写 `Task.engine = 'claude'`。
- 领取时的检查从 `session.provider === settings.provider` 改为同时要求 `session.engine === 'claude'`。

#### 偏好

- 服务端不按 `defaultModels` 选模型，但 PATCH 的每个键都经解析函数规范化（§6.5）：
  - 新格式键 `<engine>:<provider>`：校验 engine 与 provider 兼容。
  - 旧客户端写来的旧格式键（裸 slug、`opencode/<slug>`、旧 DSH slug）：照原样存，同时写一份对应的新键。旧客户端仍读得回自己的键。
  - 解析不了的旧键照原样存，不拒绝旧客户端。

#### 提及投递（`tasks.service.ts` 复核种子）

- 种子改为 (engine, provider) 对，拒绝文案不变。

### 3.6 key 的新建、编辑、停用与删除

- **旧客户端新建 DSH 配置**（`runtime: 'dsh'` 或 preset `deepseek-harness`）：存为 DeepSeek key。
  - 写入 `preset_slug = 'deepseek'`、`runtime = 'claude'`，模型跟随 preset，忽略请求里的模型（DSH 配置本来就不带）。
  - 标签为 `DeepSeek Harness` 时按 §7.2 的规则改名（例如已有 `DeepSeek` 时叫 `DeepSeek 2`）；slug 从 `deepseek` 取。
  - 不与已有的同一把 key 合并，用户可以有多把相同的 key，与普通新建一致。
  - 响应就是这一行：旧客户端把它显示成 Claude 方言的 key。在它上面只传 provider 新建，得到的是 `claude`（§8）。
- **改方言**（PATCH `runtime`）：若有未结束会话（`completed_at IS NULL AND deleted_at IS NULL`）或任务 pin 以新方言不支持的 engine 使用这把 key，返回 `PROVIDER_DIALECT_IN_USE`（409）。
  - 计数时 engine 为 NULL 的会话按推导出的 engine 算。允许修改时，先在同一事务里给引用这把 key、engine 为 NULL 的会话补上 engine（§1.1），再改 key。改 baseUrl、换 key 同样如此。
  - 都兼容时允许。例如两种方言都支持 `opencode` 的会话。
  - 现有的 `provider runtime cannot change into or out of dsh; create a separate provider` 退役：改成 `dsh` 被 `PROVIDER_RUNTIME_DSH_RETIRED` 拒绝；从遗留 `dsh` 改走，按本条判定。
  - 已结束的会话不阻止改方言。之后若被恢复，会在写入或领取时按兼容表拒绝或暂留，不会换 engine。
- **改 baseUrl 或 key**：会话 engine 不变。DSH 会话按 P3b 的 reload 规则重新 Prepare 后 resume，与现在相同。
  - 改 baseUrl 可能让一把自定义 key 不再是 DeepSeek key。此时它的 `dsh` 会话和 pin 按上一条同样拒绝（409 `PROVIDER_DIALECT_IN_USE`，文案中的「protocol」换成「endpoint」）。
  - 换成 Claude 订阅 token 时同样检查：`opencode`、`dsh` 不接受订阅 token（文案中的「protocol」换成「key」）。
- **停用**：会话 engine 不变。新建返回 `provider not available: "<slug>"`。已有会话的新消息照常排队，停在 PENDING，错误为 `Provider is unavailable; check its configuration`，重新启用后在原 engine、原 `runtimeSessionId` 上继续。
  - 停用一把 key 会同时停掉它在所有 engine 上的会话，不是某个 engine 的开关。
- **删除**：允许，与其它 key 相同。会话 engine 不变，状态与停用相同，可以切到同 engine 兼容的其它 provider。
  - DSH 会话换一把 DeepSeek key 后，在原 ACP 会话上续聊。
  - 指向它的别名级联删除。
  - 现在 DSH 行「有历史就不能删」的规则（`DeepSeek Harness provider has session or task history and cannot be removed`）退役：它保护的会话身份已经由 `Session.engine` 记录。

### 3.7 错误码与文案

新增。body 形如 `{ code, message, ... }`，与现有 `PROVIDER_POOL_MEMBER_REFUSED` 相同：

| code | HTTP | 何时 | message | body 附加字段 |
| --- | --- | --- | --- | --- |
| `ENGINE_UNKNOWN` | 400 | engine 不是六个值之一 | `engine "<value>" is not one of claude, codex, kimi, antigravity, opencode, dsh` | — |
| `PROVIDER_ENGINE_INCOMPATIBLE` | 400 | engine 与 provider 不兼容（新建、切换、任务 pin、batch-pin、wiki 设置）；或只给 provider 而它没有默认 engine | 点名 engine 时：`provider "<slug>" cannot run on <CLI 名称>; it runs on <CLI 名称, …>`，可用列表为空时以 `no engine can run it` 结尾。只给 provider 时：`provider "<slug>" cannot run on any engine` | `engine`（只给 provider 时为 `null`）、`provider`、`engines` |
| `ENGINE_IMMUTABLE` | 400 | resume、config、retry 带了不同的 engine | `this session runs on <CLI 名称>, and a session's engine never changes; start a new session to use <CLI 名称>` | `engine` |
| `DEEPSEEK_KEY_REQUIRED` | 400 | 只给 `dsh`、内置 `dsh`，而用户没有启用的 DeepSeek key | `DeepSeek Harness runs on a DeepSeek API key; connect one in Providers first` | — |
| `SESSION_ENGINE_UNKNOWN` | 409 | engine 为空、推导未知，且已有 `runtimeSessionId` 的会话被续聊或切换 | `this session's engine was never recorded and its provider is gone, so Orbit cannot tell which engine its conversation belongs to; start a new session` | — |
| `PROVIDER_DIALECT_IN_USE` | 409 | 改方言（或 endpoint）会让在用的 engine 不再兼容 | `provider "<label>" is in use on <CLI 名称, …> by <n> open sessions and <m> task pins; its protocol can't change while they use it` | `engines`、`sessions`、`tasks`（计数） |
| `PROVIDER_RUNTIME_DSH_RETIRED` | 400 | PATCH 把 key 的 `runtime` 改成 `dsh`（新建时不报，见 §3.6） | `DeepSeek Harness is an engine now, not a kind of provider: keep the key as DeepSeek, then pick DeepSeek Harness as the engine` | — |

保持逐字不变，客户端和测试按原文匹配：

- `provider not available: "<slug>"`、`provider not available`
- `provider is disabled`
- `provider runtime not available: "<runtime>"`
- `provider not available on OpenCode: "<slug>"`（只用于旧编码里 key 不存在或停用）
- admin-only 拒绝、账号池拒绝
- 全部 `DSH_*` 诊断码与升级、安装、权限模式文案
- `ENGINE_SIGNED_OUT`、`MODEL_UNAVAILABLE`
- 暂留文案 `PROVIDER_UNAVAILABLE_ERROR`、`ADMIN_ONLY_PROVIDER_ERROR`

退役：

- `a <from> session cannot switch to a provider that runs on <to>`
- `DeepSeek Harness provider is disabled`
- `provider runtime cannot change into or out of dsh; create a separate provider`
- `DeepSeek Harness provider has session or task history and cannot be removed`
- `DeepSeek Harness models and default come from the runtime ACP catalogue`（新建的 DSH 配置存为 DeepSeek key，PATCH 改成 `dsh` 报 `PROVIDER_RUNTIME_DSH_RETIRED`）
- `DeepSeek Harness requires runtime prompt validation`：连通性测试对 DeepSeek key 走 Anthropic Messages 探测，与其它 Anthropic 方言 key 相同。

## 4. 运行路径

### 4.1 领取与派发

- `buildSession`（`queue.service.ts`）与 reclaim（`runner-api.controller.ts`）从 (session.engine, provider) 解析凭据，不再用 `execRuntime` 从 slug 推 engine：
  - 登录：账号目录变量（`ACCOUNT_DIR_VAR`），与现在相同。
  - 池：选成员，与现在相同。
  - key：按 engine 注入（§4.2）。
  - 别名：解析到 key。
  - 遗留内置 `dsh`：有默认 DeepSeek key 时注入它；没有时照今天的方式派发（不注入 key，工作区 env 里手写的 `ORBIT_DSH_API_KEY` 仍然生效，没有就在 runner 上以 `DSH_CREDENTIAL_MISSING` 失败）。已经能跑的旧会话不会因为解耦而停。
- 领取时再校验一次兼容。旧副本或并发写入可能留下不兼容的组合，这类组合不派发：`pausedPendingSessions` 把 PENDING 行写上 `PROVIDER_ENGINE_INCOMPATIBLE` 的 message 并跳过，领取成功时清除，与现有暂留机制相同。领取时不会遇到「dsh 没有 key」：只给 engine 的 dsh 在写入时已解析到一把 key，遗留内置 `dsh` 按上一条派发。
- engine 为 NULL 的行按旧规则推导，领取成功后在同一事务里另用一条 UPDATE 写回（§1.1）。
- 交给 runner 的负载形状不变：
  - `provider` 与 `agent.provider` 携带 engine（runner 的 `session.go` 已按 engine 读取）。
  - `agent.model` 是模型 id。OpenCode 用 key 时为 `orbit-<slug>/<model>`。
  - runner 不需要新字段。

### 4.2 注入按 engine

`injectedEnv(row, model)` 改为 `injectedEnv(engine, row, model)`：

| engine | 凭据 | 注入 |
| --- | --- | --- |
| `claude` | Anthropic 方言 key（含 DeepSeek key、遗留 dsh 行） | 现有的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 等（`custom-provider.ts` 的 claudeEnv） |
| `dsh` | DeepSeek key | `ORBIT_DSH_API_KEY`、`ORBIT_DSH_BASE_URL`（key 的 baseUrl） |
| `opencode` | 任一可用 key | `OPENCODE_CONFIG_CONTENT`：只写这一把 key，按其方言的 AI SDK 包（`openCodeKeyConfig`） |
| `codex` | Responses key | `OPENAI_BASE_URL`、`OPENAI_API_KEY` |
| `kimi` | Moonshot key | `KIMI_MODEL_*` |
| `antigravity` | Gemini key | `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL` |

同一把 DeepSeek key 在三种 engine 上的 endpoint 都是它自己的 `baseUrl`。

### 4.3 其它读 engine 的地方

以下各处从读 slug 改为读 `session.engine`：

- 切换、移动（`sessionMoveVerdict`、`moveTargetRefusal`）、steer（`runtimeTakesSteer`、`runtimeTakesLegacySteer`、runner inbox steer）
- DSH 续租检查（`assertDshLeaseSupport`）、activate-leases 预检
- reaper（`reaper.service.ts:290` 今天用 `normalizeRuntimeProvider`，跳过 key 和池上的非 Claude 会话）
- standing grant、`session-state.ts` 的权限语义
- `/runner/sessions/:id/meta`（§6.3）
- 用量上限识别（`runner-api.controller.ts:4835`）

`isAccountEngine(session.provider)` 一类判断只在凭据是登录时成立，此时 slug 就是 engine 名，可以保留。

### 4.4 模型路由

- `routeTaskRun` 的基线是 (engine, provider)：pin 或种子。
- 跨 engine 时，若基线凭据与路由出的 engine 兼容，保留原凭据；否则用该 engine 的 runner 登录。今天 `chooseEngine` 把 engine 名写进 `provider`，带 key 的工作区被路由后会改用 runner 登录。
- `routeEngine` 对找不到的 slug 不再把 slug 本身当 runtime：凭据未知时不路由。
- 路由决定写入 `task_route_decision` 时 `provider` 记凭据，`baseline` 增加 `engine`。列不变。

### 4.5 额度闸门

- 任务扫描的 `quotaGate`、`AutoRetryService` 的扫描、回合失败时的 `quotaRetryAt`，只在凭据是 runner 登录时读 runner 的 plan usage，由会话 engine 加账号决定。
- 账号池走池自己的规则（`accountPoolResumesAt`）。
- key 永远不被 runner 的额度拦，也不再记为 blind。今天 key 的 slug 永远对不上 plan usage，于是每次都被当作 blind 退避。

### 4.6 agent 跑的命令能不能读到 key

Orbit 把 key 写进 engine 进程的环境（§4.2）。agent 跑的命令是 engine 的 shell 工具起的子进程，能不能在自己的环境里直接读到 key，取决于这个 engine 传不传这些变量。

**测法**：2026-10-09 在 HPC 上用真 CLI 测。key 是带标记的假值，按 Orbit 的方式注入（同样的变量、参数和隔离目录），模型端点是本机的 mock。mock 让 agent 的 shell 工具跑一条只查它自己环境的命令：数 `env` 里有几处标记，列出带标记的变量名。

| engine（版本） | key 所在的变量 | agent 命令的环境里有没有 | 依据 |
| --- | --- | --- | --- |
| Claude Code（2.1.295） | `ANTHROPIC_AUTH_TOKEN` | 有 | 实测（`Bash` 工具）。源码与文档：只有设了 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 才会从子进程去掉凭据，Orbit 不设 |
| OpenCode（1.18.35） | `OPENCODE_CONFIG_CONTENT`：整份配置，含 `apiKey` | 有 | 实测（`bash` 工具）。源码：shell 工具的环境是 `process.env` 原样，不过滤 |
| DeepSeek Harness（0.2.0-rc.2） | `ORBIT_DSH_API_KEY` | 没有 | 实测：复跑 `TestDshRealSessionLogUpload`，bash 跑 `env \| sort`，两个变体都是 `bashSawKey=false`。源码：`dsh-subprocess` 的 `scrubbedParentEnv` 去掉名字含 KEY、PASSWORD、SECRET、TOKEN 的变量和全部 `DSH_*` |
| Codex（0.162.0） | `OPENAI_API_KEY` | 有 | 实测：`codex exec`，以及照 runner 参数起的 `codex app-server`，后者测了 Auto（`on-request`，workspace-write 沙箱）和 `never`（Bypass、Don't Ask）两组设置，都看得到。Default、Accept Edits、Plan 用 `untrusted`，命令获批后跑在同样的环境里，未单独测。对照组加 `shell_environment_policy.ignore_default_excludes=false` 后看不到。源码：0.162 的 `ignore_default_excludes` 默认为 true，不过滤 KEY、SECRET、TOKEN |
| Kimi Code（2.1.1） | `KIMI_MODEL_API_KEY` | 有 | 实测：print 模式的 `Bash` 工具。Orbit 用 ACP 驱动，initialize 不声明 terminal 能力，命令同样由 Kimi 自己的 `Bash` 工具在 kimi 进程下运行，按源码推断相同 |
| Antigravity CLI（1.3.2） | `GEMINI_API_KEY` | 有 | 实测（`run_command`），与 1.2.16 的记录一致（`docs/antigravity-runtime-contract.md` §3.2） |

- **「没有」只指命令自己的环境，不是安全边界。** engine 进程自己的环境里有 key；runner、engine 和 agent 的命令是同一个系统用户，同用户的进程一般能读 `/proc/<pid>/environ`。这是 Linux 的规则（proc(5)），未实测。DSH 环境文档已有同样的说明。
- 按 Claude Code 与 agy 的文档，MCP 服务器和 hook 也继承同样的环境，未逐一实测。
- 账号池的会话 token 也经 `OPENAI_API_KEY` 交给 Codex，按源码同样可见。
- 让命令看不到 key 的开关（Claude Code 的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`、Codex 的 `ignore_default_excludes=false`）各有副作用，不在本项目范围：前者要求 runner 装 bubblewrap，并把权限模式强制为 Default；后者会去掉所有名字含 KEY、SECRET、TOKEN 的变量。
- 给 T6：DeepSeek 连接表单的「Who gets this key」可以写：

  > Sessions on Claude Code and OpenCode hand this key to the CLI in its environment, where commands the agent runs can read it. DeepSeek Harness keeps it out of the commands it runs, but any program running as the runner's user can still read it from the Harness process.

## 5. 混合版本规则

整个项目经项目分支一次落 main。部署窗口里可能有旧 API 副本同时在跑（多副本部署），它们不认识 `Session.engine`、`Task.engine`、别名表和回执 v3。

### 5.1 事务内设置

- 新副本在每个领取或续租事务里执行 `SELECT set_config('orbit.claim_reads_session_engine', '1', true)`：
  - `QueueService.trySessionClaim`：与现有的三个 `orbit.runner_supports_*` 写在同一条语句里。
  - `RunnerApiController` 的 takeover-leases 与 activate-leases：对所有会话设置，不只是 dsh。
  - 其它把会话从 PENDING 改为 RUNNING，或改写 `inbox_lease_owner`、`inbox_lease_generation` 的写入：T2 按 `common/session-scheduling.ts` 的不变量和 db-write inventory 盘点，逐一加上。
- 旧副本不设置这一项，`current_setting(..., true)` 为 NULL，按未声明处理（fail closed）。

### 5.2 新守卫：旧副本不得领取或续租已记录 engine 的会话

新增 `guard_session_engine_acquisition()`，`BEFORE UPDATE OF "status", "inbox_lease_owner", "inbox_lease_generation" ON "session"`：

- 何时算「领取」：沿用 0377 `guard_dsh_runner_acquisition` 的判定，即 PENDING→RUNNING，或获得新的 lease owner、generation。服务端终态 revive（owner 第 15 位为 `5`）除外。
- 拒绝条件：`NEW.engine IS NOT NULL AND COALESCE(current_setting('orbit.claim_reads_session_engine', true), '0') <> '1'`。
- 拒绝方式按写入分两种：
  - PENDING→RUNNING（领取）：`RETURN NULL`，静默跳过，与 0080、0377 相同。旧副本的领取语句 `RETURNING` 不到行，就当作没有可领的会话。
  - 获得 lease owner 或 generation（takeover-leases、activate-leases 等续租写入）：`RAISE EXCEPTION`，例如 `USING ERRCODE = 'object_not_in_prerequisite_state'`，文案说明这个 API 版本不读会话 engine。报错让整个事务回滚，runner 收到 5xx 后重试，直到落到新副本。
- 续租不能静默跳过。旧代码只在 dsh 会话上检查续租写入是否生效（`runner-api.controller.ts` 的 `if (onDsh && acquired !== 1) throw`）。若静默跳过，它会照常提交同一事务里的其余写入：让当前 generation 退役、让 IN_FLIGHT 回合的租约过期、收走审批，而会话行仍是旧的 owner 和 generation。runner 下一次调用拿到 409，认为失去所有权就脱手，会话卡住。
- 新代码在所有 engine 上都检查续租写入是否生效（`acquired !== 1` 即报错），不只 dsh。

### 5.3 新形态会话

- 一律以「已记录 engine」为准，不去判断旧规则会不会恰好算对。在触发器里判断，要复刻整套旧规则。
- T2 回填后几乎所有会话都有 engine，所以旧副本此后基本不再领取；续租打到旧副本时报错，runner 重试（§5.2）。runner 连到新副本后照常。这就是 0377 的做法：未声明就当作不支持。
- 旧副本仍能领取它自己新建、engine 为 NULL 的会话。它按旧规则执行，与这个会话的记录一致；新副本领取时再把推导结果写回（§1.1）。

### 5.4 engine 为空时的推导

服务端读到 NULL 行时用 TS `legacySessionEngine`。SQL 侧不另写函数：触发器和领取 SQL 对 NULL 行沿用它们现有的谓词，那些谓词就是旧规则。

1. `provider` 为 `claude`、`codex`、`opencode`、`antigravity` → 该值。provider 为空 → `claude`（列默认值）。
2. `provider` 为 `kimi`、`dsh`，且 `provider_builtin` 为真 → 该值。
3. 同 slug 的 `model_provider` 行，属于该 owner 或为共享行，不论是否停用：
   - runtime 是 `claude`、`codex`、`kimi`、`antigravity`、`dsh` 之一时 → runtime。
   - 其它 runtime → 未知。
4. 同 slug 的池：自有池取 `engine`，共享 Codex 池取 `codex`。
5. 同 slug 的别名 → 别名的 engine。这一步由建别名表的 T3 加入。
6. 其余 → 未知。

与解耦前的 `execRuntime` 相比只有一处不同：停用、删除、越权的 key 不再兜底成 `claude`。停用和越权的行仍取行的 runtime，删除的为未知。

### 5.5 三个领取触发器的新判定

| 触发器 | 适用的会话（新） | 其余条件 |
| --- | --- | --- |
| `guard_opencode_runner_claim`（0080） | `NEW.engine = 'opencode' OR (NEW.engine IS NULL AND NEW.provider = 'opencode')` | 不变：需要 `orbit.runner_supports_opencode = '1'` |
| `guard_antigravity_runner_claim`（0377 版） | `NEW.engine = 'antigravity' OR (NEW.engine IS NULL AND <0377 现有条件>)` | 不变：需要 `orbit.runner_supports_antigravity = '1'` |
| `guard_dsh_runner_acquisition`（0377） | `NEW.engine = 'dsh' OR (NEW.engine IS NULL AND <0377 现有适用条件>)` | 需要 `orbit.runner_supports_dsh = '1'` 和持久化的 `provider:dsh` 能力（不变）。凭据检查：engine 为 NULL 的行沿用 0377；engine 为 `dsh` 的行要求 `(provider = 'dsh' AND provider_builtin)`，或者 provider 指向一行已启用、属于该 owner 或共享的 `model_provider`（T3 再加上经别名指向）。是否为 DeepSeek key 由应用层判定（§4.1） |

三个触发器都用 `CREATE OR REPLACE FUNCTION` 改写，触发器本身与 `UPDATE OF` 列不变。

### 5.6 领取 SQL 与辅助函数

- `trySessionClaim` 的 runner 能力门禁：engine 非空的行按 `s.engine` 判定。NULL 行沿用现有的两组谓词：
  - dsh 的那组：`s.provider = 'dsh' AND s.provider_builtin`，或 runtime 为 `dsh` 的配置行，再要求持久化的 `provider:dsh` 能力。
  - opencode、antigravity 的那组：直接比较 slug 和 `mp.runtime`。
- 凭据可用性判定：
  - 登录：`provider` 为 engine 名且 `provider_builtin`。
  - OpenCode 自身配置：`provider = 'opencode'`。
  - key：已启用、可用（`usableProviderSql`），而且方言属于该 engine 可能兼容的集合：`claude` 对应 `claude`/`dsh`；`dsh` 对应 `claude`/`dsh`；`opencode` 对应全部四种方言和 `dsh`；其余 engine 对应同名方言。
  - 池：池的 engine 等于会话 engine。
  - 别名：按目标 key 判定。
  - 遗留内置 `dsh`：可领取，凭据由 `buildSession` 补（§4.1）。
  - 精确的兼容（DeepSeek、订阅 token）由应用层在 §4.1 判定并暂留。
- `providerSlugsOn` 与 `providerDispatchWhereOn` 改为「engine 为 X 的会话」：`{ OR: [{ engine: X }, { engine: null, ...<现有条件> }] }`。claim 与 reclaim 用它标记或省略暂留行，逻辑不变。

### 5.7 旧副本新建的会话（T1 补充，待协调会话确认）

旧副本建会话不写 engine，列为 NULL，按 §5.4 推导。它执行的就是推导出的 engine，会话自身一致。

会违背用户意图的，是旧副本替带 engine pin 的任务建了运行。分两处处理：

- 旧副本自己建的运行：加 `BEFORE INSERT ON "session"` 触发器 `session_engine_from_task_pin`，满足以下全部条件时 `NEW.engine := task.engine`：
  - `NEW.engine IS NULL`、`NEW.task_id IS NOT NULL`；
  - `NEW.starts_task_work` 为真：只管任务运行，不管从任务页打开的对话；
  - 任务的 `engine` 非空，且任务的 `provider` 等于 `NEW.provider`：旧副本照 pin 选了凭据，而 pin 写入时已校验兼容。

  这样旧副本领不到这个会话（§5.2），新副本按 pin 的 engine 执行。
- 旧副本绑定的 v1/v2 回执由新副本执行：按 §6.4 的读法用任务的 engine pin。

混合窗口内接受以下限制，两种情况下会话的记录与执行都一致，只是没照用户的选择走：

- 只 pin 了 engine 的任务（provider 为空）由旧副本派发时，它用工作区种子的凭据，触发器不补 engine，这次运行按旧规则得到种子凭据的 engine。
- 旧副本按新形态工作区种子新建的普通会话，仍按旧规则得到 key 的原生 engine。

### 5.8 回执 v3 作为栅栏

旧副本读到 v3 回执时返回 `TASK_RUN_REQUEST_UNREADABLE`（409，可重试），不会按旧规则执行（§6.4）。

### 5.9 落地顺序

1. 部署携带 T2–T5 的服务端。T2 的迁移加列、加触发器、回填；T3 的迁移建别名表。
2. T4 的应用层迁移随服务端启动自动执行一次（§7.6）。§5.2 的守卫保证此时仍在跑的旧副本不会执行改写后的会话。
3. 客户端发版按届时授权，建议服务端上线后尽快发。

这一版只能前滚：

- 回填之后，更早的 apiserver 镜像不设置 `orbit.claim_reads_session_engine`。回退镜像会让所有已有会话都领不到、续不了租。
- 确需回退时，先执行降级 SQL，删除 `guard_session_engine_acquisition` 的触发器。T2 把这段 SQL 写在迁移目录的说明里。
- T4 改写的数据也不自动回退（§7.6）。

## 6. API 字段

### 6.1 会话

- 所有返回会话的接口增加 `engine`：列表、详情、realtime 会话事件、runner 侧会话读取。为 NULL 时给推导值，推导未知时为 `null`。
- 保留 `provider`（凭据 slug）、`model`，以及现有的其它字段。
- 请求：
  - `POST /sessions` 增加可选 `engine`。
  - `POST /sessions/:id/resume`、`PATCH /sessions/:id/config`、`POST /sessions/:id/retry-message` 可带 `engine`，但必须等于会话 engine（§3.5）。
  - runner 门的会话创建与 MCP `session_create` 同样增加 `engine`。
- 工作区 payload 增加 `lastEngine`（§3.4）。

### 6.2 任务

- 任务的读出增加 `engine: string | null`（pin），保留 `provider`、`model`。
- `POST /tasks`、`PATCH /tasks/:id`、批量创建、runner 门 `POST /runner/tasks/batch-pin` 增加 `engine`，三态语义见 §3.5。
- DTO 只用 `@IsOptional() @IsString()`。全局 ValidationPipe 没有 exceptionFactory，`@IsIn` 只会给通用的 400，所以取值由解析函数检查，不在六个值内时给 `ENGINE_UNKNOWN`。

### 6.3 /providers、/runner/providers 与 meta

| 接口 | 新增 | 保留 |
| --- | --- | --- |
| `GET /providers`（`listPublic`） | 每行 `engines: string[]`，默认 engine 在前，由服务端按订阅 token 计算 | `slug`、`label`、`runtime`（方言）、`models`、`defaultModel`、`presetSlug`、`followsPreset`、`modelsFromRuntime`、`planUsage`、`runsOnOpenCode`（等于 `engines.includes('opencode')`） |
| `GET /providers/mine`、`GET /admin/providers` | 每行 `engines` | 现有全部字段 |
| `GET /runner/providers`（`listUsable`，`orbit provider list` 读它） | 每项 `engines`：内置项为 `[slug]`，内置 `dsh` 项为 `['dsh']`（含义是默认 DeepSeek key 上的 `dsh`），key 按兼容表，池为 `[池 engine]` | `slug`、`runtime`、`builtin`、`label`、`models`、`defaultModel` |
| `GET /runner/sessions/:id/meta` | `engine`：会话 engine | `provider` 改为也给 engine（旧 runner 拿它决定用哪个 CLI 续聊，今天把 key 和池上的非 Claude 会话报成 `claude`）；`sessionUuid`、`runtimeSessionId`、`workDir`、`title` 不变 |

- 列表不列别名。
- `GET /runner/sessions/claim` 的负载不变（§4.1）。

### 6.4 任务运行回执 v3

回执在 `task_run_request.target`（0137），类型在 `src/apiserver/src/tasks/task-run-receipt.ts`。v3 只在 v2 上增加 engine：

```ts
interface TaskRunRouteV3 extends Omit<TaskRunRoute, 'provider'> {
  /** The engine the route chose. `provider` is then the credential it runs on, or null for the
   *  engine's own runner sign-in (§4.4); in v2 it was an engine name or the baseline's slug. */
  engine: string;
  provider: string | null;
}
interface TaskRunExecuteTargetV3 extends Omit<TaskRunExecuteTarget, 'v' | 'route'> {
  v: 3;
  kind: 'RUN';
  engine: string | null; // task.engine, or the routed engine; null = resolved at session create
  route: TaskRunRouteV3 | null;
}
// BATCH: { v: 3; kind: 'BATCH'; ...; items: Array<TaskRunPlan & { ...v2 item fields; engine: string | null; route: TaskRunRouteV3 | null }> }
```

- `taskRunDispatch` 产出 `{engine, provider, model, effort}`。`applyWorkspaceRun` 把 engine 一起交给 `sessions.create`。
- 路由的 `baseline` 增加 `engine`。
- STAND_DOWN 仍只有 v1。
- 读取（`readExecuteTarget`、`readBatchPlan`）：
  - v3 原样读出。
  - v1、v2 读成 `engine: null`，`provider`（包括 v2 `route.provider`）按「只给 provider」解析。v2 路由写进 `provider` 的是 engine 名或基线 slug，按这个规则得到的正是它被写下时的执行。旧 DSH slug 经别名解析。
  - 例外：回执的 `provider` 等于任务当前的 provider pin、而任务又有 engine pin 时，用这个 engine pin。这类回执是旧副本在混合窗口里为新形态 pin 绑定的。
  - v4 及未知版本返回 `TASK_RUN_REQUEST_UNREADABLE`。
- `task-model-routing-shadow.pg.spec.ts:383` 现在钉住「v3 is refused」，T3 改为 v4。
- 历史回执不改写。0367 那种对 BOUND 回执做文本替换的方式在本项目不用，别名已经覆盖。

### 6.5 `User.preferences.defaultModels`

- 新键：`<engine>:<provider>`，值为裸模型 id。例如 `dsh:deepseek-2`、`claude:deepseek-2`、`opencode:deepseek-2`、`codex:codex`。
- 新客户端只写新键。服务端 DTO 不变，仍接受任意字符串键、逐键合并；PATCH 时按 §3.5 规范化：校验新键，旧格式键照存并镜像一份新键。
- 读取 (engine, provider) 的记忆模型，依次取：
  1. `<engine>:<provider>`；
  2. engine 为 `opencode`、provider 是 key：旧键 `opencode/<provider>`，值经 `openCodeKeyOf` 取 `model`（值名的 slug 须等于 provider）；
  3. engine 为 `opencode`、provider 为 `opencode`：旧键 `opencode`，值保持原样，但不是 `orbit-` 形式；
  4. engine 等于该 provider 的默认 engine：旧键 `<provider>`。
- 旧 DSH slug 的键由 T4 迁移改写（§7.5），客户端不必认识别名。

## 7. 存量迁移

### 7.1 回填 engine（T2，SQL 迁移）

回填和加列在同一次迁移中执行，幂等：只处理 `engine IS NULL` 的行。

#### `Session.engine`

1. 内置：`provider` 为 `claude`、`codex`、`opencode`、`antigravity`，或为 `kimi`、`dsh` 且 `provider_builtin` → 该值。
2. 同 slug、属于该 owner 或共享的 `model_provider` 行，不论是否停用、调用者能否用 → 行的 runtime。
   - 例外：会话有 `runtime_session_id`，且第 4 步所说的 init 事件存在时，以事件为准。key 的 runtime 今天允许在 claude、codex、kimi、antigravity 之间改，行上的值不一定是产生这个 id 的 engine。
   - 两者不一致的会话由 T4 的报告列出。
3. 同 slug 的池 → 池 engine。
4. slug 什么都对不上（key 已删除）→ 会话的 init 事件：`run_event` 中 `type = 'system'`、`payload->>'subtype'` 为 `init` 或 `resumed`、`payload->>'sessionId' = runtime_session_id` 的 `seq` 最大的一条，取 `payload->>'provider'`。
   - 缺省为 `claude`：Claude Code 的 init 不带 provider（`src/runner-go/claude.go`），其它 engine 都带。
5. 仍不确定 → 保持 NULL（`UNRESOLVED`）。

#### `Task.engine`（只回填 `provider IS NOT NULL` 的行）

- 按上表 1–3 推导，其中「内置」的判定与会话新建一致：`dsh` 先看同名配置行或池。
- `provider = 'opencode'` → `opencode`。
- 推不出 → NULL（`UNRESOLVED`）。
- 结果与迁移前派发会用的 engine 相同。

#### 报告

T2 的迁移只写列。回填结果的逐行报告由 T4 的迁移给出：它对每个会话和任务重算本节的推导，与列值比较，列出 `UNRESOLVED` 和不一致的行（§7.6）。

### 7.2 deepseek-harness 行（T4，应用层）

对象：`model_provider.runtime = 'dsh'` 的行。按 owner 逐个处理，共享行的 owner 为 NULL。

#### 合并

- 条件：存在同 owner、`runtime = 'claude'`、`isDeepSeekKey`、已启用的 key T，与 DSH 行 S 的 endpoint 相同，解密后 key 相同（两边都 `trim()`），并且 S 也已启用。
- endpoint 相同指：scheme 和主机小写后，去掉末尾 `/` 的 `baseUrl` 字符串相等。
- 多个候选时，取 §3.3 的顺序中第一个。
- 动作：
  1. 改写 S 的引用为 (T, `dsh`)（§7.3）；
  2. 删除 S；
  3. 插入别名 (S.slug → T, `dsh`, `MERGED`)。S 还占着这个 slug 时，插入会被 0265 守卫拒绝（§1.5），所以必须先删后插，在同一事务内完成。
- DSH 行不会是账号池成员（池只接受 Claude 订阅或 Codex），删除不牵涉成员关系。

#### 原地转换（不满足合并条件，包括任一方停用）

- 改写字段：`preset_slug = 'deepseek'`，`runtime = 'claude'`，`follows_preset = true`，`models` 为 preset 目录快照，`default_model` 为 preset 默认（与 `ProvidersService.create` 相同）。
- `label` 仍是 `DeepSeek Harness` 时改名，规则同 Web 的 `suggestProviderName`（`src/web/src/lib/providerAdmin.ts`），T4 在服务端照写：
  - 基名 `DeepSeek`，与该 owner 其它 preset 为 `deepseek` 的行（同厂商的兄弟行，与连接页的 `siblingsOf` 相同，含本次迁移里已转换的行）的标签比较，去掉首尾空格、不分大小写。
  - 没被占用就用 `DeepSeek`，被占用就依次试 `DeepSeek 2`、`DeepSeek 3`……，取第一个空闲的。用户已有一把 `DeepSeek` 时，转换来的这把就叫 `DeepSeek 2`。
  - 用户自己起的标签不动。
- `slug` 改为从 `deepseek` 取的空闲 slug（三张表，`pickFreeSlug`）。
- `enabled`、`base_url`、`api_key_enc`、`position`、`owner_id` 不变。
- 然后插入别名 (旧 slug → 本行, `dsh`, `RENAMED`)，改写引用。

#### slug 为 `dsh` 的配置行（0377 保留的同名冲突）

- 若 runtime 为 `dsh`，同样处理，`dsh` 成为别名。
- 其它 runtime 的此类行不动。

### 7.3 引用改写

与 §7.2 的合并或转换在同一个 owner 事务内完成：

| 表 | 条件 | 改写 |
| --- | --- | --- |
| `session` | `provider = S AND NOT provider_builtin` | `provider = T`；`engine` 为 NULL 时设 `dsh` |
| `task` | `provider = S` | `provider = T`；`engine` 为 NULL 时设 `dsh` |
| `user.preferences.defaultModels` | 键 `S` | 改为 `dsh:T`，值不变；`dsh:T` 已存在时保留已存在的，报告冲突 |
| `wiki_space.settings.maintenance.provider` | 等于 S | 改为 T。设置校验不接受 DSH 行，正常不会出现，出现时在报告中标出 |
| `workspace.provider_fallbacks` | 项的 `provider` 等于 S | 改为 T。该字段只存储、派发不读 |
| `session` 遗留内置 `dsh` | `provider = 'dsh' AND provider_builtin` | 用户此时有默认 DeepSeek key 时，改为 (该 key, `dsh`)，`provider_builtin = false`；没有则保留并报告 `LEGACY_DSH_NO_KEY` |

- 任务的 `provider = 'dsh'` pin 不改写，派发时按 §3.3 解析。
- 不改写：`task_route_decision`、`task_run_request`、run event、`Agent.*`。它们读取时经别名解析。
- 核对后在报告中写明：账号池成员不含 DSH 行；`managed_runner.initial_provider` 只存内置 engine 名，都不受影响。

### 7.4 OpenCode 旧编码

- `session` 与 `task` 中 `provider = 'opencode'` 且 `openCodeKeyOf(model)` 为 `{slug, model}` 的行：
  - `slug` 经别名解析得到 key K 后，改为 `provider = K`、`model = <model>`、`engine = 'opencode'`；会话同时设 `provider_builtin = false`。
  - K 不存在时保留原样，报告 `UNRESOLVED`。该会话今天也无法派发。
- 读取兼容一直保留：迁移后旧副本或旧客户端仍可能写入旧编码，按 §3.3 处理。

### 7.5 偏好改键

只改写含义变了的键：

- 旧 DSH slug 的键：见 §7.3。
- `opencode/<slug>` → `opencode:<K>`，值由 `orbit-<slug>/<model>` 改为 `<model>`。
- 值为 `orbit-<slug>/<model>` 的 `opencode` 键 → `opencode:<K>`。

其它旧键（如 `anthropic-2`）不动，新客户端按 §6.5 的第 4 条读取。旧版 App 写的也是这种键，保持可读。

### 7.6 执行方式

- **入口**：在应用层执行，因为要解密 key；解密沿用 `provider-crypto.ts`，不新建凭据存储。
  - 随服务端启动自动执行一次：Prisma 迁移之后，由启动挂钩运行。
  - 完成后写完成标记，例如一张标记表里带版本号的一行。之后的启动看到标记就跳过整体扫描。
  - 但每次启动都先查一次还有没有 `runtime = 'dsh'` 的行，有就按 §7.2 处理。混合窗口里，旧副本可能在标记写下之后又建出这样的行。
  - 同一段代码也能以演练模式运行（不写库，只出报告），供 T10 在生产形态数据的副本上演练。
- **幂等**：
  - 每一步以当前状态为条件。例如合并只处理仍为 `runtime = 'dsh'` 的行；改写用 `WHERE provider = S`。
  - 没有完成标记时重跑，只产生 `NOOP`。
  - 混合窗口里旧副本写下的 engine 为 NULL 的行，不需要重跑迁移：新副本领取时会补写（§1.1）。
- **并发安全**：
  - 全局 `pg_advisory_lock(hashtextextended('provider-engine-migration', 0))`。多个副本同时启动时只有一个执行，其余等它写完标记后跳过。
  - 每个 owner 一个事务，先 `SELECT … FOR UPDATE` 锁住该 owner 的 `model_provider` 行。
  - 引用改写带原值条件（compare-and-set）。改写时被并发修改的行先跳过，报告 `SKIPPED_CHANGED`，在本次执行内重读后再试；仍有剩余时不写完成标记，下次启动再处理。
  - 线上流量不必停：领取路径能解析别名（§3.1 第 4 步），改写前后读到的都是同一把 key 和同一个 engine。
- **逐行报告**：写日志，同时写入可查询的记录（例如一张报告表）。每行 `{step, table, id, ownerId, action, before, after, note}`。
  - `action` 取 `MERGED`、`CONVERTED`、`ALIASED`、`REWRITTEN`、`NOOP`、`SKIPPED_CHANGED`、`UNRESOLVED`、`LEGACY_DSH_NO_KEY`。
  - 报告不含任何 key 材料，合并行只写 `sameKey: true`。
  - 报告末尾汇总各 action 的计数，并对每个会话列出迁移前后的解析结果（engine、凭据 slug、endpoint、模型、`runtimeSessionId`）是否相同，作为第 3 条验收的比对依据。
- **只能前滚**：迁移不删除会话数据，但改写不自动回退。报告逐行保留 `before`，需要时据此手工修复：
  - 被合并而删除的 DSH 行可以重建：先删别名，再建行，key 仍在目标行里。
  - 原地转换的行可以改回。
  - 会话、任务、偏好、wiki 设置与 fallback 的引用可以改回。

## 8. 旧版 App 的兼容边界与服务端校验

旧版 Web 与服务端一起部署，不存在。这里的旧版 App 指解耦前发布的 macOS、iOS、Android 客户端，以及旧的 `orbit` CLI。

### 8.1 旧客户端得到什么

- 只传 provider。新建时得到 provider 的默认 engine，与解耦前一致。旧 DSH slug 经别名得到 `dsh`。
- 列表里的新形态会话显示成 key 的原生 engine，例如 DeepSeek key 上的 `dsh` 会话显示为 Claude。作业指导已接受这一点。
- 迁移后不再有 `runtime='dsh'` 的行：旧客户端里原来的 DeepSeek Harness 配置变成 DeepSeek key，显示为 Claude 方言。它们在新形态会话上续聊仍走正确的 engine，因为 engine 在服务端。
- 旧客户端连接 DeepSeek Harness key，服务端存为 DeepSeek key（§3.6），在旧客户端里显示成 Claude 方言的 key。
- 旧客户端读不到新格式的记忆模型键，回退到 provider 默认模型。

### 8.2 服务端校验要求

服务端对每次写入都按会话 engine（或任务的 pin）校验，保证旧客户端不能造成错误执行：

1. 任何写入都不能改变 `Session.engine`（§1.1 触发器兜底）。
2. 切换 provider 只接受与会话 engine 兼容的凭据（§3.5）。
3. effort、权限模式、fast 用会话 engine 规范化或校验（§2.3）。例如旧客户端以为是 Claude 的 `dsh` 会话：发来 `plan` 权限模式，返回 DSH 现有的 400；发来不在 ACP 目录里的模型，派发时按退役模型换成目录默认。
4. 账号选择只对 runner 登录生效，key 和池上的会话沿用现有拒绝。
5. 领取时再校验一次兼容（§4.1），兜住旧副本和并发写入留下的组合。
6. 改 key 的方言或 endpoint 有 §3.6 的守卫，删除和停用不改变任何会话的 engine。
7. `orbit resume` 读 meta 的 `engine`，旧 runner 读 `provider`，两者都给会话 engine（§6.3）。

## 9. 分工与落点

| 内容 | 任务 |
| --- | --- |
| `Session.engine`、`Task.engine` 与回填（§7.1）、所有写 Session 的路径写入 engine、§5 的触发器和事务内设置、领取与派发按 engine（§4.1–4.3）、meta | T2 |
| 统一解析（§3）、错误码、各入口 DTO、别名表与 0265 守卫扩展（§1.5）、`/providers` 与 `/runner/providers` 的 `engines`、回执 v3、路由与额度闸门（§4.4–4.5）、key 新建与编辑规则（§3.6）、`isDeepSeekAccountRow` 改用共享模块 | T3 |
| §7.2–7.6 的应用层迁移（随启动执行）、别名数据与报告 | T4 |
| CLI `--engine`、MCP `engine` 参数与描述（列全六个 engine）、`orbit provider list` 显示 engines、`orbit resume` 读 meta engine 并补 `dsh` 分支 | T5 |
| Providers 页按厂商列 key、每把 key 标 engines | T6 |
| Web 会话、任务、工作区先选 engine 再选 provider；effort、slash 按 engine；偏好新键 | T7 |
| Swift 镜像共享模块；`AgentDefaults.runtime(for:)` 不再把 `opencode` 当成 `claude`；effort、slash 按 engine | T8 |
| Kotlin 镜像；slash、权限、运行时判断补 `dsh` 并按 engine | T9 |

### 9.1 「顺带修复」各项的具名用例落点（建议）

- key 改方言把在跑会话换 CLI：T3（`PROVIDER_DIALECT_IN_USE`）与 T2（派发读 engine）。
- 停用、删除、越权 key 被当成 Claude：T2（§5.4）。
- resume 的 effort 规范化、meta、reaper：T2。
- 路由把 engine 名写进 provider：T3。
- 额度闸门：T3。
- batch-pin 不校验：T3。
- 客户端按原始 slug 判断 effort 与 slash：T7、T8、T9。
- Swift `AgentDefaults.runtime(for:)`：T8。

### 9.2 census

- 新列、新表、新触发器与新写入加入现有 census：
  - 迁移账本 `tasks/task-judgment-data-preserved.spec.ts`
  - `common/db-write-inventory.ts` 的 `STATEMENT_UNITS`，触发器清单用 `node scripts/sync-db-trigger-inventory.mjs --write` 重新生成
  - `@db.Uuid` 字段的 public id 分类（`src/shared/src/codec.ts`）
  - NOT NULL 名单
- 新路由或新的 id 字段加 tenant isolation 用例。
- 钉住旧耦合语义的用例由对应任务改写，并在交付说明里逐条列出原名与新名：`queue/opencode-migration-guard.spec.ts`、`antigravity-migration-guard.spec.ts`、`dsh-provider-gate.pg.spec.ts`、`queue-provider-capability.spec.ts`、`runner-api/runner-provider-gate.spec.ts`、`reclaim-open-sessions.spec.ts`，以及 `src/shared/src/dsh-routing.spec.ts` 中 `deepseek-harness` preset 的部分。

### 9.3 迁移编号

- 2026-10-09 合入 main 时，最大的是 0411（`0411_retire_candidates_landed_by_receipt`）。
- 取号前按作业指导扫描 main、各 `project/*`、已推送的 `orbit/*` 分支与其它会话的工作树。
