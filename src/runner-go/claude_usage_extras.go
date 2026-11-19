package main

import (
	"encoding/json"
	"strings"
)

// What the Claude OAuth usage endpoint reports beside the named windows. All of it is display only:
// no quota decision reads it, so a field Anthropic renames costs a line in the popover, never a
// session.

// claudeUsageQuery asks the endpoint for its weekly-reset block (cedar_ember). Measured 2026-11-10:
// over OAuth it answers eligible=false, ineligible_reason="surface" with no grants, because resets
// are offered on claude.ai only. Asked anyway, so the day Anthropic offers them here they show up.
const claudeUsageQuery = "?cedar_ember=1"

// PlanUsageModelLimit is one model-scoped weekly limit (the endpoint's limits[] kind
// "weekly_scoped"), e.g. Fable's share of the weekly allowance.
type PlanUsageModelLimit struct {
	Model       string  `json:"model"`
	Utilization float64 `json:"utilization"`
	ResetsAt    string  `json:"resetsAt,omitempty"`
	// Whether this limit is the one currently binding the model, as the endpoint says.
	Active bool `json:"active"`
}

// PlanUsageExtraUsage is the account's pay-as-you-go usage past its plan limits (spend, else
// extra_usage). Amounts are in the currency's minor units; omitted when the endpoint sent none.
type PlanUsageExtraUsage struct {
	Enabled    bool   `json:"enabled"`
	Currency   string `json:"currency,omitempty"`
	Exponent   int    `json:"exponent,omitempty"`
	UsedMinor  *int64 `json:"usedMinor,omitempty"`
	LimitMinor *int64 `json:"limitMinor,omitempty"`
}

// PlanUsageResetGrants is the weekly-reset block (cedar_ember): whether this login may use a reset
// here and, if so, the grants it holds. Orbit never spends one; it only says they exist.
type PlanUsageResetGrants struct {
	Eligible         bool                  `json:"eligible"`
	IneligibleReason string                `json:"ineligibleReason,omitempty"`
	ResetsLeft       int                   `json:"resetsLeft"`
	Grants           []PlanUsageResetGrant `json:"grants,omitempty"`
}

type PlanUsageResetGrant struct {
	ID         string `json:"id"`
	Label      string `json:"label,omitempty"`
	ResetsLeft int    `json:"resetsLeft"`
	UsableNow  bool   `json:"usableNow"`
	EndsAt     string `json:"endsAt,omitempty"`
}

// parseClaudeUsageExtras fills usage's display-only Claude fields from the endpoint's body. A part
// that is missing or not the shape expected is left out; nothing here fails the read.
func parseClaudeUsageExtras(body []byte, usage *PlanUsage) {
	type money struct {
		AmountMinor *int64 `json:"amount_minor"`
		Currency    string `json:"currency"`
		Exponent    *int   `json:"exponent"`
	}
	var raw struct {
		Limits []struct {
			Kind     string   `json:"kind"`
			Percent  *float64 `json:"percent"`
			ResetsAt string   `json:"resets_at"`
			IsActive bool     `json:"is_active"`
			Scope    *struct {
				Model *struct {
					DisplayName string `json:"display_name"`
				} `json:"model"`
			} `json:"scope"`
		} `json:"limits"`
		Spend *struct {
			Enabled bool   `json:"enabled"`
			Used    *money `json:"used"`
			Limit   *money `json:"limit"`
		} `json:"spend"`
		ExtraUsage *struct {
			IsEnabled bool `json:"is_enabled"`
		} `json:"extra_usage"`
		CedarEmber *struct {
			Eligible         bool   `json:"eligible"`
			IneligibleReason string `json:"ineligible_reason"`
			Grants           []struct {
				ID         string `json:"id"`
				Label      string `json:"label"`
				ResetsLeft int    `json:"resets_left"`
				UsableNow  bool   `json:"usable_now"`
				EndsAt     string `json:"ends_at"`
			} `json:"grants"`
		} `json:"cedar_ember"`
	}
	// Each part is decoded on its own, so one changed shape does not take the others with it.
	var parts map[string]json.RawMessage
	if json.Unmarshal(body, &parts) != nil {
		return
	}
	decodeClaudeUsagePart(parts["limits"], &raw.Limits)
	decodeClaudeUsagePart(parts["spend"], &raw.Spend)
	decodeClaudeUsagePart(parts["extra_usage"], &raw.ExtraUsage)
	decodeClaudeUsagePart(parts["cedar_ember"], &raw.CedarEmber)

	for _, l := range raw.Limits {
		if l.Kind != "weekly_scoped" || l.Percent == nil || l.Scope == nil || l.Scope.Model == nil {
			continue
		}
		model := strings.TrimSpace(l.Scope.Model.DisplayName)
		if model == "" {
			continue
		}
		usage.ModelLimits = append(usage.ModelLimits, PlanUsageModelLimit{
			Model: model, Utilization: *l.Percent, ResetsAt: l.ResetsAt, Active: l.IsActive,
		})
	}

	if s := raw.Spend; s != nil {
		extra := &PlanUsageExtraUsage{Enabled: s.Enabled}
		if s.Used != nil && s.Used.AmountMinor != nil {
			extra.UsedMinor = s.Used.AmountMinor
			extra.Currency = s.Used.Currency
			if s.Used.Exponent != nil {
				extra.Exponent = *s.Used.Exponent
			}
		}
		if s.Limit != nil && s.Limit.AmountMinor != nil {
			extra.LimitMinor = s.Limit.AmountMinor
		}
		usage.ExtraUsage = extra
	} else if raw.ExtraUsage != nil {
		usage.ExtraUsage = &PlanUsageExtraUsage{Enabled: raw.ExtraUsage.IsEnabled}
	}

	if c := raw.CedarEmber; c != nil {
		grants := &PlanUsageResetGrants{Eligible: c.Eligible, IneligibleReason: c.IneligibleReason}
		for _, g := range c.Grants {
			if g.ID == "" {
				continue
			}
			grants.Grants = append(grants.Grants, PlanUsageResetGrant{
				ID: g.ID, Label: g.Label, ResetsLeft: g.ResetsLeft, UsableNow: g.UsableNow, EndsAt: g.EndsAt,
			})
			if g.UsableNow && g.ResetsLeft > 0 {
				grants.ResetsLeft += g.ResetsLeft
			}
		}
		usage.ResetGrants = grants
	}
}

// decodeClaudeUsagePart sets *into from part, or leaves it zero when part does not decode: a failed
// Unmarshal can leave a half-filled value behind.
func decodeClaudeUsagePart[T any](part json.RawMessage, into *T) {
	var v T
	if len(part) > 0 && json.Unmarshal(part, &v) == nil {
		*into = v
	}
}
