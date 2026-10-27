package production

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

type BibleCharacter struct {
	Name        string   `json:"name"`
	Aliases     []string `json:"aliases"`
	Role        string   `json:"role"`
	Gender      string   `json:"gender"`
	Age         string   `json:"age"`
	Description string   `json:"description"`
	Appearance  string   `json:"appearance"`
	Voice       string   `json:"voice"`
}

// BibleProp 是反复出现、需要保持外观一致的关键道具（法器、信物、兵器等）。
type BibleProp struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Appearance  string `json:"appearance"`
}
type BibleScene struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Appearance  string `json:"appearance"`
}

type Bible struct {
	Logline     string           `json:"logline"`
	Tone        string           `json:"tone"`
	VisualRules string           `json:"visualRules"`
	Characters  []BibleCharacter `json:"characters"`
	Props       []BibleProp      `json:"props"`
	Scenes      []BibleScene     `json:"scenes"`
}

type PlannedEpisode struct {
	Title       string `json:"title"`
	Chapters    []int  `json:"chapters"`
	Synopsis    string `json:"synopsis"`
	Hook        string `json:"hook"`
	Cliffhanger string `json:"cliffhanger"`
}

type ScriptShot struct {
	Scene           string   `json:"scene"`
	Characters      []string `json:"characters"`
	Props           []string `json:"props"`
	Speaker         string   `json:"speaker"`
	Dialogue        string   `json:"dialogue"`
	Action          string   `json:"action"`
	ShotSize        string   `json:"shotSize"`
	Camera          string   `json:"camera"`
	DurationSeconds float64  `json:"durationSeconds"`
	ImagePrompt     string   `json:"imagePrompt"`
	VideoPrompt     string   `json:"videoPrompt"`
	SourceQuote     string   `json:"sourceQuote"`
	Transition      string   `json:"transition"`
}

// MaxScriptShots 是单集镜头数上限；长集（如 10 分钟）按 3 秒一镜也在范围内。
const MaxScriptShots = 240

var ErrNoJSON = errors.New("模型没有返回可解析的 JSON")

// ExtractJSONObject 容忍模型在 JSON 前后附带代码块或说明文字。
func ExtractJSONObject(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return "", ErrNoJSON
	}
	candidate := text[start : end+1]
	if !json.Valid([]byte(candidate)) {
		return "", ErrNoJSON
	}
	return candidate, nil
}

func ParseBible(raw string) (Bible, error) {
	var bible Bible
	text, err := ExtractJSONObject(raw)
	if err != nil {
		return bible, err
	}
	if err := json.Unmarshal([]byte(text), &bible); err != nil {
		return bible, err
	}
	seen := map[string]bool{}
	characters := bible.Characters[:0]
	for _, character := range bible.Characters {
		character.Name = strings.TrimSpace(character.Name)
		key := NormalizeName(character.Name)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		characters = append(characters, character)
		if len(characters) >= 24 {
			break
		}
	}
	bible.Characters = characters
	sceneSeen := map[string]bool{}
	scenes := bible.Scenes[:0]
	for _, scene := range bible.Scenes {
		scene.Name = strings.TrimSpace(scene.Name)
		key := NormalizeName(scene.Name)
		if key == "" || sceneSeen[key] {
			continue
		}
		sceneSeen[key] = true
		scenes = append(scenes, scene)
		if len(scenes) >= 16 {
			break
		}
	}
	bible.Scenes = scenes
	propSeen := map[string]bool{}
	props := bible.Props[:0]
	for _, prop := range bible.Props {
		prop.Name = strings.TrimSpace(prop.Name)
		key := NormalizeName(prop.Name)
		if key == "" || propSeen[key] {
			continue
		}
		propSeen[key] = true
		props = append(props, prop)
		if len(props) >= 20 {
			break
		}
	}
	bible.Props = props
	if len(bible.Characters) == 0 {
		return bible, errors.New("作品圣经没有识别到角色")
	}
	return bible, nil
}

// ParsePlan 只接受本批章节内的序号，并补齐模型漏掉的章节，保证原文全部被覆盖。
func ParsePlan(raw string, batch []Chapter) ([]PlannedEpisode, error) {
	text, err := ExtractJSONObject(raw)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Episodes []struct {
			Title       string `json:"title"`
			Chapters    []any  `json:"chapters"`
			Synopsis    string `json:"synopsis"`
			Hook        string `json:"hook"`
			Cliffhanger string `json:"cliffhanger"`
		} `json:"episodes"`
	}
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return nil, err
	}
	allowed := map[int]bool{}
	for _, chapter := range batch {
		allowed[chapter.Index] = true
	}
	covered := map[int]bool{}
	episodes := make([]PlannedEpisode, 0, len(payload.Episodes))
	for _, item := range payload.Episodes {
		episode := PlannedEpisode{Title: strings.TrimSpace(item.Title), Synopsis: strings.TrimSpace(item.Synopsis), Hook: strings.TrimSpace(item.Hook), Cliffhanger: strings.TrimSpace(item.Cliffhanger)}
		for _, value := range item.Chapters {
			index, ok := anyInt(value)
			if ok && allowed[index] && !containsInt(episode.Chapters, index) {
				episode.Chapters = append(episode.Chapters, index)
				covered[index] = true
			}
		}
		if len(episode.Chapters) == 0 || episode.Synopsis == "" {
			continue
		}
		if episode.Title == "" {
			episode.Title = truncateRunes(episode.Synopsis, 10)
		}
		episodes = append(episodes, episode)
	}
	for _, chapter := range batch {
		if covered[chapter.Index] {
			continue
		}
		episodes = append(episodes, PlannedEpisode{Title: chapter.Title, Chapters: []int{chapter.Index}, Synopsis: truncateRunes(strings.TrimSpace(chapter.Text), 120)})
	}
	if len(episodes) == 0 {
		return nil, errors.New("分集规划为空")
	}
	return episodes, nil
}

func ParseScript(raw string) ([]ScriptShot, error) {
	text, err := ExtractJSONObject(raw)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Shots []ScriptShot `json:"shots"`
	}
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return nil, err
	}
	shots := make([]ScriptShot, 0, len(payload.Shots))
	for _, shot := range payload.Shots {
		shot.ImagePrompt = strings.TrimSpace(shot.ImagePrompt)
		shot.Action = strings.TrimSpace(shot.Action)
		shot.Dialogue = strings.TrimSpace(shot.Dialogue)
		shot.Speaker = strings.TrimSpace(shot.Speaker)
		if shot.ImagePrompt == "" && shot.Action == "" {
			continue
		}
		if shot.ImagePrompt == "" {
			shot.ImagePrompt = shot.Action
		}
		if shot.Dialogue == "" {
			shot.Speaker = ""
		}
		shots = append(shots, shot)
		if len(shots) >= MaxScriptShots {
			break
		}
	}
	if len(shots) == 0 {
		return nil, errors.New("分镜脚本没有可用镜头")
	}
	return shots, nil
}

func anyInt(value any) (int, bool) {
	switch v := value.(type) {
	case float64:
		return int(v), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		return n, err == nil
	}
	return 0, false
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
