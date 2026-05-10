package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type GeneralSettings struct {
	db *pgxpool.Pool
}

func NewGeneralSettings(db *pgxpool.Pool) *GeneralSettings { return &GeneralSettings{db: db} }

type generalSettings struct {
	DefaultCurrency    string `json:"default_currency"`
	CompanyName        string `json:"company_name"`
	SupportEmail       string `json:"support_email"`
	WebsiteURL         string `json:"website_url"`
	Phone              string `json:"phone"`
	AddressLine1       string `json:"address_line1"`
	AddressLine2       string `json:"address_line2"`
	City               string `json:"city"`
	StateRegion        string `json:"state_region"`
	PostalCode         string `json:"postal_code"`
	Country            string `json:"country"`
	TaxID              string `json:"tax_id"`
	RegistrationNumber string `json:"registration_number"`
	LogoURL            string `json:"logo_url"`
}

const defaultCurrency = "NGN"

func (h *GeneralSettings) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var raw []byte
	if err := h.db.QueryRow(c, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := generalSettings{DefaultCurrency: defaultCurrency}
	mergeSettings(&out, raw)
	c.JSON(http.StatusOK, out)
}

func (h *GeneralSettings) Put(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var body generalSettings
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.normalize()

	patch, err := json.Marshal(body.toMap())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if _, err := h.db.Exec(c, `
		UPDATE tenants
		   SET settings   = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
		       updated_at = now()
		 WHERE id = $1`, tid, patch); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Echo the saved value so the client can refresh its cache without an extra GET.
	c.JSON(http.StatusOK, body)
}

func (g *generalSettings) normalize() {
	g.DefaultCurrency = strings.ToUpper(strings.TrimSpace(g.DefaultCurrency))
	if g.DefaultCurrency == "" {
		g.DefaultCurrency = defaultCurrency
	}
	g.CompanyName        = strings.TrimSpace(g.CompanyName)
	g.SupportEmail       = strings.TrimSpace(strings.ToLower(g.SupportEmail))
	g.WebsiteURL         = strings.TrimSpace(g.WebsiteURL)
	g.Phone              = strings.TrimSpace(g.Phone)
	g.AddressLine1       = strings.TrimSpace(g.AddressLine1)
	g.AddressLine2       = strings.TrimSpace(g.AddressLine2)
	g.City               = strings.TrimSpace(g.City)
	g.StateRegion        = strings.TrimSpace(g.StateRegion)
	g.PostalCode         = strings.TrimSpace(g.PostalCode)
	g.Country            = strings.TrimSpace(g.Country)
	g.TaxID              = strings.TrimSpace(g.TaxID)
	g.RegistrationNumber = strings.TrimSpace(g.RegistrationNumber)
	g.LogoURL            = strings.TrimSpace(g.LogoURL)
}

func (g generalSettings) toMap() map[string]any {
	return map[string]any{
		"default_currency":    g.DefaultCurrency,
		"company_name":        g.CompanyName,
		"support_email":       g.SupportEmail,
		"website_url":         g.WebsiteURL,
		"phone":               g.Phone,
		"address_line1":       g.AddressLine1,
		"address_line2":       g.AddressLine2,
		"city":                g.City,
		"state_region":        g.StateRegion,
		"postal_code":         g.PostalCode,
		"country":             g.Country,
		"tax_id":              g.TaxID,
		"registration_number": g.RegistrationNumber,
		"logo_url":            g.LogoURL,
	}
}

func mergeSettings(out *generalSettings, raw []byte) {
	var s map[string]any
	if len(raw) == 0 {
		return
	}
	_ = json.Unmarshal(raw, &s)
	str := func(k string) string {
		if v, ok := s[k].(string); ok {
			return v
		}
		return ""
	}
	if v := str("default_currency"); v != "" {
		out.DefaultCurrency = v
	}
	out.CompanyName        = str("company_name")
	out.SupportEmail       = str("support_email")
	out.WebsiteURL         = str("website_url")
	out.Phone              = str("phone")
	out.AddressLine1       = str("address_line1")
	out.AddressLine2       = str("address_line2")
	out.City               = str("city")
	out.StateRegion        = str("state_region")
	out.PostalCode         = str("postal_code")
	out.Country            = str("country")
	out.TaxID              = str("tax_id")
	out.RegistrationNumber = str("registration_number")
	out.LogoURL            = str("logo_url")
}

