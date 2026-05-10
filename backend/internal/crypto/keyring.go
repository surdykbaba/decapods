// Package crypto provides envelope-style application-side encryption for
// Tier-2 sensitive data (financials, contracts, proposal bodies, audit log
// entries). The master key is loaded from MASTER_KEY (a base64-encoded
// 32-byte value) and never leaves the process. Each value is sealed with
// AES-256-GCM under a per-record nonce, with a leading version byte so we
// can rotate keys without touching every row.
//
// Wire format of a sealed payload:
//
//   [1 byte version] [12 byte nonce] [n bytes ciphertext+tag]
//
// Version 1 = MASTER_KEY_PRIMARY. Version 2+ would be added when rotating;
// rows still carry their original version byte so the right key is picked.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

const (
	versionV1   byte = 1
	nonceSize        = 12 // GCM standard
	keyByteLen       = 32 // AES-256
)

// Keyring holds the active and (optionally) historical keys. It is safe for
// concurrent use; nothing here mutates after construction.
type Keyring struct {
	primary    *keyEntry
	historical map[byte]*keyEntry // version -> key
	hmacKey    []byte             // for blind indexes
}

type keyEntry struct {
	version byte
	aead    cipher.AEAD
	raw     []byte // kept only for HMAC fallback / rotation tooling
}

// New constructs a Keyring from the primary master key plus optional
// historical entries (used during a rotation window). The blindHashSalt
// is derived from the primary key by default but can be overridden.
//
// `primaryB64` and `historical` should each be base64-encoded 32-byte
// values. A separate `blindHashSaltB64` (any length) keys the HMAC used
// for searchable blind indexes.
func New(primaryB64 string, historical map[int]string, blindHashSaltB64 string) (*Keyring, error) {
	primary, err := parseKey(versionV1, primaryB64)
	if err != nil {
		return nil, fmt.Errorf("primary key: %w", err)
	}
	hist := map[byte]*keyEntry{primary.version: primary}
	for ver, b64 := range historical {
		if ver < 1 || ver > 255 {
			return nil, fmt.Errorf("historical version %d out of range", ver)
		}
		if byte(ver) == primary.version {
			continue
		}
		k, err := parseKey(byte(ver), b64)
		if err != nil {
			return nil, fmt.Errorf("historical key v%d: %w", ver, err)
		}
		hist[k.version] = k
	}
	salt := []byte{}
	if blindHashSaltB64 != "" {
		s, err := base64.StdEncoding.DecodeString(blindHashSaltB64)
		if err != nil {
			return nil, fmt.Errorf("blind salt: %w", err)
		}
		salt = s
	} else {
		// Derive a deterministic salt from the primary key so a missing
		// salt env var still gives stable hashes within an environment.
		h := sha256.Sum256(append([]byte("blind-index-v1:"), primary.raw...))
		salt = h[:]
	}
	return &Keyring{primary: primary, historical: hist, hmacKey: salt}, nil
}

func parseKey(version byte, b64 string) (*keyEntry, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("not base64: %w", err)
	}
	if len(raw) != keyByteLen {
		return nil, fmt.Errorf("key must be %d bytes, got %d", keyByteLen, len(raw))
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &keyEntry{version: version, aead: aead, raw: raw}, nil
}

// Encrypt seals the given plaintext under the primary key and returns the
// wire-format bytes ready to insert into a `bytea` column. An empty input
// yields a nil slice (so callers don't accidentally encrypt blank values).
func (k *Keyring) Encrypt(plaintext []byte) ([]byte, error) {
	if len(plaintext) == 0 {
		return nil, nil
	}
	nonce := make([]byte, nonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ct := k.primary.aead.Seal(nil, nonce, plaintext, nil)
	out := make([]byte, 0, 1+nonceSize+len(ct))
	out = append(out, k.primary.version)
	out = append(out, nonce...)
	out = append(out, ct...)
	return out, nil
}

// EncryptString is a convenience for the common case of stringy fields.
func (k *Keyring) EncryptString(s string) ([]byte, error) {
	return k.Encrypt([]byte(s))
}

// Decrypt opens a sealed payload, picking the historical key whose version
// matches the leading byte. Returns ErrTampered on auth failure.
func (k *Keyring) Decrypt(sealed []byte) ([]byte, error) {
	if len(sealed) == 0 {
		return nil, nil
	}
	if len(sealed) < 1+nonceSize+16 {
		return nil, ErrMalformed
	}
	ver := sealed[0]
	entry, ok := k.historical[ver]
	if !ok {
		return nil, fmt.Errorf("%w: unknown key version %d", ErrUnknownVersion, ver)
	}
	nonce := sealed[1 : 1+nonceSize]
	ct := sealed[1+nonceSize:]
	pt, err := entry.aead.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, ErrTampered
	}
	return pt, nil
}

// DecryptString opens a sealed payload and returns it as a string. Empty
// input yields the empty string.
func (k *Keyring) DecryptString(sealed []byte) (string, error) {
	pt, err := k.Decrypt(sealed)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// BlindHash produces a deterministic HMAC-SHA256 over the normalised input.
// Values that are searched by exact match (emails, phone numbers, document
// references) get this stored alongside the encrypted payload — index it
// with a regular B-tree to keep `WHERE email_hash = $1` fast.
//
// Normalisation: trims whitespace, lower-cases. For numbers strip the value
// at the call site before hashing.
func (k *Keyring) BlindHash(plaintext string) []byte {
	if plaintext == "" {
		return nil
	}
	mac := hmac.New(sha256.New, k.hmacKey)
	mac.Write([]byte(normalise(plaintext)))
	return mac.Sum(nil)
}

// PrimaryVersion returns the version byte of the active key. Useful for
// surfacing rotation state on /healthz.
func (k *Keyring) PrimaryVersion() byte { return k.primary.version }

// GenerateMasterKeyB64 returns a fresh base64-encoded 32-byte key suitable
// for setting MASTER_KEY. Call this once per environment.
func GenerateMasterKeyB64() (string, error) {
	raw := make([]byte, keyByteLen)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func normalise(s string) string {
	// Cheap inline lower + trim. Keeping the dependency surface tiny.
	out := make([]byte, 0, len(s))
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n') {
		end--
	}
	for i := start; i < end; i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out = append(out, c)
	}
	return string(out)
}

// Errors callers can match on.
var (
	ErrMalformed      = errors.New("crypto: malformed sealed payload")
	ErrTampered       = errors.New("crypto: ciphertext failed auth check")
	ErrUnknownVersion = errors.New("crypto: unknown key version")
)
