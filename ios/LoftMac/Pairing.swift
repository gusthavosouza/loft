import LoftKit
import SwiftUI

/// Loft's address: this Mac by default, or another Mac's Tailscale address. Saved only once Loft answers there.
struct AddressForm: View {
    @Environment(LoftStore.self) private var store
    let isOnboarding: Bool

    static let local = "http://localhost:7420"

    @State private var address = UserDefaults.standard.string(forKey: Prefs.serverURL) ?? AddressForm.local
    @State private var checking = false
    @State private var failure: APIError?

    private var url: URL? { LiveLoftAPI.normalize(address) }
    private var saved: String? { UserDefaults.standard.string(forKey: Prefs.serverURL) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if isOnboarding {
                Image(systemName: "house.lodge.fill").font(.system(size: 40)).foregroundStyle(.tint).accessibilityHidden(true)
                Text("Connect to Loft").font(.largeTitle.bold())
                Text("Loft runs on this Mac by default. To use a Loft running on another Mac, enter its Tailscale address.")
                    .foregroundStyle(.secondary)
            } else {
                Text("Loft address").font(.headline)
            }
            HStack {
                TextField("Loft address", text: $address)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("serverAddressField")
                    .onSubmit { Task { await connect() } }
                    .onChange(of: address) { failure = nil }
                Button("This Mac") { address = Self.local }
                    .help("Loft on this Mac: \(Self.local)")
            }
            Text("This Mac: \(Self.local). Another Mac: its https address from `tailscale serve`, such as https://your-mac.your-tailnet.ts.net.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let failure {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Can't reach Loft at \(url?.absoluteString ?? address)", systemImage: "xmark.octagon.fill")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("connectError")
                    Text("\(failure.title). Check that Loft is running there and the address is right. \(failure.suggestion)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
            HStack {
                Button {
                    Task { await connect() }
                } label: {
                    Text(isOnboarding ? "Connect" : "Save and connect")
                }
                .keyboardShortcut(.defaultAction)
                .disabled(url == nil || checking || (!isOnboarding && url?.absoluteString == saved))
                .accessibilityIdentifier("saveServer")
                if checking { ProgressView().controlSize(.small) }
            }
            if !isOnboarding, store.api != nil {
                Divider()
                LabeledContent("Connection", value: store.connection.label)
                LabeledContent("This Mac", value: store.isPaired ? "Paired" : "Not paired")
                    .accessibilityIdentifier("pairedState")
                Button("Forget this Loft", role: .destructive) { store.forgetServer() }
                    .help("Removes the address and this Mac's pairing token. You pair again next time.")
            }
        }
    }

    /// Asks Loft for its info first: a wrong address or a Loft that isn't running is said here, nothing is saved.
    private func connect() async {
        guard let url else { return }
        checking = true
        defer { checking = false }
        do {
            _ = try await LiveLoftAPI(baseURL: url).info()
            store.connect(address: url.absoluteString)
        } catch {
            failure = APIError.from(error)
        }
    }
}

/// "Pair this Mac" (ADR 0004): shows the code to compare at Loft's dialog or on a paired device, polls with the
/// secret, and keeps the token in the Keychain.
struct PairScreen: View {
    @Environment(LoftStore.self) private var store

    private enum Phase: Equatable {
        case starting
        case waiting(code: String)
        case denied
        case expired
        case failed(String)
    }

    @State private var phase = Phase.starting
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "desktopcomputer").font(.system(size: 44)).foregroundStyle(.tint).accessibilityHidden(true)
            Text("Pair this Mac").font(.largeTitle.bold())
            switch phase {
            case .starting:
                ProgressView("Asking Loft…")
            case .waiting(let code):
                Text("Allow this Mac in Loft's dialog or on a paired device, after checking it shows this code:")
                    .multilineTextAlignment(.center)
                Text(code)
                    .font(.system(size: 44, weight: .bold, design: .monospaced))
                    .kerning(8)
                    .accessibilityLabel("Code \(code.map(String.init).joined(separator: " "))")
                    .accessibilityIdentifier("pairingCode")
                ProgressView().controlSize(.small).accessibilityLabel("Waiting for approval")
                Text("Only allow it if the codes match.").font(.footnote).foregroundStyle(.secondary)
            case .denied:
                outcome("Pairing was denied", "Nothing was paired. Try again if that wasn't you.")
            case .expired:
                outcome("Nobody allowed it in time", "The code expired after two minutes.")
            case .failed(let why):
                outcome("Couldn't pair", why)
            }
            Button("Change address…") { store.forgetServer() }
                .buttonStyle(.link)
                .accessibilityIdentifier("pairingChangeAddress")
        }
        .frame(maxWidth: 460)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: attempt) { await run() }
    }

    private func outcome(_ title: String, _ detail: String) -> some View {
        VStack(spacing: 10) {
            Text(title).font(.headline).accessibilityIdentifier("pairingOutcome")
            Text(detail).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Try again") { attempt += 1 }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("pairingTryAgain")
        }
    }

    /// Asks to pair, then polls every two seconds until Loft answers. Leaving the screen gives the pairing up.
    private func run() async {
        guard let api = store.api else { return }
        phase = .starting
        let start: PairingStart
        do {
            start = try await api.startPairing(name: Host.current().localizedName ?? "Mac")
        } catch {
            let e = APIError.from(error)
            phase = .failed("\(e.title). Check that Loft is running at \(api.baseURL.absoluteString).")
            return
        }
        phase = .waiting(code: start.code)
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            if Task.isCancelled { break }
            guard let poll = try? await api.pollPairing(secret: start.secret) else { continue }
            switch poll.status {
            case "allowed":
                if poll.token.map(store.finishPairing) != true {
                    phase = .failed("This Mac couldn't keep its pairing in the Keychain.")
                }
                return
            case "denied": phase = .denied; return
            case "gone": phase = .expired; return
            default: continue
            }
        }
        Task { try? await api.cancelPairing(secret: start.secret) }
    }
}
