import Foundation

/// 后端统一响应包装：`{ ok: Bool, data: T? , error: String? }`
struct APIEnvelope<T: Decodable>: Decodable {
    var ok: Bool
    var data: T?
    var error: String?
}

enum APIError: LocalizedError {
    case badURL
    case notOK(String)
    case emptyData
    case transport(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "服务器地址无效"
        case .notOK(let m):
            return m.isEmpty ? "请求失败" : m
        case .emptyData:
            return "服务器返回空数据"
        case .transport(let e):
            return "网络错误：\(e.localizedDescription)"
        case .decoding:
            return "数据解析失败"
        }
    }
}

/// 局域网后端 REST 客户端
actor APIClient {
    static let shared = APIClient()

    private var baseURL: URL?

    func setBaseURL(_ urlString: String?) {
        var s = (urlString ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty {
            baseURL = nil
            return
        }
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") {
            s = "http://" + s
        }
        // 去掉尾部斜杠
        while s.hasSuffix("/") { s.removeLast() }
        baseURL = URL(string: s)
    }

    func currentBaseURL() -> URL? { baseURL }

    private func requireBase() throws -> URL {
        guard let baseURL else { throw APIError.badURL }
        return baseURL
    }

    // MARK: - 底层请求

    private func get<T: Decodable>(_ path: String,
                                   query: [String: String?] = [:],
                                   as type: T.Type = T.self) async throws -> T {
        let base = try requireBase()
        var comps = URLComponents(url: base.appendingPathComponent(path),
                                  resolvingAgainstBaseURL: false)
        var items: [URLQueryItem] = []
        for (k, v) in query {
            if let v, !v.isEmpty { items.append(URLQueryItem(name: k, value: v)) }
        }
        if !items.isEmpty { comps?.queryItems = items }
        guard let url = comps?.url else { throw APIError.badURL }

        var req = URLRequest(url: url)
        req.timeoutInterval = 90
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.transport(error)
        }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.notOK("HTTP \(http.statusCode)")
        }
        do {
            let env = try JSONDecoder().decode(APIEnvelope<T>.self, from: data)
            guard env.ok else { throw APIError.notOK(env.error ?? "服务端返回失败") }
            guard let value = env.data else { throw APIError.emptyData }
            return value
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.decoding(error)
        }
    }

    // MARK: - 业务接口

    /// 拉取配置
    func fetchConfig() async throws -> ServerConfig {
        try await get("api/config", as: ServerConfig.self)
    }

    /// 健康检查（用于「测试连接」）
    func health() async throws -> Bool {
        struct Health: Decodable {
            var ok: Bool
            var sites: Int?
        }
        let h: Health = try await get("api/health", as: Health.self)
        return h.ok
    }

    /// 首页：分类 + 推荐
    func home(site: String) async throws -> HomeResponse {
        try await get("api/site/\(site)/home", as: HomeResponse.self)
    }

    /// 分类分页
    func category(site: String, tid: String, pg: Int, filter: [String: String] = [:]) async throws -> VodPage {
        var q: [String: String?] = ["tid": tid, "pg": String(pg)]
        for (k, v) in filter { q[k] = v }
        return try await get("api/site/\(site)/category", query: q, as: VodPage.self)
    }

    /// 详情
    func detail(site: String, id: String) async throws -> DetailResponse {
        // vod_id 可能含 # $ @@ 等字符，必须正确编码；用 query 而非 path
        return try await get("api/site/\(site)/detail", query: ["id": id], as: DetailResponse.self)
    }

    /// 搜索
    func search(site: String, keyword: String, pg: Int = 1) async throws -> VodPage {
        try await get("api/site/\(site)/search",
                      query: ["wd": keyword, "pg": String(pg)],
                      as: VodPage.self)
    }

    /// 播放解析
    func play(site: String, flag: String, url: String) async throws -> PlayResult {
        try await get("api/site/\(site)/play",
                      query: ["flag": flag, "id": url],
                      as: PlayResult.self)
    }

    /// 运行时日志（调试用）
    func logs(site: String) async throws -> String {
        struct LogsWrap: Decodable { var logs: String }
        let l: LogsWrap = try await get("api/site/\(site)/logs", as: LogsWrap.self)
        return l.logs
    }
}