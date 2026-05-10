package auth

import (
	"github.com/pquerna/otp/totp"
)

func GenerateTOTP(issuer, account string) (secret, url string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{Issuer: issuer, AccountName: account})
	if err != nil {
		return "", "", err
	}
	return key.Secret(), key.URL(), nil
}

func VerifyTOTP(secret, code string) bool {
	return totp.Validate(code, secret)
}
