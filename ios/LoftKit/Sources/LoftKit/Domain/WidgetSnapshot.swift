import Foundation

/// Where a tap on a widget opens the app: `loft://needs-you`, `loft://agents` or `loft://agent/<id>`.
public enum DeepLink: Equatable {
    case needsYou
    case agents
    case agent(String)

    public var url: URL {
        switch self {
        case .needsYou: URL(string: "loft://needs-you")!
        case .agents: URL(string: "loft://agents")!
        case .agent(let id): URL(string: "loft://agent/\(id)")!
        }
    }

    public init?(url: URL) {
        guard url.scheme == "loft" else { return nil }
        switch url.host {
        case "needs-you": self = .needsYou
        case "agents": self = .agents
        case "agent":
            guard let id = url.pathComponents.dropFirst().first, !id.isEmpty else { return nil }
            self = .agent(id)
        default: return nil
        }
    }
}

/// What the widgets show (spec #382): Needs you (the count and the first items), who is working now and the spend.
public struct WidgetSnapshot: Equatable {
    public enum Phase: Equatable {
        /// The app hasn't connected to a Loft yet.
        case notConnected
        /// Connected, but Loft didn't answer.
        case unreachable
        case ready
    }

    public struct Item: Equatable, Identifiable {
        public let id: String
        public let title: String
        public let agentName: String?
        /// 3 blocks an agent now … 0 to review.
        public let urgency: Int
        public let link: DeepLink
        /// One short line: the item's reason, or for a permission what will run (`permissionSubject`) when it has a short
        /// one-line form.
        public var summary = ""
        /// A permission's Allow once and Deny, sent as the server gave them (spec #462); nil on everything else. Approve
        /// only when the summary shows what will run whole; Deny on every permission.
        public var approve: NeedsYouAction?
        public var deny: NeedsYouAction?
    }

    /// The Needs you widget's large size shows this many; the overview widget the first `overviewLimit`.
    public static let itemLimit = 6
    public static let overviewLimit = 3

    public var phase: Phase
    public var needsCount = 0
    public var urgent = 0
    public var items: [Item] = []
    public var working: [String] = []
    /// What the Usage week's runs cost, in US dollars; nil when Loft didn't say.
    public var weekSpend: Double?

    public static let notConnected = WidgetSnapshot(phase: .notConnected)
    public static let unreachable = WidgetSnapshot(phase: .unreachable)

    public init(phase: Phase) { self.phase = phase }

    /// `permissions`: an agent with one pending is waiting on the user, not working (like the menu bar).
    public init(needsYou: NeedsYouList, agents: [Agent], permissions: [PermissionRequest] = [], weekSpend: Double?) {
        phase = .ready
        needsCount = needsYou.count
        urgent = needsYou.urgent
        items = needsYou.items.prefix(Self.itemLimit).map {
            let agentId = $0.openAction?.target?.agentId ?? $0.agent?.id
            let isPermission = $0.type == "permission"
            let subject = isPermission ? Self.permissionSubject($0.text) : nil
            return Item(id: $0.id, title: $0.title, agentName: $0.agent?.name, urgency: $0.urgency,
                        link: agentId.map(DeepLink.agent) ?? .needsYou,
                        summary: subject ?? $0.reason,
                        approve: subject == nil ? nil : $0.actions.first { $0.kind == "approve" && $0.isRequest },
                        deny: isPermission ? $0.actions.first { $0.kind == "deny" && $0.isRequest } : nil)
        }
        working = agents.filter { a in
            AgentState(agent: a, pendingApprovals: permissions.filter { $0.isPending && $0.agentId == a.id }.count) == .working
        }
            .map(\.name).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        self.weekSpend = weekSpend
    }

    /// The longest subject the widget approves: it wraps to at most three caption lines, so it always shows whole.
    public static let subjectLimit = 60

    /// What a permission will run, as the server's text says it (backend `permission_text`): the `$ command` line for
    /// Bash (never the agent's own description above it), else the path or URL. Nil when the widget can't show it whole:
    /// more than one line, cut by the server, longer than `subjectLimit`, or a tool with no one-line form (its JSON).
    static func permissionSubject(_ text: String) -> String? {
        let lines = text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
        // Bash: the command starts at its "$ " line and runs to the end of the text.
        let subject = lines.firstIndex { $0.hasPrefix("$ ") }.map { lines[$0...] } ?? lines[...]
        guard subject.count == 1, let line = subject.first?.trimmingCharacters(in: .whitespaces), !line.isEmpty,
              line != "$", !line.hasPrefix("{"), !line.hasPrefix("["), !line.hasSuffix("…"), line.count <= subjectLimit else { return nil }
        return line
    }

    /// "$12.40", or nil when the spend is unknown.
    public var spendText: String? {
        weekSpend.map { $0.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US"))) }
    }

    /// Reads Loft at the address the app connected to.
    public static func load() async -> WidgetSnapshot {
        guard let server = SharedServer.address else { return .notConnected }
        let api = LiveLoftAPI(baseURL: server)
        return await load(needsYou: api.needsYou, agents: api.agents, permissions: api.permissions, weekSpend: api.weekSpend)
    }

    /// Needs you and the agents are required; the permissions (who counts as working) and the spend are extras, so
    /// either failing (an older Loft, a timeout) leaves them out instead of making Loft look unreachable.
    static func load(needsYou: () async throws -> NeedsYouList, agents: () async throws -> [Agent],
                     permissions: () async throws -> [PermissionRequest], weekSpend: () async throws -> Double) async -> WidgetSnapshot {
        do {
            async let needs = needsYou()
            async let list = agents()
            async let asks = try? permissions()
            async let spend = try? weekSpend()
            return WidgetSnapshot(needsYou: try await needs, agents: try await list, permissions: await asks ?? [], weekSpend: await spend)
        } catch {
            return .unreachable
        }
    }
}
