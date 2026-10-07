import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the batch-create review exactly as ToolApprovalCard composes
// it in the approval review sheet (ApprovalReviewSheet: NavigationStack, the grouped
// ApprovalReviewLayout, BatchCreateReviewBody, the two actions, ApprovalReviewCloseButton), presented
// as a .large sheet, fed one of two batches through the same parsers the card uses:
//   -probe.state real3    the three independent tasks of the owner's screenshot (real titles and bodies)
//   -probe.state diamond  1 → 2, 3 → 4, the first also waiting on an existing task (made-up data)
@main
struct BatchReviewProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

private enum Fixture {
    static let real3 = #"""
{"tasks": [{"title": "管理员共享模型提供方的 API key 会下发到任何账号的 runner（开放注册前需所有者决定）", "description": "背景：T2 租户隔离普查（任务 34bRA94WvvYHXeB74nFsI）发现，owner_id 为空的模型提供方，即管理员的共享提供方（RealtimeService.publishForAllUsers 注释称之为 \"the shared (admin-owned) model providers\"），对所有账号都可用。会话的 provider 按 `OR: [{ ownerId: null }, { ownerId }]` 解析：src/apiserver/src/providers/custom-provider.ts 第 156 行 sessionExecRuntime、第 186 行 providerSlugsOn，以及 src/apiserver/src/queue/queue.service.ts 第 733 行的派发路径。派发时 custom-provider.ts 第 240 行 injectedEnv 把该行的 apiKeyEnc 解密，放进交给 runner 的会话环境（第 473 行）。任何账号都可以在自己注册的 runner 上用这样的 slug 开会话，再从引擎的环境变量里读出管理员的 key。今天的账号都是管理员拉进来的同事；orbitd.io 切到 OPEN（docs/google-sign-in-design.md 第 5.6 节）后，陌生人注册后即可这样做。设计 5.6 写的是「新用户看不到也用不了别人的 runner、workspace 和共享池（共享池要池主显式拉人）」，共享提供方不在其中。\n\n要做：\n1. 用 ask_owner 请所有者决定策略，不要自行选择。可选项例如：共享提供方只对管理员显式放入的账号可用（与共享池同理）；经服务端网关转发，key 不离开服务端；orbitd.io 上不设共享提供方。\n2. 按决定实现，覆盖上面列出的所有解析点（会话创建、派发认领、运行时解析、列表）。\n3. 写 pg spec，用 scripts/run-pg-spec.sh 跑：未获准的账号用共享提供方的 slug 建会话或被派发都被拒绝，它任何会话的注入环境里都没有该 key；获准的账号照常。", "acceptanceCriteria": "任务评论里记录了所有者的决定。scripts/run-pg-spec.sh 跑的 pg spec 全部通过、零跳过，并显示：按该决定未获准的账号用共享提供方 slug 建会话或被派发均被拒绝，且该账号任何会话的注入环境里没有该提供方的 key；获准的账号照常可用。项目合并检查在最终提交上通过。", "completionCriterion": "EVIDENCE_JUDGMENT", "labels": ["google-sign-in"]}, {"title": "池网关原样转发 OpenAI-Organization / OpenAI-Project，池成员能让别人贡献的 key 被标为 INVALID", "description": "背景：T2 租户隔离普查（任务 34bRA94WvvYHXeB74nFsI）发现，src/apiserver/src/providers/pool-gateway.service.ts 第 416 行的 forwardedHeaders 把调用方请求的全部头转发给 OpenAI，只去掉 NOT_FORWARDED 列出的几个。一个已加入共享池的成员，其会话发往网关的请求可以带上指向别的组织或项目的 `OpenAI-Organization`、`OpenAI-Project` 头；OpenAI 对不匹配的组织以 401 拒绝该 key，网关随即在第 243 行调用 markKeyInvalid，把贡献者的 key 标为 INVALID，直到贡献者或管理员替换。成员因此可以一个一个停掉别人贡献的 key，写的是别的账号的行。\n\n要做：\n1. 不再转发这两个头，或改为只转发白名单内的头。\n2. 由调用方自带的头引起的 401 不再把 key 标为 INVALID。\n3. 在 pool-gateway 的单测里覆盖这两点。", "acceptanceCriteria": "单测显示：转发给上游的请求里没有 OpenAI-Organization、OpenAI-Project（若改为白名单，则没有白名单以外的头）；带这类头的请求得到上游 401 时，key 不被标为 INVALID。现有网关 spec 通过，项目合并检查在最终提交上通过。", "completionCriterion": "EVIDENCE_JUDGMENT", "labels": ["google-sign-in"]}, {"title": "T1 用户路由普查补读 JWT 路由的 id 头与无类型请求体，并在 pg 里演示 JWT 门上的同类修复", "description": "背景：T1 的租户隔离普查（src/apiserver/src/auth/tenant-isolation-cases.ts、tenant-isolation-census.spec.ts 前半、tenant-isolation.pg.spec.ts）对 JwtAuthGuard 路由只读路径参数、查询和以 DTO 类声明的请求体。它不读 X-Orbit-Session-Id、X-Orbit-Workspace-Id、X-Orbit-Agent-Id 这类 id 头（common/public-id-headers.ts 的 ID_HEADERS），也不读只用 TypeScript 类型声明的请求体。\n\n要做：\n1. 把 T2 的头与无类型请求体读取用到 JWT 门，新发现的 id 字段逐个登记：跨账号用例，或附手工证明。\n2. 在 T1 的 pg 普查里补四个字段的跨账号用例。\n3. 用 scripts/run-pg-spec.sh 跑 T1 的 pg 普查，再在最终提交上跑项目合并检查。", "acceptanceCriteria": "JWT 路由新增 id 头或无类型请求体里的 id 字段而不登记时，tenant-isolation-census.spec.ts 失败（附一次红检记录）。T1 的 pg 普查包含上述四个字段的跨账号用例，用 scripts/run-pg-spec.sh 运行全部通过、零跳过。项目合并检查在最终提交上通过。", "completionCriterion": "EVIDENCE_JUDGMENT", "labels": ["google-sign-in"]}], "preview": {"taskCount": 3, "startingNow": 0, "blocked": 0, "needsManualStart": 3, "notDispatchable": 0, "internalEdges": 0, "externalEdges": 0, "lists": [], "tasks": [{"title": "管理员共享模型提供方的 API key 会下发到任何账号的 runner（开放注册前需所有者决定）", "dependsOnRefs": [], "dependsOnTaskIds": [], "ref": null}, {"title": "池网关原样转发 OpenAI-Organization / OpenAI-Project，池成员能让别人贡献的 key 被标为 INVALID", "dependsOnRefs": [], "dependsOnTaskIds": [], "ref": null}, {"title": "T1 用户路由普查补读 JWT 路由的 id 头与无类型请求体，并在 pg 里演示 JWT 门上的同类修复", "dependsOnRefs": [], "dependsOnTaskIds": [], "ref": null}], "titlesTruncated": 0}}
"""#
    static let diamond = #"""
{"tasks": [{"title": "Google OAuth 回调与身份落库", "ref": "a", "dependsOnTaskIds": ["existing-1"], "description": "把 Google 的 OAuth 回调接进来，外部身份写进 external_identity。", "acceptanceCriteria": "回调能建会话；pg spec 通过。", "completionCriterion": "EXECUTABLE", "labels": ["google-sign-in"]}, {"title": "登录页加「用 Google 登录」按钮", "ref": "b", "dependsOnRefs": ["a"], "description": "登录页加按钮。", "acceptanceCriteria": "按钮走通回调。", "completionCriterion": "EVIDENCE_JUDGMENT", "labels": ["google-sign-in"]}, {"title": "首次登录自动建账号与默认 workspace", "ref": "c", "dependsOnRefs": ["a"], "description": "首次登录建账号。", "acceptanceCriteria": "新账号有默认 workspace。", "completionCriterion": "EVIDENCE_JUDGMENT", "labels": ["google-sign-in"]}, {"title": "开放注册 e2e：新账号看不到别人的 runner", "ref": "d", "dependsOnRefs": ["b", "c"], "description": "背景：开放注册后，陌生人可以直接用 Google 账号注册。设计 5.6 写的是「新用户看不到也用不了别人的 runner、workspace 和共享池」，这条 e2e 用来守住它。\n\n要做：\n1. 用全新的 Google 测试账号走一遍注册 → 登录 → 打开三个列表。\n2. 断言三处都为空，且直接请求别人的 id 返回 404。\n3. 接进 CI 的 e2e 任务。", "acceptanceCriteria": "用一个新注册的 Google 账号登录后，runner、workspace、共享池三处列表都为空，直接请求别人的 id 返回 404；e2e 在 CI 上通过，附运行记录。", "completionCriterion": "EVIDENCE_JUDGMENT", "labels": ["google-sign-in"]}], "preview": {"taskCount": 4, "startingNow": 1, "blocked": 3, "needsManualStart": 0, "notDispatchable": 0, "internalEdges": 4, "externalEdges": 1, "lists": [{"id": "l1", "title": "Backlog"}], "tasks": [{"title": "Google OAuth 回调与身份落库", "ref": "a", "dependsOnRefs": [], "dependsOnTaskIds": ["existing-1"]}, {"title": "登录页加「用 Google 登录」按钮", "ref": "b", "dependsOnRefs": ["a"], "dependsOnTaskIds": []}, {"title": "首次登录自动建账号与默认 workspace", "ref": "c", "dependsOnRefs": ["a"], "dependsOnTaskIds": []}, {"title": "开放注册 e2e：新账号看不到别人的 runner", "ref": "d", "dependsOnRefs": ["b", "c"], "dependsOnTaskIds": []}], "titlesTruncated": 0}}
"""#

    static var input: JSONValue {
        let args = ProcessInfo.processInfo.arguments
        let name = args.firstIndex(of: "-probe.state").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        let text = name == "diamond" ? diamond : real3
        return try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }
}

private struct ProbeRoot: View {
    var body: some View {
        Color(uiColor: .systemBackground)
            .ignoresSafeArea()
            .sheet(isPresented: .constant(true)) {
                ProbeReview(input: Fixture.input)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .interactiveDismissDisabled()
            }
    }
}

private struct ProbeReview: View {
    let input: JSONValue

    var body: some View {
        let batch = Approvals.batchPreview(from: input)!
        NavigationStack {
            ApprovalReviewLayout(title: "Create \(batch.taskCount) tasks?", symbol: "checklist", tone: .orange,
                                 summary: "", grouped: true) {
                BatchCreateReviewBody(batch: batch, details: Approvals.batchTaskDetails(from: input), close: {})
            } actions: {
                ApprovalActions {
                    Button {} label: {
                        Text(Approvals.batchCreateAction(batch.taskCount)).approvalActionLabel()
                    }
                    .buttonStyle(.borderedProminent)
                    Button {} label: {
                        Text(Approvals.chatAction).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                }
            }
            .environment(\.inApprovalReview, true)
            .toolbar { ApprovalReviewCloseButton {} }
        }
    }
}
