import SwiftUI

@main
struct VibeSDRWatchApp: App {
  @StateObject private var link = WatchLink.shared

  var body: some Scene {
    WindowGroup {
      // NavigationStack so the numpad can be PUSHED. As a sheet it came with a
      // mandatory header (X + clock + grab handle) that stole ~100pt and cut the
      // bottom row off; that chrome cannot be removed from a sheet.
      NavigationStack {
        ContentView()
          .environmentObject(link)
          .navigationBarHidden(true)   // the waterfall is full-bleed; no bar on it
      }
      .onAppear { link.activate() }
    }
  }
}
