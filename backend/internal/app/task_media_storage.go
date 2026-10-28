package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"yingce/backend/internal/model"
)

const mediaStagingBudget int64 = 2 << 30
const mediaStagingMinFreeBytes int64 = 5 << 30

func mediaStagingCapacityAvailable(freeBytes, reservation int64, available, writable bool) bool {
	return available && writable && reservation > 0 && reservation <= mediaStagingBudget && freeBytes >= reservation && freeBytes-reservation >= mediaStagingMinFreeBytes
}

// 单次结果下载的时限：上游慢但一直在传输时允许跑完，长时间收不到任何字节才判定卡住。
// 原来的固定 3 分钟总时限会让慢速结果服务器上的大图永远下载不完——每次重试都从零开始，
// 又在差不多同一位置超时。总时限仍有上限，避免一个下载长期占住有限的保存并发槽位。
var (
	mediaDownloadMaxDuration  = 15 * time.Minute
	mediaDownloadStallTimeout = 90 * time.Second
)

// errMediaDownloadStalled 包装 DeadlineExceeded，保证停滞与总超时一样按可重试的保存失败处理。
var errMediaDownloadStalled = fmt.Errorf("结果下载长时间没有进度：%w", context.DeadlineExceeded)

// mediaDownloadProgress 每收到一段数据就重置停滞计时。
type mediaDownloadProgress struct {
	reader io.Reader
	stall  *time.Timer
}

func (p mediaDownloadProgress) Read(buffer []byte) (int, error) {
	n, err := p.reader.Read(buffer)
	if n > 0 {
		p.stall.Reset(mediaDownloadStallTimeout)
	}
	return n, err
}

// mediaDownloadError 把停滞看门狗触发的取消还原成可识别的停滞错误；其他取消（任务租约失效、
// 服务停止）保持原样，不能被误判成上游问题。
func mediaDownloadError(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); errors.Is(cause, errMediaDownloadStalled) {
		return cause
	}
	return err
}

// mediaDownloadLogError 是写进请求明细的脱敏原因：不含地址与签名，只区分卡住、超时与其他失败。
func mediaDownloadLogError(err error) error {
	switch {
	case errors.Is(err, errMediaDownloadStalled):
		return errors.New("结果下载长时间没有进度")
	case errors.Is(err, context.DeadlineExceeded):
		return errors.New("结果下载超时")
	default:
		return errors.New("结果下载失败")
	}
}

// mediaStagingRetainedTTL 是未完成作品检查点仍引用的暂存文件的最长保留时间。
const mediaStagingRetainedTTL = 7 * 24 * time.Hour

var mediaStagingMu sync.Mutex
var mediaStagingReservations = map[string]int64{}
var errMediaStagingFull = errors.New("作品暂存空间不足，请等待已有作品保存完成")

type mediaStagingFile struct {
	name string
	path string
	size int64
}

// validMediaStagingName accepts the current flat name and the legacy per-user
// hash/result-* layout. It deliberately rejects every other path shape so a
// checkpoint can never escape the media-staging directory.
func validMediaStagingName(name string) bool {
	name = filepath.ToSlash(strings.TrimSpace(name))
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "../") || strings.ContainsAny(name, `\\`) {
		return false
	}
	parts := strings.Split(name, "/")
	if len(parts) > 2 {
		return false
	}
	base := parts[len(parts)-1]
	if !strings.HasPrefix(base, "result-") || filepath.Base(base) != base {
		return false
	}
	if len(parts) == 1 {
		return true
	}
	if len(parts[0]) != 64 {
		return false
	}
	for _, char := range parts[0] {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}

func (s *Service) listMediaStagingFiles() ([]mediaStagingFile, error) {
	root := filepath.Join(s.dataDir, "media-staging")
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	files := make([]mediaStagingFile, 0)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		if !validMediaStagingName(name) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files = append(files, mediaStagingFile{name: name, path: path, size: info.Size()})
		return nil
	})
	return files, err
}

// Reserve the maximum response size before opening a file. Temporary files are
// sparse reservations, so concurrent downloads cannot oversubscribe this budget.
func (s *Service) newMediaTemp(limit int64) (*mediaStagingReservationFile, error) {
	probe := s.mediaStagingDiskProbe
	if probe == nil {
		probe = func() SystemPerformanceDisk { return collectSystemDisk(s.dataDir) }
	}
	return s.newMediaTempWithDisk(limit, probe)
}

func (s *Service) newMediaTempWithDisk(limit int64, diskInfo func() SystemPerformanceDisk) (*mediaStagingReservationFile, error) {
	mediaStagingMu.Lock()
	defer mediaStagingMu.Unlock()
	dir := filepath.Join(s.dataDir, "media-staging")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	files, err := s.listMediaStagingFiles()
	if err != nil {
		return nil, err
	}
	var used, reservedDisk int64
	for _, file := range files {
		reserved, inFlight := mediaStagingReservations[file.path]
		if inFlight {
			used += reserved
		} else {
			used += file.size
		}
	}
	for _, reserved := range mediaStagingReservations {
		reservedDisk += reserved
	}
	if limit <= 0 || limit > mediaStagingBudget || used > mediaStagingBudget-limit {
		return nil, errMediaStagingFull
	}
	disk := diskInfo()
	if !mediaStagingCapacityAvailable(int64(disk.FreeBytes)-reservedDisk, limit, disk.Available, disk.Writable) {
		return nil, errMediaStagingFull
	}
	file, err := os.CreateTemp(dir, "result-*")
	if err != nil {
		return nil, err
	}
	if err := file.Truncate(limit); err != nil {
		file.Close()
		os.Remove(file.Name())
		return nil, err
	}
	mediaStagingReservations[file.Name()] = limit
	return &mediaStagingReservationFile{File: file}, nil
}

type mediaStagingReservationFile struct {
	*os.File
}

func (f *mediaStagingReservationFile) Close() error {
	if f == nil || f.File == nil {
		return nil
	}
	mediaStagingMu.Lock()
	err := f.File.Close()
	delete(mediaStagingReservations, f.Name())
	mediaStagingMu.Unlock()
	return err
}

func (f *mediaStagingReservationFile) updateReservation(size int64) error {
	if size <= 0 {
		return errMediaStagingFull
	}
	mediaStagingMu.Lock()
	defer mediaStagingMu.Unlock()
	reserved, ok := mediaStagingReservations[f.Name()]
	if !ok || size > reserved {
		return errMediaStagingFull
	}
	mediaStagingReservations[f.Name()] = size
	return nil
}

func (f *mediaStagingReservationFile) release() {
	if f == nil || f.File == nil {
		return
	}
	mediaStagingMu.Lock()
	delete(mediaStagingReservations, f.Name())
	mediaStagingMu.Unlock()
}

func (s *Service) stageInlineMedia(data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("上游返回空作品")
	}
	file, err := s.newMediaTemp(int64(len(data)))
	if err != nil {
		return "", err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(file.Name())
		return "", err
	}
	return filepath.Base(file.Name()), nil
}

func (s *Service) downloadTaskMedia(ctx context.Context, config providerConfig, url, mode string) (name, mimeType string, err error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return "", "", err
	}
	limit := min(megabytes(policy.Resource.GeneratedFileMB), mediaStagingBudget)
	deadlineCtx, cancelDeadline := context.WithTimeout(withProviderRequestKind(ctx, "download"), mediaDownloadMaxDuration)
	defer cancelDeadline()
	downloadCtx, cancelStalled := context.WithCancelCause(deadlineCtx)
	defer cancelStalled(nil)
	stall := time.AfterFunc(mediaDownloadStallTimeout, func() { cancelStalled(errMediaDownloadStalled) })
	defer stall.Stop()
	req, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", "", err
	}
	started := time.Now()
	statusCode := 0
	defer func() {
		// Signed paths and net/url errors can contain bearer credentials. Keep
		// the real error for retry classification, never in request logs.
		logged := req.Clone(req.Context())
		redactedURL := *req.URL
		redactedURL.Path, redactedURL.RawPath, redactedURL.RawQuery, redactedURL.Fragment = "/task-media", "", "", ""
		redactedURL.User = nil
		logged.URL = &redactedURL
		var safeErr error
		if err != nil {
			safeErr = mediaDownloadLogError(err)
		}
		recordProviderRequest(logged, started, statusCode, nil, safeErr)
	}()
	if _, err = ValidateOutboundURL(url); err != nil {
		return "", "", err
	}
	if sameProviderOrigin(config.BaseURL, url) {
		applyProviderAuth(req, config)
		ApplyOutboundHeaders(req, config.Headers)
	}
	ApplyDefaultOutboundHeaders(req)
	// 结果文件可能托管在渠道同域（sameProviderOrigin 时还带渠道鉴权），
	// 渠道配置了出站代理时下载必须走同一代理，否则配代理渠道的结果无法取回。
	proxyURL := ""
	if metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext); ok {
		proxyURL = metadata.ProxyURL
	}
	if strings.TrimSpace(proxyURL) == "" && strings.TrimSpace(config.ChannelID) != "" {
		if ch, err := s.repo.SystemChannel(config.ChannelID); err == nil {
			proxyURL = ch.ProxyURL
		}
	}
	// 客户端总时限与上下文一致；真正决定何时放弃的是停滞看门狗。
	response, err := OutboundHTTPClientWithProxy(mediaDownloadMaxDuration, proxyURL).Do(req)
	if err != nil {
		return "", "", mediaDownloadError(downloadCtx, err)
	}
	defer response.Body.Close()
	statusCode = response.StatusCode
	if statusCode < 200 || statusCode >= 300 {
		return "", "", providerHTTPError{StatusCode: statusCode, Status: response.Status, RetryAfter: parseRetryAfter(response.Header.Get("Retry-After"), time.Now())}
	}
	if response.ContentLength > limit {
		return "", "", errors.New("生成文件超过大小限制")
	}
	if response.ContentLength > 0 {
		limit = response.ContentLength
	}
	file, err := s.newMediaTemp(limit)
	if err != nil {
		return "", "", err
	}
	defer func() {
		if err != nil {
			file.release()
			_ = file.Close()
			_ = os.Remove(file.Name())
		}
	}()
	size, err := io.Copy(file, io.LimitReader(mediaDownloadProgress{reader: response.Body, stall: stall}, limit+1))
	if err != nil {
		return "", "", mediaDownloadError(downloadCtx, err)
	}
	if size == 0 || size > limit {
		return "", "", errors.New("生成文件为空或超过大小限制")
	}
	if response.ContentLength >= 0 && size != response.ContentLength {
		return "", "", io.ErrUnexpectedEOF
	}
	if err = file.Truncate(size); err != nil {
		return "", "", err
	}
	if err = file.updateReservation(size); err != nil {
		return "", "", err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return "", "", err
	}
	head := make([]byte, min(size, 512))
	if _, err = io.ReadFull(file, head); err != nil {
		return "", "", err
	}
	mimeType = normalizedMediaMimeType(response.Header.Get("Content-Type"), head)
	if mode == "audio" && mimeType == "application/ogg" {
		mimeType = "audio/ogg"
	}
	if !strings.HasPrefix(mimeType, mode+"/") {
		return "", "", errors.New("上游返回的内容不是有效的" + mode + "媒体")
	}
	if err = file.Sync(); err != nil {
		return "", "", err
	}
	if err = file.Close(); err != nil {
		return "", "", err
	}
	return filepath.Base(file.Name()), mimeType, nil
}

func mediaUploadKey(taskID string, index int) *string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("task-media:%s:%d", taskID, index)))
	key := hex.EncodeToString(sum[:])
	return &key
}

// storeTaskMediaFile persists one staged media result to its stable OSS identity.
func (s *Service) storeTaskMediaFile(task *model.Task, index int, path, mimeType, kind string, existing *model.Resource) (resource *model.Resource, err error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("暂存作品不是普通文件")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("暂存作品不是普通文件")
	}
	width, height := 0, 0
	durationMs := int64(0)
	if kind == "image" {
		config, _, err := image.DecodeConfig(file)
		if err != nil {
			// The standard library does not decode WebP/AVIF. Verify their
			// container signatures instead of trusting a response MIME header.
			head := make([]byte, 64)
			n, _ := file.ReadAt(head, 0)
			head = head[:n]
			webp := mimeType == "image/webp" && n >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP"
			avif := mimeType == "image/avif" && n >= 16 && string(head[4:8]) == "ftyp" && (strings.Contains(string(head[8:]), "avif") || strings.Contains(string(head[8:]), "avis"))
			if !webp && !avif {
				return nil, fmt.Errorf("图片内容校验失败：%w", err)
			}
		}
		width, height = config.Width, config.Height
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
	} else if kind == "audio" || kind == "video" {
		// Audio and video-processing duration is the source of truth for per-second
		// settlement. The media can still be saved when ffprobe is unavailable;
		// settlement then falls back to provider usage or moves the order to review.
		durationMs = probeMediaDurationMs(path)
	}
	day, err := s.reserveGeneratedResourceQuota(task.UserID, info.Size())
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			s.releaseUserUploadQuota(task.UserID, day, info.Size())
		}
	}()
	writeObject := s.taskMediaObjectWriter()
	if existing == nil {
		resource, _, err = s.storeResourceWithWriter(task.UserID, kind, "generated."+extensionFromMimeType(mimeType), mimeType, info.Size(), width, height, durationMs, file, mediaUploadKey(task.ID, index), false, writeObject)
	} else {
		// Reuse the same object key after a failed upload; no orphan per retry.
		resource = existing
		if resource.UserID != task.UserID || resource.Size != info.Size() || resource.MimeType != mimeType {
			return nil, errors.New("恢复文件与原始资源不一致")
		}
		resource.DurationMs = durationMs
		resource.ETag, err = writeObject(resource, "generated."+extensionFromMimeType(mimeType), file)
		if err == nil {
			resource.Status, resource.Error, resource.UpdatedAt = model.ResourceStatusReady, "", time.Now()
			err = s.saveResourceWithinStorageLimit(resource, "")
		} else {
			// 保留最近一次的存储错误，管理员排查时不必只看首次失败原因。
			resource.Status, resource.Error, resource.UpdatedAt = model.ResourceStatusFailed, err.Error(), time.Now()
			if saveErr := s.repo.SaveResource(resource); saveErr != nil {
				err = errors.Join(err, fmt.Errorf("记录资源失败状态失败：%w", saveErr))
			}
		}
	}
	if err != nil {
		return nil, err
	}
	s.commitUserUploadQuota(task.UserID, info.Size())
	committed = true
	if existing != nil {
		s.recordActivity(task.UserID, "resource", 1)
		s.maybeStartPlaybackTranscode(resource)
	}
	return resource, nil
}

func probeMediaDurationMs(path string) int64 {
	if strings.TrimSpace(path) == "" {
		return 0
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return 0
	}
	output, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path).Output()
	if err != nil {
		return 0
	}
	seconds, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil || seconds <= 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return 0
	}
	return int64(math.Ceil(seconds * 1000))
}

// storeTaskMediaObjectContext 直传对象存储。是否改存本地由 taskMediaObjectWriter
// 决定：只有平台存储失败才会兜底，并且总会登记补传任务，不会静默改变存储位置。
func (s *Service) storeTaskMediaObjectContext(ctx context.Context, resource *model.Resource, body io.Reader) (string, error) {
	setting, err := s.ossSettingForResource(resource.UserID, resource)
	if err != nil {
		return "", err
	}
	return putOSSObjectContext(ctx, s.storageSettingWithRuntimePolicy(setting), resource.ObjectKey, resource.MimeType, resource.Size, body)
}

// Staged copies are removed only after OSS persistence and task registration succeed.
func (s *Service) cleanupMediaCheckpointFiles(task *model.Task) {
	checkpoint, err := s.decodeMediaCheckpoint(task)
	if err != nil {
		return
	}
	for _, item := range checkpoint.Items {
		if path := s.mediaTempPath(item.TempName); path != "" {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				_ = s.log(task.UserID, task.ID, "warn", "清理作品暂存文件失败", "")
			}
		}
	}
}
