import Foundation

/// One git repo in the projects folder (`GET /api/repos`), as the web's home counts it.
public struct RepoSummary: Codable, Hashable, Identifiable {
    public var name: String
    public var path: String
    public var branch: String
    public var ahead: Int
    public var behind: Int
    public var staged: Int
    public var modified: Int
    public var untracked: Int
    public var totalCommits: Int
    /// Commits per day, oldest first, the last 26 weeks.
    public var daily: [Int]
    public var error: String?

    public var id: String { name }
    /// Has local changes (staged, modified or untracked).
    public var isDirty: Bool { staged + modified + untracked > 0 }
    public var commits30: Int { daily.suffix(30).reduce(0, +) }
    public var commitsPrior30: Int { daily.dropLast(30).suffix(30).reduce(0, +) }
}

/// A repo's open pull requests and issues on GitHub (`GET /api/repos/github`, by repo name; read `slug`, not the
/// key, since the decoder's snake-case conversion may rewrite keys).
public struct RepoGithub: Codable, Hashable {
    public struct Item: Codable, Hashable, Identifiable {
        public var number: Int
        public var title: String
        public var author: String
        public var url: String
        public var draft: Bool
        public var updatedAt: Date
        public var id: String { url }
    }

    /// "owner/name"
    public var slug: String?
    public var pulls: [Item]
    public var issues: [Item]
    public var error: String?
}

/// `GET /api/agents/summary?totals=true` without the per-agent rows: runs and spend this period, the one before,
/// and all time.
public struct AgentsTotals: Codable, Hashable {
    public struct Spend: Codable, Hashable { public var runs: Int; public var costUsd: Double }
    public struct Period: Codable, Hashable {
        /// `usage_week` (since the plan's weekly reset) or `last_7_days`
        public var kind: String
        public var runs: Int
        public var costUsd: Double
        public var previous: Spend
    }

    public var period: Period
    public var allTime: Spend
}
