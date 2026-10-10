package app

import (
	"strconv"
	"strings"
)

// 供应商与 Seedream 5.0 官方文档的精确尺寸；档位不能由通用像素阈值推断。
func kemeiSeedreamImagePresets() []ImageSizePreset {
	ratios := []string{"1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"}
	tiers := []struct {
		name  string
		sizes []string
	}{
		{"1k", []string{"1024x1024", "1152x864", "864x1152", "1424x800", "800x1424", "1248x832", "832x1248", "1568x672"}},
		{"1.5k", []string{"1536x1536", "1792x1344", "1344x1792", "2048x1152", "1152x2048", "1872x1248", "1248x1872", "2352x1008"}},
		{"2k", []string{"2048x2048", "2368x1776", "1776x2368", "2816x1584", "1584x2816", "2496x1664", "1664x2496", "3136x1344"}},
	}
	result := make([]ImageSizePreset, 0, 24)
	for _, tier := range tiers {
		for index, size := range tier.sizes {
			parts := strings.Split(size, "x")
			width, _ := strconv.Atoi(parts[0])
			height, _ := strconv.Atoi(parts[1])
			result = append(result, ImageSizePreset{Tier: tier.name, Ratio: ratios[index], Width: width, Height: height, Size: size})
		}
	}
	return result
}
