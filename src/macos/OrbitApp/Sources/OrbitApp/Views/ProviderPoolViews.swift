#if os(iOS)
import SwiftUI
import OrbitKit

// Settings → Providers and the pool pages its rows open, drawn from what they are handed: the runners,
// pools and keys to list, a pool, and the presses a shared pool's page makes. Nothing here reads
// `AppModel` — SettingsSheet's pages do, and hand these views the answers — so each page can also be
// drawn from fixtures alone. The words, and what the pages make of a pool's numbers, are OrbitKit's
// (`ProvidersOverview`, `SharedPoolPage`, `AddPoolKey`, `ProviderPools`), where they are tested.

// MARK: - Providers

/// Settings → Providers: where the account's models come from — the engines signed in on each runner
/// (a row opens that runner, where signing in lives), the pools (a row opens the pool's page), and the
/// account's API keys, which are added and changed on the web.
struct ProvidersOverviewForm: View {
    let runners: [Runner]
    let pools: [ProviderPool]
    let sharedPools: [SharedPool]
    let keys: [ConfiguredProvider]

    var body: some View {
        Form {
            Section {
                ForEach(runners) { runner in
                    NavigationLink(value: NavNode.runnerDetail(runnerID: runner.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(runner.displayName?.isEmpty == false ? runner.displayName! : runner.name)
                            Text(ProvidersOverview.runnerSummary(runner))
                                .font(.orbitListSubtitle)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                SettingsHeader(ProvidersOverview.onYourRunners)
            } footer: {
                Text(ProvidersOverview.onYourRunnersDetail)
            }

            if !pools.isEmpty || !sharedPools.isEmpty {
                Section {
                    ForEach(sharedPools) { pool in
                        NavigationLink(value: NavNode.sharedPool(poolID: pool.id)) {
                            PoolRowLabel(engine: pool.engine, title: pool.label,
                                         line: ProvidersOverview.sharedPoolLine(pool),
                                         value: ProvidersOverview.sharedPoolSummary(pool))
                        }
                    }
                    ForEach(pools) { pool in
                        NavigationLink(value: NavNode.accountPool(poolID: pool.id)) {
                            // A Codex pool of one's own runs on a ChatGPT account: "Just me · the
                            // account" under its name, and where that account stands.
                            PoolRowLabel(engine: ProviderPools.runsCodex(pool) ? "codex" : "claude",
                                         title: pool.label,
                                         line: CodexLoginPool.isLoginPool(pool) ? CodexLoginPool.overviewLine(pool) : nil,
                                         value: ProvidersOverview.poolSummary(pool))
                        }
                    }
                } header: {
                    SettingsHeader(ProvidersOverview.accountPools)
                } footer: {
                    Text(ProvidersOverview.accountPoolsDetail)
                }
            }

            Section {
                if keys.isEmpty {
                    Text(ProvidersOverview.noKeys).foregroundStyle(.secondary)
                }
                ForEach(keys) { key in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(key.label)
                        if let defaultModel = key.defaultModel {
                            Text(defaultModel)
                                .font(.orbitListSubtitle)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                SettingsHeader(ProvidersOverview.apiKeys)
            } footer: {
                Text(ProvidersOverview.apiKeysDetail + " " + ProvidersOverview.editOnWeb)
            }
        }
    }
}

/// A pool's row: its engine's mark and its name — "Shared · 4 members" under a shared pool's — and how
/// many of its keys or accounts a session could start on now.
private struct PoolRowLabel: View {
    let engine: String
    let title: String
    let line: String?
    let value: String

    var body: some View {
        LabeledContent {
            Text(value)
        } label: {
            HStack(spacing: 12) {
                ProviderMark(provider: engine, size: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .lineLimit(1)
                    if let line {
                        Text(line)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

// MARK: - A shared pool

/// What a shared pool's page asks the account to do. Each press answers with why it didn't happen, or
/// nil; the pool on screen is whatever the server answered last, so a press that worked shows itself.
struct SharedPoolActions {
    var addKey: (AddPoolKeyRequest) async -> AddPoolKey.Outcome
    /// A new secret for a key OpenAI refused.
    var replaceKey: (SharedPoolKey, String) async -> AddPoolKey.Outcome
    var removeKey: (SharedPoolKey) async -> String?
    /// Its contributor's own switch.
    var switchKey: (SharedPoolKey, Bool) async -> String?
    var setRules: (UpdateSharedPoolRequest) async -> String?
    /// Someone added by their Orbit account's email.
    var addPerson: (String) async -> String?
    var setRole: (SharedPoolPerson, SharedPoolRole) async -> String?
    var removePerson: (SharedPoolPerson) async -> String?
    var deletePool: () async -> String?
    var leavePool: () async -> String?
}

/// Which sheet is up over a shared pool's page.
enum SharedPoolSheet: Identifiable {
    case add
    case replace(SharedPoolKey)

    var id: String {
        switch self {
        case .add: return "add"
        case .replace(let key): return "replace-\(key.id)"
        }
    }
}

/// A shared pool's page, in the web page's five blocks: what the pool is and "Add a key", its keys (a
/// key is switched off or taken out with a swipe, and a refused one is replaced from its row), its
/// people (an admin manages them with a swipe), its two rules — each switch its own section, its
/// sentence the footer, and only an admin's to change — and deleting the pool (an admin) or leaving it
/// (anyone else).
struct SharedPoolPageView: View {
    let pool: SharedPool
    let actions: SharedPoolActions

    @State private var sheet: SharedPoolSheet?
    @State private var removingKey: SharedPoolKey?
    @State private var removingPerson: SharedPoolPerson?
    @State private var confirmingExit = false
    @State private var addingPerson = false
    @State private var email = ""
    /// A switch just flipped, shown as flipped until the pool the server answers with arrives.
    @State private var membersCanAdd: Bool?
    @State private var ownKeyFirst: Bool?
    @State private var notice: String?

    private var isAdmin: Bool { SharedPoolPage.isAdmin(pool) }

    var body: some View {
        Form {
            head
            keysSection
            peopleSection
            rulesSections
            exitSection
        }
        .navigationTitle(pool.label)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $sheet) { kind in
            sheetView(kind)
        }
        .confirmationDialog(removingKey.map(SharedPoolPage.removeKeyTitle) ?? "",
                            isPresented: removingKeyAsked, titleVisibility: .visible, presenting: removingKey) { key in
            Button(SharedPoolPage.remove, role: .destructive) {
                run(done: SharedPoolPage.removedKey(key)) { await actions.removeKey(key) }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: { _ in
            Text(SharedPoolPage.removeKeyNote)
        }
        .confirmationDialog(removingPerson.map { SharedPoolPage.removePersonTitle($0, in: pool) } ?? "",
                            isPresented: removingPersonAsked, titleVisibility: .visible,
                            presenting: removingPerson) { person in
            Button(SharedPoolPage.remove, role: .destructive) {
                run { await actions.removePerson(person) }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: { _ in
            Text(SharedPoolPage.removePersonNote)
        }
        .confirmationDialog(isAdmin ? SharedPoolPage.deleteTitle(pool) : SharedPoolPage.leaveTitle(pool),
                            isPresented: $confirmingExit, titleVisibility: .visible) {
            Button(isAdmin ? SharedPoolPage.delete : SharedPoolPage.leave, role: .destructive) {
                let admin = isAdmin
                run {
                    if admin { return await actions.deletePool() }
                    return await actions.leavePool()
                }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: {
            Text(isAdmin ? SharedPoolPage.deletePoolNote : SharedPoolPage.leavePoolNote)
        }
        .alert(SharedPoolPage.addMembersTitle(pool), isPresented: $addingPerson) {
            TextField(SharedPoolPage.emailPlaceholder, text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button(SharedPoolPage.add) {
                let typed = email
                run(done: SharedPoolPage.added(pool)) { await actions.addPerson(typed) }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: {
            Text(SharedPoolPage.addMembersNote)
        }
        .overlay(alignment: .bottom) {
            if let notice {
                Text(notice)
                    .font(.orbitListSubtitle.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                    .transition(.opacity)
            }
        }
        .animation(.default, value: notice)
        .onChange(of: pool) { _, _ in
            membersCanAdd = nil
            ownKeyFirst = nil
        }
    }

    // MARK: blocks

    /// What the pool is — its engine's mark, "Shared Codex pool", how many are in it and how many of its
    /// keys can run — and the one press everyone who may put a key in has.
    private var head: some View {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ProviderMark(provider: pool.engine, size: 30)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(SharedPoolPage.title)
                                .font(.headline)
                            PoolChip(text: SharedPoolPage.sharedChip, brand: true)
                        }
                        Text(SharedPoolPage.subtitle(pool))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 4)
                if SharedPoolPage.canAddKey(pool) {
                    WideButton(title: SharedPoolPage.addKey) { sheet = .add }
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
    }

    private var keysSection: some View {
        Section {
            if pool.keys.isEmpty {
                Text(SharedPoolPage.noKeys)
                    .foregroundStyle(.secondary)
            }
            ForEach(pool.keys) { key in
                PoolKeyRow(key: key, pool: pool) {
                    sheet = .replace(key)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if SharedPoolPage.canRemove(key, in: pool) {
                        Button(role: .destructive) { removingKey = key } label: {
                            Label(SharedPoolPage.remove, systemImage: "trash")
                        }
                    }
                    if SharedPoolPage.canSwitch(key) {
                        Button {
                            run { await actions.switchKey(key, !key.enabled) }
                        } label: {
                            Label(key.enabled ? SharedPoolPage.disableKey : SharedPoolPage.enableKey,
                                  systemImage: key.enabled ? "pause.circle" : "play.circle")
                        }
                        .tint(.gray)
                    }
                }
            }
        } header: {
            PoolSectionHeader(title: SharedPoolPage.keysHeader, trailing: SharedPoolPage.keysHeadline(pool))
        } footer: {
            Text(SharedPoolPage.keysFooter)
        }
    }

    private var peopleSection: some View {
        Section {
            ForEach(pool.people) { person in
                PoolPersonRow(person: person, pool: pool)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if SharedPoolPage.canManage(person, in: pool) {
                            Button(role: .destructive) { removingPerson = person } label: {
                                Label(SharedPoolPage.removeFromPool, systemImage: "person.badge.minus")
                            }
                            Button {
                                let role: SharedPoolRole = person.role == .admin ? .member : .admin
                                run { await actions.setRole(person, role) }
                            } label: {
                                Label(person.role == .admin ? SharedPoolPage.makeMember : SharedPoolPage.makeAdmin,
                                      systemImage: person.role == .admin ? "person" : "person.badge.key")
                            }
                            .tint(.gray)
                        }
                    }
            }
            if isAdmin {
                Button {
                    email = ""
                    addingPerson = true
                } label: {
                    Label(SharedPoolPage.addMembers, systemImage: "plus")
                }
            }
        } header: {
            PoolSectionHeader(title: SharedPoolPage.membersHeader, trailing: SharedPoolPage.shareHeader)
        }
    }

    @ViewBuilder private var rulesSections: some View {
        Section {
            Toggle(SharedPoolPage.membersCanAdd, isOn: Binding(
                get: { membersCanAdd ?? pool.membersCanAdd },
                set: { value in
                    membersCanAdd = value
                    setRule(UpdateSharedPoolRequest(membersCanAdd: value)) { membersCanAdd = nil }
                }))
            .disabled(!isAdmin)
        } header: {
            PoolSectionHeader(title: SharedPoolPage.rulesHeader, trailing: isAdmin ? nil : SharedPoolPage.setByAdmins)
        } footer: {
            Text(SharedPoolPage.membersCanAddHint(pool))
        }
        Section {
            Toggle(SharedPoolPage.ownKeyFirst, isOn: Binding(
                get: { ownKeyFirst ?? pool.ownKeyFirst },
                set: { value in
                    ownKeyFirst = value
                    setRule(UpdateSharedPoolRequest(ownKeyFirst: value)) { ownKeyFirst = nil }
                }))
            .disabled(!isAdmin)
        } footer: {
            Text(SharedPoolPage.ownKeyFirstHint)
        }
    }

    private var exitSection: some View {
        Section {
            Button(role: .destructive) { confirmingExit = true } label: {
                Text(isAdmin ? SharedPoolPage.deletePool : SharedPoolPage.leavePool)
                    .frame(maxWidth: .infinity)
            }
        } footer: {
            Text(isAdmin ? SharedPoolPage.deletePoolNote : SharedPoolPage.leavePoolNote)
        }
    }

    @ViewBuilder private func sheetView(_ sheet: SharedPoolSheet) -> some View {
        switch sheet {
        case .add:
            AddPoolKeySheet(pool: pool) { name, key, cap in
                await actions.addKey(AddPoolKeyRequest(label: name, apiKey: key, shareCap: cap))
            }
        case .replace(let refused):
            AddPoolKeySheet(pool: pool, replacing: refused) { _, key, _ in
                let outcome = await actions.replaceKey(refused, key)
                if case .added = outcome { show(AddPoolKey.replaced(refused, in: pool)) }
                return outcome
            }
        }
    }

    // MARK: presses

    private var removingKeyAsked: Binding<Bool> {
        Binding(get: { removingKey != nil }, set: { if !$0 { removingKey = nil } })
    }

    private var removingPersonAsked: Binding<Bool> {
        Binding(get: { removingPerson != nil }, set: { if !$0 { removingPerson = nil } })
    }

    /// A press, and a line over the page's foot saying how it went: why it didn't go through, or — for
    /// a press whose effect isn't on screen by itself — `done`.
    private func run(done: String? = nil, _ press: @escaping () async -> String?) {
        Task {
            if let failure = await press() {
                show(failure)
            } else if let done {
                show(done)
            }
        }
    }

    /// A rule, flipped back on screen when the server didn't take it.
    private func setRule(_ change: UpdateSharedPoolRequest, revert: @escaping () -> Void) {
        Task {
            guard let failure = await actions.setRules(change) else { return }
            revert()
            show(failure)
        }
    }

    private func show(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(3))
            if notice == text { notice = nil }
        }
    }
}

/// One key: whose it is and its name, where it stands, what the others spent on it against its cap —
/// and, when OpenAI refused it, why, and (to its contributor or an admin) the press that replaces it.
private struct PoolKeyRow: View {
    let key: SharedPoolKey
    let pool: SharedPool
    let replace: () -> Void

    var body: some View {
        let status = SharedPoolPage.status(key, in: pool)
        HStack(alignment: .top, spacing: 12) {
            PoolAvatar(name: key.contributor.name, hex: SharedPoolPage.avatarHex(key.contributor.userId, in: pool))
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(key.label)
                        .font(.headline)
                        .lineLimit(1)
                    if key.contributor.you {
                        Text(SharedPoolPage.you)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                    }
                    if key.next {
                        PoolChip(text: SharedPoolPage.nextChip)
                    }
                }
                Text(SharedPoolPage.keyLine(key))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                Text(status.label)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(PoolTone.color(status.tone))
                if let why = SharedPoolPage.invalidReason(key, in: pool) {
                    Text(why)
                        .font(.orbitLabel)
                        .foregroundStyle(PoolTone.color(.danger))
                        .padding(.top, 2)
                }
                if key.state == .invalid && SharedPoolPage.canReplace(key, in: pool) {
                    Button(SharedPoolPage.replaceKey, action: replace)
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .padding(.top, 7)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                Text(SharedPoolPage.money(key))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if let percent = SharedPoolPage.capPercent(key) {
                    PoolGaugeBar(percent: percent,
                                 tint: percent >= 90 ? PoolTone.color(.warning) : Color.accentColor)
                }
            }
            .padding(.top, 3)
        }
        .padding(.vertical, 4)
    }
}

/// One person: who, their role, what they put in and how much they ran, and their share of what the
/// pool ran this month.
private struct PoolPersonRow: View {
    let person: SharedPoolPerson
    let pool: SharedPool

    var body: some View {
        let share = SharedPoolPage.share(person, in: pool)
        HStack(alignment: .top, spacing: 12) {
            PoolAvatar(name: person.name, hex: SharedPoolPage.avatarHex(person.userId, in: pool))
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(person.name)
                        .lineLimit(1)
                    if person.you {
                        Text(SharedPoolPage.you)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                    }
                    if person.role == .admin {
                        PoolChip(text: SharedPoolPage.adminChip)
                    }
                }
                Text(SharedPoolPage.personLine(person))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                Text(verbatim: "\(share)%")
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                PoolGaugeBar(percent: share, tint: Color.accentColor)
            }
            .padding(.top, 3)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Add a key

/// "Add a key": what putting a key in means (and the warning that stays), then its name, the key and the
/// monthly limit, then what the pool shows of it — its fingerprint, never the key. The same sheet
/// replaces a key OpenAI refused (web's "Replace key"): the key alone, its name and limit staying.
struct AddPoolKeySheet: View {
    let pool: SharedPool
    let replacing: SharedPoolKey?
    /// Name, key and limit, sent.
    let submit: (String, String, Int?) async -> AddPoolKey.Outcome

    @State private var step: AddPoolKey.Step
    @State private var name: String
    @State private var key: String
    @State private var limit: String
    @State private var sending = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    init(pool: SharedPool, replacing: SharedPoolKey? = nil, step: AddPoolKey.Step? = nil,
         name: String = "", key: String = "", limit: String = "",
         submit: @escaping (String, String, Int?) async -> AddPoolKey.Outcome) {
        self.pool = pool
        self.replacing = replacing
        self.submit = submit
        _step = State(initialValue: step ?? (replacing == nil ? .consent : .form))
        _name = State(initialValue: name)
        _key = State(initialValue: key)
        _limit = State(initialValue: limit)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(replacing.map(AddPoolKey.replaceTitle) ?? AddPoolKey.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                        }
                        .accessibilityLabel(AddPoolKey.cancel)
                    }
                }
        }
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .consent:
            consent
        case .form:
            form
        case .done(let label, let fingerprint):
            done(label: label, fingerprint: fingerprint)
        case .duplicate(let by):
            duplicate(by)
        }
    }

    // MARK: steps

    /// What putting a key in means: who can run on it, where it stays, that it can be taken out — and
    /// that a key can't be resold, and whoever adds it answers for it.
    private var consent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                (Text(AddPoolKey.leadPrefix) + Text(pool.label).bold() + Text("."))
                    .padding(.horizontal, 24)
                    .padding(.top, 6)
                    .padding(.bottom, 12)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(AddPoolKey.facts(pool).enumerated()), id: \.offset) { index, fact in
                        if index > 0 {
                            Divider().padding(.leading, 16)
                        }
                        FactText(fact: fact)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 11)
                    }
                }
                .background(Color(uiColor: .secondarySystemGroupedBackground),
                            in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .padding(.horizontal, 16)
                (Text("⚠︎ ") + Text(AddPoolKey.risk.lead).bold() + Text(AddPoolKey.risk.rest))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(PoolTone.color(.warning))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                WideButton(title: AddPoolKey.continueLabel) { step = .form }
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                Text(AddPoolKey.consentNext)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 28)
                    .padding(.top, 10)
            }
            .padding(.bottom, 24)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// Name, key and limit — or, replacing a refused key, the key alone.
    private var form: some View {
        Form {
            Section {
                Text(replacing.map(AddPoolKey.replaceLead) ?? AddPoolKey.formLead)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
            }
            if replacing == nil {
                Section {
                    TextField(AddPoolKey.name, text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text(AddPoolKey.name)
                }
            }
            Section {
                SecureField(AddPoolKey.keyPlaceholder, text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: key) { _, _ in failure = nil }
            } header: {
                Text(AddPoolKey.key)
            } footer: {
                if let failure {
                    Text(failure).foregroundStyle(PoolTone.color(.danger))
                } else {
                    (Text(AddPoolKey.keyHintPrefix) + Text(AddPoolKey.fingerprint(of: key)).bold() + Text(AddPoolKey.keyHintSuffix))
                }
            }
            if replacing == nil {
                Section {
                    HStack(spacing: 6) {
                        Text(AddPoolKey.limitPrefix)
                            .foregroundStyle(.secondary)
                        TextField(AddPoolKey.noLimit, text: $limit)
                            .keyboardType(.numberPad)
                            .onChange(of: limit) { _, typed in
                                let digits = AddPoolKey.limitDigits(typed)
                                if digits != typed { limit = digits }
                            }
                        Text(AddPoolKey.limitSuffix)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text(AddPoolKey.limit)
                } footer: {
                    Text(AddPoolKey.limitHint(pool))
                }
            }
            Section {
                WideButton(title: replacing == nil ? AddPoolKey.submit : SharedPoolPage.replaceKey, busy: sending) {
                    send()
                }
                .disabled(!canSend || sending)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            }
        }
    }

    /// It went in: its name, and all anyone will be shown of it.
    private func done(label: String, fingerprint: String) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(PoolTone.color(.success))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AddPoolKey.doneTitle(label: label, pool: pool))
                            .font(.headline)
                        (Text(fingerprint).bold() + Text(AddPoolKey.doneDetail))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                if let me {
                    HStack(spacing: 12) {
                        PoolAvatar(name: me.name, hex: SharedPoolPage.avatarHex(me.userId, in: pool))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(label)
                                .font(.headline)
                            Text(AddPoolKey.doneRow(me: me.name, fingerprint: fingerprint))
                                .font(.orbitLabel)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .secondarySystemGroupedBackground),
                                in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                }
                WideButton(title: AddPoolKey.done) { dismiss() }
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// The same key is in the pool already: whose it is, and why a second copy adds nothing.
    private func duplicate(_ by: AddPoolKey.AddedBy) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(PoolTone.color(.warning))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AddPoolKey.duplicateTitle(pool))
                            .font(.headline)
                        Text(AddPoolKey.duplicateDetail(by))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                WideButton(title: AddPoolKey.addAnother) {
                    key = ""
                    step = .form
                }
                Button(AddPoolKey.close) { dismiss() }
                    .frame(maxWidth: .infinity)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    // MARK: sending

    private var me: SharedPoolPerson? { pool.people.first(where: \.you) }

    private var canSend: Bool {
        replacing == nil
            ? AddPoolKey.canSubmit(name: name, key: key)
            : !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let typed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = name.trimmingCharacters(in: .whitespaces)
        let cap = AddPoolKey.shareCap(limit)
        let before = pool
        sending = true
        Task {
            let outcome = await submit(label, typed, cap)
            sending = false
            switch outcome {
            case .added(let after):
                // A replaced key is back in its row on the page underneath; a new one is shown here once.
                guard replacing == nil else { dismiss(); return }
                let added = AddPoolKey.added(before: before, after: after)
                key = ""
                step = .done(label: added?.label ?? label, fingerprint: added?.fingerprint ?? AddPoolKey.fingerprint(of: typed))
            case .duplicate(let by):
                if replacing == nil {
                    step = .duplicate(by)
                } else {
                    failure = AddPoolKey.replaceDuplicate(by, pool: pool)
                }
            case .refused(let reason):
                failure = reason
            }
        }
    }
}

/// One thing putting a key in means: its claim in bold, then what follows from it.
private struct FactText: View {
    let fact: AddPoolKey.Fact

    var body: some View {
        (Text(fact.lead).bold().foregroundStyle(Color.primary) + Text(fact.rest))
            .font(.orbitListSubtitle)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - A Codex pool of one's own

/// What a Codex pool of one's own asks the account to do: the device sign-in's three calls, and the
/// pool's two ways out. A press that answers a String? answers why it didn't happen, or nil; the pool on
/// screen is whatever the list last read, so a press that worked shows itself.
struct CodexPoolActions {
    var start: () async throws -> CodexLoginAttempt
    var poll: () async throws -> CodexLoginPoll
    /// Give a sign-in still waiting on its code up, on the server.
    var cancel: () async -> Void
    var signOut: () async -> String?
    var deletePool: () async -> String?
    /// The pools read again: an account just went in.
    var refresh: () async -> Void
}

/// A Codex pool of one's own ChatGPT account (migration 0323), in the web page's blocks: what the pool
/// is and — while it has no account — "Sign in with ChatGPT"; the Account section, its one row the
/// account with its windows and when each resets (signed out: why, and "Sign in again"; a swipe signs
/// it out); and deleting the pool. Only its owner ever sees the pool, so every press is theirs.
struct CodexPoolPageView: View {
    let pool: ProviderPool
    let actions: CodexPoolActions
    var now: Date = Date()

    @State private var signingIn = false
    @State private var signingOut = false
    @State private var confirmingDelete = false
    @State private var notice: String?

    var body: some View {
        Form {
            head
            accountSection
            deleteSection
        }
        .navigationTitle(pool.label)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $signingIn) {
            CodexSignInSheet(pool: pool, actions: actions)
        }
        .confirmationDialog(pool.login.map(CodexLoginPool.signOutTitle) ?? CodexLoginPool.signOut,
                            isPresented: $signingOut, titleVisibility: .visible) {
            Button(CodexLoginPool.signOut, role: .destructive) {
                let login = pool.login
                run(done: CodexLoginPool.signedOut(login)) { await actions.signOut() }
            }
            Button(CodexSignIn.cancel, role: .cancel) {}
        } message: {
            Text(CodexLoginPool.signOutNote)
        }
        .confirmationDialog(CodexLoginPool.deleteTitle(pool), isPresented: $confirmingDelete,
                            titleVisibility: .visible) {
            Button(CodexLoginPool.delete, role: .destructive) {
                run { await actions.deletePool() }
            }
            Button(CodexSignIn.cancel, role: .cancel) {}
        } message: {
            Text(CodexLoginPool.deleteNote)
        }
        .overlay(alignment: .bottom) {
            if let notice {
                Text(notice)
                    .font(.orbitListSubtitle.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                    .transition(.opacity)
            }
        }
        .animation(.default, value: notice)
    }

    /// What the pool is — Codex's mark, "Codex pool", "Just me" — and, while it has no account, the one
    /// press that puts one in.
    private var head: some View {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ProviderMark(provider: "codex", size: 30)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(CodexLoginPool.pageTitle)
                            .font(.headline)
                        Text(CodexLoginPool.justMe)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 4)
                if pool.login == nil {
                    WideButton(title: CodexLoginPool.signIn) { signingIn = true }
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
    }

    private var accountSection: some View {
        Section {
            if let member = pool.members.first, let login = member.login {
                CodexAccountRow(member: member, login: login, now: now) { signingIn = true }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { signingOut = true } label: {
                            Label(CodexLoginPool.signOut, systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    }
            } else {
                Text(CodexLoginPool.noAccount)
                    .foregroundStyle(.secondary)
            }
        } header: {
            PoolSectionHeader(title: CodexLoginPool.accountHeader, trailing: headerNote)
        } footer: {
            Text(CodexLoginPool.accountFooter)
        }
    }

    /// Why nothing can run, or until when — the account's own row says the rest.
    private var headerNote: String? {
        pool.members.contains(where: \.next) ? nil : CodexLoginPool.headline(pool, now: now)
    }

    private var deleteSection: some View {
        Section {
            Button(role: .destructive) { confirmingDelete = true } label: {
                Text(CodexLoginPool.deletePool)
                    .frame(maxWidth: .infinity)
            }
        } footer: {
            Text(CodexLoginPool.deleteNote)
        }
    }

    /// A press, and a line over the page's foot saying how it went: why it didn't go through, or — for a
    /// press whose effect isn't on screen by itself — `done`.
    private func run(done: String? = nil, _ press: @escaping () async -> String?) {
        Task {
            if let failure = await press() {
                show(failure)
            } else if let done {
                show(done)
            }
        }
    }

    private func show(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(3))
            if notice == text { notice = nil }
        }
    }
}

/// The ChatGPT account: its email and plan, where it stands, each of its windows with when it resets —
/// and, once OpenAI signed it out, why and the press that signs it in again.
private struct CodexAccountRow: View {
    let member: PoolMember
    let login: CodexLogin
    let now: Date
    let signInAgain: () -> Void

    var body: some View {
        let status = ProviderPools.memberStatus(member, now: now)
        let windows = CodexLoginPool.windows(login)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ProviderMark(provider: "codex", size: 28)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(member.label)
                        .font(.headline)
                        .lineLimit(1)
                    Text(CodexLoginPool.line(login))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                    Text(status.label)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(PoolTone.color(status.tone))
                    if member.state == .signedOut {
                        Text(CodexLoginPool.signedOutReason)
                            .font(.orbitLabel)
                            .foregroundStyle(PoolTone.color(.danger))
                            .padding(.top, 2)
                        Button(CodexLoginPool.signInAgain, action: signInAgain)
                            .buttonStyle(.borderedProminent)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                            .padding(.top, 7)
                    }
                }
                Spacer(minLength: 0)
            }
            if windows.isEmpty {
                Text(CodexLoginPool.noQuota)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 40)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(windows) { row in
                        CodexWindowRow(row: row, resets: CodexLoginPool.resets(row, now: now))
                    }
                }
                .padding(.leading, 40)
            }
        }
        .padding(.vertical, 4)
    }
}

/// One window of the account's quota: its name and how much of it is used, the gauge across the row,
/// and when it resets.
private struct CodexWindowRow: View {
    let row: PlanUsageRow
    let resets: String?

    var body: some View {
        let tint = row.percent >= 90 ? PoolTone.color(.warning) : Color.accentColor
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.label)
                    .font(.orbitLabel.weight(.semibold))
                Spacer(minLength: 8)
                Text(verbatim: "\(row.percent)%")
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Capsule()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 5)
                .overlay(alignment: .leading) {
                    GeometryReader { geo in
                        Capsule()
                            .fill(tint)
                            .frame(width: geo.size.width * CGFloat(row.percent) / 100, height: 5)
                    }
                }
            if let resets {
                Text(resets)
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// "Sign in with ChatGPT": what signing in means (and the warning that stays: an account is one
/// person's), then the page to open and the one-time code — copied with a tap — while the sheet asks the
/// server every couple of seconds whether it was approved, then the account. Closing it before the code
/// was approved gives the sign-in up on the server.
struct CodexSignInSheet: View {
    let pool: ProviderPool
    let actions: CodexPoolActions

    @State private var step: CodexSignIn.Step
    @State private var starting = false
    /// A sign-in the server is running for this sheet: what closing it has to give up.
    @State private var live = false
    @State private var copied = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    init(pool: ProviderPool, actions: CodexPoolActions, step: CodexSignIn.Step = .consent) {
        self.pool = pool
        self.actions = actions
        _step = State(initialValue: step)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(CodexSignIn.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { close() } label: {
                            Image(systemName: "xmark")
                        }
                        .accessibilityLabel(CodexSignIn.cancel)
                    }
                }
        }
        .presentationDragIndicator(.visible)
        .task(id: waitingOn) {
            guard waitingOn != nil else { return }
            await waitForApproval()
        }
        .onDisappear { giveUp() }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .consent:
            consent
        case .code(let url, let code, let expiresAt):
            codeStep(url: url, code: code, expiresAt: expiresAt)
        case .done(let account):
            done(account)
        case .expired:
            ending(icon: "exclamationmark.circle.fill", title: CodexSignIn.expiredTitle,
                   detail: CodexSignIn.expiredDetail, retry: CodexSignIn.newCode)
        case .failed(let reason):
            ending(icon: "exclamationmark.circle.fill", title: CodexSignIn.failedTitle,
                   detail: CodexSignIn.sentence(reason), retry: CodexSignIn.tryAgain)
        case .duplicate:
            ending(icon: "exclamationmark.circle.fill", title: CodexSignIn.duplicateTitle(pool),
                   detail: CodexSignIn.duplicateDetail, retry: nil)
        case .taken:
            ending(icon: "exclamationmark.circle.fill", title: CodexSignIn.takenTitle(pool),
                   detail: CodexSignIn.takenDetail(pool.login), retry: CodexSignIn.newCode)
        }
    }

    // MARK: steps

    /// What signing in means: whose it is, where the sign-in stays, that it can be signed out — and that
    /// an account is not to be shared.
    private var consent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                lead
                    .padding(.horizontal, 24)
                    .padding(.top, 6)
                    .padding(.bottom, 12)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(CodexSignIn.facts(pool).enumerated()), id: \.offset) { index, fact in
                        if index > 0 {
                            Divider().padding(.leading, 16)
                        }
                        CodexFactText(fact: fact)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 11)
                    }
                }
                .background(Color(uiColor: .secondarySystemGroupedBackground),
                            in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .padding(.horizontal, 16)
                (Text("⚠︎ ") + Text(CodexSignIn.risk.lead).bold() + Text(CodexSignIn.risk.rest))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(PoolTone.color(.warning))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                WideButton(title: CodexSignIn.start, busy: starting) { start() }
                    .disabled(starting)
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
            }
            .padding(.bottom, 24)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// The lead: signing in for the first time, or — the pool's account signed out — as that account.
    private var lead: Text {
        if CodexSignIn.isAgain(pool) {
            return Text(CodexSignIn.againLeadPrefix(pool.login)) + Text(pool.label).bold()
                + Text(CodexSignIn.againLeadSuffix)
        }
        return Text(CodexSignIn.leadPrefix) + Text(pool.label).bold() + Text(CodexSignIn.leadSuffix)
    }

    /// The page to open (and its address), what to do there, the code, and the wait.
    private func codeStep(url: String, code: String, expiresAt: String) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        if let link = URL(string: url) { openURL(link) }
                    } label: {
                        Label(CodexSignIn.openPage, systemImage: "arrow.up.forward.square")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: 14))
                    Text(url)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity)
                }
                instruction
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                Button {
                    PlatformPasteboard.copyString(code)
                    PlatformHaptics.success()
                    copied = true
                } label: {
                    VStack(spacing: 8) {
                        Text(code)
                            .font(.orbitCode)
                            .tracking(2)
                            .foregroundStyle(Color.primary)
                        Label(copied ? CodexSignIn.copied : CodexSignIn.copyCode,
                              systemImage: copied ? "checkmark" : "doc.on.doc")
                            .font(.orbitLabel)
                            .foregroundStyle(Color.accentColor)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color(uiColor: .secondarySystemGroupedBackground),
                                in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(CodexSignIn.copyCode)
                HStack(spacing: 8) {
                    ProgressView()
                    Text(CodexSignIn.waiting)
                        .font(.orbitListSubtitle)
                }
                if let expiry = CodexSignIn.expiry(expiresAt) {
                    Text(expiry)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                Button(CodexSignIn.cancel) { close() }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 4)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// What to do on the page: sign in — as the account signed out, when signing it in again — and
    /// enter the code.
    private var instruction: Text {
        if CodexSignIn.isAgain(pool), let email = pool.login?.email {
            return Text(CodexSignIn.enterCodeAsPrefix) + Text(email).bold() + Text(CodexSignIn.enterCodeAsSuffix)
        }
        return Text(CodexSignIn.enterCode)
    }

    /// It went in: the account, as the pool now holds it.
    private func done(_ account: CodexLogin?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(PoolTone.color(.success))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(CodexSignIn.doneTitle(account, pool: pool))
                            .font(.headline)
                        Text(CodexSignIn.doneDetail)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                if let account {
                    HStack(spacing: 12) {
                        ProviderMark(provider: "codex", size: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(CodexLoginPool.name(account))
                                .font(.headline)
                            Text(CodexSignIn.doneRow(account))
                                .font(.orbitLabel)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .secondarySystemGroupedBackground),
                                in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                }
                WideButton(title: CodexSignIn.done) { dismiss() }
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// Any other way it ended: why, and — unless the pool already runs on that account — a new code.
    private func ending(icon: String, title: String, detail: String, retry: String?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: icon)
                        .font(.title2)
                        .foregroundStyle(PoolTone.color(.warning))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title)
                            .font(.headline)
                        Text(detail)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                if let retry {
                    WideButton(title: retry, busy: starting) { start() }
                        .disabled(starting)
                }
                Button(CodexSignIn.close) { close() }
                    .frame(maxWidth: .infinity)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    // MARK: talking to the server

    /// The code being waited on, if any: what the approval poll is keyed by.
    private var waitingOn: String? {
        if case .code(_, let code, _) = step { return code }
        return nil
    }

    private func start() {
        starting = true
        copied = false
        Task {
            do {
                let attempt = try await actions.start()
                live = true
                step = .code(url: attempt.verificationUrl, code: attempt.userCode, expiresAt: attempt.expiresAt)
            } catch {
                step = CodexSignIn.step(afterStartFailure: error)
            }
            starting = false
        }
    }

    /// Ask every couple of seconds until the answer is one the sheet moves on for.
    private func waitForApproval() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: CodexSignIn.pollInterval)
            if Task.isCancelled { return }
            var next: CodexSignIn.Step?
            do {
                next = CodexSignIn.step(after: try await actions.poll())
            } catch {
                next = CodexSignIn.step(afterPollFailure: error)
            }
            if Task.isCancelled { return }
            guard let next else { continue }
            live = false
            if case .done = next { await actions.refresh() }
            step = next
            return
        }
    }

    private func close() {
        giveUp()
        dismiss()
    }

    /// Leaving before the code was approved gives the sign-in up on the server.
    private func giveUp() {
        guard live else { return }
        live = false
        Task { await actions.cancel() }
    }
}

/// One thing signing in means: its claim in bold, then what follows from it.
private struct CodexFactText: View {
    let fact: CodexSignIn.Fact

    var body: some View {
        (Text(fact.lead).bold().foregroundStyle(Color.primary) + Text(fact.rest))
            .font(.orbitListSubtitle)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - An account pool

/// An account pool's page — the user's own Claude subscriptions under one name — read-only here: which
/// account the next session starts on, and where each one stands. Adding or taking out an account is
/// a key's business, which happens on the web.
struct AccountPoolPageView: View {
    let pool: ProviderPool
    var now: Date = Date()

    var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    ProviderMark(provider: "claude", size: 30)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ProviderPools.pageTitle)
                            .font(.headline)
                        Text(ProviderPools.pageSubtitle(pool))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 4)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            }
            Section {
                ForEach(pool.members) { member in
                    AccountRow(member: member, now: now)
                }
            } header: {
                PoolSectionHeader(title: ProviderPools.accountsHeader, trailing: ProviderPools.headline(pool, now: now))
            } footer: {
                Text(ProviderPools.accountsFooter + " " + ProvidersOverview.editOnWeb)
            }
        }
        .navigationTitle(pool.label)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// One account of a pool: its mark and name, where it stands, and the window its row's gauge reads.
private struct AccountRow: View {
    let member: PoolMember
    let now: Date

    var body: some View {
        let status = ProviderPools.memberStatus(member, now: now)
        let quota = ProviderPools.memberQuota(member)
        HStack(alignment: .top, spacing: 12) {
            ProviderMark(provider: member.slug, size: 28, brandKey: member.presetSlug, label: member.label)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(member.label)
                        .font(.headline)
                        .lineLimit(1)
                    if member.next {
                        PoolChip(text: SharedPoolPage.nextChip)
                    }
                }
                Text(status.label)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(PoolTone.color(status.tone))
            }
            Spacer(minLength: 8)
            if let quota {
                // The percent over the gauge, as a member's share is drawn; the window it reads under it,
                // so a long account name keeps the row's width.
                VStack(alignment: .trailing, spacing: 6) {
                    Text(verbatim: "\(quota.percent)%")
                        .font(.orbitListSubtitle)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    PoolGaugeBar(percent: quota.percent,
                                 tint: quota.percent >= 90 ? PoolTone.color(.warning) : Color.accentColor)
                    Text(quota.label)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 3)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Parts

/// A section's heading with a few words at its far end ("Next: orbit-org-1").
private struct PoolSectionHeader: View {
    let title: String
    let trailing: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            SettingsHeader(title)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .textCase(nil)
                    .lineLimit(1)
            }
        }
    }
}

/// A small capitalised tag: NEXT, ADMIN — and SHARED, in the brand colour.
private struct PoolChip: View {
    let text: String
    var brand = false

    var body: some View {
        Text(text)
            .font(.orbitMeta.weight(.bold))
            .foregroundStyle(brand ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(brand ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.065),
                        in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

/// A person: their initial on the colour they wear across the pool.
private struct PoolAvatar: View {
    let name: String
    let hex: String
    var size: CGFloat = 32

    var body: some View {
        Circle()
            .fill(PoolTone.hex(hex))
            .frame(width: size, height: size)
            .overlay {
                Text(SharedPoolPage.initial(name))
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(.white)
            }
    }
}

/// A thin gauge, 0…100.
private struct PoolGaugeBar: View {
    let percent: Int
    let tint: Color

    var body: some View {
        Capsule()
            .fill(Color.primary.opacity(0.08))
            .frame(width: 96, height: 5)
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(tint)
                    .frame(width: 96 * CGFloat(min(100, max(0, percent))) / 100, height: 5)
            }
    }
}

/// A full-width prominent press: "Add a key", "Continue", "Add key", "Done".
private struct WideButton: View {
    let title: String
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Text(title)
                    .font(.headline)
                    .opacity(busy ? 0 : 1)
                if busy {
                    ProgressView()
                        .tint(.white)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 14))
    }
}

/// The colours a pool's status words and people are drawn in: web's tag colours, in the effect mock's
/// inks on light (system green/orange/red on their own washes read too faint) and the system colours on
/// dark.
enum PoolTone {
    static func color(_ tone: PoolStatus.Tone) -> Color {
        switch tone {
        case .success: return Color(light: Color(red: 0.141, green: 0.541, blue: 0.239), dark: .green)   // #248A3D
        case .brand: return .accentColor
        case .warning: return Color(light: Color(red: 0.702, green: 0.353, blue: 0), dark: .orange)      // #B35A00
        case .danger: return Color(light: Color(red: 0.788, green: 0.149, blue: 0.106), dark: .red)      // #C9261B
        case .neutral: return .secondary
        }
    }

    static func hex(_ hex: String) -> Color {
        guard let c = TagChipColor.components(hex: hex) else { return .gray }
        return Color(red: c.red, green: c.green, blue: c.blue)
    }
}
#endif
