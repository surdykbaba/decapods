package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/audit"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Payroll — salary structure + monthly pay runs with Nigerian statutory
// math (PAYE under PITA, 8% pension, optional 2.5% NHF). HR/Finance only;
// every route is gated by payroll:read / payroll:write in the router.
//
// The "intelligent" bits, all server-side so the numbers are auditable:
//   • PAYE computed with the Consolidated Relief Allowance + the six
//     progressive PITA bands; pension + NHF are deducted pre-tax.
//   • Gross is pro-rated by unpaid-leave days taken in the period
//     (approved leave on an unpaid leave_type), using the real working
//     -day count for that month.
//   • Each payslip is flagged for the things a human should eyeball
//     (no salary on file, missing bank details, zero/!negative net).
//   • Payslips are an immutable snapshot — a later comp edit can't
//     rewrite an approved run.
type Payroll struct {
	db *pgxpool.Pool
}

func NewPayroll(db *pgxpool.Pool) *Payroll { return &Payroll{db: db} }

/* ---------------- Tenant-configurable statutory rates ----------------

Stored under tenants.settings.payroll_config (same JSONB pattern as
work_policy / standup). Defaults are the standard Nigerian PITA /
Finance-Act figures so a fresh tenant computes correctly with zero
setup; an operator can tune bands + rates from Payroll → Settings
without a deploy when the law changes or a state band differs. */

type PayBand struct {
	// Size in annual currency. A band with Size <= 0 is the unbounded
	// top band ("everything above").
	Size float64 `json:"size"`
	Rate float64 `json:"rate"`
}

type PayrollConfig struct {
	// Consolidated Relief Allowance = max(CRAFloor, gross*CRAMinPctOfGross)
	//                                  + gross*CRAGrossPct
	CRAFloor         float64   `json:"cra_floor"`
	CRAMinPctOfGross float64   `json:"cra_min_pct_of_gross"`
	CRAGrossPct      float64   `json:"cra_gross_pct"`
	PensionRate      float64   `json:"pension_rate"`
	NHFRate          float64   `json:"nhf_rate"`
	Bands            []PayBand `json:"bands"`
}

func DefaultPayrollConfig() PayrollConfig {
	return PayrollConfig{
		CRAFloor:         200_000,
		CRAMinPctOfGross: 0.01,
		CRAGrossPct:      0.20,
		PensionRate:      0.08,
		NHFRate:          0.025,
		Bands: []PayBand{
			{Size: 300_000, Rate: 0.07},
			{Size: 300_000, Rate: 0.11},
			{Size: 500_000, Rate: 0.15},
			{Size: 500_000, Rate: 0.19},
			{Size: 1_600_000, Rate: 0.21},
			{Size: 0, Rate: 0.24}, // 0 = unbounded top band
		},
	}
}

func (cfg *PayrollConfig) normalize() {
	d := DefaultPayrollConfig()
	if cfg.CRAFloor < 0 {
		cfg.CRAFloor = d.CRAFloor
	}
	if cfg.CRAMinPctOfGross < 0 || cfg.CRAMinPctOfGross > 1 {
		cfg.CRAMinPctOfGross = d.CRAMinPctOfGross
	}
	if cfg.CRAGrossPct < 0 || cfg.CRAGrossPct > 1 {
		cfg.CRAGrossPct = d.CRAGrossPct
	}
	if cfg.PensionRate < 0 || cfg.PensionRate > 1 {
		cfg.PensionRate = d.PensionRate
	}
	if cfg.NHFRate < 0 || cfg.NHFRate > 1 {
		cfg.NHFRate = d.NHFRate
	}
	// Reject a malformed/empty band table — fall back to the statutory
	// default rather than silently taxing everyone at 0%.
	clean := cfg.Bands[:0]
	for _, b := range cfg.Bands {
		if b.Rate < 0 || b.Rate > 1 {
			continue
		}
		clean = append(clean, b)
	}
	if len(clean) == 0 {
		cfg.Bands = d.Bands
	} else {
		cfg.Bands = clean
	}
}

func LoadPayrollConfig(ctx context.Context, db *pgxpool.Pool, tid uuid.UUID) PayrollConfig {
	out := DefaultPayrollConfig()
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil || len(raw) == 0 {
		return out
	}
	var s map[string]json.RawMessage
	if err := json.Unmarshal(raw, &s); err != nil {
		return out
	}
	pc, ok := s["payroll_config"]
	if !ok {
		return out
	}
	_ = json.Unmarshal(pc, &out)
	out.normalize()
	return out
}

func (h *Payroll) GetSettings(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	c.JSON(http.StatusOK, LoadPayrollConfig(c.Request.Context(), h.db, tid))
}

func (h *Payroll) PutSettings(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var body PayrollConfig
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.normalize()
	patch, _ := json.Marshal(map[string]any{"payroll_config": body})
	if _, err := h.db.Exec(c, `
		UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || $2::jsonb,
		       updated_at = now() WHERE id = $1`, tid, patch); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, h.db, c, tid, &uid, "settings.payroll_config_changed", "tenant", tid, body)
	c.JSON(http.StatusOK, body)
}

/* ---------------- Nigerian statutory engine ---------------- */

// payComputation is the full monthly breakdown for one employee.
type payComputation struct {
	Basic            float64
	Allowances       map[string]float64
	Gross            float64 // pro-rated monthly gross
	PAYE             float64
	Pension          float64
	NHF              float64
	OtherDeductions  float64
	DeductionsTotal  float64
	Net              float64
	WorkingDays      int
	UnpaidLeaveDays  int
}

// computePay runs the statutory math for ONE month. basic + allowances are
// the full (non-prorated) monthly figures; unpaidDays/workingDays drive the
// pro-ration. pensionOptIn / nhfOptIn come from employee_compensation.
func computePay(basic float64, allowances map[string]float64, pensionOptIn, nhfOptIn bool, workingDays, unpaidDays int, cfg PayrollConfig) payComputation {
	fullGross := basic
	for _, v := range allowances {
		fullGross += v
	}
	// Pro-rate: lose pay for unpaid leave days against the month's
	// working days. Never go below zero or above the full month.
	factor := 1.0
	if workingDays > 0 && unpaidDays > 0 {
		worked := workingDays - unpaidDays
		if worked < 0 {
			worked = 0
		}
		factor = float64(worked) / float64(workingDays)
	}
	gross := round2(fullGross * factor)
	proBasic := round2(basic * factor)

	// Pensionable emolument (PenCom): basic + housing + transport.
	pensionable := proBasic
	for k, v := range allowances {
		lk := strings.ToLower(k)
		if strings.Contains(lk, "hous") || strings.Contains(lk, "transport") {
			pensionable += round2(v * factor)
		}
	}
	pension := 0.0
	if pensionOptIn {
		pension = round2(pensionable * cfg.PensionRate) // default 8%
	}
	nhf := 0.0
	if nhfOptIn {
		nhf = round2(proBasic * cfg.NHFRate) // default 2.5% of basic
	}

	// PAYE (PITA). Work annually, divide back to the month.
	annualGross := gross * 12
	annualPension := pension * 12
	annualNHF := nhf * 12
	// Consolidated Relief Allowance: higher of ₦200,000 or 1% of gross,
	// plus 20% of gross income.
	cra := math.Max(cfg.CRAFloor, annualGross*cfg.CRAMinPctOfGross) + annualGross*cfg.CRAGrossPct
	taxable := annualGross - cra - annualPension - annualNHF
	if taxable < 0 {
		taxable = 0
	}
	annualPAYE := payeFor(taxable, cfg.Bands)
	paye := round2(annualPAYE / 12)

	deductions := round2(paye + pension + nhf)
	net := round2(gross - deductions)
	return payComputation{
		Basic:           proBasic,
		Allowances:      allowances,
		Gross:           gross,
		PAYE:            paye,
		Pension:         pension,
		NHF:             nhf,
		DeductionsTotal: deductions,
		Net:             net,
		WorkingDays:     workingDays,
		UnpaidLeaveDays: unpaidDays,
	}
}

// payeFor — progressive tax over the configured bands on annual taxable
// income. A band with size <= 0 is the unbounded top band.
func payeFor(taxable float64, bands []PayBand) float64 {
	tax := 0.0
	rem := taxable
	for _, b := range bands {
		if rem <= 0 {
			break
		}
		size := b.Size
		if size <= 0 {
			size = math.MaxFloat64
		}
		slice := math.Min(rem, size)
		tax += slice * b.Rate
		rem -= slice
	}
	return round2(tax)
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// workingDaysInMonth — Mon–Fri count for a YYYY-MM period.
func workingDaysInMonth(period string) int {
	t, err := time.Parse("2006-01", period)
	if err != nil {
		return 22
	}
	year, month := t.Year(), t.Month()
	days := 0
	for d := 1; ; d++ {
		cur := time.Date(year, month, d, 0, 0, 0, 0, time.UTC)
		if cur.Month() != month {
			break
		}
		if wd := cur.Weekday(); wd != time.Saturday && wd != time.Sunday {
			days++
		}
	}
	return days
}

/* ---------------- Compensation ---------------- */

// ListCompensation — every active member with their salary structure
// (or zeros + a "not set" flag when no row exists yet).
func (h *Payroll) ListCompensation(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT u.id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       COALESCE(u.job_title,''),
		       ec.currency, ec.basic_monthly, ec.allowances,
		       ec.pension_opt_in, ec.nhf_opt_in, ec.effective_from, ec.updated_at
		FROM users u
		LEFT JOIN employee_compensation ec ON ec.user_id = u.id
		WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'
		ORDER BY u.full_name ASC`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                       uuid.UUID
			name, email, jobTitle    string
			currency                 *string
			basic                    *float64
			allowRaw                 []byte
			pensionOpt, nhfOpt       *bool
			effFrom                  *time.Time
			updatedAt                *time.Time
		)
		if err := rows.Scan(&id, &name, &email, &jobTitle, &currency, &basic, &allowRaw,
			&pensionOpt, &nhfOpt, &effFrom, &updatedAt); err != nil {
			continue
		}
		allow := map[string]float64{}
		if len(allowRaw) > 0 {
			_ = json.Unmarshal(allowRaw, &allow)
		}
		set := basic != nil
		row := gin.H{
			"user_id": id, "name": name, "email": email, "job_title": jobTitle,
			"currency":       deref(currency, "NGN"),
			"basic_monthly":  derefF(basic),
			"allowances":     allow,
			"pension_opt_in": derefB(pensionOpt, true),
			"nhf_opt_in":     derefB(nhfOpt, false),
			"is_set":         set,
		}
		if effFrom != nil {
			row["effective_from"] = effFrom.Format("2006-01-02")
		}
		if updatedAt != nil {
			row["updated_at"] = updatedAt
		}
		out = append(out, row)
	}
	c.JSON(200, gin.H{"items": out})
}

// PutCompensation — upsert one employee's salary structure.
func (h *Payroll) PutCompensation(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	target, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Currency      string             `json:"currency"`
		BasicMonthly  float64            `json:"basic_monthly"`
		Allowances    map[string]float64 `json:"allowances"`
		PensionOptIn  *bool              `json:"pension_opt_in"`
		NHFOptIn      *bool              `json:"nhf_opt_in"`
		EffectiveFrom string             `json:"effective_from"`
		Notes         string             `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Currency == "" {
		req.Currency = "NGN"
	}
	if req.Allowances == nil {
		req.Allowances = map[string]float64{}
	}
	allowJSON, _ := json.Marshal(req.Allowances)
	pension := true
	if req.PensionOptIn != nil {
		pension = *req.PensionOptIn
	}
	nhf := false
	if req.NHFOptIn != nil {
		nhf = *req.NHFOptIn
	}
	eff := strings.TrimSpace(req.EffectiveFrom)
	if _, err := h.db.Exec(c, `
		INSERT INTO employee_compensation
		  (user_id, tenant_id, currency, basic_monthly, allowances,
		   pension_opt_in, nhf_opt_in, effective_from, notes, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE(NULLIF($8,'')::date, CURRENT_DATE), NULLIF($9,''), $10)
		ON CONFLICT (user_id) DO UPDATE SET
		  currency=EXCLUDED.currency, basic_monthly=EXCLUDED.basic_monthly,
		  allowances=EXCLUDED.allowances, pension_opt_in=EXCLUDED.pension_opt_in,
		  nhf_opt_in=EXCLUDED.nhf_opt_in, effective_from=EXCLUDED.effective_from,
		  notes=EXCLUDED.notes, updated_by=EXCLUDED.updated_by, updated_at=now()`,
		target, tid, req.Currency, req.BasicMonthly, allowJSON,
		pension, nhf, eff, req.Notes, actor); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

/* ---------------- Runs ---------------- */

func (h *Payroll) ListRuns(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT id, period, status, currency, gross_total, deduction_total,
		       net_total, headcount, created_at, approved_at, paid_at
		FROM payroll_runs WHERE tenant_id=$1
		ORDER BY period DESC, created_at DESC`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                              uuid.UUID
			period, status, currency        string
			gross, ded, net                 float64
			headcount                       int
			created                         time.Time
			approvedAt, paidAt              *time.Time
		)
		if err := rows.Scan(&id, &period, &status, &currency, &gross, &ded, &net,
			&headcount, &created, &approvedAt, &paidAt); err == nil {
			out = append(out, gin.H{
				"id": id, "period": period, "status": status, "currency": currency,
				"gross_total": gross, "deduction_total": ded, "net_total": net,
				"headcount": headcount, "created_at": created,
				"approved_at": approvedAt, "paid_at": paidAt,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// CreateRun — open a draft run for a period (YYYY-MM). One per period.
func (h *Payroll) CreateRun(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Period string `json:"period" binding:"required"`
		Notes  string `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if _, err := time.Parse("2006-01", strings.TrimSpace(req.Period)); err != nil {
		c.JSON(400, gin.H{"error": "period must be YYYY-MM"})
		return
	}
	var id uuid.UUID
	err := h.db.QueryRow(c, `
		INSERT INTO payroll_runs (tenant_id, period, notes, created_by)
		VALUES ($1,$2,NULLIF($3,''),$4) RETURNING id`,
		tid, req.Period, req.Notes, actor).Scan(&id)
	if err != nil {
		if strings.Contains(err.Error(), "payroll_runs_tenant_id_period_key") || strings.Contains(err.Error(), "duplicate") {
			c.JSON(409, gin.H{"error": "a run already exists for " + req.Period})
			return
		}
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

// GenerateRun — (re)snapshot every active employee with a comp record into
// the run as payslips, running the full statutory math. Only allowed while
// the run is still draft. Wipes + regenerates so it's idempotent.
func (h *Payroll) GenerateRun(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	runID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var period, status, runCurrency string
	if err := h.db.QueryRow(c, `
		SELECT period, status, currency FROM payroll_runs
		WHERE id=$1 AND tenant_id=$2`, runID, tid).Scan(&period, &status, &runCurrency); err != nil {
		c.JSON(404, gin.H{"error": "run not found"})
		return
	}
	if status != "draft" {
		c.JSON(409, gin.H{"error": "only a draft run can be regenerated"})
		return
	}
	workDays := workingDaysInMonth(period)
	cfg := LoadPayrollConfig(c.Request.Context(), h.db, tid)

	rows, err := h.db.Query(c, `
		SELECT u.id, COALESCE(u.full_name, u.email::text),
		       ec.currency, ec.basic_monthly, ec.allowances,
		       ec.pension_opt_in, ec.nhf_opt_in,
		       up.bank_name, up.bank_account_number, up.bank_account_name
		FROM users u
		JOIN employee_compensation ec ON ec.user_id = u.id
		LEFT JOIN user_personnel up ON up.user_id = u.id
		WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type emp struct {
		id                              uuid.UUID
		name, currency                  string
		basic                           float64
		allow                           map[string]float64
		pension, nhf                    bool
		bankName, bankAcct, bankAcctNm  string
	}
	emps := []emp{}
	for rows.Next() {
		var (
			id                          uuid.UUID
			name                        string
			currency                    *string
			basic                       float64
			allowRaw                    []byte
			pension, nhf                bool
			bankName, bankAcct, bankNm  *string
		)
		if err := rows.Scan(&id, &name, &currency, &basic, &allowRaw, &pension, &nhf,
			&bankName, &bankAcct, &bankNm); err != nil {
			continue
		}
		a := map[string]float64{}
		if len(allowRaw) > 0 {
			_ = json.Unmarshal(allowRaw, &a)
		}
		emps = append(emps, emp{
			id: id, name: name, currency: deref(currency, "NGN"),
			basic: basic, allow: a, pension: pension, nhf: nhf,
			bankName: deref(bankName, ""), bankAcct: deref(bankAcct, ""), bankAcctNm: deref(bankNm, ""),
		})
	}
	rows.Close()

	tx, err := h.db.Begin(c)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)
	if _, err := tx.Exec(c, `DELETE FROM payslips WHERE run_id=$1`, runID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	periodStart := period + "-01"
	var grossTotal, dedTotal, netTotal float64
	count := 0
	for _, e := range emps {
		// Unpaid leave days approved within the period.
		var unpaid int
		_ = tx.QueryRow(c, `
			SELECT COALESCE(SUM(GREATEST(LEAST(lr.end_date, ($1::date + INTERVAL '1 month - 1 day')::date)
			                            - GREATEST(lr.start_date, $1::date) + 1, 0)), 0)::int
			FROM leave_requests lr
			JOIN leave_types lt ON lt.id = lr.leave_type_id
			WHERE lr.tenant_id=$2 AND lr.user_id=$3 AND lr.status='approved'
			  AND lt.paid = false
			  AND lr.start_date <= ($1::date + INTERVAL '1 month - 1 day')::date
			  AND lr.end_date   >= $1::date`, periodStart, tid, e.id).Scan(&unpaid)
		if unpaid > workDays {
			unpaid = workDays
		}

		pc := computePay(e.basic, e.allow, e.pension, e.nhf, workDays, unpaid, cfg)
		flags := []string{}
		if e.basic == 0 && len(e.allow) == 0 {
			flags = append(flags, "no_salary")
		}
		if e.bankAcct == "" {
			flags = append(flags, "missing_bank")
		}
		if pc.Net <= 0 {
			flags = append(flags, "non_positive_net")
		}
		if unpaid > 0 {
			flags = append(flags, "prorated_unpaid_leave")
		}
		allowJSON, _ := json.Marshal(e.allow)
		if _, err := tx.Exec(c, `
			INSERT INTO payslips
			  (tenant_id, run_id, user_id, employee_name, currency, basic, allowances,
			   gross, paye, pension, nhf, other_deductions, deductions_total, net,
			   working_days, unpaid_leave_days, bank_name, bank_account_number,
			   bank_account_name, flags)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
			        NULLIF($17,''),NULLIF($18,''),NULLIF($19,''),$20)`,
			tid, runID, e.id, e.name, e.currency, pc.Basic, allowJSON,
			pc.Gross, pc.PAYE, pc.Pension, pc.NHF, 0.0, pc.DeductionsTotal, pc.Net,
			pc.WorkingDays, pc.UnpaidLeaveDays, e.bankName, e.bankAcct, e.bankAcctNm,
			flags); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		grossTotal += pc.Gross
		dedTotal += pc.DeductionsTotal
		netTotal += pc.Net
		count++
	}
	if _, err := tx.Exec(c, `
		UPDATE payroll_runs SET gross_total=$1, deduction_total=$2, net_total=$3,
		       headcount=$4 WHERE id=$5 AND tenant_id=$6`,
		round2(grossTotal), round2(dedTotal), round2(netTotal), count, runID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "headcount": count,
		"gross_total": round2(grossTotal), "net_total": round2(netTotal)})
}

// GetRun — run header + all payslips.
func (h *Payroll) GetRun(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	runID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var (
		period, status, currency  string
		gross, ded, net           float64
		headcount                 int
		created                   time.Time
		approvedAt, paidAt        *time.Time
		notes                     *string
	)
	if err := h.db.QueryRow(c, `
		SELECT period, status, currency, gross_total, deduction_total, net_total,
		       headcount, created_at, approved_at, paid_at, notes
		FROM payroll_runs WHERE id=$1 AND tenant_id=$2`, runID, tid).
		Scan(&period, &status, &currency, &gross, &ded, &net, &headcount,
			&created, &approvedAt, &paidAt, &notes); err != nil {
		if err == pgx.ErrNoRows {
			c.JSON(404, gin.H{"error": "run not found"})
			return
		}
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	slips := []gin.H{}
	srows, serr := h.db.Query(c, `
		SELECT id, user_id, employee_name, currency, basic, allowances, gross,
		       paye, pension, nhf, other_deductions, deductions_total, net,
		       working_days, unpaid_leave_days, bank_name, bank_account_number,
		       bank_account_name, flags
		FROM payslips WHERE run_id=$1 ORDER BY employee_name ASC`, runID)
	if serr == nil {
		defer srows.Close()
		for srows.Next() {
			var (
				id, userID                       uuid.UUID
				name, cur                        string
				basic, grossV, paye, pen, nhf    float64
				other, dedT, netV                float64
				allowRaw                         []byte
				wd, ul                           int
				bankName, bankAcct, bankNm       *string
				flags                            []string
			)
			if err := srows.Scan(&id, &userID, &name, &cur, &basic, &allowRaw, &grossV,
				&paye, &pen, &nhf, &other, &dedT, &netV, &wd, &ul,
				&bankName, &bankAcct, &bankNm, &flags); err == nil {
				allow := map[string]float64{}
				if len(allowRaw) > 0 {
					_ = json.Unmarshal(allowRaw, &allow)
				}
				slips = append(slips, gin.H{
					"id": id, "user_id": userID, "employee_name": name, "currency": cur,
					"basic": basic, "allowances": allow, "gross": grossV,
					"paye": paye, "pension": pen, "nhf": nhf,
					"other_deductions": other, "deductions_total": dedT, "net": netV,
					"working_days": wd, "unpaid_leave_days": ul,
					"bank_name": deref(bankName, ""), "bank_account_number": deref(bankAcct, ""),
					"bank_account_name": deref(bankNm, ""), "flags": flags,
				})
			}
		}
	}
	c.JSON(200, gin.H{
		"id": runID, "period": period, "status": status, "currency": currency,
		"gross_total": gross, "deduction_total": ded, "net_total": net,
		"headcount": headcount, "created_at": created,
		"approved_at": approvedAt, "paid_at": paidAt, "notes": deref(notes, ""),
		"payslips": slips,
	})
}

// transition — draft→approved (approve) or approved→paid (pay).
func (h *Payroll) transition(c *gin.Context, from, to string) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	runID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var status string
	var headcount int
	if err := h.db.QueryRow(c, `SELECT status, headcount FROM payroll_runs WHERE id=$1 AND tenant_id=$2`,
		runID, tid).Scan(&status, &headcount); err != nil {
		c.JSON(404, gin.H{"error": "run not found"})
		return
	}
	if status != from {
		c.JSON(409, gin.H{"error": fmt.Sprintf("run is %s — expected %s", status, from)})
		return
	}
	if to == "approved" && headcount == 0 {
		c.JSON(409, gin.H{"error": "generate payslips before approving"})
		return
	}
	q := `UPDATE payroll_runs SET status=$1`
	if to == "approved" {
		q += `, approved_by=$3, approved_at=now()`
	} else {
		q += `, paid_at=now()`
	}
	q += ` WHERE id=$2 AND tenant_id=` + "$4"
	if _, err := h.db.Exec(c, q, to, runID, actor, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "status": to})
}

func (h *Payroll) ApproveRun(c *gin.Context) { h.transition(c, "draft", "approved") }
func (h *Payroll) PayRun(c *gin.Context)     { h.transition(c, "approved", "paid") }

// ExportRun — CSV bank schedule for an approved/paid run.
func (h *Payroll) ExportRun(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	runID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var period, currency string
	if err := h.db.QueryRow(c, `SELECT period, currency FROM payroll_runs WHERE id=$1 AND tenant_id=$2`,
		runID, tid).Scan(&period, &currency); err != nil {
		c.JSON(404, gin.H{"error": "run not found"})
		return
	}
	rows, err := h.db.Query(c, `
		SELECT employee_name, COALESCE(bank_name,''), COALESCE(bank_account_number,''),
		       COALESCE(bank_account_name,''), gross, paye, pension, nhf,
		       deductions_total, net
		FROM payslips WHERE run_id=$1 ORDER BY employee_name ASC`, runID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var b strings.Builder
	b.WriteString("Employee,Bank,Account Number,Account Name,Gross,PAYE,Pension,NHF,Total Deductions,Net Pay\n")
	for rows.Next() {
		var (
			name, bn, ba, bnm                       string
			gross, paye, pen, nhf, ded, net         float64
		)
		if err := rows.Scan(&name, &bn, &ba, &bnm, &gross, &paye, &pen, &nhf, &ded, &net); err == nil {
			b.WriteString(fmt.Sprintf("%s,%s,%s,%s,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f\n",
				csvCell(name), csvCell(bn), csvCell(ba), csvCell(bnm),
				gross, paye, pen, nhf, ded, net))
		}
	}
	c.Header("Content-Disposition", `attachment; filename="payroll-`+period+`.csv"`)
	c.Data(http.StatusOK, "text/csv", []byte(b.String()))
}

/* ---------------- small helpers ---------------- */

func deref(p *string, d string) string {
	if p == nil {
		return d
	}
	return *p
}
func derefF(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
func derefB(p *bool, d bool) bool {
	if p == nil {
		return d
	}
	return *p
}
func csvCell(s string) string {
	if strings.ContainsAny(s, ",\"\n") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}
