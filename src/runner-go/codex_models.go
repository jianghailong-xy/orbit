package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
)

type codexDebugModels struct {
	Models []struct {
		Slug                     string `json:"slug"`
		DisplayName              string `json:"display_name"`
		Visibility               string `json:"visibility"`
		Priority                 *int   `json:"priority"`
		ContextWindow            int    `json:"context_window"`
		DefaultReasoningLevel    string `json:"default_reasoning_level"`
		SupportedReasoningLevels []struct {
			Effort string `json:"effort"`
		} `json:"supported_reasoning_levels"`
		ServiceTiers []struct {
			ID string `json:"id"`
		} `json:"service_tiers"`
	} `json:"models"`
}

func fetchCodexModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	out, err := exec.CommandContext(cctx, "codex", "debug", "models").CombinedOutput()
	if err != nil {
		return nil, err
	}
	return parseCodexModelCatalog(out)
}

func codexCLIAvailable() bool {
	_, err := exec.LookPath("codex")
	return err == nil
}

func parseCodexModelCatalog(out []byte) ([]ModelInfo, error) {
	start := bytes.IndexByte(out, '{')
	if start < 0 {
		return nil, fmt.Errorf("codex debug models returned no JSON object")
	}
	var raw codexDebugModels
	if err := json.Unmarshal(out[start:], &raw); err != nil {
		return nil, err
	}

	models := make([]ModelInfo, 0, len(raw.Models))
	for _, m := range raw.Models {
		if strings.TrimSpace(m.Slug) == "" || m.Visibility != "list" {
			continue
		}
		label := strings.TrimSpace(m.DisplayName)
		if label == "" {
			label = m.Slug
		}
		info := ModelInfo{
			Value:                 m.Slug,
			Label:                 label,
			Priority:              m.Priority,
			ContextWindow:         m.ContextWindow,
			DefaultReasoningLevel: m.DefaultReasoningLevel,
		}
		for _, r := range m.SupportedReasoningLevels {
			if r.Effort != "" {
				info.ReasoningLevels = append(info.ReasoningLevels, r.Effort)
			}
		}
		for _, t := range m.ServiceTiers {
			if t.ID != "" {
				info.ServiceTiers = append(info.ServiceTiers, t.ID)
			}
		}
		models = append(models, info)
	}
	sort.SliceStable(models, func(i, j int) bool {
		pi, pj := int(^uint(0)>>1), int(^uint(0)>>1)
		if models[i].Priority != nil {
			pi = *models[i].Priority
		}
		if models[j].Priority != nil {
			pj = *models[j].Priority
		}
		if pi != pj {
			return pi < pj
		}
		return models[i].Value < models[j].Value
	})
	return models, nil
}
