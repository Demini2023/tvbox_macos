import SwiftUI

/// 首页：顶部站点切换 + 横向分类 + 推荐/分类列表网格
struct HomeView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: AppRouter

    @State private var home: HomeResponse?
    @State private var vods: [Vod] = []
    @State private var categories: [Category] = []
    @State private var selectedCategory: String?
    @State private var page = 1
    @State private var pageCount = 1
    @State private var isLoading = false
    @State private var isLoadingMore = false
    @State private var errorText: String?
    @State private var showSitePicker = false

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let err = errorText {
                        ErrorBanner(text: err) { Task { await reload() } }
                    }

                    // 站点选择
                    Button {
                        showSitePicker = true
                    } label: {
                        HStack {
                            Text(store.selectedSite?.name ?? "未选择站点")
                                .font(.headline)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .confirmationDialog("选择站点", isPresented: $showSitePicker) {
                        ForEach(store.sites) { s in
                            Button(s.name) {
                                store.selectedSiteKey = s.key
                                Task { await reload() }
                            }
                        }
                    }

                    // 分类栏
                    if !categories.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(categories) { c in
                                    let active = selectedCategory == c.type_id
                                    Text(c.type_name)
                                        .font(.subheadline)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 7)
                                        .background(active ? Color.accentColor : Color.white.opacity(0.12),
                                                    in: Capsule())
                                        .foregroundStyle(active ? .black : .white)
                                        .onTapGesture {
                                            selectedCategory = c.type_id
                                            Task { await loadCategory(reset: true) }
                                        }
                                }
                            }
                            .padding(.horizontal, 16)
                        }
                    }

                    // 列表
                    if vods.isEmpty && isLoading {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    } else if vods.isEmpty {
                        Text("暂无内容").foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    } else {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(vods) { vod in
                                VodCard(vod: vod)
                                    .onTapGesture { openDetail(vod) }
                            }
                        }
                        .padding(.horizontal, 16)

                        if isLoadingMore {
                            ProgressView().padding(.vertical, 16)
                        } else if page < pageCount {
                            Button("加载更多") { Task { await loadCategory(reset: false) } }
                                .padding(.vertical, 16)
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
                .padding(.vertical, 12)
            }
            .navigationTitle("影视仓")
            .refreshable { await reload() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        router.showSearch = true
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                }
            }
        }
        .task { if vods.isEmpty { await reload() } }
    }

    private func openDetail(_ vod: Vod) {
        store.addHistory(vod, siteKey: store.currentSiteKey)
        router.showDetail(for: vod)
    }

    private func reload() async {
        let key = store.currentSiteKey
        guard !key.isEmpty else { return }
        isLoading = true
        errorText = nil
        do {
            let h = try await APIClient.shared.home(site: key)
            home = h
            categories = h.classes?.`class` ?? []
            if let first = categories.first {
                selectedCategory = first.type_id
            }
            await loadCategory(reset: true)
        } catch {
            errorText = error.localizedDescription
        }
        isLoading = false
    }

    private func loadCategory(reset: Bool) async {
        let key = store.currentSiteKey
        guard !key.isEmpty, let tid = selectedCategory else { return }
        if reset { page = 1; vods = []; pageCount = 1 } else { isLoadingMore = true }
        do {
            let result = try await APIClient.shared.category(site: key, tid: tid, pg: page)
            vods = reset ? result.list : (vods + result.list)
            pageCount = result.pagecount ?? 1
            if page < pageCount { page += 1 }
        } catch {
            errorText = error.localizedDescription
        }
        isLoadingMore = false
    }
}

// MARK: - 影片卡片

struct VodCard: View {
    let vod: Vod

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                AsyncImage(url: vod.imageURL) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().aspectRatio(contentMode: .fill)
                    case .failure:
                        placeholder
                    default:
                        placeholder
                    }
                }
                .frame(height: 150)
                .frame(maxWidth: .infinity)
                .clipped()
                .cornerRadius(8)

                if let r = vod.vod_remarks, !r.isEmpty {
                    Text(r)
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(.black.opacity(0.7))
                        .foregroundStyle(.white)
                        .cornerRadius(4)
                        .padding(4)
                }
            }
            Text(vod.vod_name)
                .font(.subheadline)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color.white.opacity(0.08))
            .overlay(Image(systemName: "film").foregroundStyle(.secondary))
    }
}

// MARK: - 错误提示条

struct ErrorBanner: View {
    let text: String
    let retry: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "exclamationmark.triangle")
            Text(text).font(.footnote)
            Spacer()
            Button("重试", action: retry).font(.footnote.bold())
        }
        .padding(10)
        .background(Color.red.opacity(0.2), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 16)
    }
}