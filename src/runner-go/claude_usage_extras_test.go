package main

import (
	"encoding/json"
	"testing"
)

// The OAuth endpoint's body as it answered on 2026-11-10, trimmed to the parts read.
const claudeUsageExtrasOAuthBody = `{
 "five_hour":null,
 "seven_day":{"utilization":99.0,"resets_at":"2026-11-13T04:00:00.041181+00:00"},
 "cedar_ember":{"eligible":false,"ineligible_reason":"surface","at_limit":false,"exhausted":[],"grants":[],"next_grant_id":null},
 "extra_usage":{"is_enabled":false,"monthly_limit":null,"used_credits":null},
 "limits":[
  {"kind":"weekly_all","group":"weekly","percent":99,"severity":"critical","resets_at":"2026-11-13T04:00:00.041181+00:00","scope":null,"is_active":true},
  {"kind":"weekly_scoped","group":"weekly","percent":0,"severity":"normal","resets_at":"2026-11-13T04:00:00+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}
 ],
 "spend":{"used":{"amount_minor":0,"currency":"USD","exponent":2},"limit":null,"percent":0,"enabled":false}
}`

func TestParsePlanUsageReadsClaudeExtras(t *testing.T) {
	usage, err := parsePlanUsage([]byte(claudeUsageExtrasOAuthBody))
	if err != nil {
		t.Fatal(err)
	}
	if usage.SevenDay == nil || usage.SevenDay.Utilization != 99 {
		t.Fatalf("seven_day = %+v", usage.SevenDay)
	}
	if len(usage.ModelLimits) != 1 || usage.ModelLimits[0].Model != "Fable" || usage.ModelLimits[0].Utilization != 0 ||
		usage.ModelLimits[0].ResetsAt != "2026-11-13T04:00:00+00:00" || usage.ModelLimits[0].Active {
		t.Fatalf("modelLimits = %+v", usage.ModelLimits)
	}
	extra := usage.ExtraUsage
	if extra == nil || extra.Enabled || extra.Currency != "USD" || extra.Exponent != 2 || extra.UsedMinor == nil ||
		*extra.UsedMinor != 0 || extra.LimitMinor != nil {
		t.Fatalf("extraUsage = %+v", extra)
	}
	grants := usage.ResetGrants
	if grants == nil || grants.Eligible || grants.IneligibleReason != "surface" || grants.ResetsLeft != 0 || len(grants.Grants) != 0 {
		t.Fatalf("resetGrants = %+v", grants)
	}
}

// The grants as claude.ai's own surface reports them: only usable ones count toward resetsLeft.
func TestParsePlanUsageCountsUsableResetGrants(t *testing.T) {
	body := `{"seven_day":{"utilization":2},"cedar_ember":{"eligible":true,"ineligible_reason":null,"grants":[
	 {"id":"launch-a","label":"One reset","resets_total":1,"resets_left":1,"usable_now":true,"ends_at":"2027-03-09T07:59:00+00:00"},
	 {"id":"launch-b","label":"Another","resets_total":1,"resets_left":1,"usable_now":false},
	 {"id":"","resets_left":5,"usable_now":true}]},
	 "spend":null,"extra_usage":{"is_enabled":true}}`
	usage, err := parsePlanUsage([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	grants := usage.ResetGrants
	if grants == nil || !grants.Eligible || grants.ResetsLeft != 1 || len(grants.Grants) != 2 ||
		grants.Grants[0].EndsAt != "2027-03-09T07:59:00+00:00" || grants.Grants[1].UsableNow {
		t.Fatalf("resetGrants = %+v", grants)
	}
	if usage.ExtraUsage == nil || !usage.ExtraUsage.Enabled || usage.ExtraUsage.UsedMinor != nil {
		t.Fatalf("extraUsage = %+v", usage.ExtraUsage)
	}
}

// A part in a shape not expected is dropped alone: the windows and the other parts still arrive.
func TestParsePlanUsageSurvivesChangedExtras(t *testing.T) {
	body := `{"seven_day":{"utilization":40},"limits":"changed","cedar_ember":{"eligible":true,"grants":[]},"spend":7}`
	usage, err := parsePlanUsage([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if usage.SevenDay == nil || usage.ModelLimits != nil || usage.ExtraUsage != nil || usage.ResetGrants == nil {
		b, _ := json.Marshal(usage)
		t.Fatalf("usage = %s", b)
	}
}
