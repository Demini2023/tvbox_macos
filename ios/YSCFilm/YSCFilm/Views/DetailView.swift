import SwiftUI

/// 影片详情：元信息 + 线路切换 + 选集网格
struct DetailView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: AppRouter
    @Environment(\.dismiss) private var dismiss

    let vodId: String

    @State private var detail: VodDetail?
    @State private var lineIndex = 0
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var favSnapshot = false

    private var episodes: [Episode] {
        detail?.episodes(forLineIndex: lineIndex) ?? []
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if isLoading {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    } else if let err = errorText {
                        ErrorBanner(text: err) { Task { await load() } }
                    } else if let d = detail {
                        header(d)
                        if d.vod_content.hasContent {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("简介").font(.headline)
                                Text(d.vod_content!).font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        episodeSection(d)
                    }
                }
                .padding(16)
            }
            .navigationTitle(detail?.vod_name ?? "详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if let d = detail {
                            var v = d.asVod
                            v.vod_id = vodId
                            favSnapshot.toggle()
                            store.toggleFavorite(v, siteKey: store.currentSiteKey)
                        }
                    } label: {
                        Image(systemName: favSnapshot || store.isFavorite(vodId) ? "star.fill" : "star")
                    }
                }
            }
        }
        .task { await load() }
    }

    private func header(_ d: VodDetail) -> some View {
        HStack(alignment: .top, spacing: 14) {
            AsyncImage(url: vodImageURL(d.vod_pic)) { phase in
                if case .success(let img) = phase {
                    img.resizable().aspectRatio(contentMode: .fill)
                } else {
                    Rectangle().fill(Color.white.opacity(0.08))
                        .overlay(Image(systemName: "film").foregroundStyle(.secondary))
                }
            }
            .frame(width: 120, height: 170)
            .clipped()
            .cornerRadius(10)

            VStack(alignment: .leading, spacing: 6) {
                Text(d.vod_name).font(.title3.bold())
                metaRow("年份", d.vod_year)
                metaRow("地区", d.vod_area)
                metaRow("主演", d.vod_actor)
                metaRow("导演", d.vod_director)
                metaRow("更新", d.vod_remarks)
            }
            .font(.footnote)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func metaRow(_ label: String, _ value: String?) -> some View {
        if let v = value, v.notEmpty {
            HStack(alignment: .top) {
                Text(label).foregroundStyle(.secondary).frame(width: 34, alignment: .leading)
                Text(v)
            }
        }
    }

    @ViewBuilder
    private func episodeSection(_ d: VodDetail) -> some View {
        let lines = d.lineNames()
        if episodes.isEmpty {
            Text("该资源没有可选集").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                if lines.count > 1 {
                    Picker("线路", selection: $lineIndex) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { i, name in
                            Text(name).tag(i)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 10)], spacing: 10) {
                    ForEach(episodes) { ep in
                        Button(ep.name) {
                            play(index: episodes.firstIndex(of: ep) ?? 0)
                        }
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
        }
    }

    private func play(index: Int) {
        guard let d = detail else { return }
        router.pendingVod = d.asVod
        // 必须先填好 PlayerTarget 再打开播放页：
        // SwiftUI 观测到 showPlayer 后同一轮事务就会构造 PlayerView，
        // 其 onAppear 会立刻读 PlayerTarget.shared
        PlayerTarget.shared.siteKey = store.currentSiteKey
        PlayerTarget.shared.lineName = d.lineNames().indices.contains(lineIndex)
            ? d.lineNames()[lineIndex] : "线路1"
        PlayerTarget.shared.episodes = episodes
        PlayerTarget.shared.index = index
        router.showPlayer = true
    }

    private func load() async {
        isLoading = true
        errorText = nil
        do {
            let r = try await APIClient.shared.detail(site: store.currentSiteKey, id: vodId)
            detail = r.list.first
            if detail == nil { errorText = "未找到该影片" }
        } catch {
            errorText = error.localizedDescription
        }
        isLoading = false
    }

    private func vodImageURL(_ s: String?) -> URL? {
        guard let s, !s.isEmpty else { return nil }
        if s.hasPrefix("http") { return URL(string: s) }
        return URL(string: "http://" + s)
    }
}

/// 传递给播放器的目标信息
/// 标记 @MainActor：这些字段会被 UI 层读写，Swift 6 严格并发下需要显式隔离
@MainActor
final class PlayerTarget {
    static let shared = PlayerTarget()
    var siteKey = ""
    var lineName = ""
    var episodes: [Episode] = []
    var index = 0
}

extension String {
    /// 供可选字符串判断「非空且有内容」
    var notEmpty: Bool { !isEmpty }
}

extension Optional where Wrapped == String {
    /// nil 或空串都视为无内容
    var hasContent: Bool {
        guard let s = self else { return false }
        return !s.isEmpty
    }
}