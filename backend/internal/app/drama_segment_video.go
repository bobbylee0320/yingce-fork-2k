package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

type dramaRevisionPayload struct {
	Revision int64 `json:"revision"`
	Seconds  int   `json:"seconds,omitempty"`
}

func encodeDramaRevision(revision int64) string {
	b, _ := json.Marshal(dramaRevisionPayload{Revision: revision})
	return string(b)
}

func dramaPromptReady(segment model.DramaSegment) bool {
	return strings.TrimSpace(segment.VideoPromptOverride) != "" || (segment.PromptStatus == model.DramaMediaReady && strings.TrimSpace(segment.VideoPrompt) != "")
}

func dramaSegmentVideoDone(segment model.DramaSegment) bool {
	return segment.VideoStatus == model.DramaMediaReady && segment.VideoResourceID != "" && segment.TailFrameResourceID != ""
}

// dramaVideoWaitReason 说明第 index 段视频为何还不能提交；空串表示调度会提交它。调度与详情页共用。
func dramaVideoWaitReason(settings DramaSettings, p *model.DramaProduction, e *model.DramaEpisode, segments []model.DramaSegment, index int, shots []model.DramaShot, lookup func(string) (model.DramaCast, bool)) string {
	switch {
	case p.Status == model.DramaStatusPaused:
		if reason := strings.TrimSpace(p.PauseReason); reason != "" {
			return "制作已暂停：" + reason
		}
		return "制作已暂停"
	case p.Status != model.DramaStatusRunning:
		return "制作未在运行，点“继续制作”后开始"
	case e.Stage == model.DramaEpisodeQueued || e.Stage == model.DramaEpisodeScript:
		return "等待本集剧本完成"
	case dramaMediaHeld(settings, e):
		return "本集尚未放行生图"
	case settings.ReviewMode == DramaReviewSample && !p.SampleApproved && e.Number != 1:
		return "等待确认第 1 集样片"
	}
	if index > 0 && !dramaSegmentVideoDone(segments[index-1]) {
		return "等待上一段视频生成（需要它的最后一帧）"
	}
	if !dramaPromptReady(segments[index]) {
		return "等待本段视频提示词撰写完成"
	}
	// 未生成的参考图在自动生图或已放行时会被调度排队，同样要等。
	requested := settings.MediaMode != DramaMediaManual || p.AssetsReleased
	if names := dramaReferencesInProgress(segments[index].SegmentIndex, shots, lookup, requested); len(names) > 0 {
		return "等待参考图生成：" + strings.Join(names, "、")
	}
	return ""
}

// dramaReferencesInProgress 返回本段引用、仍在生成的参考图名称。等它们能提升角色一致性；
// 失败、锁定或从未请求的参考图不再等待，提交时改用文字设定（见 prepareDramaSegment）。
func dramaReferencesInProgress(segmentIndex int, shots []model.DramaShot, lookup func(string) (model.DramaCast, bool), unrequestedQueued bool) []string {
	names := []string{}
	seen := map[string]bool{}
	for _, shot := range shots {
		if shot.SegmentIndex != segmentIndex {
			continue
		}
		for _, id := range dramaShotCastIDs(shot) {
			cast, ok := lookup(id)
			if !ok || seen[id] || cast.Locked {
				continue
			}
			seen[id] = true
			if cast.ImageStatus == model.DramaMediaQueued || cast.ImageStatus == model.DramaMediaRunning || (cast.ImageStatus == "" && unrequestedQueued) {
				names = append(names, cast.Name)
			}
		}
	}
	return names
}

func segmentVideoChoice(segment model.DramaSegment, fallback DramaModelChoice) DramaModelChoice {
	var choice DramaModelChoice
	if json.Unmarshal([]byte(segment.VideoModelJSON), &choice) == nil && !choice.Empty() {
		return choice
	}
	return fallback
}

// prepareDramaSegment is shared by the request preview and provider submission.
// Reference numbering remains stable even when a model cannot accept every image.
func (s *Service) prepareDramaSegment(settings DramaSettings, draft dramaSegmentDraft, segment model.DramaSegment, previous *model.DramaSegment, casts map[string]model.DramaCast) (DramaSegmentRequest, []any, error) {
	profile, err := s.dramaVideoProfile(segmentVideoChoice(segment, settings.Models.Video))
	if err != nil {
		return DramaSegmentRequest{}, nil, err
	}
	request := DramaSegmentRequest{Seconds: production.SnapVideoSeconds(draft.view.DurationMs, profile.Durations), MaxVideoSeconds: profile.maxSeconds(), References: []DramaSegmentReference{}}
	if draft.view.DurationMs > int64(request.MaxVideoSeconds)*1000 {
		return request, nil, errors.New("剧情段超过所选视频模型的时长上限，请调整分镜时长或重新改编")
	}
	if !profile.GenerateAudio {
		return request, nil, errors.New("所选模型未声明同步生成声音能力，请选择支持对白与音效的视频模型")
	}
	refs := []any{}
	header := []string{}
	if previous != nil {
		request.Operation = "image_to_video"
		request.FirstFramePending = previous.VideoStatus != model.DramaMediaReady || previous.TailFrameResourceID == ""
		if !request.FirstFramePending {
			request.FirstFrameResourceID = previous.TailFrameResourceID
			ref, err := s.dramaResourceReference(previous.TailFrameResourceID, "first-frame", "first_frame")
			if err != nil {
				return request, nil, err
			}
			refs = append(refs, ref)
		}
		header = append(header, "首帧图为上一段视频的最后一帧，不占参考图编号。")
	} else if profile.supports("reference_to_video") {
		request.Operation = "reference_to_video"
	} else {
		request.Operation = "text_to_video"
	}
	if !profile.supports(request.Operation) {
		return request, nil, fmt.Errorf("所选模型不支持本段所需的 %s", request.Operation)
	}
	capacity := profile.MaxImages
	if previous != nil {
		capacity--
	}
	if request.Operation == "text_to_video" {
		capacity = 0
	}
	for _, reference := range draft.view.Request.References {
		cast, exists := casts[reference.CastID]
		if !exists {
			return request, nil, errors.New("剧情段引用的设定不存在")
		}
		reference.ResourceID = cast.ImageResourceID
		reference.Sent = capacity > 0 && cast.ImageStatus == model.DramaMediaReady && cast.ImageResourceID != ""
		if reference.Sent {
			ref, err := s.dramaResourceReference(cast.ImageResourceID, reference.Label, "")
			if err != nil {
				return request, nil, err
			}
			refs = append(refs, ref)
			capacity--
			header = append(header, reference.Label+"："+reference.Name)
		} else {
			header = append(header, reference.Label+"（"+reference.Name+"）未附图，请依据文字设定："+firstNonEmpty(cast.Appearance, cast.Description))
			request.Warning = "部分参考图未就绪或超出模型上限，详见参考图列表"
		}
		request.References = append(request.References, reference)
	}
	request.Header = strings.Join(header, "\n")
	return request, refs, nil
}

func (s *Service) dramaResourceReference(id, name, role string) (map[string]any, error) {
	// The caller has already verified the project owner; check resource ownership at submission too.
	resource, err := s.repo.Resource(id)
	if err != nil {
		return nil, err
	}
	if resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, "image/") {
		return nil, errors.New("参考图片不可用")
	}
	ref := map[string]any{"id": name, "name": name, "type": resource.MimeType, "mimeType": resource.MimeType, "storageKey": "resource:" + id, "bytes": resource.Size, "width": resource.Width, "height": resource.Height}
	if role != "" {
		ref["role"] = role
	}
	return ref, nil
}

func (r *dramaRun) submitSegmentVideo(job *model.DramaJob) (*model.Task, bool, error) {
	segment, err := r.s.repo.DramaSegment(r.project.ID, job.ShotID)
	if err != nil {
		return nil, false, err
	}
	job.PayloadJSON = encodeDramaRevision(segment.Revision)
	if segment.VideoStatus != "" && segment.VideoStatus != model.DramaMediaQueued {
		return nil, true, nil
	}
	episode, err := r.s.repo.DramaEpisode(r.project.ID, segment.EpisodeID)
	if err != nil {
		return nil, false, err
	}
	explicit := segment.VideoStatus == model.DramaMediaQueued && (episode.Stage == model.DramaEpisodePrompts || episode.Stage == model.DramaEpisodeReview)
	if (episode.Stage != model.DramaEpisodeVideo && !explicit) || r.mediaHeld(episode) || r.sampleBlocked(episode) {
		return nil, true, nil
	}
	if !dramaPromptReady(*segment) {
		return nil, false, errors.New("请先完成并确认本段视频提示词")
	}
	shots, err := r.s.repo.DramaShots(episode.ID)
	if err != nil {
		return nil, false, err
	}
	rows, err := r.s.repo.DramaSegments(episode.ID)
	if err != nil {
		return nil, false, err
	}
	casts := map[string]model.DramaCast{}
	for _, cast := range r.casts {
		casts[cast.ID] = cast
	}
	var previous *model.DramaSegment
	for i := range rows {
		if rows[i].ID == segment.ID && i > 0 {
			previous = &rows[i-1]
		}
	}
	for _, draft := range buildDramaSegmentDrafts(r.settings, r.meta, shots, casts) {
		if draft.view.Index != segment.SegmentIndex {
			continue
		}
		request, refs, err := r.s.prepareDramaSegment(r.settings, draft, *segment, previous, casts)
		if err != nil {
			return nil, false, err
		}
		if segment.PromptSeconds > 0 && segment.PromptSeconds != request.Seconds {
			return nil, false, errors.New("所选模型时长档位与提示词不同，请先用该模型重新撰写提示词")
		}
		if request.FirstFramePending {
			return nil, true, nil
		}
		for _, ref := range refs {
			m := ref.(map[string]any)
			id := strings.TrimPrefix(m["storageKey"].(string), "resource:")
			if _, err := r.s.repo.ResourceForUser(r.project.UserID, id); err != nil {
				return nil, false, err
			}
		}
		metadata := r.metadata(job)
		if previous != nil {
			metadata["videoStartFrameNodeId"] = "first-frame"
		}
		config := map[string]any{"videoSeconds": itoa(request.Seconds), "size": r.settings.AspectRatio, "videoGenerateAudio": "true"}
		prompt := strings.TrimSpace(request.Header + "\n\n" + firstNonEmpty(segment.VideoPromptOverride, segment.VideoPrompt))
		payload, _ := json.Marshal(dramaRevisionPayload{Revision: segment.Revision, Seconds: request.Seconds})
		job.PayloadJSON = string(payload)
		task, err := r.createTaskWith(segmentVideoChoice(*segment, r.settings.Models.Video), "video", request.Operation, prompt, map[string]any{"config": config, "referenceImages": refs, "metadata": metadata})
		return task, false, err
	}
	return nil, false, errors.New("剧情段没有对应分镜")
}

func (r *dramaRun) applySegmentVideo(job *model.DramaJob, task *model.Task) error {
	resourceID := dramaTaskResource(task)
	if resourceID == "" {
		return errors.New("视频任务未返回资源")
	}
	var payload dramaRevisionPayload
	if err := json.Unmarshal([]byte(job.PayloadJSON), &payload); err != nil {
		return err
	}
	if err := r.s.repo.CreateDramaTake(&model.DramaTake{ID: newID(), ProjectID: r.project.ID, OwnerID: job.ShotID, Kind: "video", ResourceID: resourceID, TaskID: task.ID, Prompt: task.Prompt, DurationMs: int64(payload.Seconds) * 1000, CreatedAt: time.Now()}); err != nil {
		return err
	}
	segment, err := r.s.repo.DramaSegment(r.project.ID, job.ShotID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if segment.Revision != payload.Revision {
		return nil
	}
	// Persist the paid output before local post-processing. Retrying only reopens this task's result.
	if _, err := r.s.repo.UpdateDramaSegmentRevision(segment.ID, payload.Revision, map[string]any{"video_resource_id": resourceID, "video_seconds": payload.Seconds}); err != nil {
		return err
	}
	tail, err := r.s.extractDramaTailFrame(r.project.UserID, resourceID)
	if err != nil {
		return err
	}
	_, err = r.s.repo.UpdateDramaSegmentRevision(segment.ID, payload.Revision, map[string]any{"video_status": model.DramaMediaReady, "tail_frame_resource_id": tail, "video_error": ""})
	return err
}

// dramaVideoJobReplayable 表示段视频作业的生成任务已成功，只是结果回写（如抽尾帧）失败；
// 重新处理会重放同一任务结果，不再提交模型。
func dramaVideoJobReplayable(job model.DramaJob) bool {
	if job.Kind != model.DramaJobSegmentVideo || job.Status != model.DramaJobFailed || job.TaskID == "" {
		return false
	}
	var attempts []DramaJobAttempt
	_ = json.Unmarshal([]byte(job.AttemptsJSON), &attempts)
	for _, attempt := range attempts {
		if attempt.TaskID == job.TaskID && attempt.Status == string(model.TaskStatusSucceeded) {
			return true
		}
	}
	return false
}

// ReprocessDramaSegmentVideo 重新处理一段已生成、但后处理失败的视频：只重放原任务结果，不重新生成、不重复扣费。
func (s *Service) ReprocessDramaSegmentVideo(userID, projectID, episodeID string, index int) (map[string]any, error) {
	project, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return nil, err
	}
	episode, err := s.repo.DramaEpisode(project.ID, episodeID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.DramaSegments(episode.ID)
	if err != nil {
		return nil, err
	}
	var segment *model.DramaSegment
	for i := range rows {
		if rows[i].SegmentIndex == index {
			segment = &rows[i]
			break
		}
	}
	if segment == nil {
		return nil, BadAuthRequest("剧情段不存在")
	}
	if segment.VideoStatus != model.DramaMediaFailed || segment.VideoResourceID == "" {
		return nil, BadAuthRequest("本段没有需要重新处理的视频")
	}
	jobs, err := s.repo.RecentDramaSegmentJobs(project.ID, episode.ID)
	if err != nil {
		return nil, err
	}
	for _, job := range jobs {
		if job.Kind != model.DramaJobSegmentVideo || job.ShotID != segment.ID {
			continue
		}
		// 只看最近一次视频作业：更早的结果已被后续生成取代，不能拿来重放。
		if !dramaVideoJobReplayable(job) {
			break
		}
		reopened, err := s.repo.ReopenDramaSegmentVideoJob(job.ID, segment.ID)
		if err != nil {
			return nil, err
		}
		if !reopened {
			break
		}
		return map[string]any{"reprocessing": true}, s.requestDramaWork(p)
	}
	return nil, BadAuthRequest("找不到可重新处理的视频结果，请重新生成本段视频")
}

func (s *Service) extractDramaTailFrame(userID, resourceID string) (string, error) {
	if s.dramaTailFrameHook != nil {
		return s.dramaTailFrameHook(userID, resourceID)
	}
	resource, body, err := s.OpenResource(userID, resourceID)
	if err != nil {
		return "", err
	}
	defer body.Close()
	if !strings.HasPrefix(resource.MimeType, "video/") {
		return "", errors.New("尾帧来源不是视频")
	}
	ffmpegBin, err := renderFfmpegBinary()
	if err != nil {
		return "", fmt.Errorf("抽取尾帧失败：%w", err)
	}
	dir, err := os.MkdirTemp("", "yingce-drama-tail-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	input := filepath.Join(dir, "input.mp4")
	file, err := os.Create(input)
	if err != nil {
		return "", err
	}
	_, copyErr := io.Copy(file, body)
	closeErr := file.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	output := filepath.Join(dir, "tail.png")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Decode every remaining frame and update the same output, so the saved image is the actual final frame.
	cmd := exec.CommandContext(ctx, ffmpegBin, "-hide_banner", "-loglevel", "error", "-sseof", "-1", "-i", input, "-an", "-update", "1", "-y", output)
	if out, err := cmd.CombinedOutput(); err != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("抽取尾帧失败：%s", clipText(detail, 400))
	}
	image, err := os.Open(output)
	if err != nil {
		return "", err
	}
	defer image.Close()
	info, err := image.Stat()
	if err != nil {
		return "", err
	}
	saved, err := s.UploadResourceFile(userID, "tail.png", info.Size(), "image", resource.Width, resource.Height, 0, image, "drama-tail:"+resourceID)
	if err != nil {
		return "", err
	}
	return saved.ID, nil
}
