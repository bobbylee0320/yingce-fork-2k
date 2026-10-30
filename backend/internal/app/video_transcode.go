package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"errors"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
)

// 播放副本转码：HEVC/H.265 原片在 Chrome/Firefox 等无法解码（<video> 黑屏），
// 上传就绪后若探测到 hvc1/hev1 且本机可用 ffmpeg，则异步转 H.264/AAC 到本地
// playback 目录，供 file 端点 variant=playback 读取。转码只作用于本地原件；
// OSS 原件不转码（避免每次上传拉取远端）。

// ErrPlaybackNotReady 表示资源没有可用的浏览器兼容播放副本（未转码/转码中/失败），
// file 端点应回退 serve 原件。
var ErrPlaybackNotReady = errors.New("播放副本尚未就绪")

const (
	playbackDirName         = "playback"
	videoCodecH264          = "h264"
	videoCodecH265          = "h265"
	videoCodecAV1           = "av1"
	videoCodecVP9           = "vp9"
	videoCodecMPEG4         = "mpeg4"
	probeMaxMoovSize        = 128 << 20
	playbackPersistAttempts = 3
	// playbackTranscodeTimeout 是单个播放副本转码的墙钟上限；异常输入让 ffmpeg 卡住时按超时失败，
	// 不能让 goroutine、子进程和 processing 状态一直挂到下次重启。
	playbackTranscodeTimeout = 2 * time.Hour
)

// playbackTranscodeSlots 限制同时运行的 ffmpeg 转码数量。启动回填会一次认领全部待转码视频，
// 不设上限时存量较多就会同时拉起几十个 ffmpeg，耗尽 CPU 与内存。
var playbackTranscodeSlots = make(chan struct{}, max(1, runtime.NumCPU()/2))

// probeVideoCodec 解析本地 mp4 的 stsd 首个视频 sample entry fourcc，返回 h264/h265 等。
// 非 mp4 容器或解析失败返回空串（调用方按“无需转码”处理，前端仍可用原件）。
func probeVideoCodec(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return ""
	}
	fileSize := info.Size()

	// 顶层 box 遍历（跳过 mdat 数据体），定位 moov。
	pos := int64(0)
	for pos+8 <= fileSize {
		boxType, size, headerSize, err := readMP4BoxHeaderAt(f, pos)
		// 声明长度超过文件剩余字节说明容器被截断或被构造过，不能再按它跳转。
		if err != nil || size > fileSize-pos {
			return ""
		}
		if boxType == "moov" {
			if size > probeMaxMoovSize {
				return ""
			}
			moovData := make([]byte, size-headerSize)
			if _, err := f.ReadAt(moovData, pos+headerSize); err != nil {
				return ""
			}
			return codecFromMoov(moovData)
		}
		pos += size
	}
	return ""
}

// readMP4BoxHeaderAt 定位文件 pos 处的 box（8/16 字节头），返回类型、总大小与头部长度。
func readMP4BoxHeaderAt(r io.ReaderAt, pos int64) (string, int64, int64, error) {
	var hdr [16]byte
	if _, err := r.ReadAt(hdr[:8], pos); err != nil {
		return "", 0, 0, err
	}
	size := int64(binary.BigEndian.Uint32(hdr[:4]))
	boxType := string(hdr[4:8])
	headerSize := int64(8)
	if size == 1 {
		if _, err := r.ReadAt(hdr[8:16], pos+8); err != nil {
			return "", 0, 0, err
		}
		size = int64(binary.BigEndian.Uint64(hdr[8:16]))
		headerSize = 16
	}
	if size < headerSize {
		return "", 0, 0, fmt.Errorf("invalid box size %d", size)
	}
	return boxType, size, headerSize, nil
}

// codecFromMoov 在 moov 子树中找出所有 stsd，取首个视频 sample entry fourcc。
func codecFromMoov(moov []byte) string {
	for _, stsdBody := range boxBodies(moov, "stsd") {
		// stsd = fullbox(4) + entry_count(4) + entries…
		// 首个 sample entry：entry_size(4) + fourcc(4) → fourcc 在 body+12。
		if stsdBody+16 > len(moov) {
			continue
		}
		fourcc := string(moov[stsdBody+12 : stsdBody+16])
		switch fourcc {
		case "avc1":
			return videoCodecH264
		case "hvc1", "hev1":
			return videoCodecH265
		case "av01":
			return videoCodecAV1
		case "vp09":
			return videoCodecVP9
		case "mp4v":
			return videoCodecMPEG4
		}
	}
	return ""
}

// boxBodies 在 data 中递归查找类型为 want 的 box，返回其 body 起始偏移。
// 只下钻容器 box（moov/trak/mdia/minf/stbl），避免误入 sample entry 内部。
func boxBodies(data []byte, want string) []int {
	var out []int
	var walk func(start, end int)
	walk = func(start, end int) {
		pos := start
		for pos+8 <= end {
			size := int(binary.BigEndian.Uint32(data[pos : pos+4]))
			boxType := string(data[pos+4 : pos+8])
			hdr := 8
			if size == 1 {
				if pos+16 > end {
					return
				}
				size = int(binary.BigEndian.Uint64(data[pos+8 : pos+16]))
				hdr = 16
			}
			// 用减法比较：64 位 largesize 接近 int 上限时 pos+size 会溢出成负数，
			// 绕过越界检查后在下一轮切片时 panic。
			if size < hdr || size > end-pos {
				return
			}
			if boxType == want {
				out = append(out, pos+hdr)
			}
			switch boxType {
			case "moov", "trak", "mdia", "minf", "stbl":
				walk(pos+hdr, pos+size)
			}
			pos += size
		}
	}
	walk(0, len(data))
	return out
}

// maybeStartPlaybackTranscode 由上传就绪路径调用；H.265 且 ffmpeg 可用时置
// processing 并异步转码。H.264 直接标记 none，避免每次上传重复探测。
func (s *Service) maybeStartPlaybackTranscode(resource *model.Resource) {
	if resource == nil || resource.Kind != "video" {
		return
	}
	// 远端存储（OSS 等）不落本地副本：标 none 表示无需转码，前端按原生播放/直链处理，
	// 避免状态留空被当成 processing 无限轮询（markPlaybackNone 幂等）。
	if resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		if resource.Provider != "local" {
			markPlaybackNone(s, resource)
		}
		return
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return
	}
	// 不可转码场景（无 ffmpeg）落 none：状态为空会被前端当成 processing 无限轮询，
	// 也会让启动回填每次重试探测。none 表示"无需转码"，按原生播放处理。
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		markPlaybackNone(s, resource)
		return
	}
	src := filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey))
	switch probeVideoCodec(src) {
	case videoCodecH265, videoCodecMPEG4:
		// H.265 与 MPEG-4 Part 2（mp4v）Chromium/Firefox/Edge 均不能解码：
		// H.265 需转 H.264；MPEG-4 Part 2 浏览器不支持，老式/损坏文件只能转码兜底
		// （转码失败会落 failed，前端据此显示终止性错误，不再出现死循环）。
		// 原子抢占（空/none → processing）：并发上传 + 回填、多实例同抢时
		// 仅一个能成功置位，其余直接返回，避免重复转码。
		claimed, err := s.repo.ClaimPlaybackTranscode(resource.ID)
		if err != nil || !claimed {
			return
		}
		resource.PlaybackStatus = model.PlaybackStatusProcessing
		go s.runPlaybackTranscode(resource.UserID, resource.ID, src)
	case videoCodecH264, videoCodecAV1, videoCodecVP9, "":
		// H.264 浏览器可直接解码；AV1/VP9 现代浏览器可直接解码，均不需转码；
		// 探针读不出编码（非 mp4 / moov 在尾部 / 加密容器）也无法处理 —— 均标 none，
		// 避免重复探测与前端无限轮询。
		markPlaybackNone(s, resource)
	}
}

// markPlaybackNone 将资源标记为无需播放副本（幂等）。写失败必须可见：空状态会被前端当成 processing 轮询。
func markPlaybackNone(s *Service, resource *model.Resource) {
	if resource.PlaybackStatus == model.PlaybackStatusNone {
		return
	}
	previous := resource.PlaybackStatus
	resource.PlaybackStatus = model.PlaybackStatusNone
	if err := persistPlaybackResource(s.repo, resource, "mark_none"); err != nil {
		resource.PlaybackStatus = previous
	}
}

// runPlaybackTranscode 转码本地原件到 playback/<id>.mp4 并回写状态（幂等按 id 重载）。
func (s *Service) runPlaybackTranscode(userID string, resourceID string, src string) {
	// 转码 goroutine 意外 panic 时把状态落 failed，避免 processing 卡死到下次重启。
	defer func() {
		if r := recover(); r != nil {
			if res, err := s.repo.ResourceForUser(userID, resourceID); err == nil && res != nil {
				res.PlaybackStatus = model.PlaybackStatusFailed
				res.PlaybackError = clipText(fmt.Sprintf("转码 panic：%v", r), 1000)
				_ = persistPlaybackResource(s.repo, res, "panic")
			}
		}
	}()
	playbackTranscodeSlots <- struct{}{}
	defer func() { <-playbackTranscodeSlots }()
	status := model.PlaybackStatusFailed
	objectKey := ""
	var errText string
	dst := filepath.Join(s.dataDir, playbackDirName, resourceID+".mp4")
	// 副本已存在且为 H.264（上次转码完成但回写随进程崩溃丢失）：直接置 ready 不重转。
	if probeVideoCodec(dst) == videoCodecH264 {
		status = model.PlaybackStatusReady
		objectKey = resourceID + ".mp4"
	} else if err := runH264Transcode(src, dst); err != nil {
		errText = clipText(err.Error(), 1000)
	} else {
		status = model.PlaybackStatusReady
		objectKey = resourceID + ".mp4"
	}
	res, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil || res == nil {
		log.Printf("playback transcode persist skipped: resource=%s user=%s lookup_error=%v", resourceID, userID, err)
		return
	}
	res.PlaybackStatus = status
	res.PlaybackObjectKey = objectKey
	res.PlaybackError = errText
	_ = persistPlaybackResource(s.repo, res, "transcode_complete")
}

type resourcePersister interface {
	SaveResource(resource *model.Resource) error
}

func persistPlaybackResource(saver resourcePersister, resource *model.Resource, context string) error {
	var err error
	for attempt := 1; attempt <= playbackPersistAttempts; attempt++ {
		err = saver.SaveResource(resource)
		if err == nil {
			return nil
		}
	}
	log.Printf("playback transcode persist failed: resource=%s context=%s attempts=%d error=%v", resource.ID, context, playbackPersistAttempts, err)
	return err
}

// runH264Transcode 用 ffmpeg 将任意输入转为 H.264/AAC mp4（faststart、yuv420p、偶数尺寸）。
func runH264Transcode(src string, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), playbackTranscodeTimeout)
	defer cancel()
	// 先写临时文件再改名：进程中途退出时不会留下半截文件被下次启动当成已完成的副本。
	tmp := dst + ".part"
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-i", src,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
		"-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
		"-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
		"-f", "mp4", tmp)
	cmd.WaitDelay = 10 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(tmp)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("ffmpeg 转码超过 %s 仍未完成，已终止", playbackTranscodeTimeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("ffmpeg 转码失败：%s", clipText(msg, 800))
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("保存播放副本失败：%w", err)
	}
	return nil
}

func clipText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// OpenResourcePlaybackRange 打开浏览器兼容播放副本（本地 ffmpeg 转码的 H.264）。
// 仅当资源为本地存储且副本 ready 时可用；否则返回 ErrPlaybackNotReady，调用方回退原件。
func (s *Service) OpenResourcePlaybackRange(userID string, resourceID string) (*ResourceStream, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource == nil || resource.Status != model.ResourceStatusReady || resource.Provider != "local" ||
		resource.PlaybackStatus != model.PlaybackStatusReady || resource.PlaybackObjectKey == "" {
		return nil, ErrPlaybackNotReady
	}
	body, err := os.Open(filepath.Join(s.dataDir, playbackDirName, filepath.FromSlash(resource.PlaybackObjectKey)))
	if err != nil {
		return nil, err
	}
	playback := *resource
	playback.MimeType = "video/mp4"
	playback.ObjectKey = filepath.Join(playbackDirName, resource.PlaybackObjectKey)
	size := int64(0)
	if st, err := body.Stat(); err == nil {
		size = st.Size()
	}
	return &ResourceStream{Resource: &playback, Body: body, StatusCode: http.StatusOK, ContentLength: size, AcceptRanges: "bytes"}, nil
}

// BackfillPlaybackTranscodes 在服务启动后扫描存量本地视频：未判定 codec 的补判定，
// H.265/MPEG-4 Part 2 触发转码、H.264 标记 none；再对旧规则遗留的 none 行做一次
// 有界重判（见 PlaybackNoneVideos）。幂等：maybeStartPlaybackTranscode 先置
// processing/none 再入库，重复扫描不会重复转码。
func (s *Service) BackfillPlaybackTranscodes() {
	// 上次进程可能崩溃在转码中途（状态卡 processing），先重置为待判定。
	_ = s.repo.ResetStuckPlaybackTranscodes()
	seen := make(map[string]bool)
	for {
		resources, err := s.repo.PlaybackPendingVideos(20)
		if err != nil || len(resources) == 0 {
			break
		}
		progressed := false
		for i := range resources {
			if seen[resources[i].ID] {
				continue
			}
			seen[resources[i].ID], progressed = true, true
			s.backfillPlaybackTranscode(&resources[i])
		}
		// 认领或写库失败时记录仍是待判定，会被同一查询反复取回；本批没有新记录就退出，避免空转。
		if !progressed {
			break
		}
	}
	// 旧版本曾把 H.265/MPEG-4 Part 2 误判为浏览器可播并落 none；对存量 none 行
	// 做一次有界重判（H.264 保持 none，H.265/MPEG-4 Part 2 触发转码），使 codec
	// 判定规则的变更覆盖规则变更前已导入的文件。每次启动最多重判 20 条最旧行，
	// 天然收敛且不会重复转码（claim 原子地把 none → processing）。
	legacy, err := s.repo.PlaybackNoneVideos(20)
	if err == nil {
		for i := range legacy {
			s.backfillPlaybackTranscode(&legacy[i])
		}
	}
}

// backfillPlaybackTranscode 让单个资源的判定异常只影响它自己：回填运行在独立 goroutine，
// 未恢复的 panic 会让进程在每次启动时都退出。
func (s *Service) backfillPlaybackTranscode(resource *model.Resource) {
	platform.RunRecovered("playback_backfill:"+resource.ID, func() { s.maybeStartPlaybackTranscode(resource) })
}
