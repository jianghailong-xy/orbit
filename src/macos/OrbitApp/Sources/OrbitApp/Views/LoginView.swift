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
                        .disabled(model.busy || model.googleBusy || model.email.isEmpty || model.password.isEmpty)
                        .padding(.top, 8)

                        if model.signInMethods.google {
                            googleSignIn
                        }
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
        // Whether this server offers Google: asked when the page appears, and again when the
        // hidden server sheet changes the server.
        .task(id: model.instanceField) { await model.loadSignInMethods() }
    }

    /// Continue with Google, under the form, for a server that offers it (docs/google-sign-in-design.md
    /// §8.2) — and, where Google opens new accounts, the line that says so.
    @ViewBuilder private var googleSignIn: some View {
        HStack(spacing: 12) {
            Rectangle().fill(.quaternary).frame(height: 1)
            Text("or").font(.orbitLabel).foregroundStyle(.secondary)
            Rectangle().fill(.quaternary).frame(height: 1)
        }
        .padding(.vertical, 4)
        Button {
            Task { await model.loginWithGoogle() }
        } label: {
            HStack(spacing: 10) {
                if model.googleBusy {
                    ProgressView().controlSize(.small)
                } else {
                    GoogleMark().frame(width: 18, height: 18)
                }
                Text("Continue with Google")
            }
        }
        .buttonStyle(GoogleButtonStyle())
        .disabled(model.busy || model.googleBusy)
        if model.signInMethods.googleSignup {
            Text("New to Orbit? Continue with Google to create an account.")
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
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

/// Google's sign-in button, in the colours its branding guidelines give for a light and a dark
/// page, shaped like the Sign In capsule above it.
private struct GoogleButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorScheme) private var colorScheme

    func makeBody(configuration: Configuration) -> some View {
        let dark = colorScheme == .dark
        configuration.label
            .font(.headline)
            .foregroundStyle(dark ? Color(red: 0.890, green: 0.890, blue: 0.890) : Color(red: 0.122, green: 0.122, blue: 0.122))
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Capsule().fill(dark ? Color(red: 0.075, green: 0.075, blue: 0.078) : .white))
            .overlay(Capsule().strokeBorder(dark ? Color(red: 0.557, green: 0.569, blue: 0.561)
                                                 : Color(red: 0.455, green: 0.467, blue: 0.459)))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
            .contentShape(Capsule())
    }
}

/// Google's four-colour "G", unaltered: the 48-unit mark of Google's sign-in button, as vectors
/// (the macOS build ships no asset catalog — see `OrbitAppIcon`).
private struct GoogleMark: View {
    var body: some View {
        Canvas { ctx, canvas in
            ctx.scaleBy(x: canvas.width / 48, y: canvas.height / 48)
            ctx.fill(Self.red, with: .color(Color(red: 0.918, green: 0.263, blue: 0.208)))
            ctx.fill(Self.blue, with: .color(Color(red: 0.259, green: 0.522, blue: 0.957)))
            ctx.fill(Self.yellow, with: .color(Color(red: 0.984, green: 0.737, blue: 0.020)))
            ctx.fill(Self.green, with: .color(Color(red: 0.204, green: 0.659, blue: 0.325)))
        }
        .accessibilityHidden(true)
    }

    private static func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }

    private static let red = Path { p in
        p.move(to: pt(24, 9.5))
        p.addCurve(to: pt(33.21, 13.1), control1: pt(27.54, 9.5), control2: pt(30.71, 10.72))
        p.addLine(to: pt(40.06, 6.25))
        p.addCurve(to: pt(24, 0), control1: pt(35.9, 2.38), control2: pt(30.47, 0))
        p.addCurve(to: pt(2.56, 13.22), control1: pt(14.62, 0), control2: pt(6.51, 5.38))
        p.addLine(to: pt(10.54, 19.41))
        p.addCurve(to: pt(24, 9.5), control1: pt(12.43, 13.72), control2: pt(17.74, 9.5))
        p.closeSubpath()
    }

    private static let blue = Path { p in
        p.move(to: pt(46.98, 24.55))
        p.addCurve(to: pt(46.6, 20), control1: pt(46.98, 22.98), control2: pt(46.83, 21.46))
        p.addLine(to: pt(24, 20))
        p.addLine(to: pt(24, 29.02))
        p.addLine(to: pt(36.94, 29.02))
        p.addCurve(to: pt(32.16, 36.2), control1: pt(36.36, 31.98), control2: pt(34.68, 34.5))
        p.addLine(to: pt(39.89, 42.2))
        p.addCurve(to: pt(46.98, 24.55), control1: pt(44.4, 38.02), control2: pt(46.98, 31.84))
        p.closeSubpath()
    }

    private static let yellow = Path { p in
        p.move(to: pt(10.53, 28.59))
        p.addCurve(to: pt(9.77, 24), control1: pt(10.05, 27.14), control2: pt(9.77, 25.6))
        p.addCurve(to: pt(10.53, 19.41), control1: pt(9.77, 22.4), control2: pt(10.04, 20.86))
        p.addLine(to: pt(2.55, 13.22))
        p.addCurve(to: pt(0, 24), control1: pt(0.92, 16.46), control2: pt(0, 20.12))
        p.addCurve(to: pt(2.56, 34.78), control1: pt(0, 27.88), control2: pt(0.92, 31.54))
        p.addLine(to: pt(10.53, 28.59))
        p.closeSubpath()
    }

    private static let green = Path { p in
        p.move(to: pt(24, 48))
        p.addCurve(to: pt(39.89, 42.19), control1: pt(30.48, 48), control2: pt(35.93, 45.87))
        p.addLine(to: pt(32.16, 36.19))
        p.addCurve(to: pt(24, 38.49), control1: pt(30.01, 37.64), control2: pt(27.24, 38.49))
        p.addCurve(to: pt(10.53, 28.58), control1: pt(17.74, 38.49), control2: pt(12.43, 34.27))
        p.addLine(to: pt(2.55, 34.77))
        p.addCurve(to: pt(24, 48), control1: pt(6.51, 42.62), control2: pt(14.62, 48))
        p.closeSubpath()
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
