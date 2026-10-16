import SwiftUI

struct FavoritesView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: AppRouter
    @State private var filter: String?

    private var items: [FavoriteItem] {
        guard let f = filter else { return store.favorites }
        return store.favorites.filter { $0.siteKey == f }
    }

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if store.favorites.isEmpty {
                        Text("还没有收藏").foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    } else {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(items) { item in
                                VodCard(vod: item.vod)
                                    .contextMenu {
                                        Button(role: .destructive) {
                                            store.toggleFavorite(item.vod, siteKey: item.siteKey)
                                        } label: {
                                            Label("取消收藏", systemImage: "trash")
                                        }
                                    }
                                    .onTapGesture {
                                        store.selectedSiteKey = item.siteKey
                                        router.showDetail(for: item.vod)
                                    }
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                }
                .padding(.vertical, 12)
            }
            .navigationTitle("收藏")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("全部") { filter = nil }
                        ForEach(store.sites) { s in
                            Button(s.name) { filter = s.key }
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                    }
                }
            }
        }
    }
}

struct HistoryView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: AppRouter

    var body: some View {
        NavigationStack {
            Group {
                if store.history.isEmpty {
                    Text("还没有播放记录").foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        ForEach(store.history) { item in
                            HStack(spacing: 12) {
                                AsyncImage(url: item.vod.imageURL) { phase in
                                    if case .success(let img) = phase {
                                        img.resizable().aspectRatio(contentMode: .fill)
                                    } else {
                                        Rectangle().fill(Color.white.opacity(0.08))
                                    }
                                }
                                .frame(width: 54, height: 72)
                                .clipped()
                                .cornerRadius(6)

                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.vod.vod_name).font(.subheadline)
                                    Text(siteName(item.siteKey))
                                        .font(.caption).foregroundStyle(.secondary)
                                    Text(item.date, style: .relative)
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                store.selectedSiteKey = item.siteKey
                                router.showDetail(for: item.vod)
                            }
                        }
                        .onDelete { offsets in
                            store.history.remove(atOffsets: offsets)
                        }
                    }
                }
            }
            .navigationTitle("历史")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("清空") { store.clearHistory() }
                        .disabled(store.history.isEmpty)
                }
            }
        }
    }

    private func siteName(_ key: String) -> String {
        store.sites.first { $0.key == key }?.name ?? key
    }
}