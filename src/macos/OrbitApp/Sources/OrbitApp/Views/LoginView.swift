import SwiftUI
import OrbitKit

/// Brand + email + password. The server address stays off the page (it defaults to orbitd.io and
/// remembers the last one); triple-tapping the logo opens the hidden server sheet for self-hosters.
struct LoginView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focus: Field?
    @State private var showsPassword = false
    @State private var serverSheet = false

    private enum Field { case email, password }

    /// While typing on iPhone the keyboard takes half the screen, so the brand folds into one row
    /// to keep the form and the button above it.
    private var compact: Bool {
        #if os(iOS)
        focus != nil
        #else
        false
        #endif
    }

    var body: some View {
        @Bindable var model = model
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) {
                    header
                    VStack(spacing: 12) {
                        LoginField(label: "Email", focused: focus == .email) {
                            // Verbatim: a LocalizedStringKey would turn the address into a blue link.
                            TextField("Email", text: $model.email, prompt: Text(verbatim: "you@example.com"))
                                .textContentType(.username)
                                #if os(iOS)
                                .keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                #endif
                                .autocorrectionDisabled()
                                .focused($focus, equals: .email)
                                .submitLabel(.next)
                                .onSubmit { focus = .password }
                        }
                        LoginField(label: "Password", focused: focus == .password) {
                            HStack(spacing: 8) {
                                Group {
                                    if showsPassword {
                                        TextField("Enter your password", text: $model.password)
                                    } else {
                                        SecureField("Enter your password", text: $model.password)
                                    }
                                }
                                .textContentType(.password)
                                .focused($focus, equals: .password)
                                .submitLabel(.go)
                                .onSubmit(submit)
                                Button { showsPassword.toggle() } label: {
                                    Image(systemName: showsPassword ? "eye.slash" : "eye")
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(.secondary)
                                .accessibilityLabel(showsPassword ? "Hide password" : "Show password")
                            }
                        }

                        if let e = model.errorText {
                            Text(e).font(.orbitProseAside).foregroundStyle(.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Button(action: submit) {
                            Text(model.busy ? "Signing in…" : "Sign In")
                        }
                        .buttonStyle(SignInButtonStyle())
                        .keyboardShortcut(.return)
                        .disabled(model.busy || model.email.isEmpty || model.password.isEmpty)
                        .padding(.top, 8)
                    }
                    .padding(.top, compact ? 24 : 36)
                }
                .frame(maxWidth: 360)
                .padding(.horizontal, 24)
                .padding(.vertical, compact ? 16 : 40)
                .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: compact ? .top : .center)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background {
            RadialGradient(colors: [Color.accentColor.opacity(0.10), .clear],
                           center: .top, startRadius: 0, endRadius: 520)
                .ignoresSafeArea()
        }
        .animation(.snappy, value: compact)
        .sensoryFeedback(.impact, trigger: serverSheet) { _, shown in shown }
        .sheet(isPresented: $serverSheet) { ServerSheet() }
    }

    @ViewBuilder private var header: some View {
        if compact {
            HStack(spacing: 12) {
                logo(40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Welcome back").font(.title3.bold())
                    Text("Sign in to continue to Orbit").font(.orbitLabel).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        } else {
            VStack(spacing: 0) {
                logo(76)
                    .background {
                        // Faint orbits around the mark.
                        ZStack {
                            ForEach([(180.0, 0.14), (280.0, 0.09), (392.0, 0.05)], id: \.0) { d, o in
                                Circle().stroke(Color.accentColor.opacity(o)).frame(width: d, height: d)
                            }
                        }
                        .allowsHitTesting(false)
                    }
                    .padding(.bottom, 20)
                Text("Welcome back").font(.largeTitle.bold())
                Text("Sign in to continue to Orbit").foregroundStyle(.secondary).padding(.top, 6)
            }
        }
    }

    private func logo(_ size: CGFloat) -> some View {
        OrbitAppIcon(size: size)
            .shadow(color: Color.accentColor.opacity(0.28), radius: size / 6, y: size / 10)
            .onTapGesture(count: 3) { serverSheet = true }
            .accessibilityLabel("Orbit")
            .accessibilityAction(named: "Change server") { serverSheet = true }
    }

    private func submit() {
        Task { await model.login() }
    }
}

/// A rounded field with a standing label, so an empty field still says what goes in it.
private struct LoginField<Content: View>: View {
    let label: String
    let focused: Bool
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.orbitLabel).foregroundStyle(focused ? Color.accentColor : .secondary)
            content.textFieldStyle(.plain).font(.orbitControl)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(shape.fill(focused ? AnyShapeStyle(Color.loginOpaque) : AnyShapeStyle(Color.secondary.opacity(0.1))))
        .overlay(shape.strokeBorder(Color.accentColor, lineWidth: focused ? 1.5 : 0))
    }
}

/// Full-width accent capsule; disabled it fades instead of going grey, so it still reads as the
/// page's one action.
private struct SignInButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    /// The brand blue (iOS AccentColor), fixed: iOS greys out `Color.accentColor` on a disabled control.
    private static let blue = Color(red: 0.18, green: 0.42, blue: 1)

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Capsule().fill(Self.blue.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.38)))
            .contentShape(Capsule())
    }
}

private extension Color {
    /// The plain page background, opaque even inside an iOS 26 glass sheet (`.background` isn't).
    static var loginOpaque: Color {
        #if os(iOS)
        Color(uiColor: .systemBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}

/// The hidden server picker behind the logo's triple tap.
private struct ServerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var invalid = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                LoginField(label: "Server address", focused: focused) {
                    TextField(AppModel.defaultInstance, text: $draft)
                        .textContentType(.URL)
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(save)
                }
                Text(invalid ? "Enter a valid server address."
                             : "For self-hosted Orbit. Leave as \(AppModel.defaultInstance) unless your admin gave you another address.")
                    .font(.orbitLabel)
                    .foregroundStyle(invalid ? .red : .secondary)
                Button("Reset to \(AppModel.defaultInstance)") {
                    draft = AppModel.defaultInstance
                    invalid = false
                }
                .buttonStyle(.borderless)
                .padding(.top, 6)
                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Server")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save) }
            }
        }
        .presentationDetents([.medium])
        // Opaque: the iOS 26 glass sheet otherwise shows the login page through the field.
        .presentationBackground(Color.loginOpaque)
        #if os(macOS)
        .frame(width: 400, height: 220)
        #endif
        .onAppear {
            draft = model.instanceField
            focused = true
        }
    }

    private func save() {
        guard ServerURL.normalize(draft) != nil else {
            invalid = true
            return
        }
        model.instanceField = draft
        dismiss()
    }
}

/// The app icon (`src/ios/Support/Assets.xcassets/AppIcon.appiconset`) drawn as vectors: the
/// macOS build ships no compiled asset catalog (see `VectorMark`), so `Image("AppIcon")` would
/// render blank there. The mark is the favicon's 64-unit geometry, placed where the icon puts it.
private struct OrbitAppIcon: View {
    let size: CGFloat

    var body: some View {
        Canvas { ctx, canvas in
            ctx.scaleBy(x: canvas.width / 1024, y: canvas.height / 1024)
            let tile = Path(roundedRect: CGRect(x: 0, y: 0, width: 1024, height: 1024),
                            cornerRadius: 229, style: .continuous)
            ctx.fill(tile, with: .linearGradient(
                Gradient(colors: [Color(red: 0.36, green: 0.55, blue: 1), Color(red: 0.20, green: 0.44, blue: 1)]),
                startPoint: .zero, endPoint: CGPoint(x: 1024, y: 1024)))

            // 13pt per favicon unit, the 64-unit mark's origin at (96, 118).
            ctx.translateBy(x: 96, y: 118)
            ctx.scaleBy(x: 13, y: 13)
            var orbit = ctx
            orbit.translateBy(x: 32, y: 32)
            orbit.rotate(by: .degrees(-26))
            orbit.translateBy(x: -32, y: -32)
            orbit.stroke(Path(ellipseIn: CGRect(x: 4, y: 19.5, width: 56, height: 25)),
                         with: .color(.white.opacity(0.9)), lineWidth: 3.4)
            orbit.fill(Path(ellipseIn: CGRect(x: 50.6, y: 20.2, width: 10.8, height: 10.8)), with: .color(.white))

            ctx.fill(Path(roundedRect: CGRect(x: 19, y: 20, width: 26, height: 24), cornerRadius: 6, style: .continuous),
                     with: .color(.white))
            var prompt = Path()
            prompt.move(to: CGPoint(x: 25, y: 27.5))
            prompt.addLine(to: CGPoint(x: 30, y: 32))
            prompt.addLine(to: CGPoint(x: 25, y: 36.5))
            prompt.move(to: CGPoint(x: 33, y: 35.8))
            prompt.addLine(to: CGPoint(x: 39.5, y: 35.8))
            ctx.stroke(prompt, with: .color(Color(red: 0.20, green: 0.44, blue: 1)),
                       style: StrokeStyle(lineWidth: 2.9, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
    }
}
