import Foundation
import Security

/// Pairing with Loft (spec #164, ADR 0004): only a paired client may change things through the API. The app
/// shows a code, polls with a secret, and keeps the token it gets in the Keychain.
public enum Pairing {
    /// Posted when Loft refuses a request because this app isn't paired (a 401): the pairing screen comes back.
    public static let unpairedNotification = Notification.Name("loft.unpaired")

    public static func reportUnpaired() {
        NotificationCenter.default.post(name: unpairedNotification, object: nil)
    }

    public static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }

    /// Why this app may not pair, or nil when it may. Agents drive the Simulator and can read its files, so it
    /// never holds a token; neither does the demo. `fixture`: UI tests may walk the pairing screen on fixture data
    /// (`-fixture-pairing`), where nothing is ever stored.
    public static func refusal(isDemo: Bool, fixture: Bool) -> String? {
        if isDemo {
            return "The demo runs on sample data and never pairs with a Mac. Leave the demo to pair this iPhone."
        }
        if isSimulator && !fixture {
            return "Loft never pairs the iOS Simulator: agents drive it and can read its files. Pair from a real iPhone, or open the demo's sample data here."
        }
        return nil
    }
}

/// `POST /api/pair`: the code to show, and the secret to poll with (never shown).
public struct PairingStart: Decodable, Equatable {
    public var secret: String
    public var code: String
    public var expiresIn: Int?
}

/// A browser or iPhone paired with Loft (`GET /api/paired-clients`); `this` is the one asking.
public struct PairedClient: Decodable, Identifiable, Equatable {
    public var id: String
    public var name: String
    public var pairedAt: Date
    public var lastUsedAt: Date
    public var this: Bool
}

/// `POST /api/pair/poll`: `pending`, `denied`, `gone` (expired, cancelled or already collected), or `allowed`
/// with the token, once.
public struct PairingPoll: Decodable, Equatable {
    public var status: String
    public var token: String?
}

/// This app's token for one Loft server, in the Keychain only (`AfterFirstUnlockThisDeviceOnly`: not in backups,
/// not synced). In the Simulator nothing is ever read or written. The item sits in the Keychain group the apps and
/// the widgets share (`<team>.<bundle id>.shared`, the first group in their entitlements), so the widgets read the
/// token through LoftKit with no other storage: the item's account is the server's address.
public enum ClientToken {
    private static let service = "loft.client-token"
    /// The shared group's name ends with this; a token saved before the widgets existed sits in the app's own group.
    private static let sharedSuffix = ".shared"

    public static func load(for server: URL) -> String? {
        read(query(server))?.token
    }

    /// The server and token the apps paired with, for a widget that doesn't know the address; nil when unpaired.
    public static func paired() -> (server: URL, token: String)? {
        guard let found = read(query(nil)), let server = found.server else { return nil }
        return (server, found.token)
    }

    private static func read(_ base: [CFString: Any]) -> (token: String, server: URL?)? {
        #if targetEnvironment(simulator)
        return nil
        #else
        var q = base
        q[kSecReturnData] = true
        q[kSecReturnAttributes] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let item = out as? [CFString: Any],
              let data = item[kSecValueData] as? Data, let token = String(data: data, encoding: .utf8) else { return nil }
        let server = (item[kSecAttrAccount] as? String).flatMap(URL.init(string:))
        // Moves a token from before the widgets into the shared group.
        if let server, let group = item[kSecAttrAccessGroup] as? String, !group.hasSuffix(sharedSuffix) { save(token, for: server) }
        return (token, server)
        #endif
    }

    @discardableResult
    public static func save(_ token: String, for server: URL) -> Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        SecItemDelete(query(server) as CFDictionary)
        var q = query(server)
        q[kSecValueData] = Data(token.utf8)
        q[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
        #endif
    }

    public static func delete(for server: URL) {
        #if !targetEnvironment(simulator)
        SecItemDelete(query(server) as CFDictionary)
        #endif
    }

    private static func query(_ server: URL?) -> [CFString: Any] {
        var q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service]
        if let server { q[kSecAttrAccount] = server.absoluteString }
        #if os(macOS)
        // Access groups only exist in the data protection Keychain.
        q[kSecUseDataProtectionKeychain] = true
        #endif
        return q
    }
}
