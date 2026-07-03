import { ConfigRepository } from '../db/config-repo.js';

const ipBuckets = new Map();
export { ipBuckets };
const configRepo = new ConfigRepository();

/**
 * 令牌桶限流中间件
 * 每个IP独立维护一个令牌桶，支持突发流量，配置从数据库热加载
 */
export function tokenBucketLimiter() {
    let configCache = configRepo.getAllConfigs();

    setInterval(() => {
        configCache = configRepo.getAllConfigs();
        console.log('令牌桶配置已刷新，当前配置数：', configCache.length);
    }, 30 * 1000);

    return function (req, res, next) {
        const ip = req.ip;
        const now = Date.now();

        let config = configCache.find(
            c => c.route_path === req.path && c.route_method === req.method
        );

        if (!config) {
            config = configCache.find(
                c => c.route_path === '*' && c.route_method === req.method
            );
        }

        if (!config) {
            return next();
        }

        const capacity = config.max_requests;
        const windowSec = config.window_ms / 1000;
        const fillRate = capacity / windowSec;

        if (!ipBuckets.has(ip)) {
            ipBuckets.set(ip, {
                tokens: capacity,
                lastRefill: now
            });
        }

        const bucket = ipBuckets.get(ip);

        const elapsed = (now - bucket.lastRefill) / 1000;
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * fillRate);
        bucket.lastRefill = now;

        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            next();
        } else {
            const retryAfter = Math.ceil((1 - bucket.tokens) / fillRate);

            return res.status(429).json({
                error: '请求太频繁，请稍后再试',
                retryAfter: retryAfter + '秒',
                limit: capacity,
                window: windowSec + '秒',
                algorithm: 'token-bucket'
            });
        }
    };
}
