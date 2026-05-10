package notifications

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/smtp"
	"strings"

	"github.com/decapods/pgdp/backend/internal/platform/config"
)

// Mailer wraps the configured SMTP server. Methods are no-ops (with a logged
// warning) when SMTPHost is empty, so the API stays usable in dev / on misconfigured
// envs without crashing invite/notification flows.
type Mailer struct {
	cfg *config.Config
}

func NewMailer(cfg *config.Config) *Mailer { return &Mailer{cfg: cfg} }

func (m *Mailer) Configured() bool {
	return m != nil && m.cfg != nil && strings.TrimSpace(m.cfg.SMTPHost) != ""
}

// Email — minimal envelope. HTML is optional; if empty, only the plain
// part is sent.
type Email struct {
	To      string
	Subject string
	Plain   string
	HTML    string
	From    string // optional; falls back to SMTPFrom or SMTPUser
}

func (m *Mailer) Send(ctx context.Context, e Email) error {
	if !m.Configured() {
		slog.Warn("mailer not configured — skipping send", "to", e.To, "subject", e.Subject)
		return nil
	}
	if strings.TrimSpace(e.To) == "" {
		return errors.New("mailer: empty recipient")
	}

	from := strings.TrimSpace(e.From)
	if from == "" {
		from = strings.TrimSpace(m.cfg.SMTPFrom)
	}
	if from == "" {
		from = strings.TrimSpace(m.cfg.SMTPUser)
	}
	if from == "" {
		return errors.New("mailer: no From address (set SMTP_FROM or SMTP_USER)")
	}

	addr := fmt.Sprintf("%s:%d", m.cfg.SMTPHost, m.cfg.SMTPPort)
	body := buildMIME(from, e)

	auth := smtp.PlainAuth("", m.cfg.SMTPUser, m.cfg.SMTPPass, m.cfg.SMTPHost)

	// Use STARTTLS on 587 / 25; implicit TLS on 465.
	if m.cfg.SMTPPort == 465 {
		return sendImplicitTLS(addr, m.cfg.SMTPHost, auth, from, []string{e.To}, body)
	}
	return smtp.SendMail(addr, auth, from, []string{e.To}, body)
}

func sendImplicitTLS(addr, host string, auth smtp.Auth, from string, to []string, body []byte) error {
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: host})
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	defer conn.Close()
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		return fmt.Errorf("smtp client: %w", err)
	}
	defer c.Quit()
	if auth != nil {
		if err := c.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(from); err != nil {
		return err
	}
	for _, r := range to {
		if err := c.Rcpt(r); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(body); err != nil {
		return err
	}
	return w.Close()
}

func buildMIME(from string, e Email) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + e.To + "\r\n")
	b.WriteString("Subject: " + e.Subject + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	if strings.TrimSpace(e.HTML) == "" {
		b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		b.WriteString(e.Plain)
	} else {
		boundary := "ALT-mailer-" + randomBoundary()
		b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n")
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		b.WriteString(e.Plain)
		b.WriteString("\r\n--" + boundary + "\r\n")
		b.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
		b.WriteString(e.HTML)
		b.WriteString("\r\n--" + boundary + "--\r\n")
	}
	return []byte(b.String())
}

func randomBoundary() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
