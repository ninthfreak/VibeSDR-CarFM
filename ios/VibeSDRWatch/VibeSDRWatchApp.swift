import SwiftUI

@main
struct VibeSDRWatchApp: App {
  @StateObject private var link = WatchLink.shared

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(link)
        .onAppear { link.activate() }
    }
  }
}
