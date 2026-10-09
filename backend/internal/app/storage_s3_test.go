package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestS3ObjectOperationsUsePathStyleSessionTokenAndNoManagedHeaders(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		if r.URL.Path != "/bucket/prefix/object.txt" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("X-Amz-Security-Token") != "session-token" {
			t.Errorf("X-Amz-Security-Token = %q", r.Header.Get("X-Amz-Security-Token"))
		}
		if r.Header.Get("X-Amz-Acl") != "" || r.Header.Get("X-Amz-Server-Side-Encryption") != "" {
			t.Errorf("unexpected ACL/SSE headers: %#v", r.Header)
		}
		switch r.Method {
		case http.MethodPut:
			data, _ := io.ReadAll(r.Body)
			if string(data) != "payload" {
				t.Errorf("body = %q", data)
			}
			w.Header().Set("ETag", `"etag-value"`)
		case http.MethodGet:
			if r.Header.Get("Range") != "bytes=0-3" {
				t.Errorf("Range = %q", r.Header.Get("Range"))
			}
			w.Header().Set("Content-Range", "bytes 0-3/7")
			w.Header().Set("Accept-Ranges", "bytes")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, "payl")
		case http.MethodDelete:
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>`)
		}
	}))
	defer server.Close()

	setting := ossSettingValue{Provider: s3Provider, Region: "us-east-1", Endpoint: server.URL, Bucket: "bucket", AccessKeyID: "access-id", AccessKeySecret: "secret-value", SessionToken: "session-token"}
	etag, err := putS3Object(setting, "prefix/object.txt", "text/plain", 7, bytes.NewReader([]byte("payload")))
	if err != nil || etag != "etag-value" {
		t.Fatalf("putS3Object() = %q, %v", etag, err)
	}
	stream, err := getS3ObjectRange(setting, "prefix/object.txt", "bytes=0-3")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(stream.Body)
	_ = stream.Body.Close()
	if stream.StatusCode != http.StatusPartialContent || stream.ContentRange != "bytes 0-3/7" || string(data) != "payl" {
		t.Fatalf("stream = %#v, body = %q", stream, data)
	}
	if err := deleteS3Object(setting, "prefix/object.txt"); err != nil {
		t.Fatalf("deleteS3Object(404) error = %v", err)
	}
	if strings.Join(methods, ",") != "PUT,GET,DELETE" {
		t.Fatalf("methods = %v", methods)
	}
}

func TestDirectS3ImageUploadLifecycle(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var uploaded []byte
	var objectPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			objectPath = r.URL.Path
			if !strings.Contains(objectPath, "/users/user-1/image/") || !strings.HasSuffix(objectPath, ".png") {
				t.Errorf("object path = %q", objectPath)
			}
			if r.URL.Query().Get("X-Amz-Signature") == "" {
				t.Error("direct PUT is missing its presigned signature")
			}
			if r.Header.Get("Content-Type") != "image/png" {
				t.Errorf("PUT Content-Type = %q", r.Header.Get("Content-Type"))
			}
			uploaded, _ = io.ReadAll(r.Body)
			w.Header().Set("ETag", `"direct-etag"`)
		case http.MethodHead:
			if r.URL.Path != objectPath {
				t.Errorf("HEAD path = %q, want %q", r.URL.Path, objectPath)
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(uploaded)))
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("ETag", `"direct-etag"`)
		default:
			t.Errorf("unexpected method %s", r.Method)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()

	svc := newResourceTestService(t)
	settingJSON, err := json.Marshal(ossSettingValue{
		Enabled: true, Provider: s3Provider, Region: "us-east-1", Endpoint: server.URL,
		Bucket: "bucket", AccessKeyID: "access-id", AccessKeySecret: "secret-value",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.SaveSystemSetting(&model.SystemSetting{Key: ossSettingKey, ValueJSON: string(settingJSON)}); err != nil {
		t.Fatal(err)
	}

	started, err := svc.BeginDirectImageUpload("user-1", "direct.png", 7, "image/png", 1, 1, "direct-upload-1")
	if err != nil {
		t.Fatal(err)
	}
	if started.Resource.Status != model.ResourceStatusPending || started.UploadURL == "" || strings.Contains(started.UploadURL, "secret-value") {
		t.Fatalf("BeginDirectImageUpload() = %#v", started)
	}
	request, err := http.NewRequest(http.MethodPut, started.UploadURL, bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range started.Headers {
		request.Header.Set(name, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Fatalf("presigned PUT status = %d", response.StatusCode)
	}
	completed, err := svc.CompleteDirectImageUpload("user-1", started.Resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != model.ResourceStatusReady || completed.ETag != "direct-etag" || string(uploaded) != "payload" {
		t.Fatalf("completed upload = %#v, payload = %q", completed, uploaded)
	}
	ready, err := svc.BeginDirectImageUpload("user-1", "direct.png", 7, "image/png", 1, 1, "direct-upload-1")
	if err != nil || ready.Resource.ID != completed.ID || ready.UploadURL != "" {
		t.Fatalf("idempotent BeginDirectImageUpload() = %#v, %v", ready, err)
	}
}

func TestSignedS3ObjectURLUsesSDKPresignAndSessionToken(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	value, err := signedS3ObjectURL(ossSettingValue{
		Provider: s3Provider, Region: "us-east-1", Endpoint: server.URL, Bucket: "bucket",
		AccessKeyID: "access-id", AccessKeySecret: "secret-value", SessionToken: "session-token",
	}, "folder/object.png", time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/bucket/folder/object.png" || parsed.Query().Get("X-Amz-Security-Token") != "session-token" || parsed.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("presigned URL = %q", value)
	}
	if strings.Contains(value, "secret-value") {
		t.Fatal("presigned URL leaked secret key")
	}
}

func TestS3EndpointAndDigestsEnforceStorageContract(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "storage.internal")
	if _, err := validateStorageEndpoint("https://example.com/path"); err == nil {
		t.Fatal("validateStorageEndpoint() accepted a path")
	}
	if _, err := validateStorageEndpoint("http://example.com"); err == nil {
		t.Fatal("validateStorageEndpoint() accepted public HTTP")
	}
	base := ossSettingValue{Provider: s3Provider, Region: "us-east-1", Endpoint: "https://s3.example.com", Bucket: "bucket", PathPrefix: "assets", AccessKeyID: "id", AccessKeySecret: "secret"}
	rotated := base
	rotated.AccessKeySecret = "rotated"
	moved := base
	moved.PathPrefix = "other"
	if storageLocationDigest(base) != storageLocationDigest(rotated) {
		t.Fatal("credential rotation changed the location digest")
	}
	if storageTestDigest(base) == storageTestDigest(rotated) {
		t.Fatal("credential rotation did not invalidate the tested digest")
	}
	if storageLocationDigest(base) == storageLocationDigest(moved) {
		t.Fatal("location change did not create a different digest")
	}
}

func TestOSSSettingKeepsS3SecretsWhenLocationChanges(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	current := ossSettingValue{
		Provider:        s3Provider,
		Region:          "us-east-1",
		Endpoint:        "https://127.0.0.1",
		Bucket:          "old-bucket",
		AccessKeyID:     "access-id",
		AccessKeySecret: "secret-value",
		SessionToken:    "session-token",
		PathPrefix:      defaultOSSPathPrefix,
	}
	next, err := ossSettingFromRequest(OSSSettingRequest{
		Enabled:     true,
		Provider:    s3Provider,
		S3Preset:    "custom",
		Region:      "us-east-1",
		Endpoint:    "https://127.0.0.1",
		Bucket:      "new-bucket",
		AccessKeyID: "access-id",
		PathPrefix:  "changed-prefix",
	}, current)
	if err != nil {
		t.Fatal(err)
	}
	if next.AccessKeySecret != current.AccessKeySecret || next.SessionToken != current.SessionToken {
		t.Fatalf("secrets were not retained: %#v", next)
	}
}

func TestDefaultOSSPathPrefix(t *testing.T) {
	value := normalizeOSSSetting(ossSettingValue{})
	if value.PathPrefix != defaultOSSPathPrefix || defaultOSSSetting().PathPrefix != defaultOSSPathPrefix {
		t.Fatalf("default path prefix = %q, default setting = %q", value.PathPrefix, defaultOSSSetting().PathPrefix)
	}
}

func TestResourceObjectKeyPreservesOrInfersExtension(t *testing.T) {
	setting := ossSettingValue{PathPrefix: "assets"}
	now := time.Date(2026, time.August, 27, 20, 31, 0, 0, time.UTC)

	for _, test := range []struct {
		name     string
		fileName string
		mimeType string
		kind     string
		ext      string
	}{
		{name: "original filename", fileName: "photo.JPEG", mimeType: "image/jpeg", kind: "image", ext: ".jpeg"},
		{name: "mime type", mimeType: "image/png", kind: "image", ext: ".png"},
		{name: "kind fallback", kind: "video", ext: ".mp4"},
	} {
		t.Run(test.name, func(t *testing.T) {
			objectKey := ossObjectKey(setting, "user-1", test.kind, test.fileName, test.mimeType, now)
			if !strings.HasSuffix(objectKey, test.ext) {
				t.Fatalf("object key = %q, want suffix %q", objectKey, test.ext)
			}
		})
	}
}
