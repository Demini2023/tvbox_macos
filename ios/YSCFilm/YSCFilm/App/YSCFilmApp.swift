import SwiftUI

@main
struct YSCFilmApp: App {
    @StateObject private var store = AppStore()
    @StateObject private var player = PlayerController()
    @StateObject private var router = AppRouter()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(player)
                .environmentObject(router)
                .preferredColorScheme(.dark)
        }
    }
}

/// 极简路由：集中管理 sheet 呈现，避免散落的全局单例
@MainActor
final class AppRouter: ObservableObject {
    @Published var showPlayer = false
    @Published var showSettings = false
    @Published var showSearch = false
    @Published var showDetail = false

    /// 待查看的影片（首页/收藏/历史/搜索 都走这里）
    @Published var pendingVod: Vod?

    func showDetail(for vod: Vod) {
        pendingVod = vod
        showDetail = true
    }
}