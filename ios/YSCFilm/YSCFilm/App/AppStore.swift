import Foundation

/// 本地持久化：服务器地址、收藏、历史
@MainActor
final class AppStore: ObservableObject {
    @Published var serverURL: String {
        didSet {
            UserDefaults.standard.set(serverURL, forKey: Keys.serverURL)
            Task { await APIClient.shared.setBaseURL(serverURL) }
        }
    }

    @Published var selectedSiteKey: String {
        didSet { UserDefaults.standard.set(selectedSiteKey, forKey: Keys.siteKey) }
    }

    @Published var config: ServerConfig?
    @Published var isLoadingConfig = false
    @Published var configError: String?

    @Published var favorites: [FavoriteItem] {
        didSet { saveJSON(favorites, key: Keys.favorites) }
    }

    @Published var history: [HistoryItem] {
        didSet { saveJSON(history, key: Keys.history) }
    }

    private enum Keys {
        static let serverURL = "ysc.serverURL"
        static let siteKey = "ysc.siteKey"
        static let favorites = "ysc.favorites"
        static let history = "ysc.history"
    }

    init() {
        let saved = UserDefaults.standard.string(forKey: Keys.serverURL) ?? ""
        // 默认指向本机，局域网场景下用户首次启动时改成电脑 IP
        self.serverURL = saved.isEmpty ? "http://192.168.20.103:9527" : saved
        self.selectedSiteKey = UserDefaults.standard.string(forKey: Keys.siteKey) ?? ""
        if let data = UserDefaults.standard.data(forKey: Keys.favorites),
           let v = try? JSONDecoder().decode([FavoriteItem].self, from: data) {
            self.favorites = v
        } else {
            self.favorites = []
        }
        if let data = UserDefaults.standard.data(forKey: Keys.history),
           let v = try? JSONDecoder().decode([HistoryItem].self, from: data) {
            self.history = v
        } else {
            self.history = []
        }
        Task { await APIClient.shared.setBaseURL(self.serverURL) }
    }

    /// 仅本服务真正能跑的站点（CSP 插件会被服务端标 supported=false）
    var usableSites: [Site] { sites.filter { $0.supported != false } }
    /// 被跳过的不可用站点数量，设置页要如实告知用户
    var unsupportedCount: Int { sites.count - usableSites.count }

    var selectedSite: Site? {
        let pool = usableSites
        return pool.first { $0.key == selectedSiteKey } ?? pool.first
    }
    var currentSiteKey: String { selectedSite?.key ?? "" }

    func loadConfig() async {
        isLoadingConfig = true
        configError = nil
        defer { isLoadingConfig = false }
        do {
            let cfg = try await APIClient.shared.fetchConfig()
            config = cfg
            let pool = usableSites
            if pool.isEmpty {
                // 配置里一个能跑的站点都没有 —— 必须说清楚原因，
                // 否则首页只会是一片空白，用户无从判断哪里出错
                let csp = sites.filter { $0.kind == "csp" }.count
                let file = sites.filter { $0.kind == "ext_file" }.count
                if sites.isEmpty {
                    configError = "配置里没有任何站点"
                } else {
                    var parts: [String] = []
                    if csp > 0 { parts.append("\(csp) 个 CSP 插件（Android 原生 Java 插件）") }
                    if file > 0 { parts.append("\(file) 个依赖 TVBox 客户端私有规则文件（不随配置分发）") }
                    configError = "配置里 \(sites.count) 个站点全部无法在本服务运行："
                        + parts.joined(separator: "、")
                        + "。请换一个提供 dr_py 内联规则或接口地址的配置。"
                }
                return
            }
            if selectedSiteKey.isEmpty || !pool.contains(where: { $0.key == selectedSiteKey }) {
                selectedSiteKey = pool.first?.key ?? ""
            }
        } catch {
            configError = error.localizedDescription
        }
    }

    func testConnection() async -> String {
        do {
            let ok = try await APIClient.shared.health()
            return ok ? "连接成功" : "服务未就绪"
        } catch {
            return "连接失败：\(error.localizedDescription)"
        }
    }

    // MARK: - 收藏

    func isFavorite(_ vodId: String) -> Bool {
        favorites.contains { $0.vodId == vodId }
    }

    func toggleFavorite(_ vod: Vod, siteKey: String) {
        if let idx = favorites.firstIndex(where: { $0.vodId == vod.vod_id }) {
            favorites.remove(at: idx)
        } else {
            favorites.insert(FavoriteItem(vod: vod, siteKey: siteKey,
                                         date: Date()), at: 0)
        }
    }

    // MARK: - 历史

    func addHistory(_ vod: Vod, siteKey: String) {
        history.removeAll { $0.vodId == vod.vod_id }
        history.insert(HistoryItem(vod: vod, siteKey: siteKey, date: Date()), at: 0)
        if history.count > 300 { history.removeLast(history.count - 300) }
    }

    func clearHistory() { history.removeAll() }

    // MARK: - 持久化

    private func saveJSON<T: Encodable>(_ value: T, key: String) {
        if let data = try? JSONEncoder().encode(value) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}

struct FavoriteItem: Codable, Identifiable, Hashable {
    var vod: Vod
    var siteKey: String
    var date: Date
    var id: String { vod.vod_id + "#" + siteKey }
    var vodId: String { vod.vod_id }
}

struct HistoryItem: Codable, Identifiable, Hashable {
    var vod: Vod
    var siteKey: String
    var date: Date
    var id: String { vod.vod_id + "#" + siteKey }
    var vodId: String { vod.vod_id }
}