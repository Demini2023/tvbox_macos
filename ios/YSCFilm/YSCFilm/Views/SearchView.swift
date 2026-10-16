import SwiftUI

struct SearchView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: AppRouter
    @Environment(\.dismiss) private var dismiss

    @State private var keyword = ""
    @State private var results: [Vod] = []
    @State private var isSearching = false
    @State private var searched = false
    @State private var errorText: String?

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 12)]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                searchBar
                Divider()
                content
            }
            .navigationTitle("搜索")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("输入片名", text: $keyword)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { Task { await doSearch() } }
            if isSearching { ProgressView().controlSize(.small) }
        }
        .padding(10)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var content: some View {
        if let err = errorText {
            ErrorBanner(text: err) { Task { await doSearch() } }.padding(.top, 12)
        } else if !searched {
            Spacer()
            Text("输入关键词开始搜索").foregroundStyle(.secondary)
            Spacer()
        } else if results.isEmpty {
            Spacer()
            Text("没有找到结果").foregroundStyle(.secondary)
            Spacer()
        } else {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(results) { vod in
                        VodCard(vod: vod).onTapGesture {
                            store.addHistory(vod, siteKey: store.currentSiteKey)
                            router.showDetail(for: vod)
                            dismiss()
                        }
                    }
                }
                .padding(16)
            }
        }
    }

    private func doSearch() async {
        let kw = keyword.trimmingCharacters(in: .whitespaces)
        guard !kw.isEmpty, !store.currentSiteKey.isEmpty else { return }
        isSearching = true
        errorText = nil
        defer { isSearching = false; searched = true }
        do {
            let page = try await APIClient.shared.search(site: store.currentSiteKey, keyword: kw)
            results = page.list
        } catch {
            errorText = error.localizedDescription
            results = []
        }
    }
}