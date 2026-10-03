#if os(iOS)
import SwiftUI
import OrbitKit

// Settings → Providers and the pool pages its rows open, drawn from what they are handed: the runners,
// pools and keys to list, a pool, and the presses its page makes. Nothing here reads `AppModel` —
// SettingsSheet's pages do, and hand these views the answers — so each page can also be drawn from
// fixtures alone. The words, and what the pages make of a pool's numbers, are OrbitKit's
// (`ProvidersOverview`, `CodexPoolPage`, `WhoCanUseIt`, `SharedPoolPage`, `AddPoolKey`, `ProviderPools`),
// where they are tested.

// MARK: - Providers

/// Settings → Providers: where the account's models come from — the engines signed in on each runner
/// (a row opens that runner, where signing in lives), the pools (a row opens the pool's page), and the
/// account's API keys, which are added and changed on the web.
struct ProvidersOverviewForm: View {
    let runners: [Runner]
    /// The account's own pools — a Codex one with its people and keys read beside its accounts, once they are.
    let pools: [ProviderPool]
    /// The Codex pools the account is in as one of their people.
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
                            CodexPoolRowLabel(pool: SharedPools.asProviderPool(pool))
                        }
                    }
                    ForEach(pools) { pool in
                        NavigationLink(value: NavNode.accountPool(poolID: pool.id)) {
                            if ProviderPools.runsCodex(pool) {
                                CodexPoolRowLabel(pool: pool)
                            } else {
                                PoolRowLabel(engine: "claude", title: pool.label, line: nil,
                                             value: ProvidersOverview.poolSummary(pool))
                            }
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

/// A Codex pool's row, by who reads it (web's `PoolCard` head): its name — SHARED once anybody but its
/// owner can use it — then whose it is and how many keys the reader can run on, or "Just me" and how many
/// of its accounts can run, and at its end the head's gauge, where the reader has one.
private struct CodexPoolRowLabel: View {
    let pool: ProviderPool

    var body: some View {
        let value = ProvidersOverview.codexPoolValue(pool)
        PoolRowLabel(engine: "codex", title: pool.label, shared: ProvidersOverview.isShared(pool),
                     line: ProvidersOverview.codexPoolLine(pool), value: value?.label, valueTone: value?.tone)
    }
}

/// A pool's row: its engine's mark and its name — and a line under it, where it has one — and at its
/// end how many of its accounts a session could start on now, or the gauge a Codex pool's head reads, in
/// that gauge's tone.
private struct PoolRowLabel: View {
    let engine: String
    let title: String
    var shared = false
    let line: String?
    let value: String?
    var valueTone: PoolStatus.Tone? = nil

    var body: some View {
        LabeledContent {
            if let value {
                if let valueTone {
                    Text(value)
                        .foregroundStyle(PoolTone.color(valueTone))
                } else {
                    Text(value)
                }
            }
        } label: {
            HStack(spacing: 12) {
                ProviderMark(provider: engine, size: 26)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(title)
                            .lineLimit(1)
                        if shared {
                            PoolChip(text: CodexPoolPage.sharedChip, brand: true)
                        }
                    }
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

// MARK: - A Codex pool

/// What a Codex pool of one's own asks the account to do about its ChatGPT accounts: the device sign-in's
/// three calls, and signing one out. A press that answers a String? answers why it didn't happen, or nil;
/// the pool on screen is whatever the list last read, so a press that worked shows itself.
struct CodexPoolActions {
    var start: () async throws -> CodexLoginAttempt
    var poll: () async throws -> CodexLoginPoll
    /// Give a sign-in still waiting on its code up, on the server.
    var cancel: () async -> Void
    /// Sign one of its accounts out.
    var signOut: (CodexLogin) async -> String?
    /// The pool read again: an account just went in.
    var refresh: () async -> Void
}

/// What a Codex pool's page asks of its people and its API keys. Each press answers with why it didn't
/// happen, or nil; the pool on screen is whatever the server answered last, so a press that worked shows
/// itself.
struct PoolAccessActions {
    var addKey: (AddPoolKeyRequest) async -> AddPoolKey.Outcome
    /// A new secret for a key OpenAI refused.
    var replaceKey: (SharedPoolKey, String) async -> AddPoolKey.Outcome
    var removeKey: (SharedPoolKey) async -> String?
    /// Its contributor's own switch.
    var switchKey: (SharedPoolKey, Bool) async -> String?
    var setRules: (UpdateSharedPoolRequest) async -> String?
    /// "Share": the emails typed, and whether they may add keys of their own — how it went, in a sentence.
    var share: ([String], Bool) async -> String
    /// Back to Just me: everybody but its owner taken out.
    var keepToSelf: () async -> String?
    var setRole: (SharedPoolPerson, SharedPoolRole) async -> String?
    var removePerson: (SharedPoolPerson) async -> String?
}

/// Which sheet is up over a Codex pool's page.
enum CodexPoolSheet: Identifiable {
    /// "Add account": what kind goes in.
    case choose
    /// "Sign in with ChatGPT": one more account (nil), or one OpenAI signed out going back in.
    case signIn(CodexLogin?)
    case addKey
    /// "Replace key", for one OpenAI refused.
    case replace(SharedPoolKey)
    case share

    var id: String {
        switch self {
        case .choose: return "choose"
        case .signIn(let again): return again.map { "again \($0.fingerprint)" } ?? "sign-in"
        case .addKey: return "add-key"
        case .replace(let key): return "replace-\(key.id)"
        case .share: return "share"
        }
    }
}

/// A Codex pool's page (docs/mocks/account-pool-access/), drawn for whoever reads it (`CodexPoolPage`):
/// what the pool is, whose, and how many of its accounts or keys can run, and the press that puts one in;
/// its Accounts — its owner's ChatGPT accounts (read by everybody in the pool since 2026-10-03, and signed
/// out with its mark or a swipe only by its owner) — then its API keys (switched off or taken out with a
/// swipe, a refused one replaced from its row), each saying whose sessions it runs once the pool is shared;
/// who can use it (`WhoCanUseIt`); and deleting the pool (its owner) or leaving it (anybody else). Every
/// press is the server's to allow.
struct CodexPoolPageView: View {
    let page: CodexPoolPage
    /// What its ChatGPT accounts' presses do: its owner's, on a pool of their own.
    let accountActions: CodexPoolActions?
    /// What its people's and keys' presses do, once they are read.
    let accessActions: PoolAccessActions?
    /// Delete the pool (its owner) or leave it (anybody else).
    let exit: () async -> String?
    var now: Date = Date()

    @State private var sheet: CodexPoolSheet?
    @State private var signingOut: CodexLogin?
    @State private var removingKey: SharedPoolKey?
    @State private var removingPerson: SharedPoolPerson?
    @State private var confirmingJustMine = false
    @State private var confirmingExit = false
    /// The rules just flipped, shown as flipped until the pool the server answers with arrives.
    @State private var membersCanAdd: Bool?
    @State private var membersCanAddAccounts: Bool?
    @State private var notice: String?

    private var pool: ProviderPool { page.pool }
    private var card: WhoCanUseIt? { page.access.map { WhoCanUseIt(pool: $0, accounts: page.accounts) } }

    var body: some View {
        Form {
            head
            accountsSection
            if let card {
                whoCanUseIt(card)
            }
            exitSection
        }
        .navigationTitle(pool.label)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $sheet) { kind in
            sheetView(kind)
        }
        .confirmationDialog(signingOut.map(CodexLoginPool.signOutTitle) ?? CodexLoginPool.signOut,
                            isPresented: asked($signingOut), titleVisibility: .visible, presenting: signingOut) { login in
            Button(CodexLoginPool.signOut, role: .destructive) {
                run(done: CodexLoginPool.signedOut(login)) { await accountActions?.signOut(login) }
            }
            Button(CodexSignIn.cancel, role: .cancel) {}
        } message: { _ in
            Text(CodexLoginPool.signOutNote(pool))
        }
        .confirmationDialog(removingKey.map(SharedPoolPage.removeKeyTitle) ?? "",
                            isPresented: asked($removingKey), titleVisibility: .visible, presenting: removingKey) { key in
            Button(SharedPoolPage.remove, role: .destructive) {
                run(done: SharedPoolPage.removedKey(key)) { await accessActions?.removeKey(key) }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: { _ in
            Text(SharedPoolPage.removeKeyNote)
        }
        .confirmationDialog(removingPerson.flatMap { person in page.access.map { SharedPoolPage.removePersonTitle(person, in: $0) } } ?? "",
                            isPresented: asked($removingPerson), titleVisibility: .visible,
                            presenting: removingPerson) { person in
            Button(SharedPoolPage.remove, role: .destructive) {
                run { await accessActions?.removePerson(person) }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: { _ in
            Text(SharedPoolPage.removePersonNote)
        }
        .confirmationDialog(page.access.map(JustMine.title) ?? "", isPresented: $confirmingJustMine,
                            titleVisibility: .visible) {
            Button(JustMine.confirm, role: .destructive) {
                run { await accessActions?.keepToSelf() }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: {
            if let access = page.access {
                Text(JustMine.cost(access, accounts: page.accounts))
            }
        }
        .confirmationDialog(page.exitTitle, isPresented: $confirmingExit, titleVisibility: .visible) {
            Button(page.exitConfirm, role: .destructive) {
                run { await exit() }
            }
            Button(AddPoolKey.cancel, role: .cancel) {}
        } message: {
            Text(page.outNote)
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
        .onChange(of: page.access) { _, _ in
            membersCanAdd = nil
            membersCanAddAccounts = nil
        }
    }

    // MARK: blocks

    /// What the pool is — Codex's mark, "Codex pool", SHARED once anybody but its owner can use it — whose
    /// it is and how many of its accounts or keys can run, and the press that puts one in, where the reader
    /// has one.
    private var head: some View {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ProviderMark(provider: "codex", size: 30)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(CodexPoolPage.title)
                                .font(.headline)
                            if page.people {
                                PoolChip(text: CodexPoolPage.sharedChip, brand: true)
                            }
                        }
                        (Text(page.who).bold() + Text(page.subtitleRest))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 4)
                if let adding = page.adding {
                    WideButton(title: page.addLabel) { add(adding) }
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
    }

    /// Its accounts, then its keys, under a head that names the one the next session starts on and reads
    /// its tightest window — or, with none to start on, says when or why — and what the reader's sessions
    /// run on, under them.
    private var accountsSection: some View {
        Section {
            if let note = page.emptyNote {
                Text(note)
                    .foregroundStyle(.secondary)
            }
            ForEach(pool.members) { member in
                memberRow(member)
            }
        } header: {
            PoolSectionHeader(title: CodexPoolPage.accountsHeader, count: page.accountsCount,
                              trailing: ProviderPools.headline(pool, now: now), reading: ProviderPools.headGauge(pool))
        } footer: {
            Text(page.howSentence)
        }
    }

    @ViewBuilder private func memberRow(_ member: PoolMember) -> some View {
        if let login = member.login {
            // What THIS reader may do to THIS account (migration 0371): the person who signed it in signs
            // it in again, and with the pool's admins takes it out (web's `actionsFor`). Without the pool's
            // people read — an own pool whose access is not in yet — the page's own presses stand.
            let canSignInAgain = page.access.map { SharedPoolPage.canSignInAgain(login, in: $0) } ?? page.mine
            let canSignOut = page.access.map { SharedPoolPage.canSignOut(login, in: $0) } ?? page.mine
            CodexAccountRow(member: member, login: login, next: CodexLoginPool.showsNext(member, in: pool),
                            tagged: page.tagged, canSignInAgain: canSignInAgain, canSignOut: canSignOut,
                            contributor: contributorName(login), now: now,
                            signInAgain: { sheet = .signIn(login) },
                            signOut: { signingOut = login })
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if canSignOut {
                        Button(role: .destructive) { signingOut = login } label: {
                            Label(CodexLoginPool.signOut, systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    }
                }
        } else if let key = member.key, let access = page.access {
            PoolKeyRow(key: key, pool: access, next: member.next, tagged: page.tagged) {
                sheet = .replace(key)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if SharedPoolPage.canRemove(key, in: access) {
                    Button(role: .destructive) { removingKey = key } label: {
                        Label(SharedPoolPage.remove, systemImage: "trash")
                    }
                }
                if SharedPoolPage.canSwitch(key) {
                    Button {
                        run { await accessActions?.switchKey(key, !key.enabled) }
                    } label: {
                        Label(key.enabled ? SharedPoolPage.disableKey : SharedPoolPage.enableKey,
                              systemImage: key.enabled ? "pause.circle" : "play.circle")
                    }
                    .tint(.gray)
                }
            }
        }
    }

    /// The person who signed an account in, named where the pool's people are read and the account is one
    /// of theirs (web's `contributorOf`).
    private func contributorName(_ login: CodexLogin) -> String? {
        guard let access = page.access, let userId = login.userId else { return nil }
        let key = PublicID.storageKey(userId)
        return access.people.first { PublicID.storageKey($0.userId) == key }?.name
    }

    /// Who can use it: its owner's switch and what it means, each person's row (taken out, or made an admin
    /// on a pool made on the shared pools page, with a swipe), "Add people", whether they may put keys of
    /// their own in, the notice that the ChatGPT accounts run everyone's sessions here, and — shared with
    /// nothing anybody added could run on — what fixes it.
    @ViewBuilder private func whoCanUseIt(_ card: WhoCanUseIt) -> some View {
        Section {
            if card.showsMode {
                VStack(alignment: .leading, spacing: 8) {
                    Picker(WhoCanUseIt.header, selection: mode(card)) {
                        ForEach(WhoCanUseIt.Mode.allCases, id: \.self) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    Text(card.modeHint)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
            ForEach(card.rows) { person in
                PoolPersonRow(person: person, pool: card.pool, line: card.line(person),
                              share: card.ran ? SharedPoolPage.share(person, in: card.pool) : nil)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if card.manages(person) {
                            Button(role: .destructive) { removingPerson = person } label: {
                                Label(SharedPoolPage.removeFromPool, systemImage: "person.badge.minus")
                            }
                            if card.offersRoles {
                                Button {
                                    let role: SharedPoolRole = person.role == .admin ? .member : .admin
                                    run { await accessActions?.setRole(person, role) }
                                } label: {
                                    Label(person.role == .admin ? SharedPoolPage.makeMember : SharedPoolPage.makeAdmin,
                                          systemImage: person.role == .admin ? "person" : "person.badge.key")
                                }
                                .tint(.gray)
                            }
                        }
                    }
            }
            if card.addsPeople {
                Button { sheet = .share } label: {
                    Label(WhoCanUseIt.addPeople, systemImage: "person.badge.plus")
                }
            }
        } header: {
            PoolSectionHeader(title: WhoCanUseIt.header, count: card.count, trailing: card.note)
        }
        if card.showsRule {
            Section {
                Toggle(WhoCanUseIt.ruleTitle, isOn: Binding(
                    get: { membersCanAdd ?? card.pool.membersCanAdd },
                    set: { value in
                        membersCanAdd = value
                        setRule(UpdateSharedPoolRequest(membersCanAdd: value))
                    }))
                // The accounts' own rule, beside the keys' (migration 0371).
                Toggle(WhoCanUseIt.ruleAccountsTitle, isOn: Binding(
                    get: { membersCanAddAccounts ?? card.pool.membersCanAddAccounts },
                    set: { value in
                        membersCanAddAccounts = value
                        setRule(UpdateSharedPoolRequest(membersCanAddAccounts: value))
                    }))
            } footer: {
                VStack(alignment: .leading, spacing: 10) {
                    Text(WhoCanUseIt.ruleHint)
                    Text(WhoCanUseIt.ruleAccountsHint)
                    if card.showsFoot {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: "lock.fill")
                                .imageScale(.small)
                            (Text(WhoCanUseIt.footLead).bold() + Text(WhoCanUseIt.footRest))
                        }
                    }
                }
            }
        }
        if let warning = card.warning {
            Section {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(PoolTone.color(.warning))
                    VStack(alignment: .leading, spacing: 8) {
                        (Text(warning.lead).bold().foregroundStyle(Color.primary) + Text(warning.rest))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                        Button(WhoCanUseIt.addAPIKey) { sheet = .addKey }
                            .buttonStyle(.borderedProminent)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                    }
                }
                .padding(.vertical, 4)
                .listRowBackground(Color.orange.opacity(0.14))
            }
        }
    }

    private var exitSection: some View {
        Section {
            Button(role: .destructive) { confirmingExit = true } label: {
                Text(page.exitLabel)
                    .frame(maxWidth: .infinity)
            }
        } footer: {
            Text(page.outNote)
        }
    }

    @ViewBuilder private func sheetView(_ kind: CodexPoolSheet) -> some View {
        switch kind {
        case .choose:
            AddAccountSheet(pool: pool, accounts: page.logins.count, mine: page.mine) { chosen in
                sheet = chosen == .key ? CodexPoolSheet.addKey : .signIn(nil)
            }
        case .signIn(let again):
            if let accountActions {
                CodexSignInSheet(pool: page.own ?? pool, mine: page.mine, again: again, actions: accountActions)
            }
        case .addKey:
            if let access = page.access, let accessActions {
                AddPoolKeySheet(pool: access) { name, key, cap in
                    await accessActions.addKey(AddPoolKeyRequest(label: name, apiKey: key, shareCap: cap))
                }
            }
        case .replace(let refused):
            if let access = page.access, let accessActions {
                AddPoolKeySheet(pool: access, replacing: refused) { _, key, _ in
                    let outcome = await accessActions.replaceKey(refused, key)
                    if case .added = outcome { show(AddPoolKey.replaced(refused, in: access)) }
                    return outcome
                }
            }
        case .share:
            if let access = page.access, let accessActions {
                SharePoolSheet(pool: access, accounts: page.accounts, share: { emails, canAdd in
                    show(await accessActions.share(emails, canAdd))
                }, addKeyFirst: { sheet = .addKey })
            }
        }
    }

    // MARK: presses

    private func add(_ adding: CodexPoolPage.Adding) {
        switch adding {
        case .choose: sheet = .choose
        case .signIn: sheet = .signIn(nil)
        case .key: sheet = .addKey
        }
    }

    /// The switch says the pool's people: a press opens what changes them — Share, or the question before
    /// going back to Just me — and the pool's next read moves it.
    private func mode(_ card: WhoCanUseIt) -> Binding<WhoCanUseIt.Mode> {
        Binding(get: { card.mode }, set: { mode in
            guard mode != card.mode else { return }
            if mode == .withPeople {
                sheet = .share
            } else {
                confirmingJustMine = true
            }
        })
    }

    /// Whether the dialog `value` is for is up: closing it lets the value go.
    private func asked<Value>(_ value: Binding<Value?>) -> Binding<Bool> {
        Binding(get: { value.wrappedValue != nil }, set: { if !$0 { value.wrappedValue = nil } })
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

    /// The rule, flipped back on screen when the server didn't take it.
    private func setRule(_ change: UpdateSharedPoolRequest) {
        Task {
            guard let failure = await accessActions?.setRules(change) else { return }
            membersCanAdd = nil
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

/// Whose sessions a credential of a shared pool runs, said on its owner's page (web's `RunsFor`): since
/// 2026-10-03 a ChatGPT account runs everybody's as a key does — a rule rather than a setting. The mark and
/// its words are one unit on the line: where the line wraps, they go to the next one together.
private func runsFor() -> Text {
    let words = CodexPoolPage.everyoneHere.replacingOccurrences(of: " ", with: "\u{00A0}")
    return (Text(Image(systemName: "person.2.fill")) + Text(verbatim: "\u{00A0}")
        + Text(verbatim: words))
        .foregroundStyle(PoolTone.color(.success))
}

/// One key: whose it is and its name, where it stands, what the others spent on it against its cap —
/// once its owner shares the pool, that it runs everybody's sessions — and, when OpenAI refused it, why,
/// and (to its contributor or an admin) the press that replaces it.
private struct PoolKeyRow: View {
    let key: SharedPoolKey
    let pool: SharedPool
    /// The next session the reader starts runs on it.
    let next: Bool
    /// It says whose sessions it runs: everybody's.
    let tagged: Bool
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
                    if next {
                        PoolChip(text: SharedPoolPage.nextChip)
                    }
                }
                (Text(SharedPoolPage.keyLine(key)) + (tagged ? Text(verbatim: " · ") + runsFor() : Text(verbatim: "")))
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

/// One person: who, OWNER or ADMIN, what their sessions run on — said to its owner — the keys they put in
/// and the sessions they started, and their share of this month's API key use once anything ran on it.
private struct PoolPersonRow: View {
    let person: SharedPoolPerson
    let pool: SharedPool
    let line: WhoCanUseIt.PersonLine
    /// Their share of this month's API key use, 0…100 — nil while nothing has run on the pool's keys.
    let share: Int?

    var body: some View {
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
                    if person.creator {
                        PoolChip(text: WhoCanUseIt.ownerChip)
                    } else if person.role == .admin {
                        PoolChip(text: SharedPoolPage.adminChip)
                    }
                }
                meta
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if let share {
                VStack(alignment: .trailing, spacing: 6) {
                    Text(verbatim: "\(share)%")
                        .font(.orbitListSubtitle)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    PoolGaugeBar(percent: share, tint: Color.accentColor)
                }
                .padding(.top, 3)
            }
        }
        .padding(.vertical, 4)
    }

    /// What their sessions run on — the pool's owner's own on everything, a little darker — then the rest.
    private var meta: Text {
        guard let runs = line.runs else { return Text(line.rest) }
        let rule = line.everything ? Text(runs).foregroundStyle(Color.primary.opacity(0.75)) : Text(runs)
        return rule + Text(" · " + line.rest)
    }
}

/// "Add account" (03-1): what kind goes in — another ChatGPT account of the owner's, which runs their own
/// sessions alone, or an OpenAI API key, which runs everybody's — said on the choice rather than found out
/// after. Continue goes on to that kind's own sheet.
private struct AddAccountSheet: View {
    let pool: ProviderPool
    /// How many ChatGPT accounts the pool holds already.
    let accounts: Int
    /// The reader is the pool's owner: an account may be shared with others yet, or already is.
    let mine: Bool
    let onContinue: (CodexPoolPage.Kind.ID) -> Void

    @State private var kind = CodexPoolPage.Kind.ID.chatGPT
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(CodexPoolPage.kinds(accounts: accounts, mine: mine)) { option in
                        Button { kind = option.id } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: kind == option.id ? "largecircle.fill.circle" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(kind == option.id ? Color.accentColor : Color.secondary)
                                if option.id == .chatGPT {
                                    ProviderMark(provider: "codex", size: 26)
                                } else {
                                    Image(systemName: "key.fill")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .frame(width: 26, height: 26)
                                        .background(Color.primary.opacity(0.065),
                                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                                }
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(option.title)
                                        .font(.headline)
                                        .foregroundStyle(Color.primary)
                                    (Text(option.lead + " ") + Text(option.bold).bold().foregroundStyle(Color.primary)
                                        + Text(option.rest))
                                        .font(.orbitListSubtitle)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 4)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(kind == option.id ? .isSelected : [])
                    }
                }
                Section {
                    WideButton(title: AddPoolKey.continueLabel) { onContinue(kind) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                }
            }
            .navigationTitle(CodexPoolPage.addAccountTitle(pool.label))
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
}

/// "Share <pool>" (03-4): who to add, by the email of their Orbit account, and — before they are in —
/// what that means, with whether they may put keys of their own in; with no key in the pool yet, that they
/// couldn't start a session on it, and adding one first.
private struct SharePoolSheet: View {
    let pool: SharedPool
    /// How many ChatGPT accounts of its owner's the pool holds — nil for one made on the shared pools page.
    let accounts: Int?
    /// Everybody typed, and whether they may add keys of their own.
    let share: ([String], Bool) async -> Void
    let addKeyFirst: () -> Void

    @State private var typed = ""
    @State private var canAdd: Bool
    @State private var sending = false
    @Environment(\.dismiss) private var dismiss

    init(pool: SharedPool, accounts: Int?, share: @escaping ([String], Bool) async -> Void,
         addKeyFirst: @escaping () -> Void) {
        self.pool = pool
        self.accounts = accounts
        self.share = share
        self.addKeyFirst = addKeyFirst
        _canAdd = State(initialValue: pool.membersCanAdd)
    }

    private var emails: [String] { SharePool.emails(typed) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(SharePool.emailsLabel, text: $typed, axis: .vertical)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                if SharePool.empty(pool, accounts: accounts) {
                    Section {
                        let risk = SharePool.risk(pool, accounts: accounts)
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(PoolTone.color(.warning))
                            (Text(risk.lead).bold().foregroundStyle(Color.primary) + Text(risk.rest))
                                .font(.orbitListSubtitle)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                        .listRowBackground(Color.orange.opacity(0.14))
                    }
                    Section {
                        WideButton(title: SharePool.addKeyFirst) { addKeyFirst() }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                            .listRowSeparator(.hidden)
                        Button(SharePool.shareAnyway) { send() }
                            .disabled(emails.isEmpty || sending)
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                } else {
                    Section {
                        ForEach(Array(SharePool.facts(pool, accounts: accounts).enumerated()), id: \.offset) { _, fact in
                            FactText(fact: fact)
                                .padding(.vertical, 2)
                        }
                    }
                    Section {
                        Toggle(WhoCanUseIt.ruleTitle, isOn: $canAdd)
                    }
                    Section {
                        WideButton(title: SharePool.share, busy: sending) { send() }
                            .disabled(emails.isEmpty || sending)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                    }
                }
            }
            .navigationTitle(SharePool.title(pool))
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

    private func send() {
        let typed = emails
        let canAdd = canAdd
        sending = true
        Task {
            await share(typed, canAdd)
            sending = false
            dismiss()
        }
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

// MARK: - A Codex pool's ChatGPT accounts

/// One of the pool's ChatGPT accounts: its email and plan — NEXT, when it is the one the next session
/// starts on among several; once the pool is shared, that it runs everybody's sessions (2026-10-03) —
/// where it stands, and each of its windows with when it resets; once OpenAI signed it out, why and — to
/// the pool's owner alone, whose the sign-in is — the press that signs it in again, and the sign-out mark.
private struct CodexAccountRow: View {
    let member: PoolMember
    let login: CodexLogin
    let next: Bool
    /// It says whose sessions it runs: everybody's.
    let tagged: Bool
    /// The reader signed this account in: only they can sign it in again (migration 0371) — nobody, an
    /// admin included, has a credential for it.
    let canSignInAgain: Bool
    /// The reader may take it out: the person who signed it in, or the pool's admins.
    let canSignOut: Bool
    /// Who signed it in, where the pool's people are read.
    let contributor: String?
    let now: Date
    let signInAgain: () -> Void
    let signOut: () -> Void

    var body: some View {
        let status = ProviderPools.memberStatus(member, now: now)
        let windows = CodexLoginPool.windows(login)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ProviderMark(provider: "codex", size: 28)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(member.label)
                            .font(.headline)
                            .lineLimit(1)
                        if next {
                            PoolChip(text: SharedPoolPage.nextChip)
                        }
                    }
                    (Text(CodexLoginPool.line(login, contributor: contributor))
                        + (tagged ? Text(verbatim: " · ") + runsFor() : Text(verbatim: "")))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                    Text(status.label)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(PoolTone.color(status.tone))
                    if member.state == .signedOut {
                        Text(canSignInAgain
                            ? CodexLoginPool.signedOutReason
                            : CodexLoginPool.signedOutReasonNotYours(contributor))
                            .font(.orbitLabel)
                            .foregroundStyle(PoolTone.color(.danger))
                            .padding(.top, 2)
                        if canSignInAgain {
                            Button(CodexLoginPool.signInAgain, action: signInAgain)
                                .buttonStyle(.borderedProminent)
                                .buttonBorderShape(.capsule)
                                .controlSize(.small)
                                .padding(.top, 7)
                        }
                    }
                }
                Spacer(minLength: 0)
                // Signing this account out: the mark rests in the row's grey — red on a row that is fine
                // reads as something wrong with it — and asks before it does anything. The tint, not a
                // style on the image: a borderless button draws its label in its tint. Offered to whoever
                // the pool admits (the person who signed it in, and its admins) and applied per row.
                if canSignOut {
                    Button(action: signOut) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .tint(Color.secondary)
                    .accessibilityLabel(CodexLoginPool.signOutLabel(login))
                }
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
/// server every couple of seconds whether it was approved, then the account and how many the pool holds
/// now. One account per sign-in: the pool's first, one more beside those, or — `again` — one OpenAI
/// signed out going back in. Closing it before the code was approved gives the sign-in up on the server.
struct CodexSignInSheet: View {
    let pool: ProviderPool
    /// The reader is the pool's owner — the page drawn for them — rather than one of the people it is
    /// shared with, whose own account goes in for everyone here too (migration 0371).
    var mine: Bool = true
    /// The account a sign-in again is for, once OpenAI signed it out; nil to add one more.
    let again: CodexLogin?
    let actions: CodexPoolActions

    @State private var step: CodexSignIn.Step
    @State private var starting = false
    /// What this sheet has going on the server — a reference, so a start that answers after the sheet
    /// closed still reads that it closed.
    @State private var run = CodexSignInRun()
    @State private var copied = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    init(pool: ProviderPool, mine: Bool = true, again: CodexLogin? = nil, actions: CodexPoolActions,
         step: CodexSignIn.Step = .consent) {
        self.pool = pool
        self.mine = mine
        self.again = again
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
        case .done(let account, let logins):
            done(account, logins: logins)
        case .expired:
            ending(icon: "exclamationmark.circle.fill", title: CodexSignIn.expiredTitle,
                   detail: CodexSignIn.expiredDetail, retry: CodexSignIn.newCode)
        case .failed(let reason):
            ending(icon: "exclamationmark.circle.fill", title: CodexSignIn.failedTitle,
                   detail: CodexSignIn.sentence(reason), retry: CodexSignIn.tryAgain)
        case .duplicate(let email):
            // A new code, for a different account.
            ending(icon: "exclamationmark.circle.fill", title: CodexSignIn.duplicateTitle(pool),
                   detail: CodexSignIn.duplicateDetail(email), retry: CodexSignIn.newCode)
        }
    }

    // MARK: steps

    /// Adding one more to a pool that already runs on an account of its owner's own: the notice says what
    /// the pool runs on now, that this account stays theirs alone even once the pool is shared, and what
    /// the pool does without it.
    private var addsAnother: Bool { CodexSignIn.addsAnother(pool, again: again) }

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
                    let facts = addsAnother
                        ? CodexSignIn.anotherFacts(pool, mine: mine)
                        : CodexSignIn.facts(pool, mine: mine)
                    ForEach(Array(facts.enumerated()), id: \.offset) { index, fact in
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
                let risk = addsAnother ? CodexSignIn.anotherRisk : CodexSignIn.risk(mine: mine)
                (Text("⚠︎ ") + Text(risk.lead).bold() + Text(risk.rest))
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

    /// The lead: the pool's first account, one more beside those it runs on, or — one OpenAI signed out
    /// — that account again.
    private var lead: Text {
        if let again {
            return Text(CodexSignIn.againLeadPrefix(again)) + Text(pool.label).bold()
                + Text(CodexSignIn.againLeadSuffix)
        }
        if addsAnother {
            return Text(CodexSignIn.anotherLeadPrefix) + Text(pool.label).bold()
                + Text(CodexSignIn.anotherLeadSuffix(pool))
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
        if let email = again?.email {
            return Text(CodexSignIn.enterCodeAsPrefix) + Text(email).bold() + Text(CodexSignIn.enterCodeAsSuffix)
        }
        return Text(CodexSignIn.enterCode)
    }

    /// It went in: the account, as the pool now holds it, and how many accounts that makes.
    private func done(_ account: CodexLogin?, logins: [CodexLogin]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(PoolTone.color(.success))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(CodexSignIn.doneTitle(account, pool: pool))
                            .font(.headline)
                        Text(CodexSignIn.doneDetail(pool, logins: logins))
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

    /// Any other way it ended: why, and a new code — after the same account twice, for a different one.
    private func ending(icon: String, title: String, detail: String, retry: String) -> some View {
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
                WideButton(title: retry, busy: starting) { start() }
                    .disabled(starting)
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
        let run = run
        Task {
            do {
                let attempt = try await actions.start()
                // Closed while the code was on its way: give the sign-in it started up rather than show it.
                if run.closed {
                    await actions.cancel()
                    return
                }
                run.live = true
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
            run.live = false
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
        run.closed = true
        guard run.live else { return }
        run.live = false
        Task { await actions.cancel() }
    }
}

/// What a "Sign in with ChatGPT" sheet has going on the server, read by the presses it started even once
/// the sheet is gone. Only ever touched from the sheet's own (main-thread) presses.
private final class CodexSignInRun {
    /// A sign-in the server is running for the sheet: what closing it has to give up.
    var live = false
    /// The sheet closed: a start still on its way gives its sign-in up instead of showing it.
    var closed = false
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
                        Text(ProviderPools.availability(pool))
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
                PoolSectionHeader(title: ProviderPools.accountsHeader, trailing: ProviderPools.headline(pool, now: now),
                                  reading: ProviderPools.headGauge(pool))
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

/// A section's heading — with how many it holds, where that is said ("Accounts 2") — and a few words at
/// its far end ("Next: orbit-org-1"), then the head's gauge where it has one ("Weekly 97%", orange near
/// its limit), which keeps its width while the words before it give way.
private struct PoolSectionHeader: View {
    let title: String
    var count: Int? = nil
    let trailing: String?
    var reading: PoolStatus? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            SettingsHeader(title)
            if let count {
                Text(verbatim: "\(count)")
                    .font(.orbitLabel)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .textCase(nil)
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)
            }
            if let reading {
                Text(reading.label)
                    .font(.orbitLabel.weight(reading.tone == .warning ? .semibold : .regular))
                    .foregroundStyle(PoolTone.color(reading.tone))
                    .monospacedDigit()
                    .textCase(nil)
                    .lineLimit(1)
                    .fixedSize()
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
