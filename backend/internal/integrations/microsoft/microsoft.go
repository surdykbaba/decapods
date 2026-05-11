// Package microsoft handles per-user OAuth + Microsoft Graph calls.
//
// Why a dedicated package: the OAuth dance, token refresh and Graph
// pagination are involved enough that the handlers package would balloon if
// it all lived there. The package exposes:
//
//   • Config       — tenant credentials loaded from tenants.settings.microsoft
//   • StartAuthURL — builds the consent URL with a signed state token
//   • Exchange     — code → access/refresh token pair
//   • Refresh      — refresh_token → new access token
//   • ValidState   — verifies the HMAC-signed state on callback
//   • FetchEvents  — pulls /me/calendar/calendarView for a window
//
// Scopes requested: openid, profile, email, offline_access (refresh token),
// Calendars.Read (calendar events), User.Read (account display info).
package microsoft

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Config carries the Azure AD app credentials the admin pasted into
// settings. TenantHint = "common" allows multi-tenant sign-in; an org may
// also paste their specific tenant id ("contoso.onmicrosoft.com" or a GUID).
type Config struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	TenantHint   string `json:"tenant_hint"` // "common" | "organizations" | "<tenantId>"
	RedirectURI  string `json:"redirect_uri"`
	Configured   bool   `json:"configured"`
}

// Token mirrors the access/refresh pair we persist.
type Token struct {
	AccessToken  string
	RefreshToken string
	Scope        string
	ExpiresAt    time.Time
	Account      string // userPrincipalName from Graph
	ObjectID     string // Microsoft object id
}

// CalendarEvent is a trimmed-down /me/calendar/calendarView item — only the
// fields the SPA actually renders.
type CalendarEvent struct {
	ID            string    `json:"id"`
	Subject       string    `json:"subject"`
	Start         time.Time `json:"start"`
	End           time.Time `json:"end"`
	IsAllDay      bool      `json:"is_all_day"`
	IsOnline      bool      `json:"is_online"`
	JoinURL       string    `json:"join_url,omitempty"`
	WebLink       string    `json:"web_link,omitempty"`
	Organizer     string    `json:"organizer,omitempty"`
	Location      string    `json:"location,omitempty"`
	BodyPreview   string    `json:"body_preview,omitempty"`
	Attendees     []string  `json:"attendees,omitempty"`
	ShowAs        string    `json:"show_as,omitempty"` // free | tentative | busy | oof
}

// authority builds the OAuth base URL for whichever tenant hint we have.
func (c Config) authority() string {
	t := strings.TrimSpace(c.TenantHint)
	if t == "" {
		t = "common"
	}
	return "https://login.microsoftonline.com/" + url.PathEscape(t)
}

// scopes returns the space-separated list we request. openid/profile/email
// give us the standard ID-token claims; offline_access mints the refresh
// token; Calendars.Read pulls events; User.Read returns user profile for
// the friendly "connected as" label.
const Scopes = "openid profile email offline_access Calendars.Read Mail.Read User.Read"

// StartAuthURL builds the Microsoft consent URL with a state value the
// callback can verify. State carries the user ID + a random nonce, HMAC-
// signed with the OAuth secret so a third party can't forge it.
func (c Config) StartAuthURL(state string) string {
	q := url.Values{
		"client_id":     {c.ClientID},
		"response_type": {"code"},
		"redirect_uri":  {c.RedirectURI},
		"response_mode": {"query"},
		"scope":         {Scopes},
		"state":         {state},
		"prompt":        {"select_account"}, // let users pick the right MS account
	}
	return c.authority() + "/oauth2/v2.0/authorize?" + q.Encode()
}

// SignState produces an HMAC-signed state string the callback can verify.
// Shape: base64url(payload).hex(hmac). Payload = userID|nonce|unix_ts.
func SignState(secret []byte, userID string) (string, error) {
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	payload := fmt.Sprintf("%s|%s|%d", userID, base64.RawURLEncoding.EncodeToString(nonce), time.Now().Unix())
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	sig := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + hex.EncodeToString(sig), nil
}

// ValidState returns the embedded userID if the state verifies and is fresh
// (≤ 10 minutes old). Anything older is rejected to avoid replay.
func ValidState(secret []byte, state string) (string, error) {
	parts := strings.SplitN(state, ".", 2)
	if len(parts) != 2 {
		return "", errors.New("malformed state")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", errors.New("bad state b64")
	}
	sig, err := hex.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("bad state sig")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payloadBytes)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return "", errors.New("state signature mismatch")
	}
	// payload = userID|nonce|unix_ts
	fields := strings.SplitN(string(payloadBytes), "|", 3)
	if len(fields) != 3 {
		return "", errors.New("malformed state payload")
	}
	ts, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil {
		return "", errors.New("bad state ts")
	}
	if time.Since(time.Unix(ts, 0)) > 10*time.Minute {
		return "", errors.New("state expired")
	}
	return fields[0], nil
}

var httpClient = &http.Client{Timeout: 15 * time.Second}

// Exchange swaps the auth-code for tokens. Microsoft returns access_token,
// refresh_token, expires_in (seconds), scope, token_type.
func (c Config) Exchange(ctx context.Context, code string) (Token, error) {
	form := url.Values{
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {c.RedirectURI},
		"scope":         {Scopes},
	}
	return c.tokenRequest(ctx, form)
}

// Refresh swaps a refresh_token for a fresh access_token. Microsoft may
// return a new refresh_token too — we always overwrite the stored value.
func (c Config) Refresh(ctx context.Context, refreshToken string) (Token, error) {
	form := url.Values{
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"scope":         {Scopes},
	}
	return c.tokenRequest(ctx, form)
}

func (c Config) tokenRequest(ctx context.Context, form url.Values) (Token, error) {
	req, err := http.NewRequestWithContext(ctx, "POST",
		c.authority()+"/oauth2/v2.0/token", strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return Token{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return Token{}, fmt.Errorf("microsoft token endpoint returned %d: %s", resp.StatusCode, string(body))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return Token{}, fmt.Errorf("microsoft token decode: %w", err)
	}
	if raw.AccessToken == "" {
		return Token{}, errors.New("microsoft did not return an access token")
	}
	return Token{
		AccessToken:  raw.AccessToken,
		RefreshToken: raw.RefreshToken,
		Scope:        raw.Scope,
		ExpiresAt:    time.Now().Add(time.Duration(raw.ExpiresIn) * time.Second),
	}, nil
}

// graphGet is a tiny helper that adds the Bearer header + decodes JSON.
func graphGet(ctx context.Context, accessToken, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	// Tell Graph to return event start/end in UTC ISO so we don't have to
	// parse timezone-tagged values ourselves.
	req.Header.Set("Prefer", `outlook.timezone="UTC"`)
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("graph %s returned %d: %s", url, resp.StatusCode, snip(string(body)))
	}
	return json.Unmarshal(body, out)
}

func snip(s string) string {
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}

// FetchProfile pulls the connected account's basic identity. Used right
// after Exchange so the SPA can show "Connected as alice@contoso.com".
func FetchProfile(ctx context.Context, accessToken string) (account, oid string, err error) {
	var out struct {
		UserPrincipalName string `json:"userPrincipalName"`
		Mail              string `json:"mail"`
		ID                string `json:"id"`
	}
	if err := graphGet(ctx, accessToken, "https://graph.microsoft.com/v1.0/me", &out); err != nil {
		return "", "", err
	}
	acct := out.Mail
	if acct == "" {
		acct = out.UserPrincipalName
	}
	return acct, out.ID, nil
}

// FetchEvents returns calendar events between [from, to) for the connected
// user. Uses /me/calendarView which expands recurring series — that's what
// "show me my next 7 days" actually wants.
func FetchEvents(ctx context.Context, accessToken string, from, to time.Time) ([]CalendarEvent, error) {
	u := "https://graph.microsoft.com/v1.0/me/calendarView" +
		"?$top=50" +
		"&$orderby=start/dateTime" +
		"&startDateTime=" + url.QueryEscape(from.UTC().Format(time.RFC3339)) +
		"&endDateTime=" + url.QueryEscape(to.UTC().Format(time.RFC3339)) +
		"&$select=id,subject,start,end,isAllDay,isOnlineMeeting,onlineMeeting,webLink,organizer,location,bodyPreview,attendees,showAs"
	var raw struct {
		Value []struct {
			ID       string `json:"id"`
			Subject  string `json:"subject"`
			Start    struct {
				DateTime string `json:"dateTime"`
				TimeZone string `json:"timeZone"`
			} `json:"start"`
			End struct {
				DateTime string `json:"dateTime"`
				TimeZone string `json:"timeZone"`
			} `json:"end"`
			IsAllDay        bool   `json:"isAllDay"`
			IsOnlineMeeting bool   `json:"isOnlineMeeting"`
			OnlineMeeting   *struct {
				JoinURL string `json:"joinUrl"`
			} `json:"onlineMeeting"`
			WebLink   string `json:"webLink"`
			Organizer struct {
				EmailAddress struct {
					Name    string `json:"name"`
					Address string `json:"address"`
				} `json:"emailAddress"`
			} `json:"organizer"`
			Location struct {
				DisplayName string `json:"displayName"`
			} `json:"location"`
			BodyPreview string `json:"bodyPreview"`
			Attendees   []struct {
				EmailAddress struct {
					Name    string `json:"name"`
					Address string `json:"address"`
				} `json:"emailAddress"`
			} `json:"attendees"`
			ShowAs string `json:"showAs"`
		} `json:"value"`
	}
	if err := graphGet(ctx, accessToken, u, &raw); err != nil {
		return nil, err
	}
	out := make([]CalendarEvent, 0, len(raw.Value))
	for _, ev := range raw.Value {
		start, _ := parseGraphTime(ev.Start.DateTime)
		end, _ := parseGraphTime(ev.End.DateTime)
		attendees := make([]string, 0, len(ev.Attendees))
		for _, a := range ev.Attendees {
			n := strings.TrimSpace(a.EmailAddress.Name)
			if n == "" {
				n = a.EmailAddress.Address
			}
			if n != "" {
				attendees = append(attendees, n)
			}
		}
		join := ""
		if ev.OnlineMeeting != nil {
			join = ev.OnlineMeeting.JoinURL
		}
		out = append(out, CalendarEvent{
			ID:          ev.ID,
			Subject:     ev.Subject,
			Start:       start,
			End:         end,
			IsAllDay:    ev.IsAllDay,
			IsOnline:    ev.IsOnlineMeeting,
			JoinURL:     join,
			WebLink:     ev.WebLink,
			Organizer:   firstNonEmpty(ev.Organizer.EmailAddress.Name, ev.Organizer.EmailAddress.Address),
			Location:    ev.Location.DisplayName,
			BodyPreview: ev.BodyPreview,
			Attendees:   attendees,
			ShowAs:      ev.ShowAs,
		})
	}
	return out, nil
}

// MailMessage is a trimmed-down /me/messages item — only the fields the SPA
// renders on the Today briefing card.
type MailMessage struct {
	ID          string    `json:"id"`
	Subject     string    `json:"subject"`
	From        string    `json:"from"`
	FromName    string    `json:"from_name"`
	Preview     string    `json:"preview"`
	WebLink     string    `json:"web_link"`
	Received    time.Time `json:"received"`
	IsRead      bool      `json:"is_read"`
	HasAttach   bool      `json:"has_attachments"`
	Importance  string    `json:"importance"` // low | normal | high
}

// FetchRecentMail pulls the user's most recent Inbox messages. We only need
// the headline fields — subject, sender, preview, received time, web link —
// so the Today card can render a compact list.
func FetchRecentMail(ctx context.Context, accessToken string, top int) ([]MailMessage, error) {
	if top <= 0 || top > 50 {
		top = 10
	}
	u := "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages" +
		"?$top=" + strconv.Itoa(top) +
		"&$orderby=receivedDateTime+desc" +
		"&$select=id,subject,from,bodyPreview,webLink,receivedDateTime,isRead,hasAttachments,importance"
	var raw struct {
		Value []struct {
			ID      string `json:"id"`
			Subject string `json:"subject"`
			From    struct {
				EmailAddress struct {
					Name    string `json:"name"`
					Address string `json:"address"`
				} `json:"emailAddress"`
			} `json:"from"`
			BodyPreview      string `json:"bodyPreview"`
			WebLink          string `json:"webLink"`
			ReceivedDateTime string `json:"receivedDateTime"`
			IsRead           bool   `json:"isRead"`
			HasAttachments   bool   `json:"hasAttachments"`
			Importance       string `json:"importance"`
		} `json:"value"`
	}
	if err := graphGet(ctx, accessToken, u, &raw); err != nil {
		return nil, err
	}
	out := make([]MailMessage, 0, len(raw.Value))
	for _, m := range raw.Value {
		recv, _ := parseGraphTime(m.ReceivedDateTime)
		out = append(out, MailMessage{
			ID:         m.ID,
			Subject:    m.Subject,
			From:       m.From.EmailAddress.Address,
			FromName:   firstNonEmpty(m.From.EmailAddress.Name, m.From.EmailAddress.Address),
			Preview:    strings.TrimSpace(m.BodyPreview),
			WebLink:    m.WebLink,
			Received:   recv,
			IsRead:     m.IsRead,
			HasAttach:  m.HasAttachments,
			Importance: m.Importance,
		})
	}
	return out, nil
}

// parseGraphTime parses the "2006-01-02T15:04:05.0000000" shape Graph emits
// when we Prefer outlook.timezone="UTC". Falls back to RFC3339 for safety.
func parseGraphTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	for _, layout := range []string{"2006-01-02T15:04:05.0000000", "2006-01-02T15:04:05", time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised time %q", s)
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// ResponseBody is exposed only for tests/debug — the engine never reads it.
type ResponseBody = bytes.Buffer
