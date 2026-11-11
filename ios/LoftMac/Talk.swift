import AppKit
import LoftKit
import SwiftUI

/// Talk on the Mac (spec #382): you talk to one agent, tap Done, and the tidied text lands in that agent's chat
/// message box to read and send. It only reads `VoiceSession` (LoftKit's pipeline: one audio owner, one reader)
/// and calls its actions.
struct TalkSheet: View {
    @Environment(LoftStore.self) private var store
    @Environment(VoiceSession.self) private var voice
    @Environment(\.dismiss) private var dismiss
    let agentId: String
    /// The tidied text and who it's for, to put in that chat's message box.
    let done: (String, String) -> Void
    @State private var picking = false

    private var current: String { voice.agentId ?? agentId }

    var body: some View {
        VStack(spacing: 18) {
            toRow
            Group {
                if case .failed(let message) = voice.phase {
                    failed(message)
                } else if voice.phase == .cleaning || voice.phase == .review {
                    ProgressView("Tidying up…").frame(maxHeight: .infinity)
                } else {
                    dictate
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                Button("Cancel") { voice.discard(); dismiss() }.keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("talkCancel")
                Spacer()
                if case .failed = voice.phase {} else {
                    Button { Task { await voice.finish() } } label: { Label("Done", systemImage: "mic.fill") }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(voice.raw.isEmpty || voice.phase != .listening)
                        .accessibilityIdentifier("talkDone")
                }
            }
        }
        .padding(20)
        .frame(width: 520, height: 400)
        .task { await voice.start(agentId: agentId) }
        .onChange(of: voice.phase) { _, p in
            // The tidied text goes to the chat's message box, to read there and send.
            guard p == .review, voice.autoSendAt == nil else { return }
            let text = voice.cleaned ?? voice.raw
            let id = current
            voice.discard()
            done(text, id)
            dismiss()
        }
        .onDisappear { if voice.isActive { voice.discard() } }
    }

    // MARK: To: row

    private var toRow: some View {
        let shown = TalkRecipients.chips(store.agents, current: current)
        return HStack(spacing: 8) {
            Text("To").foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack {
                    ForEach(shown) { a in
                        Button { voice.switchAgent(a.id) } label: {
                            Text(TalkRecipients.label(a, among: shown)).fontWeight(a.id == current ? .semibold : .regular)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(a.id == current ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.12), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("talkTo-\(a.name)")
                    }
                }
            }
            .scrollIndicators(.hidden)
            Button("More") { picking = true }.fixedSize().accessibilityIdentifier("talkMore")
                .popover(isPresented: $picking) { TalkMore(isPresented: $picking) }
        }
    }

    // MARK: Listening

    private var dictate: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 0)
            Group {
                if voice.committed.isEmpty && voice.live.isEmpty {
                    Text(voice.phase == .preparing ? "Getting ready…" : "Start talking…").foregroundStyle(.tertiary)
                } else {
                    Text(voice.committed) + Text(voice.committed.isEmpty || voice.live.isEmpty ? "" : " ") + Text(voice.live).foregroundStyle(Color.accentColor)
                }
            }
            .font(.title3.weight(.medium))
            .lineLimit(5)
            .truncationMode(.head)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("talkTranscript")
            Spacer(minLength: 0)
            TalkBars(level: voice.level, active: voice.phase == .listening)
            Text(voice.phase == .listening ? "Listening · \(Int(voice.elapsed))s" : " ").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }

    // MARK: Failure

    private func failed(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer(minLength: 0)
            Image(systemName: "mic.slash").font(.system(size: 40)).foregroundStyle(.secondary).accessibilityHidden(true)
            Text(voice.failureNeedsPermission ? "Loft can't use the microphone" : "Voice stopped").font(.title3.bold())
            Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
            if voice.failureNeedsPermission {
                Button("Open System Settings") { NSWorkspace.shared.open(TalkPermission.settingsURL(for: message)) }
                    .accessibilityIdentifier("talkOpenSettings")
            }
            Button("Try again") { Task { await voice.start(agentId: current) } }
                .accessibilityIdentifier("talkRetry")
            Spacer(minLength: 0)
        }
    }
}

/// Where System Settings turns access back on, for what the failure says is off.
enum TalkPermission {
    static func settingsURL(for message: String) -> URL {
        let pane = message.localizedCaseInsensitiveContains("speech") ? "Privacy_SpeechRecognition" : "Privacy_Microphone"
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
    }
}

/// Bars that rise with the voice.
struct TalkBars: View {
    var level: Float
    var active: Bool

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<21, id: \.self) { i in
                let centre = 1 - abs(CGFloat(i) - 10) / 12
                Capsule()
                    .fill(Color.accentColor.opacity(0.55 + 0.45 * centre))
                    .frame(width: 5, height: 6 + (active ? 44 * CGFloat(min(max(level, 0), 1)) * centre : 0))
            }
        }
        .frame(height: 56)
        .animation(.easeOut(duration: 0.1), value: level)
        .accessibilityHidden(true)
    }
}

/// Talk's More: every agent by group, searchable.
private struct TalkMore: View {
    @Environment(LoftStore.self) private var store
    @Environment(VoiceSession.self) private var voice
    @Binding var isPresented: Bool
    @State private var query = ""

    var body: some View {
        VStack(spacing: 8) {
            TextField("Name, title, group or project", text: $query).textFieldStyle(.roundedBorder)
            List {
                ForEach(TalkRecipients.sections(store.agents, query: query), id: \.title) { section in
                    Section(section.title) {
                        ForEach(section.agents) { a in
                            Button {
                                voice.switchAgent(a.id)
                                isPresented = false
                            } label: {
                                HStack { Text(a.name); Spacer(); if a.id == voice.agentId { Image(systemName: "checkmark") } }.contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .frame(height: 260)
        }
        .padding(12)
        .frame(width: 300)
    }
}
