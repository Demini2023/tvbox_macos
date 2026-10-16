import Foundation

// MARK: - 站点

struct Site: Codable, Identifiable, Hashable {
    var key: String
    var name: String
    /// 1 = drpy2 / spider 源
    var type: Int?
    var searchable: Int?
    var quickSearch: Int?
    var categories: [Category]?

    var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, name, type, searchable, quickSearch, categories
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? key
        type = try c.decodeIfPresent(Int.self, forKey: .type)
        searchable = try c.decodeIfPresent(Int.self, forKey: .searchable) ?? 2
        quickSearch = try c.decodeIfPresent(Int.self, forKey: .quickSearch) ?? 1
        categories = try c.decodeIfPresent([Category].self, forKey: .categories)
    }
}

// MARK: - 分类

struct Category: Codable, Identifiable, Hashable {
    var type_id: String
    var type_name: String

    var id: String { type_id }

    enum CodingKeys: String, CodingKey {
        case type_id, type_name
    }

    init(typeId: String, typeName: String) {
        self.type_id = typeId
        self.type_name = typeName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let tid = try c.decodeIfPresent(String.self, forKey: .type_id)
            ?? c.decodeIfPresent(Int.self, forKey: .type_id).map { String($0) }
            ?? ""
        let tname = try c.decodeIfPresent(String.self, forKey: .type_name) ?? tid
        type_id = tid
        type_name = tname
    }
}

// MARK: - 影片条目（首页推荐 / 分类列表 / 搜索结果共用）

struct Vod: Codable, Identifiable, Hashable {
    var vod_id: String
    var vod_name: String
    var vod_pic: String?
    var vod_remarks: String?
    var vod_year: String?
    var vod_area: String?
    var vod_actor: String?
    var vod_director: String?
    var vod_content: String?

    var id: String { vod_id }

    enum CodingKeys: String, CodingKey {
        case vod_id, vod_name, vod_pic, vod_remarks
        case vod_year, vod_area, vod_actor, vod_director, vod_content
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        vod_id = try c.decodeIfPresent(String.self, forKey: .vod_id)
            ?? c.decodeIfPresent(Int.self, forKey: .vod_id).map { String($0) }
            ?? ""
        vod_name = try c.decodeIfPresent(String.self, forKey: .vod_name) ?? "未命名"
        vod_pic = try c.decodeIfPresent(String.self, forKey: .vod_pic)
        vod_remarks = try c.decodeIfPresent(String.self, forKey: .vod_remarks)
        vod_year = try c.decodeIfPresent(String.self, forKey: .vod_year)
        vod_area = try c.decodeIfPresent(String.self, forKey: .vod_area)
        vod_actor = try c.decodeIfPresent(String.self, forKey: .vod_actor)
        vod_director = try c.decodeIfPresent(String.self, forKey: .vod_director)
        vod_content = try c.decodeIfPresent(String.self, forKey: .vod_content)
    }

    /// 显式成员初始化（自定义 Codable 后 Swift 不再自动合成）
    init(vod_id: String,
         vod_name: String,
         vod_pic: String? = nil,
         vod_remarks: String? = nil,
         vod_year: String? = nil,
         vod_area: String? = nil,
         vod_actor: String? = nil,
         vod_director: String? = nil,
         vod_content: String? = nil) {
        self.vod_id = vod_id
        self.vod_name = vod_name
        self.vod_pic = vod_pic
        self.vod_remarks = vod_remarks
        self.vod_year = vod_year
        self.vod_area = vod_area
        self.vod_actor = vod_actor
        self.vod_director = vod_director
        self.vod_content = vod_content
    }

    /// 供 AsyncImage 使用；空图返回 nil
    var imageURL: URL? {
        guard let pic = vod_pic, !pic.isEmpty else { return nil }
        if pic.hasPrefix("http://") || pic.hasPrefix("https://") {
            return URL(string: pic)
        }
        return URL(string: "http://" + pic)
    }
}

// MARK: - 分页列表响应

struct VodPage: Codable {
    var page: Int?
    var pagecount: Int?
    var limit: Int?
    var total: Int?
    var list: [Vod]

    var hasMore: Bool {
        guard let pagecount = pagecount, pagecount > 0 else { return true }
        return (page ?? 1) < pagecount
    }
}

// MARK: - 首页响应

struct HomeResponse: Codable {
    var classes: ClassList?
    var list: VodPage?

    struct ClassList: Codable {
        var class: [Category]
    }
}

// MARK: - 详情响应（drpy2 返回 { list: [单个 vod] }）

struct DetailResponse: Codable {
    var list: [VodDetail]
}

/// 详情比列表多出选集信息
struct VodDetail: Codable, Identifiable, Hashable {
    var vod_id: String
    var vod_name: String
    var vod_pic: String?
    var vod_remarks: String?
    var vod_year: String?
    var vod_area: String?
    var vod_actor: String?
    var vod_director: String?
    var vod_content: String?
    var vod_play_from: String?
    var vod_play_url: String?

    var id: String { vod_id }

    var asVod: Vod {
        Vod(
            vod_id: vod_id,
            vod_name: vod_name,
            vod_pic: vod_pic,
            vod_remarks: vod_remarks,
            vod_year: vod_year,
            vod_area: vod_area,
            vod_actor: vod_actor,
            vod_director: vod_director,
            vod_content: vod_content
        )
    }

    /// 解析 `vod_play_url`：形如 `第1集$url1#第2集$url2`
    /// `vod_play_from` 形如 `线路1$$线路2`（$$ 分隔多线路）
    func episodes(forLineIndex index: Int) -> [Episode] {
        guard let raw = vod_play_url, !raw.isEmpty else { return [] }
        let lines = raw.components(separatedBy: "$$")
        let line = index < lines.count ? lines[index] : lines[0]
        return line.components(separatedBy: "#").compactMap { seg in
            let parts = seg.components(separatedBy: "$")
            guard parts.count >= 2 else { return nil }
            let name = parts[0].trimmingCharacters(in: .whitespaces)
            let url = parts[1].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, !url.isEmpty else { return nil }
            return Episode(name: name, url: url)
        }
    }

    func lineNames() -> [String] {
        guard let from = vod_play_from, !from.isEmpty else {
            return vod_play_url?.components(separatedBy: "$$").count ?? 0 > 1 ? ["默认线路"] : ["线路1"]
        }
        return from.components(separatedBy: "$$")
    }
}

struct Episode: Codable, Identifiable, Hashable {
    var name: String
    var url: String
    var id: String { url }
}

// MARK: - 播放解析结果

struct PlayResult: Codable {
    /// 0 = 直连播放；1 = 需嗅探/解析
    var parse: Int?
    var url: String
    var flag: String?
    var jx: Bool?

    var needsSniff: Bool { (parse ?? 0) == 1 }
}

// MARK: - 配置

struct ServerConfig: Codable {
    var spider: String?
    var wallpaper: String?
    var sites: [Site]
    var parses: [ParseItem]?
    var flags: [FlagItem]?
    var lives: [LivesItem]?

    struct ParseItem: Codable, Identifiable, Hashable {
        var name: String
        var type: Int?
        var url: String?
        var ext: String?
        var id: String { name }
    }

    struct FlagItem: Codable, Identifiable, Hashable {
        var name: String
        var showName: String?
        var id: String { name }
    }

    struct LivesItem: Codable, Identifiable, Hashable {
        var name: String
        var type: String?
        var url: String?
        var playerType: Int?
        var id: String { name }
    }
}