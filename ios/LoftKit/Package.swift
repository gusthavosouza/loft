// swift-tools-version: 5.10
import PackageDescription

// The code the iPhone and Mac apps share: models, the API client, the store, pairing, the on-device model and
// the voice pipeline. Anything only one platform has sits in Sources/LoftKit/Platform.
let package = Package(
    name: "LoftKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "LoftKit", targets: ["LoftKit"])],
    targets: [.target(name: "LoftKit")]
)
