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
        /// Nothing paired with a Loft yet.
        case notPaired
        /// Paired, but Loft didn't answer.
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
    }

    public static let itemLimit = 3

    public var phase: Phase
    public var needsCount = 0
    public var urgent = 0
    public var items: [Item] = []
    public var working: [String] = []
    /// What the Usage week's runs cost, in US dollars; nil when Loft didn't say.
    public var weekSpend: Double?

    public static let notPaired = WidgetSnapshot(phase: .notPaired)
    public static let unreachable = WidgetSnapshot(phase: .unreachable)

    public init(phase: Phase) { self.phase = phase }

    public init(needsYou: NeedsYouList, agents: [Agent], weekSpend: Double?) {
        phase = .ready
        needsCount = needsYou.count
        urgent = needsYou.urgent
        items = needsYou.items.prefix(Self.itemLimit).map {
            let agentId = $0.openAction?.target?.agentId ?? $0.agent?.id
            return Item(id: $0.id, title: $0.title, agentName: $0.agent?.name, urgency: $0.urgency,
                        link: agentId.map(DeepLink.agent) ?? .needsYou)
        }
        working = agents.filter { AgentState(agent: $0, pendingApprovals: 0) == .working }
            .map(\.name).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        self.weekSpend = weekSpend
    }

    /// "$12.40", or nil when the spend is unknown.
    public var spendText: String? {
        weekSpend.map { $0.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US"))) }
    }

    /// Reads Loft as the paired app does: the token and address from the shared Keychain group.
    public static func load() async -> WidgetSnapshot {
        guard let paired = ClientToken.paired() else { return .notPaired }
        let api = LiveLoftAPI(baseURL: paired.server)
        do {
            async let needs = api.needsYou()
            async let agents = api.agents()
            async let spend = try? api.weekSpend()
            return WidgetSnapshot(needsYou: try await needs, agents: try await agents, weekSpend: await spend)
        } catch APIError.server(status: 401, _) {
            return .notPaired
        } catch {
            return .unreachable
        }
    }
}
