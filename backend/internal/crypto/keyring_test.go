package crypto

import (
	"bytes"
	"strings"
	"testing"
)

const testKeyB64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" // 32 zero bytes; tests only

func newRing(t *testing.T) *Keyring {
	t.Helper()
	k, err := New(testKeyB64, nil, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return k
}

func TestRoundTrip(t *testing.T) {
	k := newRing(t)
	cases := []string{"hello", "₦20,000.00 invoice", "multi\nline\nbody", strings.Repeat("x", 4096)}
	for _, plain := range cases {
		sealed, err := k.EncryptString(plain)
		if err != nil {
			t.Fatalf("encrypt: %v", err)
		}
		out, err := k.DecryptString(sealed)
		if err != nil {
			t.Fatalf("decrypt: %v", err)
		}
		if out != plain {
			t.Fatalf("round-trip mismatch:\nwant %q\ngot  %q", plain, out)
		}
	}
}

func TestEmptyInputsAreEmpty(t *testing.T) {
	k := newRing(t)
	if b, err := k.Encrypt(nil); err != nil || b != nil {
		t.Fatalf("empty encrypt: %v / %v", b, err)
	}
	if s, err := k.DecryptString(nil); err != nil || s != "" {
		t.Fatalf("empty decrypt: %v / %v", s, err)
	}
}

func TestTamperedCiphertextFails(t *testing.T) {
	k := newRing(t)
	sealed, _ := k.EncryptString("the goods")
	sealed[len(sealed)-1] ^= 0x01
	if _, err := k.Decrypt(sealed); err == nil {
		t.Fatal("expected auth error on tampered ciphertext")
	}
}

func TestNonceUniquenessAcrossEncrypts(t *testing.T) {
	k := newRing(t)
	a, _ := k.EncryptString("same")
	b, _ := k.EncryptString("same")
	if bytes.Equal(a, b) {
		t.Fatal("two encryptions of identical plaintext produced identical bytes (nonce reuse?)")
	}
}

func TestBlindHashDeterministic(t *testing.T) {
	k := newRing(t)
	a := k.BlindHash("Person@Example.com")
	b := k.BlindHash("  person@example.com  ")
	if !bytes.Equal(a, b) {
		t.Fatal("blind hash should be case- and trim-insensitive")
	}
	c := k.BlindHash("other@example.com")
	if bytes.Equal(a, c) {
		t.Fatal("different inputs should produce different blind hashes")
	}
}

func TestUnknownVersionFails(t *testing.T) {
	k := newRing(t)
	sealed, _ := k.EncryptString("hi")
	sealed[0] = 99
	if _, err := k.Decrypt(sealed); err == nil {
		t.Fatal("expected unknown-version error")
	}
}
