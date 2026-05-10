package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type Claims struct {
	UserID   uuid.UUID `json:"uid"`
	TenantID uuid.UUID `json:"tid"`
	Roles    []string  `json:"roles"`
	jwt.RegisteredClaims
}

type Tokens struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	Expires int64  `json:"expires_in"`
}

type JWTConfig struct {
	AccessSecret  []byte
	RefreshSecret []byte
	AccessTTL     time.Duration
	RefreshTTL    time.Duration
}

func Issue(cfg JWTConfig, userID, tenantID uuid.UUID, roles []string) (Tokens, error) {
	now := time.Now()
	access := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		UserID:   userID,
		TenantID: tenantID,
		Roles:    roles,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(cfg.AccessTTL)),
			Subject:   userID.String(),
		},
	})
	at, err := access.SignedString(cfg.AccessSecret)
	if err != nil {
		return Tokens{}, err
	}
	refresh := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		UserID:   userID,
		TenantID: tenantID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(cfg.RefreshTTL)),
			Subject:   userID.String(),
		},
	})
	rt, err := refresh.SignedString(cfg.RefreshSecret)
	if err != nil {
		return Tokens{}, err
	}
	return Tokens{Access: at, Refresh: rt, Expires: int64(cfg.AccessTTL.Seconds())}, nil
}

func Parse(token string, secret []byte) (*Claims, error) {
	c := &Claims{}
	t, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil || !t.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}
