package config

import (
	"strings"
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	Env      string
	Port     string
	LogLevel string

	DatabaseURL string
	RedisURL    string

	JWTAccessSecret  string
	JWTRefreshSecret string
	JWTAccessTTL     time.Duration
	JWTRefreshTTL    time.Duration

	S3Endpoint  string
	S3Region    string
	S3Bucket    string
	S3AccessKey string
	S3SecretKey string

	SMTPHost string
	SMTPPort int
	SMTPFrom string

	GitHubAppID             string
	GitHubAppPrivateKeyPath string
	GitHubWebhookSecret     string

	AllowedOrigins []string
}

func Load() (*Config, error) {
	v := viper.New()
	v.AutomaticEnv()
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.SetConfigName(".env")
	v.SetConfigType("env")
	v.AddConfigPath(".")
	v.AddConfigPath("./backend")
	_ = v.ReadInConfig()

	v.SetDefault("APP_ENV", "development")
	v.SetDefault("APP_PORT", "8080")
	v.SetDefault("APP_LOG_LEVEL", "info")
	v.SetDefault("JWT_ACCESS_TTL", "15m")
	v.SetDefault("JWT_REFRESH_TTL", "720h")
	v.SetDefault("ALLOWED_ORIGINS", "http://localhost:5173")
	v.SetDefault("SMTP_PORT", 1025)

	cfg := &Config{
		Env:                     v.GetString("APP_ENV"),
		Port:                    v.GetString("APP_PORT"),
		LogLevel:                v.GetString("APP_LOG_LEVEL"),
		DatabaseURL:             v.GetString("DATABASE_URL"),
		RedisURL:                v.GetString("REDIS_URL"),
		JWTAccessSecret:         v.GetString("JWT_ACCESS_SECRET"),
		JWTRefreshSecret:        v.GetString("JWT_REFRESH_SECRET"),
		JWTAccessTTL:            v.GetDuration("JWT_ACCESS_TTL"),
		JWTRefreshTTL:           v.GetDuration("JWT_REFRESH_TTL"),
		S3Endpoint:              v.GetString("S3_ENDPOINT"),
		S3Region:                v.GetString("S3_REGION"),
		S3Bucket:                v.GetString("S3_BUCKET"),
		S3AccessKey:             v.GetString("S3_ACCESS_KEY"),
		S3SecretKey:             v.GetString("S3_SECRET_KEY"),
		SMTPHost:                v.GetString("SMTP_HOST"),
		SMTPPort:                v.GetInt("SMTP_PORT"),
		SMTPFrom:                v.GetString("SMTP_FROM"),
		GitHubAppID:             v.GetString("GITHUB_APP_ID"),
		GitHubAppPrivateKeyPath: v.GetString("GITHUB_APP_PRIVATE_KEY_PATH"),
		GitHubWebhookSecret:     v.GetString("GITHUB_WEBHOOK_SECRET"),
		AllowedOrigins:          strings.Split(v.GetString("ALLOWED_ORIGINS"), ","),
	}
	return cfg, nil
}
