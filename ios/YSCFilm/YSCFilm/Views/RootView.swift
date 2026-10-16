import SwiftUI

struct RootView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: AppRouter

    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("首页", systemImage: "house.fill") }
                .tag(0)

            FavoritesView()
                .tabItem { Label("收藏", systemImage: "star.fill") }
                .tag(1)

            HistoryView()
                .tabItem { Label("历史", systemImage: "clock.fill") }
                .tag(2)

            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape.fill") }
                .tag(3)
        }
        .sheet(isPresented: $router.showPlayer) {
            PlayerView()
                .environmentObject(store)
                .environmentObject(router)
                .environmentObject(player)
        }
        .sheet(isPresented: $router.showSearch) {
            SearchView()
                .environmentObject(store)
                .environmentObject(router)
        }
        .sheet(isPresented: $router.showDetail) {
            if let vod = router.pendingVod {
                DetailView(vodId: vod.vod_id)
                    .environmentObject(store)
                    .environmentObject(router)
            }
        }
        .task {
            if store.config == nil { await store.loadConfig() }
        }
    }
}