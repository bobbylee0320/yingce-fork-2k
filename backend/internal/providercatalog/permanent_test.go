package providercatalog

import (
	"testing"
	"time"
)

func TestPermanentPromotionStillHonorsStart(t *testing.T) {
	now := time.Now()
	p := Provider{StartsAt: now.Add(-time.Hour), Permanent: true}
	if !IsActive(p, now.AddDate(20, 0, 0)) {
		t.Fatal("permanent promotion expired")
	}
	if IsActive(p, now.Add(-2*time.Hour)) {
		t.Fatal("promotion active before startsAt")
	}
	p.Permanent = false
	p.EndsAt = now
	if IsActive(p, now) {
		t.Fatal("timed promotion active at end")
	}
}
