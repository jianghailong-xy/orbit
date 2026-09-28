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
                            PoolRowLabel(engine: "claude", title: pool.label, line: nil,
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
/// key is taken out with a swipe, and a refused one is replaced from its row), its people, its two
/// rules — each switch its own section, its sentence the footer, and only an admin's to change — and
/// deleting the pool (an admin) or leaving it (anyone else).
struct SharedPoolPageView: View {
    let pool: SharedPool
    let actions: SharedPoolActions
    var now: Date = Date()

    @State private var sheet: SharedPoolSheet?
    @State private var removing: SharedPoolKey?
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
        .confirmationDialog(removing.map { SharedPoolPage.removeTitle($0, in: pool) } ?? "",
                            isPresented: removingAsked, titleVisibility: .visible, presenting: removing) { key in
            Button(SharedPoolPage.removeFromPool, role: .destructive) {
                run { await actions.removeKey(key) }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        }
        .confirmationDialog(isAdmin ? SharedPoolPage.deleteTitle(pool) : SharedPoolPage.leaveTitle(pool),
                            isPresented: $confirmingExit, titleVisibility: .visible) {
            Button(isAdmin ? SharedPoolPage.deletePool : SharedPoolPage.leavePool, role: .destructive) {
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
        .alert(SharedPoolPage.addMembers, isPresented: $addingPerson) {
            TextField(SharedPoolPage.email, text: $email)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button(SharedPoolPage.add) {
                let typed = email
                run { await actions.addPerson(typed) }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: {
            Text(SharedPoolPage.addMembersPrompt)
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
                    Button { sheet = .add } label: {
                        Text(SharedPoolPage.addKey)
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: 14))
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
    }

    private var keysSection: some View {
        let next = SharedPoolPage.nextKey(pool)
        return Section {
            if pool.keys.isEmpty {
                Text(SharedPoolPage.noKeys)
                    .foregroundStyle(.secondary)
            }
            ForEach(pool.keys) { key in
                PoolKeyRow(key: key, pool: pool, now: now, next: key.id == next?.id) {
                    sheet = .replace(key)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if SharedPoolPage.canRemove(key, in: pool) {
                        Button(role: .destructive) { removing = key } label: {
                            Label(SharedPoolPage.removeKey, systemImage: "trash")
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
            PoolSectionHeader(title: SharedPoolPage.keysHeader, trailing: next.map(SharedPoolPage.nextLine))
        } footer: {
            Text(SharedPoolPage.keysFooter)
        }
    }

    private var peopleSection: some View {
        Section {
            ForEach(pool.people) { person in
                PoolPersonRow(person: person, pool: pool)
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
                await actions.replaceKey(refused, key)
            }
        }
    }

    // MARK: presses

    private var removingAsked: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }

    /// A press, and a line over the page's foot when it didn't go through.
    private func run(_ press: @escaping () async -> String?) {
        Task {
            if let failure = await press() { show(failure) }
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
    let now: Date
    let next: Bool
    let replace: () -> Void

    var body: some View {
        let status = SharedPoolPage.status(key, in: pool, now: now)
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
                    if next {
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
                                 tint: SharedPoolPage.atCap(key) ? PoolTone.color(.warning) : Color.accentColor)
                }
            }
            .padding(.top, 3)
        }
        .padding(.vertical, 4)
    }
}

/// One person: who, their role, what they put in, and their share of what the pool ran this month.
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
/// replaces a key OpenAI refused: the key alone, its name and limit staying as they were.
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
         name: String? = nil, key: String = "", limit: String = "",
         submit: @escaping (String, String, Int?) async -> AddPoolKey.Outcome) {
        self.pool = pool
        self.replacing = replacing
        self.submit = submit
        _step = State(initialValue: step ?? (replacing == nil ? .consent : .form))
        _name = State(initialValue: name ?? AddPoolKey.suggestedName(for: pool))
        _key = State(initialValue: key)
        _limit = State(initialValue: limit)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(replacing == nil ? AddPoolKey.title : AddPoolKey.replaceTitle)
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
        case .duplicate(let contributor):
            duplicate(contributor: contributor)
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
                        TextField("", text: $limit)
                            .keyboardType(.numberPad)
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
                WideButton(title: replacing == nil ? AddPoolKey.submit : AddPoolKey.replaceTitle,
                           busy: sending) {
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
                HStack(spacing: 12) {
                    PoolAvatar(name: me?.name ?? "", hex: me.map { SharedPoolPage.avatarHex($0.userId, in: pool) } ?? "")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(label)
                            .font(.headline)
                        Text(AddPoolKey.doneRow(me: me?.name ?? "", fingerprint: fingerprint))
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground),
                            in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                WideButton(title: AddPoolKey.done) { dismiss() }
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    /// The same key is in the pool already: whose it is, and why a second copy adds nothing.
    private func duplicate(contributor: String?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(PoolTone.color(.warning))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AddPoolKey.duplicateTitle(pool))
                            .font(.headline)
                        Text(AddPoolKey.duplicateDetail(contributor: contributor))
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
            ? AddPoolKey.canSubmit(name: name, key: key, limit: limit)
            : !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let typed = key
        let label = name.trimmingCharacters(in: .whitespaces)
        let cap = AddPoolKey.shareCap(limit)
        sending = true
        Task {
            let outcome = await submit(label, typed, cap)
            sending = false
            switch outcome {
            case .added(let updated):
                // A replaced key is back in its row on the page underneath; a new one is shown here once.
                guard replacing == nil else { dismiss(); return }
                let fingerprint = AddPoolKey.added(label, in: updated)?.fingerprint ?? AddPoolKey.fingerprint(of: typed)
                key = ""
                step = .done(label: label, fingerprint: fingerprint)
            case .duplicate(let contributor):
                step = .duplicate(contributor: contributor)
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
                VStack(alignment: .trailing, spacing: 6) {
                    Text(verbatim: "\(quota.label) \(quota.percent)%")
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    PoolGaugeBar(percent: quota.percent,
                                 tint: quota.percent >= 90 ? PoolTone.color(.warning) : Color.accentColor)
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
