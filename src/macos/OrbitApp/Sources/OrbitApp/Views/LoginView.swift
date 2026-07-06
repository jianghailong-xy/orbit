import SwiftUI
import OrbitKit

struct LoginView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 14) {
            Image(systemName: "circle.hexagongrid.fill")
                .font(.orbitHeroGlyph)
                .foregroundStyle(.tint)
            Text("Orbit").font(.largeTitle.bold())
            Text("Sign in to your instance").foregroundStyle(.secondary)

            VStack(spacing: 10) {
                TextField("Instance URL (e.g. orbit.example.com)", text: $model.instanceField)
                    .textContentType(.URL)
                TextField("Email", text: $model.email)
                    .textContentType(.username)
                SecureField("Password", text: $model.password)
                    .textContentType(.password)
                    .onSubmit { Task { await model.login() } }
            }
            .textFieldStyle(.roundedBorder)
            .frame(width: 320)

            if let e = model.errorText {
                Text(e).font(.orbitProseAside).foregroundStyle(.red).frame(width: 320)
            }

            Button {
                Task { await model.login() }
            } label: {
                Text(model.busy ? "Signing in…" : "Sign in").frame(width: 200)
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.return)
            .disabled(model.busy || model.email.isEmpty || model.password.isEmpty)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
