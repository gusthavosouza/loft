import SwiftUI
import WebKit

/// Workers: the Loft server's `/workers` page in a full-screen web view, with a native close button.
/// The page tells the app which agent was tapped (`openAgent`), and the chat opens natively.
struct WorkersView: View {
    @Environment(LoftStore.self) private var store
    @Environment(Router.self) private var router

    private var url: URL? {
        guard let base = store.api?.baseURL else { return nil }
        var c = URLComponents(url: base.appendingPathComponent("workers"), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "display", value: "1")]
        return c?.url
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(red: 0.06, green: 0.05, blue: 0.11).ignoresSafeArea()
            if let url {
                WorkersWebView(url: url) { id in
                    router.workers = false
                    router.openChat(id)
                }
                .ignoresSafeArea()
                .accessibilityIdentifier("workersWeb")
            } else {
                ContentUnavailableView("Not connected", systemImage: "wifi.slash")
                    .environment(\.colorScheme, .dark)
            }
            Button { router.workers = false } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .foregroundStyle(.white)
            .padding(12)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("closeWorkers")
        }
        .preferredColorScheme(.dark)
    }
}

private struct WorkersWebView: UIViewRepresentable {
    let url: URL
    let onOpenAgent: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onOpenAgent) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "openAgent")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.06, green: 0.05, blue: 0.11, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "openAgent")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let onOpenAgent: (String) -> Void
        init(_ onOpenAgent: @escaping (String) -> Void) { self.onOpenAgent = onOpenAgent }

        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            if let id = message.body as? String, !id.isEmpty { onOpenAgent(id) }
        }
    }
}
