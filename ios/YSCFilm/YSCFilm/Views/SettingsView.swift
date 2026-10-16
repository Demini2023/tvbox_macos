import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var store: AppStore

    @State private var draftURL = ""
    @State private var testResult: String?
    @State private var isTesting = false
    @State private var importURL = ""
    @State private var importMsg: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器") {
                    TextField("http://192.168.x.x:9527", text: $draftURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    HStack {
                        Button {
                            Task { await test() }
                        } label: {
                            if isTesting { ProgressView().controlSize(.small) }
                            Text("测试连接")
                        }
                        .disabled(isTesting)
                        Spacer()
                        if let r = testResult {
                            Text(r).font(.caption).foregroundStyle(r.contains("成功") ? .green : .red)
                        }
                    }
                    Button("保存并加载配置") {
                        store.serverURL = draftURL
                        Task {
                            await store.loadConfig()
                            testResult = store.configError.map { "加载失败：\($0)" } ?? "配置已加载"
                        }
                    }
                }

                Section("导入配置") {
                    TextField("配置地址（TVBox JSON）", text: $importURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("导入") {
                        Task { await importConfig() }
                    }
                    if let m = importMsg {
                        Text(m).font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section("站点（可用 \(store.usableSites.count) / 共 \(store.sites.count)）") {
                    if store.sites.isEmpty {
                        Text("尚未导入配置").foregroundStyle(.secondary)
                    }
                    ForEach(store.usableSites) { s in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.name).font(.subheadline)
                            HStack {
                                Text(s.key).font(.caption2).foregroundStyle(.secondary)
                                if let label = s.kindLabel {
                                    Text(label).font(.caption2)
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(Color.accentColor.opacity(0.15), in: Capsule())
                                }
                            }
                        }
                    }
                    if store.unsupportedCount > 0 {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("已跳过 \(store.unsupportedCount) 个站点")
                                .font(.subheadline)
                                .foregroundStyle(.orange)
                            Text("CSP 插件是 Android 原生 Java 插件；「需外部规则」指向 TVBox 客户端私有资源目录，不随配置分发。两者本服务都跑不了。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("收藏 (\(store.favorites.count)) / 历史 (\(store.history.count))") {
                    Button("清空历史", role: .destructive) { store.clearHistory() }
                }

                Section("关于") {
                    LabeledContent("版本", value: "1.0.0")
                    LabeledContent("协议", value: "TVBox / drpy2")
                    Text("需与电脑处于同一 WiFi 网络")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设置")
            .onAppear { draftURL = store.serverURL }
        }
    }

    private func test() async {
        isTesting = true
        defer { isTesting = false }
        await APIClient.shared.setBaseURL(draftURL)
        testResult = await store.testConnection()
    }

    private func importConfig() async {
        let u = importURL.trimmingCharacters(in: .whitespaces)
        guard !u.isEmpty else { importMsg = "请填写地址"; return }
        importMsg = "导入中…"
        do {
            guard let base = await APIClient.shared.currentBaseURL() else {
                importMsg = "请先配置服务器"; return
            }
            var request = URLRequest(url: base.appendingPathComponent("api/config/import"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["url": u])
            let (data, _) = try await URLSession.shared.data(for: request)
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]

            // 服务端会回报真实可用数量；这里不能用笼统的"导入成功"
            // 掩盖"配置里有 100 个站但一个都跑不了"的情况
            let total = obj?["total"] as? Int ?? 0
            let usable = obj?["usable"] as? Int ?? 0
            let serverMsg = obj?["message"] as? String
            let errMsg = obj?["error"] as? String

            if (obj?["ok"] as? Bool) == true {
                if usable > 0 {
                    importMsg = serverMsg ?? "导入成功：\(usable) 个可用站点"
                } else if total > 0 {
                    importMsg = "导入完成，但没有可用站点（详见下方说明）"
                } else {
                    importMsg = "配置已导入，但里面没有站点"
                }
                await store.loadConfig()
            } else {
                importMsg = errMsg ?? serverMsg ?? "导入失败"
            }
        } catch {
            importMsg = "导入失败：\(error.localizedDescription)"
        }
    }
}