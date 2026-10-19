import SwiftUI
import AVFoundation

/// 播放页：AVPlayerLayer 承载 HLS，进度条 + 播放/暂停/停止 + 全屏 + 返回
struct PlayerView: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var store: AppStore
    @EnvironmentObject private var pc: PlayerController
    @Environment(\.dismiss) private var dismiss

    @State private var isFullscreen = false

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                playerArea
                controlsPanel
                Spacer(minLength: 0)
            }
        }
        .overlay {
            if pc.isLoading {
                ProgressView().tint(.white)
            }
        }
        .onAppear { playAt(PlayerTarget.shared.index) }
        .fullScreenCover(isPresented: $isFullscreen) {
            FullscreenPlayerView()
        }
    }

    // MARK: - 画面区（左上角返回键）

    private var playerArea: some View {
        PlayerSurface(controller: pc)
            // 全屏切换时重建 surface：makeUIView 重新 bindLayer，
            // 保证退出全屏后画面层一定重新绑回播放器
            .id(isFullscreen)
            .frame(maxWidth: .infinity)
            .aspectRatio(16 / 9, contentMode: .fit)
            .background(Color.black)
            .overlay(alignment: .topLeading) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.title3.bold())
                        .foregroundStyle(.white)
                        .padding(10)
                        .background(.black.opacity(0.4), in: Circle())
                }
                .padding(10)
            }
    }

    // MARK: - 控制面板

    private var controlsPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(pc.currentTitle.isEmpty ? "未在播放" : pc.currentTitle)
                .font(.headline)
                .lineLimit(2)
            if let err = pc.errorMessage {
                Text(err).font(.footnote).foregroundStyle(.red)
            }

            SeekBar()

            HStack(spacing: 14) {
                Button {
                    pc.togglePlay()
                } label: {
                    Label(pc.isPlaying ? "暂停" : "播放",
                          systemImage: pc.isPlaying ? "pause.fill" : "play.fill")
                }
                .buttonStyle(.borderedProminent)

                Button("下一集") { pc.playNext() }
                    .buttonStyle(.bordered)
                    .disabled(pc.currentIndex + 1 >= pc.episodes.count)

                Button {
                    pc.stop()
                    dismiss()
                } label: {
                    Label("停止", systemImage: "stop.fill")
                }
                .buttonStyle(.bordered)

                Spacer()

                Button {
                    isFullscreen = true
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.bordered)
            }

            episodeGrid
        }
        .padding(16)
    }

    private var episodeGrid: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 10)], spacing: 10) {
                ForEach(Array(pc.episodes.enumerated()), id: \.offset) { i, ep in
                    Button(ep.name) {
                        playAt(i)
                    }
                    .font(.footnote)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity)
                    .background(
                        iTint(i).opacity(0.85),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
                    .foregroundStyle(.white)
                }
            }
            .padding(.vertical, 6)
        }
        .frame(maxHeight: 220)
    }

    private func iTint(_ i: Int) -> Color {
        i == pc.currentIndex ? Color.accentColor : Color.white.opacity(0.14)
    }

    private func playAt(_ index: Int) {
        let t = PlayerTarget.shared
        guard index >= 0, index < t.episodes.count else { return }
        Task {
            await pc.playEpisode(site: t.siteKey,
                                 vodId: "",
                                 flag: t.lineName,
                                 title: router.pendingVod?.vod_name ?? "",
                                 episodes: t.episodes,
                                 index: index,
                                 line: t.lineName)
        }
    }
}

// MARK: - 进度条（竖屏/全屏共用）

struct SeekBar: View {
    @EnvironmentObject var pc: PlayerController

    @State private var isSeeking = false
    @State private var seekValue: Double = 0

    var body: some View {
        HStack(spacing: 10) {
            Text(fmtTime(pc.currentTime))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, alignment: .leading)

            Slider(
                value: Binding(
                    get: { isSeeking ? seekValue : min(pc.currentTime, sliderMax) },
                    set: { seekValue = $0 }
                ),
                in: 0...sliderMax
            ) { editing in
                isSeeking = editing
                if !editing { pc.seek(to: seekValue) }
            }

            Text("-" + fmtTime(max(0, pc.duration - pc.currentTime)))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 48, alignment: .trailing)
        }
    }

    private var sliderMax: Double { max(pc.duration, 0.1) }

    private func fmtTime(_ t: Double) -> String {
        guard t.isFinite, t >= 0 else { return "0:00" }
        let s = Int(t)
        if s >= 3600 {
            return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
        }
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

// MARK: - 全屏播放（同一 AVPlayer 实例，强制横屏）

struct FullscreenPlayerView: View {
    @EnvironmentObject var pc: PlayerController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            PlayerSurface(controller: pc)
                .ignoresSafeArea()
                .overlay(alignment: .topLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.title3.bold())
                            .foregroundStyle(.white)
                            .padding(10)
                            .background(.black.opacity(0.4), in: Circle())
                    }
                    .padding(14)
                }

            VStack(spacing: 10) {
                SeekBar().tint(.white)
                HStack(spacing: 20) {
                    Button {
                        pc.togglePlay()
                    } label: {
                        Image(systemName: pc.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title2)
                            .foregroundStyle(.white)
                    }
                    Button("下一集") { pc.playNext() }
                        .foregroundStyle(.white)
                    Spacer()
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "arrow.down.right.and.arrow.up.left")
                            .foregroundStyle(.white)
                    }
                }
                .padding(.horizontal, 4)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 14)
        }
        .onAppear { forceOrientation(landscape: true) }
        .onDisappear { forceOrientation(landscape: false) }
    }

    /// SwiftUI App 生命周期没有视图控制器钩子，用 KVC 触发系统旋转
    /// （Info.plist 已声明支持横屏）
    private func forceOrientation(landscape: Bool) {
        let o: UIInterfaceOrientation = landscape ? .landscapeRight : .portrait
        UIDevice.current.setValue(o.rawValue, forKey: "orientation")
        UIViewController.attemptRotationToDeviceOrientation()
    }
}

/// UIViewRepresentable 包装 AVPlayerLayer
struct PlayerSurface: UIViewRepresentable {
    /// 必须 @ObservedObject：否则 controller 引用不变，SwiftUI 判定视图未变，
    /// 永远不会再次调 updateUIView，后创建的 AVPlayer 就绑不到 layer 上
    ///（症状：有声音、无画面）。
    @ObservedObject var controller: PlayerController

    func makeUIView(context: Context) -> PlayerUIView {
        let v = PlayerUIView()
        v.backgroundColor = .black
        // 注册画面层：此后每次 play() 都会在开播前把 player 绑到该 layer
        controller.bindLayer(v.playerLayer)
        return v
    }

    func updateUIView(_ uiView: PlayerUIView, context: Context) {
        // updateUIView 由 SwiftUI 保证在主线程调用，直接绑定即可
        uiView.attach(player: controller.avPlayerForUI)
    }
}

final class PlayerUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    /// backing layer 本身就是 AVPlayerLayer；暴露给 PlayerSurface 注册到控制器，
    /// 使 play() 能在开播前完成绑定
    private(set) lazy var playerLayer: AVPlayerLayer = { layer as! AVPlayerLayer }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        playerLayer.videoGravity = .resizeAspect
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        playerLayer.videoGravity = .resizeAspect
    }

    func attach(player: AVPlayer?) {
        guard playerLayer.player !== player else { return }
        playerLayer.player = player
    }
}
