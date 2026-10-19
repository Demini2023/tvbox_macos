import SwiftUI
import AVFoundation

/// 播放页：AVPlayerLayer 承载 HLS，底部选集条
struct PlayerView: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var store: AppStore
    @EnvironmentObject private var pc: PlayerController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                PlayerSurface(controller: pc)
                    .frame(maxWidth: .infinity)
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .background(Color.black)

                VStack(alignment: .leading, spacing: 14) {
                    Text(pc.currentTitle.isEmpty ? "未在播放" : pc.currentTitle)
                        .font(.headline)
                        .lineLimit(2)
                    if let err = pc.errorMessage {
                        Text(err).font(.footnote).foregroundStyle(.red)
                    }
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
                    }

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
                .padding(16)
                Spacer(minLength: 0)
            }
        }
        .onAppear { playAt(PlayerTarget.shared.index) }
        .overlay {
            if pc.isLoading {
                ProgressView().tint(.white)
            }
        }
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