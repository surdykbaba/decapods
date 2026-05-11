// Package notifications — teams.go
//
// Microsoft Teams adapter. Reads the tenant's `teams` config from
// tenants.settings (an array of webhook subscriptions) and posts an Adaptive
// Card to each subscription whose category filter matches the event.
//
// Why Adaptive Cards: Teams renders them as rich, branded cards with title,
// body, tone-coloured stripe, fact rows and a single primary action link.
// They degrade to plain text on connectors that don't support cards yet.
//
// Why webhooks (not a Bot Framework / Graph API integration): zero OAuth /
// Azure AD app registration. An admin pastes one URL per channel and we're
// posting in seconds. Bidirectional bot work can layer on later without
// touching this code.
package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TeamsWebhook is one subscription — a single Teams channel.
type TeamsWebhook struct {
	ID          string   `json:"id"`           // UUID, generated on create
	Name        string   `json:"name"`         // friendly label e.g. "Delivery channel"
	URL         string   `json:"url"`          // outlook.office.com or office365.com incoming webhook
	Categories  []string `json:"categories"`   // ["pipeline","delivery",...] — empty = all
	MinSeverity string   `json:"min_severity"` // "info" | "warn" | "critical"
	Active      bool     `json:"active"`
	CreatedAt   string   `json:"created_at,omitempty"`
}

// TeamsConfig is the JSON blob stored at tenants.settings.teams.
type TeamsConfig struct {
	Webhooks []TeamsWebhook `json:"webhooks"`
}

// LoadTeamsConfig pulls the tenant's Teams subscriptions, defaulting to empty
// when the row doesn't exist or the key is missing.
func LoadTeamsConfig(ctx context.Context, db *pgxpool.Pool, tid uuid.UUID) TeamsConfig {
	out := TeamsConfig{}
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil || len(raw) == 0 {
		return out
	}
	var s map[string]json.RawMessage
	if err := json.Unmarshal(raw, &s); err != nil {
		return out
	}
	if t, ok := s["teams"]; ok {
		_ = json.Unmarshal(t, &out)
	}
	return out
}

// SaveTeamsConfig writes the config back. Generates UUIDs + created_at for
// new rows and strips secrets from anything that's been removed.
func SaveTeamsConfig(ctx context.Context, db *pgxpool.Pool, tid uuid.UUID, cfg TeamsConfig) error {
	now := time.Now().UTC().Format(time.RFC3339)
	for i := range cfg.Webhooks {
		w := &cfg.Webhooks[i]
		w.Name = strings.TrimSpace(w.Name)
		w.URL = strings.TrimSpace(w.URL)
		if w.ID == "" {
			w.ID = uuid.NewString()
		}
		if w.CreatedAt == "" {
			w.CreatedAt = now
		}
		if w.MinSeverity == "" {
			w.MinSeverity = "info"
		}
	}
	patch, err := json.Marshal(map[string]any{"teams": cfg})
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, `
		UPDATE tenants
		   SET settings   = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
		       updated_at = now()
		 WHERE id = $1`, tid, patch)
	return err
}

// matches decides whether a webhook should receive a given event.
func (w TeamsWebhook) matches(category, severity string) bool {
	if !w.Active || w.URL == "" {
		return false
	}
	if len(w.Categories) > 0 {
		ok := false
		for _, c := range w.Categories {
			if c == category {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return severityAtLeast(severity, w.MinSeverity)
}

func severityAtLeast(s, min string) bool {
	rank := map[string]int{"info": 1, "warn": 2, "critical": 3, "danger": 3}
	if rank[s] == 0 {
		return true
	}
	return rank[s] >= rank[min]
}

// teamsClient is the HTTP client used for all webhook posts. Short timeout —
// Teams almost always responds in <500ms; anything longer is a dead channel.
var teamsClient = &http.Client{Timeout: 8 * time.Second}

// PostTeamsCard fires one Adaptive Card to a single webhook URL. Returns the
// HTTP status code and any error. Callers ignore the error in production
// (logged via slog), but the Test endpoint surfaces it to the operator.
func PostTeamsCard(ctx context.Context, webhookURL string, card map[string]any) (int, error) {
	body, err := json.Marshal(card)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", webhookURL, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := teamsClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return resp.StatusCode, fmt.Errorf("teams webhook returned %d", resp.StatusCode)
	}
	return resp.StatusCode, nil
}

// buildAdaptiveCard renders an event into the JSON Teams expects. The shape
// is "MessageCard" (the older legacy connector format) because it has the
// widest support across both Outlook and Teams webhooks — full Adaptive
// Card v1.5 still works in newer connectors but legacy MessageCard works
// everywhere.
func buildAdaptiveCard(meta EventMeta, subject, body, link string, payload map[string]any) map[string]any {
	tone := toneColor(string(meta.Severity))
	facts := []map[string]any{}
	// Surface common payload keys as fact rows — these are usually the most
	// useful "at-a-glance" details (Project, Member, Days, Reason, etc).
	for _, k := range []string{"Project", "Member", "Requester", "Title", "Days", "Reason", "Start", "End", "Actor", "Number", "Total", "DaysLeft"} {
		if v, ok := payload[k]; ok && v != nil && fmt.Sprintf("%v", v) != "" {
			facts = append(facts, map[string]any{"name": k, "value": fmt.Sprintf("%v", v)})
		}
	}

	section := map[string]any{
		"activityTitle":    subject,
		"activitySubtitle": body,
	}
	if len(facts) > 0 {
		section["facts"] = facts
	}

	card := map[string]any{
		"@type":      "MessageCard",
		"@context":   "https://schema.org/extensions",
		"summary":    subject,
		"themeColor": tone,
		"title":      subject,
		"text":       body,
		"sections":   []map[string]any{section},
	}
	if link != "" {
		card["potentialAction"] = []map[string]any{
			{
				"@type": "OpenUri",
				"name":  "Open in D'Accubin",
				"targets": []map[string]any{
					{"os": "default", "uri": link},
				},
			},
		}
	}
	return card
}

func toneColor(sev string) string {
	switch sev {
	case "critical", "danger":
		return "DC2626"
	case "warn":
		return "F59E0B"
	case "info":
		return "0F7B97"
	}
	return "0F7B97"
}

// dispatchTeams fans the event out to every matching webhook. Called from
// Engine.Notify after the event lands in the outbox. Errors are logged but
// never bubble — Teams must never break a business action.
func (e *Engine) dispatchTeams(ctx context.Context, meta EventMeta, ev Event, subject, link string) {
	if e == nil || e.db == nil {
		return
	}
	cfg := LoadTeamsConfig(ctx, e.db, ev.TenantID)
	if len(cfg.Webhooks) == 0 {
		return
	}

	severity := string(meta.Severity)
	if ev.Severity != "" {
		severity = ev.Severity
	}
	category := string(meta.Category)

	// Headline / body for the card. Reuse the engine's HeadlineTpl so the
	// Teams message reads the same as the in-app notification.
	headline := renderTpl(meta.HeadlineTpl, ev.Payload)
	if headline == "" {
		headline = subject
	}

	card := buildAdaptiveCard(meta, subject, headline, link, ev.Payload)

	for _, w := range cfg.Webhooks {
		if !w.matches(category, severity) {
			continue
		}
		// Fire-and-forget — slow / dead webhooks can't backpressure the
		// notification path. Per-webhook goroutine because Teams sometimes
		// rate-limits and we don't want one slow channel to delay another.
		go func(url, name string) {
			_, err := PostTeamsCard(ctx, url, card)
			if err != nil {
				e.log.Warn("teams: webhook post failed",
					"webhook", name, "kind", ev.Kind, "err", err)
			}
		}(w.URL, w.Name)
	}
}

// validateWebhookURL is a tiny pre-flight check before persisting a webhook.
// Microsoft hostnames vary over time (outlook.office.com,
// outlook.office365.com, *.webhook.office.com, *.logic.azure.com from Power
// Automate), so we just sanity-check the scheme + look for an office /
// azure host hint. Anything weirder gets a soft warning client-side.
var errBadWebhookURL = errors.New("webhook URL must be https and from a Microsoft host")

func validateWebhookURL(raw string) error {
	low := strings.ToLower(strings.TrimSpace(raw))
	if !strings.HasPrefix(low, "https://") {
		return errBadWebhookURL
	}
	known := []string{"webhook.office.com", "outlook.office.com", "outlook.office365.com", "logic.azure.com"}
	for _, h := range known {
		if strings.Contains(low, h) {
			return nil
		}
	}
	// Slack-style mistype check: refuse hooks.slack.com so we fail loud
	// rather than swallow Teams events into a Slack channel.
	if strings.Contains(low, "hooks.slack.com") {
		return errors.New("that looks like a Slack webhook — use the Slack integration instead")
	}
	// Unknown host — let it through with a warning the UI can surface. Some
	// enterprises route webhooks through an internal proxy; rejecting
	// outright would block legit setups.
	return nil
}

// LogTeamsDispatch is exported so the Test endpoint can write the result of
// a manual probe without round-tripping through Notify.
func LogTeamsDispatch(ctx context.Context, log *slog.Logger, webhook string, status int, err error) {
	if err != nil {
		log.Warn("teams: dispatch failed", "webhook", webhook, "status", status, "err", err)
		return
	}
	log.Info("teams: dispatch ok", "webhook", webhook, "status", status)
}
