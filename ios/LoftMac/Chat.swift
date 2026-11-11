import LoftKit
import SwiftUI
import UniformTypeIdentifiers

/// An agent's chat: its messages as they arrive, and the composer.
struct ChatView: View {
    @Environment(LoftStore.self) private var store
    let agent: Agent
    @State private var loadError: APIError?

    /// What the chat shows: the conversation's text, errors, notices and photos (not tool calls or thinking).
    private var shown: [ChatMessage] {
        store.conversation(agent.id).filter { m in
            ["text", "error", "notice"].contains(m.kind) && !(m.displayContent.isEmpty && m.photos.isEmpty)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if store.historyHasMore[agent.id] == true, !shown.isEmpty {
                        Button("Load earlier messages") { Task { try? await store.loadOlder(agent.id) } }
                            .buttonStyle(.link)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(shown) { MessageRow(message: $0) }
                    ForEach(store.pending(for: agent.id)) { PendingRow(message: $0) }
                }
                .padding(16)
            }
            .defaultScrollAnchor(.bottom)
            .accessibilityIdentifier("messageList")
            .overlay {
                if let loadError, shown.isEmpty {
                    ContentUnavailableView("Couldn't load the chat", systemImage: "exclamationmark.bubble", description: Text(loadError.title))
                }
            }
            Divider()
            Composer(agent: agent)
        }
        .task(id: agent.id) {
            do { try await store.loadConversation(agent.id); loadError = nil } catch { loadError = APIError.from(error) }
        }
    }
}

private struct MessageRow: View {
    @Environment(LoftStore.self) private var store
    let message: ChatMessage

    /// The user's own message. Another agent's handover, delegation or FYI also comes as role user, with who sent
    /// it: that one is incoming, on the left, as on the iPhone and the web.
    private var isUser: Bool { message.role == "user" && message.fromAgentName == nil }

    var body: some View {
        switch message.kind {
        case "error":
            Label(message.displayContent, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .textSelection(.enabled)
        case "notice":
            Text(message.displayContent).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        default:
            HStack(alignment: .top) {
                if isUser { Spacer(minLength: 80) }
                VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                    if let from = message.fromAgentName {
                        Text(message.isMentionReply ? "\(from) · answering your mention" : "From \(from)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tint)
                    }
                    let photos = message.photos.compactMap { store.uploadURL(agentId: message.agentId, file: $0) }
                    if !photos.isEmpty {
                        HStack { ForEach(photos, id: \.self) { Photo(url: $0) } }
                    }
                    if !message.displayContent.isEmpty {
                        Text(Self.markdown(message.displayContent))
                            .textSelection(.enabled)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .foregroundStyle(isUser ? Color.white : Color.primary)
                            .background(isUser ? Color.accentColor : Color.secondary.opacity(0.12),
                                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    Text(message.createdAt, style: .time).font(.caption2).foregroundStyle(.secondary)
                }
                if !isUser { Spacer(minLength: 80) }
            }
            // Selectable text isn't read by a combined element, so the label says it.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken)
            .accessibilityIdentifier(isUser ? "userMessage" : "agentMessage")
        }
    }

    private var spoken: String {
        var parts: [String] = []
        if let from = message.fromAgentName { parts.append(message.isMentionReply ? "\(from), answering your mention" : "From \(from)") }
        if !message.photos.isEmpty { parts.append(message.photos.count == 1 ? "Image" : "\(message.photos.count) images") }
        parts.append(message.displayContent)
        parts.append(message.createdAt.formatted(date: .omitted, time: .shortened))
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }

    static func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// A message on its way, or one that failed with Retry.
private struct PendingRow: View {
    @Environment(LoftStore.self) private var store
    let message: PendingMessage

    var body: some View {
        HStack {
            Spacer(minLength: 80)
            VStack(alignment: .trailing, spacing: 4) {
                if let n = message.images?.count, n > 0 {
                    Label(n == 1 ? "Image" : "\(n) images", systemImage: "photo").font(.caption).foregroundStyle(.secondary)
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .foregroundStyle(.white)
                        .background(Color.accentColor.opacity(message.isFailed ? 0.4 : 0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                if let failure = message.failure {
                    HStack {
                        Label("Not sent: \(failure)", systemImage: "exclamationmark.circle").foregroundStyle(.red)
                        Button("Retry") { Task { await store.retry(message) } }
                        Button("Discard") { store.discard(message) }
                    }
                    .font(.caption)
                } else {
                    Text("Sending…").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("pendingMessage")
    }
}

private struct Photo: View {
    let url: URL

    var body: some View {
        AsyncImage(url: url) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Color.secondary.opacity(0.1)
        }
        .frame(width: 180, height: 140)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityLabel("Image")
    }
}

/// An image picked or dropped: uploaded to the agent at once, sent with the next message.
private struct Attachment: Identifiable {
    let id = UUID()
    let file: URL
    var uploaded: String?
    var failure: String?
}

/// The message field, with @ to tag an agent and # to tag a spec, issue or pull request, as on the web.
/// Return sends (or picks the first suggestion while one shows); ⌥Return is a new line.
private struct Composer: View {
    @Environment(LoftStore.self) private var store
    let agent: Agent
    @State private var text = ""
    @State private var attachments: [Attachment] = []
    @State private var picksFiles = false
    @FocusState private var focused: Bool

    private var mentions: [(title: String, agents: [Agent])]? {
        MentionQuery.query(in: text).map { MentionQuery.sections($0, in: store.agents, excluding: agent.name) }
    }

    private var tags: [TagQuery.Row]? {
        TagQuery.query(in: text).map {
            TagQuery.matches(TagQuery.rows(tasks: store.tasks, prs: store.pullRequests, project: agent.project ?? ""), $0)
        }
    }

    private var canSend: Bool {
        store.canWrite && attachments.allSatisfy { $0.uploaded != nil }
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let mentions, !mentions.isEmpty {
                Suggestions {
                    ForEach(mentions, id: \.title) { section in
                        Text(section.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(section.agents) { a in
                            SuggestionButton(id: "mention-\(a.name)") { text = MentionQuery.insert(a, into: text) } label: {
                                HStack { Initials(name: a.name, lead: a.isLead, size: 20); Text(a.name) }
                            }
                        }
                    }
                }
            } else if let tags, !tags.isEmpty {
                Suggestions {
                    ForEach(tags) { r in
                        SuggestionButton(id: "tag-\(r.tag)") { text = TagQuery.insert(r.tag, into: text) } label: {
                            HStack {
                                Image(systemName: r.kind == .spec ? "doc.text" : r.kind == .pr ? "arrow.triangle.pull" : "checklist")
                                    .foregroundStyle(.secondary)
                                Text(r.tag).monospaced().foregroundStyle(.secondary)
                                Text(r.title).lineLimit(1)
                            }
                        }
                    }
                }
            }
            if !attachments.isEmpty {
                HStack {
                    ForEach(attachments) { a in
                        AttachmentChip(attachment: a) { attachments.removeAll { $0.id == a.id } }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button { picksFiles = true } label: { Image(systemName: "paperclip") }
                    .buttonStyle(.borderless)
                    .help("Attach images")
                    .accessibilityLabel("Attach images")
                    .accessibilityIdentifier("attachButton")
                TextField("Message \(agent.name)", text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($focused)
                    .onSubmit(submit)
                    .accessibilityIdentifier("composerField")
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.borderless)
                    .disabled(!canSend)
                    .help("Send (Return)")
                    .accessibilityLabel("Send")
                    .accessibilityIdentifier("sendButton")
            }
        }
        .padding(12)
        .onAppear { focused = true }
        .fileImporter(isPresented: $picksFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { attach(urls) }
        }
        .dropDestination(for: URL.self) { urls, _ in
            let images = urls.filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }
            attach(images)
            return !images.isEmpty
        }
    }

    /// Return: picks the first suggestion while the @ or # list shows, otherwise sends.
    private func submit() {
        if let a = mentions?.first?.agents.first {
            text = MentionQuery.insert(a, into: text)
        } else if let r = tags?.first {
            text = TagQuery.insert(r.tag, into: text)
        } else {
            send()
        }
        focused = true
    }

    private func send() {
        guard canSend else { return }
        let message = text, images = attachments.compactMap(\.uploaded)
        text = ""
        attachments = []
        Task { await store.send(message, to: agent.id, images: images) }
    }

    private func attach(_ urls: [URL]) {
        for url in urls {
            let a = Attachment(file: url)
            attachments.append(a)
            Task {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                do {
                    let name = try await store.upload(url, to: agent.id) { _ in }
                    if let i = attachments.firstIndex(where: { $0.id == a.id }) { attachments[i].uploaded = name }
                } catch {
                    if let i = attachments.firstIndex(where: { $0.id == a.id }) { attachments[i].failure = APIError.from(error).title }
                }
            }
        }
    }
}

private struct Suggestions<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
        .frame(maxHeight: 220)
        .fixedSize(horizontal: false, vertical: true)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("suggestions")
    }
}

private struct SuggestionButton<Label: View>: View {
    let id: String
    let action: () -> Void
    @ViewBuilder let label: Label

    var body: some View {
        Button(action: action) { label.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()) }
            .buttonStyle(.plain)
            .padding(.vertical, 2)
            .accessibilityIdentifier(id)
    }
}

private struct AttachmentChip: View {
    let attachment: Attachment
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let failure = attachment.failure {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red).help(failure)
            } else if attachment.uploaded == nil {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "photo")
            }
            Text(attachment.file.lastPathComponent).lineLimit(1).frame(maxWidth: 140)
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.borderless)
                .accessibilityLabel("Remove \(attachment.file.lastPathComponent)")
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.background.secondary, in: Capsule())
    }
}
