import Foundation
import AVFoundation

/// 播放器控制器：负责向后端请求播放地址并交给 AVPlayer 播放
@MainActor
final class PlayerController: ObservableObject {
    @Published var isPlaying = false
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var currentTitle: String = ""
    @Published var episodes: [Episode] = []
    @Published var currentIndex: Int = 0

    /// 当前播放线路名
    @Published var currentLine: String = ""
    /// 当前播放站点（换集解析时需要）
    @Published var currentSite: String = ""

    private var avPlayer: AVPlayer?
    private var timeObserver: Any?

    /// 供 UIViewRepresentable（AVPlayerLayer）绑定使用
    var avPlayerForUI: AVPlayer? { avPlayer }

    /// 直接播放一个已解析好的地址
    func play(url: String, title: String, episodes: [Episode], index: Int, line: String, site: String = "") {
        cleanupObserver()
        currentTitle = title
        self.episodes = episodes
        self.currentIndex = index
        currentLine = line
        if !site.isEmpty { currentSite = site }
        errorMessage = nil

        guard let playURL = URL(string: url) else {
            errorMessage = "播放地址无效：\(url)"
            return
        }
        isLoading = true
        let player = AVPlayer(url: playURL)
        player.automaticallyWaitsToMinimizeStalling = false
        avPlayer = player
        player.play()
        isPlaying = true
        isLoading = false

        // 播放结束自动下一集
        timeObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.playNext()
            }
        }
    }

    /// 通过后端解析并播放
    func playEpisode(site: String,
                     vodId: String,
                     flag: String,
                     title: String,
                     episodes: [Episode],
                     index: Int,
                     line: String,
                     api: APIClient = .shared) async {
        let ep = episodes[index]
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let result = try await api.play(site: site, flag: flag, url: ep.url)
            var finalURL = result.url
            // parse=1 表示后端未解析成功（常见于需要嗅探的直链）
            if result.needsSniff || finalURL.isEmpty {
                // 尝试走后端代理转发
                if let base = await api.currentBaseURL(),
                   let proxied = URL(string: "/proxy?url=" + (finalURL.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""),
                                     relativeTo: base)?.absoluteURL {
                    finalURL = proxied.absoluteString
                }
            }
            play(url: finalURL, title: "\(title) · \(ep.name)",
                 episodes: episodes, index: index, line: line, site: site)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func togglePlay() {
        guard let avPlayer else { return }
        if isPlaying {
            avPlayer.pause()
            isPlaying = false
        } else {
            avPlayer.play()
            isPlaying = true
        }
    }

    /// 播放下一集（必须走完整解析流程，不能直接用采集器原始地址）
    func playNext(api: APIClient = .shared) {
        guard currentIndex + 1 < episodes.count else { return }
        let next = currentIndex + 1
        let ep = episodes[next]
        let site = currentSite
        let line = currentLine
        // currentTitle 形如 "影片名 · 第1集"，剥掉后缀还原影片名
        let baseTitle = currentTitle.components(separatedBy: " · ").first ?? currentTitle

        Task {
            await playEpisode(site: site, vodId: "", flag: line,
                              title: baseTitle, episodes: episodes,
                              index: next, line: line, api: api)
            _ = ep
        }
    }

    func stop() {
        cleanupObserver()
        avPlayer?.pause()
        avPlayer = nil
        isPlaying = false
    }

    private func cleanupObserver() {
        if let timeObserver {
            NotificationCenter.default.removeObserver(timeObserver)
            self.timeObserver = nil
        }
    }
}