#if os(iOS)
import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import OrbitKit

// Settings on iOS: a sheet over whatever is on screen, in the ChatGPT-style shape the owner picked
// from the mockups — the account at the top, then grouped rows that each name a thing and where it
// stands, and every explanation one page in. What the list holds, in what order and with which
// words, is `SettingsHome` in OrbitKit, where it is tested; this file draws it. macOS keeps its
// Settings window and the whole form in `SettingsView`.

extension View {
    /// Hosts Settings. The drawer's gear — on iPhone, and in the iPad's sidebar, which is the same
    /// drawer — opens this sheet instead of switching section (`AppModel.settingsPresented`), so
    /// closing it lands on the page it covered. Applied at the signed-in root, beside the ⌘K
    /// palette, so both shells share it.
    func settingsSheet(_ model: AppModel) -> some View {
        @Bindable var model = model
        return sheet(isPresented: $model.settingsPresented) { SettingsSheet() }
    }
}

/// Settings' own stack: the list at its root, and each page it opens as a frame of
/// `NavState.settingsPath` — the runners list, a runner's record and its engine and name pages, the
/// `SettingsPage`s, and an account's record under Admin. A form row pushes with its `NavigationLink`
/// value; a list row inside a page pushes through `AppModel.push`, which lands here while the sheet
/// is up.
struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.nav.settingsPath) {
            SettingsHomeView()
                .toolbar { closeButton }
                .navigationDestination(for: NavNode.self) { node in
                    Group {
                        switch node {
                        case .settingsRunners:            RunnersSettingsList()
                        case .runnerDetail(let runnerID): RunnerDetailView(runnerID: runnerID)
                        case .runnerEngine(let runnerID, let engine): RunnerEnginePage(runnerID: runnerID, engine: engine)
                        case .runnerName(let runnerID):   RunnerNamePage(runnerID: runnerID)
                        case .settingsPage(let page):     SettingsPageView(page: page)
                        case .accountPool(let poolID):    AccountPoolSettingsPage(poolID: poolID)
                        case .sharedPool(let poolID):     SharedPoolSettingsPage(poolID: poolID)
                        case .providerDetail(let providerID): ProviderDetailSettingsPage(providerID: providerID)
                        case .userDetail(let userID):     AdminUserDetailView(userID: userID)
                        default:                          EmptyView()
                        }
                    }
                    .toolbar { closeButton }
                }
        }
        // A sheet is a presentation of its own: without this, picking Light or Dark here would only
        // show once the sheet closed.
        .preferredColorScheme(model.preferredColorScheme)
    }

    private var closeButton: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            // Use the sheet's dismiss action at every depth, rather than popping a page.
            Button { dismiss() } label: { Image(systemName: "xmark") }
                .accessibilityLabel("Close")
        }
    }
}

/// The page a `SettingsPage` frame names.
private struct SettingsPageView: View {
    let page: SettingsPage

    var body: some View {
        switch page {
        case .providers:      ProvidersSettingsPage()
        case .notifications:  NotificationSettingsPage()
        case .sharedLinks:    SharedLinksSettingsPage()
        case .accessTokens:   AccessTokensSettingsPage()
        case .changePassword: ChangePasswordPage()
        case .admin:          AdminUsersView(rowNavigation: .push)
        }
    }
}

// MARK: - The list

/// Settings' root: the account, then `SettingsHome`'s groups, then Sign out and the build.
struct SettingsHomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var theme = "system"
    @State private var permMode: PermissionMode = .default
    /// The account's one orchestration switch. Absent on the server means on.
    @State private var orchestration = true
    /// The account's switch for smart model selection. Absent on the server means off.
    @State private var modelRouting = false
    @State private var seeded = false
    /// This device's own answer to "may Orbit alert you" — nil until asked.
    @State private var alertsAllowed: Bool?
    @State private var confirmingSignOut = false
    /// The avatar and name are the page's title while they are on screen; the bar names the page
    /// once they have scrolled under it.
    @State private var headerScrolledAway = false
    /// The edit-profile card, which the avatar and name open.
    @State private var editingProfile = false

    private var isAdmin: Bool { model.user?.role == "ADMIN" }

    var body: some View {
        Form {
            header
            if alertsAllowed == false { alertsOffCard }
            ForEach(SettingsHome.Group.allCases, id: \.self) { group in
                Section {
                    ForEach(SettingsHome.rows(group, isAdmin: isAdmin), id: \.self) { row in
                        self.row(row)
                    }
                } header: {
                    SettingsHeader(SettingsHome.header(group))
                }
            }
            signOutSection
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text("Settings").font(.headline).opacity(headerScrolledAway ? 1 : 0)
            }
        }
        // Signing out asks first, in the shape the width calls for (see `ConfirmationStyle`): an alert
        // on a phone, the anchored panel on a tablet.
        .orbitConfirmation(SettingsCopy.signOutTitle, isPresented: $confirmingSignOut) {
            Button(SettingsCopy.signOut, role: .destructive) { model.logout() }
            Button(SharePanelCopy.cancel, role: .cancel) {}
        }
        .sheet(isPresented: $editingProfile) {
            ProfileEditSheet(name: model.user?.name ?? "")
        }
        // Changes apply the moment they are made, as settings do on iOS. Each write is guarded
        // against the value the account already has, so seeding the pickers never writes.
        .onChange(of: theme) { _, value in
            guard (model.user?.preferences?.theme ?? "system") != value else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(theme: value)) }
        }
        .onChange(of: permMode) { _, value in
            let saved = model.user?.preferences?.defaultPermissionMode
                ?? AgentDefaults.defaultPermissionMode.rawValue
            guard saved != value.rawValue else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(defaultPermissionMode: value.rawValue)) }
        }
        .onChange(of: orchestration) { _, value in
            guard (model.user?.preferences?.enableOrchestration ?? true) != value else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(enableOrchestration: value)) }
        }
        .onChange(of: modelRouting) { _, value in
            guard (model.user?.preferences?.smartModelSelection ?? false) != value else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(modelRouting: value)) }
        }
        .onAppear(perform: seed)
        // Each row's value is its own read, so they are asked for side by side.
        .task { alertsAllowed = await model.notifications.alertsAllowed() }
        .task { await model.runners?.load() }
        .task { await model.sharedLinks?.load() }
        .task { await model.accessTokens?.load() }
        // Back from the system's Settings, where the card sends you: say what it is now.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { alertsAllowed = await model.notifications.alertsAllowed() }
        }
    }

    private var displayName: String {
        if let name = model.user?.name, !name.isEmpty { return name }
        return model.user?.email ?? ""
    }

    /// The account, as ChatGPT's sheet opens: the avatar with a pencil on it and the name under it,
    /// both one button that opens the edit-profile card.
    private var header: some View {
        Section {
            Button { editingProfile = true } label: {
                VStack(spacing: 8) {
                    AccountAvatar(name: displayName, diameter: 72, font: .largeTitle.weight(.medium))
                        .overlay(alignment: .bottomTrailing) { EditBadge() }
                    Text(displayName)
                        .font(.headline)
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(SettingsCopy.editProfile)
            .accessibilityValue(displayName)
            .frame(maxWidth: .infinity)
            .onGeometryChange(for: Bool.self) { proxy in
                proxy.frame(in: .scrollView).maxY < 0
            } action: { away in
                headerScrolledAway = away
            }
        }
        .listRowBackground(Color.clear)
    }

    /// While this device won't show Orbit's alerts at all — the slot ChatGPT gives its upgrade card.
    private var alertsOffCard: some View {
        Section {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(SettingsCopy.notificationsOffTitle).font(.headline)
                    Text(SettingsCopy.notificationsOffDetail)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button(SettingsCopy.turnOn) {
                    Task { alertsAllowed = await turnOnAlerts(model, now: alertsAllowed) }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder private func row(_ row: SettingsHome.Row) -> some View {
        let label = SettingsRowLabel(row)
        switch row {
        case .defaultPermission:
            Picker(selection: $permMode) {
                ForEach(AgentDefaults.permissionModes, id: \.self) { mode in
                    Text(AgentDefaults.label(mode)).tag(mode)
                }
            } label: { label }
        case .orchestration:
            Toggle(isOn: $orchestration) { label }
        case .modelRouting:
            // The one switch on the list whose name doesn't say what it does, so the web's hint goes
            // under it.
            Toggle(isOn: $modelRouting) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(SettingsHome.title(row)).foregroundStyle(Color.primary)
                        Text(SettingsCopy.smartModelSelectionHint)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: SettingsHome.systemImage(row)).foregroundStyle(Color.primary)
                }
            }
        case .appearance:
            Picker(selection: $theme) {
                Text("System").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            } label: { label }
        case .email:
            LabeledContent { Text(model.user?.email ?? "") } label: { label }
        case .instance:
            LabeledContent { Text(SettingsHome.instanceName(model.baseURL) ?? "") } label: { label }
        case .runners:
            NavigationLink(value: NavNode.settingsRunners) {
                LabeledContent { if let value = runnersValue { Text(value) } } label: { label }
            }
        case .providers, .notifications, .sharedLinks, .accessTokens, .changePassword, .admin:
            if let page = SettingsHome.page(row) {
                NavigationLink(value: NavNode.settingsPage(page)) {
                    LabeledContent { if let value = value(of: row) { Text(value) } } label: { label }
                }
            }
        }
    }

    /// Only an answer the server gave — never the empty list a model starts with.
    private var runnersValue: String? {
        guard let runners = model.runners, runners.loadState.hasLoaded else { return nil }
        return SettingsHome.runnersValue(runners.runners)
    }

    private func value(of row: SettingsHome.Row) -> String? {
        switch row {
        case .notifications:
            return SettingsHome.notificationsValue(allowed: alertsAllowed)
        case .sharedLinks:
            return model.sharedLinks?.activeCount.map(SettingsHome.sharedLinksValue)
        case .accessTokens:
            return model.accessTokens?.activeCount.map(SettingsHome.accessTokensValue)
        default:
            return nil
        }
    }

    private var signOutSection: some View {
        Section {
            // The glyph in the word's red, as ChatGPT's Log out: the role colours only the word, and a
            // form row's icon would otherwise take the accent.
            Button(role: .destructive) { confirmingSignOut = true } label: {
                Label {
                    Text(SettingsCopy.signOut)
                } icon: {
                    Image(systemName: "rectangle.portrait.and.arrow.right").foregroundStyle(Color.red)
                }
            }
        } footer: {
            if let line = SettingsHome.versionLine(
                version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
                build: Bundle.main.infoDictionary?["CFBundleVersion"] as? String) {
                Text(line)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
            }
        }
    }

    private func seed() {
        guard !seeded else { return }
        seeded = true
        let p = model.user?.preferences
        theme = p?.theme ?? "system"
        // An unset preference is the server's floor (Auto), not Default — showing Default would name
        // a mode the account isn't actually running.
        permMode = PermissionMode(rawValue: p?.defaultPermissionMode ?? "") ?? AgentDefaults.defaultPermissionMode
        orchestration = p?.enableOrchestration ?? true
        modelRouting = p?.smartModelSelection ?? false
    }
}

/// The pencil on the header's avatar, where ChatGPT puts it: a grey disc rimmed in the page's own
/// colour, so it reads as set into the avatar's corner.
private struct EditBadge: View {
    var body: some View {
        Image(systemName: "pencil")
            .font(.orbitLabel.weight(.semibold))
            .foregroundStyle(Color.primary)
            .frame(width: 30, height: 30)
            .background(Color(uiColor: .systemGray5), in: Circle())
            .overlay(Circle().strokeBorder(Color(uiColor: .systemGroupedBackground), lineWidth: 2))
    }
}

/// A row's glyph and name, both in the label colour: a form row's icon would otherwise take the
/// accent, and inside a button's label even `.primary` resolves to it.
private struct SettingsRowLabel: View {
    let row: SettingsHome.Row

    init(_ row: SettingsHome.Row) { self.row = row }

    var body: some View {
        Label {
            Text(SettingsHome.title(row)).foregroundStyle(Color.primary)
        } icon: {
            Image(systemName: SettingsHome.systemImage(row)).foregroundStyle(Color.primary)
        }
    }
}

/// A group's heading: title case in the secondary colour, as the list's own groups read.
struct SettingsHeader: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.headline)
            .foregroundStyle(.secondary)
            .textCase(nil)
    }
}

/// Ask for alerts when this device has never been asked; once refused, only the system's Settings
/// can change it, so that is where the press goes. Answers the state to show now.
@MainActor
private func turnOnAlerts(_ model: AppModel, now: Bool?) async -> Bool? {
    if now == nil {
        let allowed = await model.notifications.askForAlerts()
        if allowed { model.enablePush() }
        return allowed
    }
    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
        _ = await UIApplication.shared.open(url)
    }
    return now
}

// MARK: - Edit profile

/// The card the header opens — ChatGPT's edit-profile card, with what an Orbit account has: the
/// photo and the name, the avatar following the field while there is no photo. The photo is changed
/// from the avatar's menu, as ChatGPT's is: the library, the camera or Files, each through the round
/// crop screen (`AvatarCropView`) — or removed.
/// Nothing is written until Save, which writes the photo and then the name (`ProfileEdit.steps`);
/// Cancel or a swipe down leaves the account as it was. A save that fails keeps the card up and says
/// why where the caption was — and what had already landed stays landed.
private struct ProfileEditSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var draft: String
    @State private var photo: ProfileEdit.Photo = .unchanged
    /// The chosen photo, decoded once for the card to show until Save.
    @State private var chosenImage: PlatformImage?
    @State private var showingLibrary = false
    @State private var libraryPick: PhotosPickerItem?
    @State private var choosingFile = false
    /// The camera, or a new photo on its way through the crop screen.
    @State private var photoFlow: PhotoFlow?
    @State private var saving = false
    @State private var failure: String?
    /// The card is as tall as what it holds, as ChatGPT's is — this is that height as last measured.
    @State private var height: CGFloat = 440

    init(name: String) {
        _draft = State(initialValue: name)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Menu {
                    Button { showingLibrary = true } label: {
                        Label(SettingsCopy.photoLibrary, systemImage: "photo.on.rectangle")
                    }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { photoFlow = .camera } label: {
                            Label(SettingsCopy.takePhoto, systemImage: "camera")
                        }
                    }
                    Button { choosingFile = true } label: {
                        Label(SettingsCopy.chooseFile, systemImage: "folder")
                    }
                    if showsPhoto {
                        Button(role: .destructive) {
                            photo = .removed
                            chosenImage = nil
                        } label: {
                            Label(SettingsCopy.removePhoto, systemImage: "trash")
                        }
                    }
                } label: {
                    avatar.overlay(alignment: .bottomTrailing) { CameraBadge() }
                }
                .disabled(saving)
                .accessibilityLabel(SettingsCopy.choosePhoto)
                .padding(.top, 28)
                .photosPicker(isPresented: $showingLibrary, selection: $libraryPick, matching: .images)
                .onChange(of: libraryPick) { _, item in
                    guard let item else { return }
                    libraryPick = nil
                    Task {
                        guard let data = try? await item.loadTransferable(type: Data.self),
                              let image = UIImage(data: data) else { return }
                        photoFlow = .crop(image)
                    }
                }
                .fileImporter(isPresented: $choosingFile, allowedContentTypes: [.image]) { result in
                    guard case .success(let url) = result else { return }
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url), let image = UIImage(data: data) else {
                        failure = SettingsCopy.photoNotSaved("that file isn't an image Orbit can read")
                        return
                    }
                    photoFlow = .crop(image)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(SettingsCopy.nameLabel)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                    TextField(SettingsCopy.namePlaceholder, text: $draft)
                        .font(.orbitControl)
                        .textContentType(.name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .onSubmit(save)
                        .disabled(saving)
                        .accessibilityLabel(SettingsCopy.nameLabel)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 50)
                        .overlay(Capsule().strokeBorder(Color(uiColor: .separator), lineWidth: 1))
                    Text(failure ?? SettingsCopy.nameCaption)
                        .font(.orbitLabel)
                        .foregroundStyle(failure == nil ? Color.secondary : Color.red)
                        .padding(.horizontal, 16)
                        .padding(.top, 2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 24)

                Button(action: save) {
                    Text(SettingsCopy.saveProfile)
                        .fontWeight(.semibold)
                        .opacity(saving ? 0 : 1)
                        .overlay { if saving { ProgressView().tint(.white) } }
                        .padding(.horizontal, 12)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .disabled(!ProfileEdit.canSave(draft, saved: model.user?.name, photo: photo))
                .padding(.top, 28)

                Button(SharePanelCopy.cancel) { dismiss() }
                    .padding(.vertical, 12)
                    .padding(.top, 4)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { measured in
                height = measured
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .presentationDetents([.height(height)])
        .interactiveDismissDisabled(saving)
        .onChange(of: draft) { _, _ in failure = nil }
        .onChange(of: photo) { _, _ in failure = nil }
        .fullScreenCover(item: $photoFlow) { flow in
            switch flow {
            case .camera:
                CameraPicker { taken in photoFlow = taken.map(PhotoFlow.crop) }
                    .ignoresSafeArea()
            case .crop(let image):
                AvatarCropView(image: image, cancel: { photoFlow = nil }) { jpeg in
                    photo = .replaced(jpeg)
                    chosenImage = PlatformImage(data: jpeg)
                    photoFlow = nil
                }
            }
        }
        // A presentation of its own, like the Settings sheet under it.
        .preferredColorScheme(model.preferredColorScheme)
    }

    /// The avatar as it will be after Save: the chosen photo, none, or the account's own.
    @ViewBuilder private var avatar: some View {
        switch photo {
        case .replaced:
            if let chosenImage { AvatarPhoto(image: chosenImage, diameter: 96) } else { monogram }
        case .removed:
            monogram
        case .unchanged:
            if let saved = model.avatarImage { AvatarPhoto(image: saved, diameter: 96) } else { monogram }
        }
    }

    private var monogram: some View {
        AvatarMonogram(name: draft, diameter: 96, font: .orbitHeroGlyph.weight(.medium))
    }

    /// Whether there is a photo to remove — the chosen one, or the account's.
    private var showsPhoto: Bool {
        switch photo {
        case .replaced: return true
        case .removed: return false
        case .unchanged: return model.user?.avatarUpdatedAt != nil
        }
    }

    private func save() {
        let steps = ProfileEdit.steps(draft, saved: model.user?.name, photo: photo)
        guard !saving, !steps.isEmpty else { return }
        saving = true
        Task {
            for step in steps {
                // A photo that landed is the account's now, so a second Save does not send it again.
                let failed: String?
                switch step {
                case .setPhoto(let jpeg):
                    failed = await model.saveAvatar(jpeg)
                    if failed == nil { photo = .unchanged }
                case .removePhoto:
                    failed = await model.removeAvatar()
                    if failed == nil { photo = .unchanged }
                case .rename(let name):
                    failed = await model.saveName(name)
                }
                if let failed {
                    failure = failed
                    saving = false
                    return
                }
            }
            saving = false
            dismiss()
        }
    }
}

/// The camera on the card's avatar, where ChatGPT puts it: a white disc that opens the photo's
/// actions.
private struct CameraBadge: View {
    var body: some View {
        Image(systemName: "camera")
            .font(.orbitLabel.weight(.semibold))
            .foregroundStyle(Color.primary)
            .frame(width: 32, height: 32)
            .background(Color(uiColor: .systemBackground), in: Circle())
            .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
    }
}

/// The camera, or a new photo in the crop screen — one full-screen cover for both, so a photo just
/// taken goes on to its crop without the cover closing in between (the same id throughout).
private enum PhotoFlow: Identifiable {
    case camera
    case crop(UIImage)

    var id: String { "photo" }
}

/// UIKit's camera, handing back the photo as taken (nil when cancelled); the crop is Orbit's own.
private struct CameraPicker: UIViewControllerRepresentable {
    let done: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void

        init(done: @escaping (UIImage?) -> Void) { self.done = done }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
    }
}

/// The crop screen a new photo passes through, as ChatGPT's does: the photo under a round window on
/// black, dragged and pinched into place (`AvatarCrop` keeps the circle covered), Cancel (×) and Save
/// along the bottom. Save hands back the circle's square as the JPEG that is sent.
private struct AvatarCropView: View {
    let image: UIImage
    let cancel: () -> Void
    let save: (Data) -> Void

    @State private var zoom: CGFloat = 1
    @State private var zoomAtStart: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var offsetAtStart: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            let circle = max(1, min(geo.size.width, geo.size.height) - 88)
            let fitted = AvatarCrop.fitted(image.size, circle: circle)
            ZStack {
                Image(uiImage: image)
                    .resizable()
                    .frame(width: fitted.width * zoom, height: fitted.height * zoom)
                    .offset(offset)
                // Everything outside the circle dimmed, and the circle's edge drawn.
                Rectangle()
                    .fill(Color.black.opacity(0.6))
                    .mask {
                        Rectangle()
                            .overlay { Circle().frame(width: circle, height: circle).blendMode(.destinationOut) }
                            .compositingGroup()
                    }
                    .allowsHitTesting(false)
                Circle()
                    .strokeBorder(Color.white.opacity(0.7), lineWidth: 1)
                    .frame(width: circle, height: circle)
                    .allowsHitTesting(false)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .onChanged { value in
                        let moved = CGSize(width: offsetAtStart.width + value.translation.width,
                                           height: offsetAtStart.height + value.translation.height)
                        offset = AvatarCrop.clampedOffset(moved, fitted: fitted, circle: circle, zoom: zoom)
                    }
                    .onEnded { _ in offsetAtStart = offset }
                    .simultaneously(with: MagnifyGesture()
                        .onChanged { value in
                            zoom = AvatarCrop.clampedZoom(zoomAtStart * value.magnification)
                            offset = AvatarCrop.clampedOffset(offset, fitted: fitted, circle: circle, zoom: zoom)
                        }
                        .onEnded { _ in
                            zoomAtStart = zoom
                            offsetAtStart = offset
                        })
            )
            .overlay(alignment: .bottom) {
                HStack {
                    Button(action: cancel) {
                        Image(systemName: "xmark")
                            .font(.orbitControl.weight(.semibold))
                            .frame(width: 48, height: 48)
                            .background(.regularMaterial, in: Circle())
                    }
                    .accessibilityLabel(SharePanelCopy.cancel)
                    Spacer()
                    Button {
                        let square = AvatarCrop.cropRect(image: image.size, circle: circle, zoom: zoom, offset: offset)
                        if let jpeg = image.orbitAvatarJPEG(crop: square) { save(jpeg) }
                    } label: {
                        Text(SettingsCopy.savePhoto)
                            .font(.orbitControl.weight(.semibold))
                            .padding(.horizontal, 22)
                            .frame(height: 48)
                            .background(.regularMaterial, in: Capsule())
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.primary)
                .padding(.horizontal, 20)
                .padding(.bottom, 12)
            }
        }
        .background(Color.black.ignoresSafeArea())
        .environment(\.colorScheme, .dark)
        .preferredColorScheme(.dark)
    }
}

// MARK: - Notifications

/// This device's own switch, the account's two switches (the web page's, in its words), and the
/// alerts neither of them governs.
private struct NotificationSettingsPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var alertsAllowed: Bool?
    @State private var sessionFinished = true
    @State private var agentMessage = true
    @State private var seeded = false

    var body: some View {
        Form {
            Section {
                Button {
                    Task { alertsAllowed = await turnOnAlerts(model, now: alertsAllowed) }
                } label: {
                    HStack {
                        Text(SettingsCopy.allowNotifications).foregroundStyle(Color.primary)
                        Spacer()
                        if let value = SettingsHome.notificationsValue(allowed: alertsAllowed) {
                            Text(value).foregroundStyle(Color.secondary)
                        }
                        Image(systemName: "arrow.up.forward")
                            .imageScale(.small)
                            .foregroundStyle(Color.secondary)
                    }
                }
            } header: {
                SettingsHeader(SettingsCopy.deviceHeader(UIDevice.current.localizedModel))
            } footer: {
                Text(SettingsCopy.deviceFooter)
            }

            Section {
                Toggle(SettingsCopy.sessionFinished, isOn: $sessionFinished)
            } header: {
                SettingsHeader(SettingsCopy.accountHeader)
            } footer: {
                Text(SettingsCopy.sessionFinishedHint)
            }

            Section {
                Toggle(SettingsCopy.agentMessage, isOn: $agentMessage)
            } footer: {
                Text(SettingsCopy.agentMessageHint)
            }

            Section {
                ForEach(SettingsCopy.alwaysSent, id: \.self) { kind in
                    LabeledContent(kind, value: SettingsCopy.always)
                }
            } header: {
                SettingsHeader(SettingsCopy.alwaysHeader)
            } footer: {
                Text(SettingsCopy.alwaysFooter)
            }
        }
        .navigationTitle(SettingsPage.notifications.title)
        .onAppear {
            guard !seeded else { return }
            seeded = true
            // Absent means on: only opting out is ever written.
            sessionFinished = model.user?.preferences?.notifySessionFinished ?? true
            agentMessage = model.user?.preferences?.notifyAgentMessage ?? true
        }
        .onChange(of: sessionFinished) { _, _ in save() }
        .onChange(of: agentMessage) { _, _ in save() }
        .task { alertsAllowed = await model.notifications.alertsAllowed() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { alertsAllowed = await model.notifications.alertsAllowed() }
        }
    }

    /// Only the switch that moved, so the other keeps whatever it is on the server.
    private func save() {
        let p = model.user?.preferences
        let finished = sessionFinished != (p?.notifySessionFinished ?? true) ? sessionFinished : nil
        let message = agentMessage != (p?.notifyAgentMessage ?? true) ? agentMessage : nil
        guard finished != nil || message != nil else { return }
        Task {
            await model.savePreferences(UpdatePreferencesRequest(notifySessionFinished: finished,
                                                                 notifyAgentMessage: message))
        }
    }
}

// MARK: - Change password

/// The web Profile page's form: the current password, and the new one twice.
private struct ChangePasswordPage: View {
    @Environment(AppModel.self) private var model

    @State private var current = ""
    @State private var fresh = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var outcome: String?

    var body: some View {
        Form {
            Section {
                SecureField(SettingsCopy.currentPassword, text: $current)
                    .textContentType(.password)
                SecureField(SettingsCopy.newPassword, text: $fresh)
                    .textContentType(.newPassword)
                SecureField(SettingsCopy.confirmPassword, text: $confirm)
                    .textContentType(.newPassword)
            } footer: {
                Text(footer)
            }

            Section {
                Button(SettingsCopy.changePassword) { Task { await submit() } }
                    .disabled(!canSubmit || busy)
            }
        }
        .navigationTitle(SettingsPage.changePassword.title)
        .onChange(of: fresh) { _, _ in outcome = nil }
    }

    private var canSubmit: Bool { !current.isEmpty && fresh.count >= 6 && confirm == fresh }

    private var footer: String {
        if let outcome { return outcome }
        if !confirm.isEmpty && confirm != fresh { return SettingsCopy.passwordsDoNotMatch }
        return SettingsCopy.passwordRule
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        if let error = await model.changePassword(current: current, new: fresh) {
            outcome = error
            return
        }
        current = ""
        fresh = ""
        confirm = ""
        outcome = SettingsCopy.passwordChanged
    }
}

// MARK: - Providers

/// Where the account's models come from: the engines signed in on each runner (a row opens that runner,
/// where signing in lives), the account's pools (a row opens the pool's page) and its API keys. A Codex
/// pool of the account's own is drawn with its people and keys, read pool by pool beside its accounts.
private struct ProvidersSettingsPage: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ProvidersOverviewForm(runners: model.runners?.runners ?? [],
                              pools: pools,
                              sharedPools: model.sharedPools?.pools ?? [],
                              keys: model.agents?.configuredProviders ?? [],
                              mine: model.agents?.personalProviders ?? [],
                              balances: model.agents?.deepSeekBalances ?? [:])
            .navigationTitle(SettingsPage.providers.title)
            .task { await model.runners?.load() }
            .task { await model.agents?.load() }
            .task { await model.agents?.loadDeepSeekBalances() }
            .task { await model.sharedPools?.load() }
            .task(id: codexPoolIDs) {
                for id in codexPoolIDs { await model.sharedPools?.loadAccess(id) }
            }
    }

    /// The account's own pools, each Codex one drawn with its people and keys once they are read.
    private var pools: [ProviderPool] {
        (model.agents?.providerPools ?? []).map { pool -> ProviderPool in
            guard CodexLoginPool.isLoginPool(pool),
                  let access = model.sharedPools?.access(pool.id) else { return pool }
            return SharedPools.ownPoolWithAccess(pool, access)
        }
    }

    /// The account's own Codex pools, whose people and keys are read one by one.
    private var codexPoolIDs: [String] {
        (model.agents?.providerPools ?? []).filter(CodexLoginPool.isLoginPool).map(\.id)
    }
}

/// An account pool's page: the pool as Providers last read it, with account pause controls; for a
/// Codex pool of one's own, its page (`CodexPoolPageView`) with its people and keys read beside its ChatGPT
/// accounts, run from here: an account signed in, in again or out, keys and people added and taken out,
/// the pool deleted. Deleting the pool closes the page.
private struct AccountPoolSettingsPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let poolID: String

    var body: some View {
        let key = PublicID.storageKey(poolID)
        if let agents = model.agents,
           let pool = agents.providerPools.first(where: { PublicID.storageKey($0.id) == key }) {
            if CodexLoginPool.isLoginPool(pool),
               let page = CodexPoolPage(own: pool, access: model.sharedPools?.access(pool.id)) {
                CodexPoolPageView(
                    page: page,
                    accountActions: CodexPoolActions(
                        start: { try await agents.startCodexLogin(pool) },
                        poll: { try await agents.pollCodexLogin(pool) },
                        cancel: { await agents.cancelCodexLogin(pool) },
                        signOut: { login in await agents.signOutCodexLogin(pool, login) },
                        refresh: { await agents.reloadPools() }),
                    accessActions: accessActions(page),
                    exit: { await close(agents, pool) },
                    pause: { member, minutes in
                        let failure = await agents.pausePoolMember(pool, member: member, durationMinutes: minutes)
                        if failure == nil { await model.sharedPools?.loadAccess(pool.id) }
                        return failure
                    })
                    .task { await model.sharedPools?.loadAccess(pool.id) }
                    .task(id: page.pool.members.map(\.pausedUntil)) {
                        await refreshAfterPauses(page.pool) {
                            await agents.reloadPools()
                            await model.sharedPools?.loadAccess(pool.id)
                        }
                    }
            } else {
                AccountPoolPageView(pool: pool, pause: { member, minutes in
                    await agents.pausePoolMember(pool, member: member, durationMinutes: minutes)
                })
                .task(id: pool.members.map(\.pausedUntil)) {
                    await refreshAfterPauses(pool) { await agents.reloadPools() }
                }
            }
        } else {
            ContentUnavailableView(ProvidersOverview.poolGone, systemImage: "person.3")
        }
    }

    /// What its people's and keys' presses do, once they are read.
    private func accessActions(_ page: CodexPoolPage) -> PoolAccessActions? {
        guard let pools = model.sharedPools, let access = page.access else { return nil }
        return poolAccessActions(pools, access)
    }

    private func close(_ agents: AgentsModel, _ pool: ProviderPool) async -> String? {
        if let failure = await agents.deletePool(pool) { return failure }
        model.sharedPools?.forget(pool.id)
        dismiss()
        return nil
    }
}

/// A DeepSeek key's page, read-only: the key as the account's own list last read it, and the balance of
/// its DeepSeek account — read with the list, and asked of DeepSeek again by Refresh or Retry.
private struct ProviderDetailSettingsPage: View {
    @Environment(AppModel.self) private var model
    let providerID: String

    var body: some View {
        let key = PublicID.storageKey(providerID)
        if let agents = model.agents,
           let provider = agents.personalProviders.first(where: { $0.providerID.map(PublicID.storageKey) == key }) {
            DeepSeekKeyPageView(key: provider, reading: agents.deepSeekBalances[providerID],
                                refresh: { await agents.refreshDeepSeekBalance(providerID) })
        } else {
            ContentUnavailableView(ProvidersOverview.keyGone, systemImage: "key")
        }
    }
}

/// A Codex pool the account is in as one of its people — a shared pool, or somebody else's own — run from
/// here: each press goes to the server, and the pool it answers with is the one drawn. Deleting the pool
/// (its owner) or leaving it (anybody else) closes the page.
private struct SharedPoolSettingsPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let poolID: String

    var body: some View {
        if let pools = model.sharedPools, let pool = pools.pool(poolID),
           let page = CodexPoolPage(own: nil, access: pool) {
            CodexPoolPageView(page: page, accountActions: accountActions(pools, pool),
                              accessActions: poolAccessActions(pools, pool),
                              exit: { await close(pools, pool, delete: page.mine) },
                              pause: { member, minutes in
                                  await pools.pauseMember(pool, member: member, durationMinutes: minutes)
                              })
                .task(id: page.pool.members.map(\.pausedUntil)) {
                    await refreshAfterPauses(page.pool) { await pools.load() }
                }
        } else {
            ContentUnavailableView(ProvidersOverview.poolGone, systemImage: "person.3")
        }
    }

    /// A member's presses on the pool's ChatGPT accounts, where its own rule lets them sign one of their
    /// own in (migration 0371): the same device sign-in, the pool read again afterwards. Nil where it does
    /// not, which leaves the rows read-only.
    private func accountActions(_ pools: SharedPoolsModel, _ pool: SharedPool) -> CodexPoolActions? {
        guard SharedPoolPage.canAddAccount(pool) else { return nil }
        return CodexPoolActions(
            start: { try await pools.startCodexLogin(pool) },
            poll: { try await pools.pollCodexLogin(pool) },
            cancel: { await pools.cancelCodexLogin(pool) },
            signOut: { login in await pools.signOutCodexLogin(pool, login) },
            refresh: { await pools.load() })
    }

    private func close(_ pools: SharedPoolsModel, _ pool: SharedPool, delete: Bool) async -> String? {
        if let failure = await pools.exit(pool, delete: delete) { return failure }
        dismiss()
        return nil
    }
}

/// Re-read the server's NEXT selection as each pause expires while its page is open.
private func refreshAfterPauses(_ pool: ProviderPool, refresh: () async -> Void) async {
    let deadlines = Set(pool.members.compactMap(\.pausedUntil).compactMap(RelativeTime.parse))
        .filter { $0 > Date() }.sorted()
    for deadline in deadlines {
        do {
            try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
        } catch { return }
        guard !Task.isCancelled else { return }
        await refresh()
    }
}

/// What a Codex pool's page asks of its people and keys, sent for `pool` as the server last answered it.
private func poolAccessActions(_ pools: SharedPoolsModel, _ pool: SharedPool) -> PoolAccessActions {
    PoolAccessActions(
        addKey: { await pools.addKey(pool, $0) },
        replaceKey: { await pools.replaceKey(pool, $0, secret: $1) },
        removeKey: { await pools.removeKey(pool, $0) },
        switchKey: { await pools.switchKey(pool, $0, on: $1) },
        setRules: { await pools.setRules(pool, $0) },
        share: { await pools.share(pool, emails: $0, membersCanAdd: $1) },
        keepToSelf: { await pools.keepToSelf(pool) },
        setRole: { await pools.setRole(pool, $0, $1) },
        removePerson: { await pools.removePerson(pool, $0) })
}

// MARK: - Shared links

/// Every public link this account has made, by where it stands — the web page's tabs, lines and
/// words. A link is copied or shared from its context menu and turned off by a swipe, which asks
/// first: whoever has the link loses it at once.
private struct SharedLinksSettingsPage: View {
    @Environment(AppModel.self) private var model

    @State private var tab: SharedLinksList.Tab = .active
    @State private var pendingTurnOff: OrbitKit.ShareLink?
    @State private var notice: String?

    var body: some View {
        let links = model.sharedLinks?.links ?? []
        let shown = SharedLinksList.links(links, in: tab)
        List {
            Section {
                Picker(SharedLinksList.title, selection: $tab) {
                    ForEach(SharedLinksList.Tab.allCases) { tab in
                        Text("\(tab.label) \(SharedLinksList.links(links, in: tab).count)").tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } footer: {
                Text(SharedLinksList.subtitle)
            }

            Section {
                switch LoadFailureLogic.presentation(model.sharedLinks?.loadState ?? ListLoadState(),
                                                     isEmpty: links.isEmpty) {
                case .loading:
                    HStack { Spacer(); ProgressView(); Spacer() }
                case .failed:
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.sharedLinks?.errorText ?? SharedLinksList.couldNotLoad)
                            .foregroundStyle(.secondary)
                        Button(SharePanelCopy.retry) { Task { await model.sharedLinks?.load() } }
                    }
                case .empty, .content:
                    if shown.isEmpty {
                        Text(tab.empty).foregroundStyle(.secondary)
                    }
                    ForEach(shown) { link in
                        row(link)
                    }
                }
            }
        }
        .navigationTitle(SharedLinksList.title)
        .task { await model.sharedLinks?.load() }
        .refreshable { await model.sharedLinks?.load() }
        .overlay(alignment: .bottom) {
            if let notice {
                Text(notice)
                    .font(.orbitListSubtitle.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.opacity)
            }
        }
        .animation(.default, value: notice)
    }

    private var turnOffAsked: Binding<Bool> {
        Binding(get: { pendingTurnOff != nil }, set: { if !$0 { pendingTurnOff = nil } })
    }

    private func row(_ link: OrbitKit.ShareLink) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(link.root.title ?? SharedLinksList.kindWord(link.kind))
                .lineLimit(2)
            Text(SharedLinksList.whereLine(link))
                .font(.orbitListSubtitle)
                .foregroundStyle(.secondary)
            Text(SharePanelCopy.viewsLine(viewCount: link.viewCount, lastViewedAt: link.lastViewedAt, now: Date()))
                .font(.orbitListSubtitle)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            if SharedLinksList.canTurnOff(link) {
                Button(SharePanelCopy.turnOff, role: .destructive) { pendingTurnOff = link }
            }
        }
        .contextMenu {
            if link.state == .active, let base = model.baseURL {
                let url = SharedLinksList.publicURL(link, base: base)
                Button {
                    UIPasteboard.general.url = url
                    show(SharePanelCopy.linkCopied)
                } label: {
                    Label(SharePanelCopy.copyLink, systemImage: "doc.on.doc")
                }
                SwiftUI.ShareLink(item: url) {
                    Label(SharePanelCopy.shareLink, systemImage: "square.and.arrow.up")
                }
            }
            if SharedLinksList.canTurnOff(link) {
                Button(role: .destructive) { pendingTurnOff = link } label: {
                    Label(SharePanelCopy.turnOff, systemImage: "xmark.circle")
                }
            }
        }
        // On the link's own row — the swipe and the long-press menu both raise it — so the panel opens
        // against that row rather than at the top of the page.
        .orbitConfirmation({ _ in SharePanelCopy.turnOffTitle },
                           isPresented: turnOffAsked, presenting: pendingTurnOff) { link in
            Button(SharePanelCopy.turnOff, role: .destructive) { Task { await turnOff(link) } }
            Button(SharePanelCopy.cancel, role: .cancel) {}
        } message: { _ in
            Text(SharePanelCopy.turnOffDetail)
        }
    }

    private func turnOff(_ link: OrbitKit.ShareLink) async {
        guard let count = await model.sharedLinks?.turnOff([link.id]) else {
            show(model.sharedLinks?.errorText ?? SharePanelCopy.turnOff)
            return
        }
        show(SharedLinksList.turnedOff(count))
    }

    /// A line over the list's foot for a moment — the app's toast lives under this sheet.
    private func show(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(2))
            if notice == text { notice = nil }
        }
    }
}

// MARK: - Access tokens

/// Every personal access token this account has issued, by whether it still works — the web page's
/// tabs, lines and words. A token that works is revoked by a swipe or from its context menu, which
/// asks first: anything using it stops working at once. A new token is issued on the web only
/// (docs/personal-access-token-design.md §9), which the page's footer says.
private struct AccessTokensSettingsPage: View {
    @Environment(AppModel.self) private var model

    @State private var tab: AccessTokensList.Tab = .active
    @State private var pendingRevoke: AccessToken?
    @State private var notice: String?

    var body: some View {
        let tokens = model.accessTokens?.tokens ?? []
        let shown = AccessTokensList.tokens(tokens, in: tab)
        List {
            Section {
                Picker(AccessTokensList.title, selection: $tab) {
                    ForEach(AccessTokensList.Tab.allCases) { tab in
                        Text("\(tab.label) \(AccessTokensList.tokens(tokens, in: tab).count)").tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } footer: {
                Text(AccessTokensList.subtitle + " " + AccessTokensList.issuedOnTheWeb)
            }

            Section {
                switch LoadFailureLogic.presentation(model.accessTokens?.loadState ?? ListLoadState(),
                                                     isEmpty: tokens.isEmpty) {
                case .loading:
                    HStack { Spacer(); ProgressView(); Spacer() }
                case .failed:
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.accessTokens?.errorText ?? AccessTokensList.couldNotLoad)
                            .foregroundStyle(.secondary)
                        Button(SharePanelCopy.retry) { Task { await model.accessTokens?.load() } }
                    }
                case .empty, .content:
                    if shown.isEmpty {
                        Text(tab.empty).foregroundStyle(.secondary)
                    }
                    ForEach(shown) { token in
                        row(token)
                    }
                }
            }
        }
        .navigationTitle(AccessTokensList.title)
        .task { await model.accessTokens?.load() }
        .refreshable { await model.accessTokens?.load() }
        .orbitConfirmation(AccessTokensList.revokeTitle, isPresented: revokeAsked,
                           presenting: pendingRevoke) { token in
            Button(AccessTokensList.revoke, role: .destructive) { Task { await revoke(token) } }
            Button(SharePanelCopy.cancel, role: .cancel) {}
        } message: { _ in
            Text(AccessTokensList.revokeDetail)
        }
        .overlay(alignment: .bottom) {
            if let notice {
                Text(notice)
                    .font(.orbitListSubtitle.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.opacity)
            }
        }
        .animation(.default, value: notice)
    }

    private var revokeAsked: Binding<Bool> {
        Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } })
    }

    private func row(_ token: AccessToken) -> some View {
        AccessTokenRow(token: token, now: Date())
            .opacity(model.accessTokens?.revokingID == token.id ? 0.5 : 1)
            .swipeActions(edge: .trailing) {
                if AccessTokensList.canRevoke(token) {
                    Button(AccessTokensList.revoke, role: .destructive) { pendingRevoke = token }
                }
            }
            .contextMenu {
                if AccessTokensList.canRevoke(token) {
                    Button(role: .destructive) { pendingRevoke = token } label: {
                        Label(AccessTokensList.revoke, systemImage: "xmark.circle")
                    }
                }
            }
    }

    private func revoke(_ token: AccessToken) async {
        guard let accessTokens = model.accessTokens else { return }
        if let reason = await accessTokens.revoke(token) {
            show(AccessTokensList.notRevoked(reason))
        } else {
            show(AccessTokensList.revoked)
        }
    }

    /// A line over the list's foot for a moment — the app's toast lives under this sheet.
    private func show(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(2))
            if notice == text { notice = nil }
        }
    }
}
#endif
