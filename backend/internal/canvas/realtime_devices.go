package canvas

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Device numbers belong to the room, so every browser and backend instance agrees.
// Expiring slots recover from process crashes without retaining device identities.
var claimRealtimeDevice = redis.NewScript(`
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local used = {}
for _, member in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
    used[tonumber(string.match(member, '^(%d+):'))] = true
end
for number = 1, 64 do
    if not used[number] then
        redis.call('ZADD', KEYS[1], now + 60000, number .. ':' .. ARGV[1])
        redis.call('EXPIRE', KEYS[1], 120)
        return number
    end
end
return 0
`)

var renewRealtimeDevice = redis.NewScript(`
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
local expires = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not expires or tonumber(expires) <= now then return 0 end
redis.call('ZADD', KEYS[1], now + 60000, ARGV[1])
redis.call('EXPIRE', KEYS[1], 120)
return 1
`)

func (s *RealtimeSession) deviceMember() string {
	return strconv.Itoa(s.peer.Number) + ":" + s.peer.ID
}

func (s *RealtimeSession) claimDeviceNumber() error {
	ctx, cancel := context.WithTimeout(s.ctx, 3*time.Second)
	defer cancel()
	number, err := claimRealtimeDevice.Run(ctx, s.hub.redis, []string{s.room + ":devices"}, s.peer.ID).Int()
	if err != nil {
		return err
	}
	if number < 1 || number > 64 {
		return errors.New("此画布打开的窗口过多")
	}
	s.peer.Number = number
	return nil
}

func (s *RealtimeSession) renewDeviceNumber() bool {
	if s.hub.redis == nil {
		return true
	}
	ctx, cancel := context.WithTimeout(s.ctx, time.Second)
	defer cancel()
	renewed, err := renewRealtimeDevice.Run(ctx, s.hub.redis, []string{s.room + ":devices"}, s.deviceMember()).Int()
	if err != nil {
		slog.Warn("画布设备编号续期失败，将重建实时连接", "error", err)
	}
	return err == nil && renewed == 1
}

func (s *RealtimeSession) releaseDeviceNumber() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.hub.redis.ZRem(ctx, s.room+":devices", s.deviceMember()).Err(); err != nil {
		slog.Warn("画布设备编号释放失败，将按租期清理", "error", err)
	}
}
