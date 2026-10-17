# 托管 runner 状态（Web · iPhone · Mac）

服务端开启托管 runner（`ORBIT_MANAGED_RUNNERS_ENABLED=true`）后，三端按服务端给出的状态显示托管 runner：准备中、等待容量、可用、休眠、唤醒中、失败/重试、已删除，以及 `MODEL_UNAVAILABLE`、`MANAGED_RUNNER_NOT_ELIGIBLE` 两个原因码。能力缺失或关闭时，界面与现在完全一样，也不读取托管状态。

图里都是真实界面。状态取自三端共用的服务端状态样例 `src/shared/src/managed-runner-states.fixture.json`，apiserver 的测试保证样例里的每个状态都是服务端真实会给出的应答；截图时只把其中的 runner 和 workspace 换成页面自己的示例 id。所有数据都是示例。

| 图 | 内容 |
| --- | --- |
| [00-overview.png](00-overview.png) | 总览：每个状态一行，Web（手机宽度）、iPhone、Mac 并排，只截提示和输入框所在的一段 |
| [web/](web/) | Web 真实页面：`desktop-*` 为 1280×800，`phone-*` 为 390×844（2x）。`e737c81ce` 的 vite 构建（此后 `src/web` 没有再改），配 `src/web/ui-migration` 的示例接口，托管的两个接口按样例应答 |
| [ios/](ios/) | iPhone App 真实界面：GitHub 的 macOS 26 runner 上用模拟器跑 XCUITest 拍摄（run 37927971105），接示例数据的假 API；按 2x 存放 |
| [mac/](mac/) | Mac App 真实界面，同一次 run |

## 每个状态

| 编号 | 状态 | 服务端条件 | 界面 | 用户能做什么 |
| --- | --- | --- | --- | --- |
| 01 | 能力缺失 | 旧服务端，`GET /api/auth/capabilities` 返回 404 | 与改动前的构建逐像素相同；不读托管状态 | 与现在一样 |
| 02 | 能力关闭 | `managedRunners.enabled: false` | 同上 | 与现在一样 |
| 03 | 准备中 | `STARTING`，从未就绪（没有 `initialProvider`） | 输入框上方「Preparing your managed runner」；新会话不显示引擎和模型，不能发送 | 等待，状态每 5 秒刷新 |
| 04 | 等待容量 | `WAITING_CAPACITY` | 「Waiting for capacity」和服务端的原因句 | 等待 |
| 05 | 可用 | `READY` 且 `usable` | 不显示提示，输入框照常 | 照常使用 |
| 06 | 休眠 | `SLEEPING` | 「Managed runner asleep」；输入框照常可以发送 | 发消息即唤醒 |
| 07 | 唤醒中 | `SLEEPING` 且期望状态为 `RUNNING`；或曾就绪后重新启动 | 「Waking your managed runner」 | 消息排队，runner 起来后执行 |
| 08 | 失败 / 重试 | `FAILED` 且服务端允许重试 | 橙色提示和 Retry | Retry 调用 `POST /managed-runner/retry`，带读到的 revision |
| 09 | 模型不可用 | `STARTING` 且原因码 `MODEL_UNAVAILABLE` | 「Your managed runner needs a model」和 Open Infrastructure | 去 Infrastructure 给这台 runner 登录一个运行时 |
| 10 | 不符合资格 | 没有映射，原因码 `MANAGED_RUNNER_NOT_ELIGIBLE` | 没有 runner 的账号：显示原因，以及注册自己机器的入口 | 注册自己的机器 |
| 11 | 开通 | 没有映射，服务端允许开通 | 「Set up a managed runner」和 Set up | Set up 调用 `POST /managed-runner/ensure` |
| 12 | 已删除 | `DELETED` | 「Managed runner removed」；不能发送 | — |

## 截图怎么来的

- **Web**：`e737c81ce` 的 `src/web` 静态构建，在无头 Chromium 里打开真实路由（新会话草稿 `/workspaces/<id>/new`、会话 `/sessions/<id>`、根路径落地页），其余接口用仓库自带的 `src/web/ui-migration` 示例数据，`GET /api/auth/capabilities` 和 `GET /api/managed-runner` 按样例应答。01、02 两张另与项目线 tip（`65c15fb5a`，不含本任务）的同一构建对比：桌面和手机都是 0 个像素不同，旧构建也从不请求托管状态。
- **iPhone / Mac**：在 GitHub 的 macOS runner 上，用 `03f3c962e` 的共享源码编出 iPhone App（`CompactShell`）和 Mac App（`MainView`）的探针版，指向一个按样例应答的假 API；XCUITest 每个状态启动一次并截图。状态没画出来测试就失败；能力缺失和关闭两项还检查 App 没有读托管状态。08 和 11 另外按了 Retry、Set up：假 API 收到 `POST /managed-runner/retry`（带读到的 revision 9）和 `POST /managed-runner/ensure`，界面随应答变成「Preparing your managed runner」（`*b-after-*.png`）。
- 同一次推送也跑了 client.yml 的两道编译门：macOS 上 OrbitKit `swift test` 加 OrbitApp `swift build`，以及 iOS 模拟器构建。探针分支只用于这次截图，不合并。
- 截图之后任务分支只合入了项目线（C6b：停用账号的托管 runner 休眠且不再唤醒），并让「休眠中、服务端不提供唤醒（`actions.canWake` 为 false）」的 runner 不再接收消息。图里休眠和唤醒中两个状态的样例都允许唤醒，所以三端的画面都不受影响。

## 三端的差别

- 没有 runner、也没有 workspace 的账号：Web 的默认落地页显示托管卡片（10、11），注册自己机器的入口在卡片下方；iPhone 和 Mac 上这样的账号本来就落在 Infrastructure，托管卡片在机器列表上方（iPhone 在列表第一节，Mac 在列表上方单独占一块）。
- 能力缺失或关闭时，Web 的托管 workspace 和现在一样显示「Runner offline」；iPhone 和 Mac 的输入框本来就不按 runner 在线状态拦截，所以 01、02 在原生端就是普通的新会话页。
- 在托管默认 workspace 里，runner 从未就绪时（03、04、08、09、12）三端都不显示引擎和模型，也不能发送：服务端会以 `MODEL_UNAVAILABLE` 拒绝这样的首个会话。

## 没有覆盖的

- 这里没有真实开启开关的服务端，也没有真实集群和 runner：休眠、唤醒、失败都来自样例，不是实测。真实环境里的开通、唤醒耗时、容量不足和重试留给 T07。
- 服务端没有实时的 revision 通知，三端都是轮询：状态在变化中每 5 秒读一次，其余每 30 秒。
- 侧栏和 Infrastructure 的机器卡片仍按心跳显示托管 runner「离线」，没有改成「休眠」。
