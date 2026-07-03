import { ConfigRepository } from '../db/config-repo.js';
import { recordAccess } from '../routes/stats.js';
import { insertLog } from '../db/log-repo.js';
import { checkIp as queryIpRule } from '../db/ip-repo.js';

const configRepo = new ConfigRepository();

// 三种算法各自的 per-IP 状态
const fixedWindowState = new Map();   // ip → { count, windowStart }
const slidingWindowState = new Map(); // ip → timestamps[]
const tokenBucketState = new Map();   // ip → { tokens, lastRefill }

// IP规则缓存（30秒过期）
const ipCache = new Map(); // ip → { rule, expiresAt }

export function flushIpCache() {
    ipCache.clear();
    console.log('IP规则缓存已刷新');
}

// 配置缓存（提升到模块作用域，支持外部强制刷新）
let configCache = configRepo.getAllConfigs();

export function refreshConfigCache() {
    configCache = configRepo.getAllConfigs();
    console.log('限流配置已强制刷新，当前配置数：', configCache.length);
}

function checkIpCache(ip) {
    const now = Date.now();
    const cached = ipCache.get(ip);
    if (cached && cached.expiresAt > now) {
        return cached.rule;
    }
    const rule = queryIpRule(ip);
    ipCache.set(ip, { rule, expiresAt: now + 30000 });
    return rule;
}

/**
 * 限流算法分发器
 * 从数据库读取配置，根据 algorithm 字段动态选择限流算法
 * 未匹配到配置或 algorithm 未知时，默认使用滑动窗口
 */
export function algorithmDispatcher() {

    setInterval(() => {
        configCache = configRepo.getAllConfigs();
        console.log('限流配置已刷新，当前配置数：', configCache.length);
    }, 30 * 1000);

    return function (req, res, next) {
        const ip = req.ip;
        const now = Date.now();

        // 0. IP 黑白名单检查（管理API自身不检查，避免无法自救）
        if (!req.path.startsWith('/api/admin')) {
        const ipRule = checkIpCache(ip);
        if (ipRule) {
            if (ipRule.action === 'deny') {
                setImmediate(() => insertLog(req.path, req.method, ip, 403, null));
                return res.status(403).json({ error: 'IP已被封禁', ip });
            }
            if (ipRule.action === 'allow') {
                setImmediate(() => insertLog(req.path, req.method, ip, 200, 'whitelist'));
                return next();
            }
        }
        } // end admin bypass

        // 1. 匹配路由配置
        let config = configCache.find(
            c => c.route_path === req.path && c.route_method === req.method
        );

        if (!config) {
            config = configCache.find(
                c => c.route_path === '*' && c.route_method === req.method
            );
        }

        // 2. 未匹配到配置 → 默认滑动窗口
        if (!config) {
            return applySlidingWindow(req, res, next, ip, now, 100, 60000);
        }

        const algorithm = config.algorithm || 'sliding-window';
        const maxRequests = config.max_requests;
        const windowMs = config.window_ms;

        // 3. 按 algorithm 字段分发
        switch (algorithm) {
            case 'fixed-window':
                return applyFixedWindow(req, res, next, ip, now, maxRequests, windowMs);
            case 'token-bucket':
                return applyTokenBucket(req, res, next, ip, now, maxRequests, windowMs);
            case 'sliding-window':
            default:
                return applySlidingWindow(req, res, next, ip, now, maxRequests, windowMs);
        }
    };
}

// ========== 固定窗口 ==========
function applyFixedWindow(req, res, next, ip, now, maxRequests, windowMs) {
    if (!fixedWindowState.has(ip)) {
        fixedWindowState.set(ip, { count: 0, windowStart: now });
    }

    const record = fixedWindowState.get(ip);

    if (now - record.windowStart > windowMs) {
        record.count = 0;
        record.windowStart = now;
    }

    if (record.count >= maxRequests) {
        const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);
        const windowSec = windowMs / 1000;

        recordAccess(req.path, false);
        setImmediate(() => insertLog(req.path, req.method, ip, 429, 'fixed-window'));
        return res.status(429).json({
            error: '请求太频繁，请稍后再试',
            retryAfter: retryAfter + '秒',
            limit: maxRequests,
            window: windowSec + '秒',
            algorithm: 'fixed-window'
        });
    }

    record.count++;
    recordAccess(req.path, true);
    setImmediate(() => insertLog(req.path, req.method, ip, 200, 'fixed-window'));
    next();
}

// ========== 滑动窗口 ==========
function applySlidingWindow(req, res, next, ip, now, maxRequests, windowMs) {
    if (!slidingWindowState.has(ip)) {
        slidingWindowState.set(ip, []);
    }

    const timestamps = slidingWindowState.get(ip);

    while (timestamps.length > 0 && now - timestamps[0] > windowMs) {
        timestamps.shift();
    }

    if (timestamps.length >= maxRequests) {
        const oldestInWindow = timestamps[0];
        const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
        const windowSec = windowMs / 1000;

        recordAccess(req.path, false);
        setImmediate(() => insertLog(req.path, req.method, ip, 429, 'sliding-window'));
        return res.status(429).json({
            error: '请求太频繁，请稍后再试',
            retryAfter: retryAfter + '秒',
            limit: maxRequests,
            window: windowSec + '秒',
            algorithm: 'sliding-window'
        });
    }

    timestamps.push(now);
    recordAccess(req.path, true);
    setImmediate(() => insertLog(req.path, req.method, ip, 200, 'sliding-window'));
    next();
}

// ========== 令牌桶 ==========
function applyTokenBucket(req, res, next, ip, now, maxRequests, windowMs) {
    const capacity = maxRequests;
    const windowSec = windowMs / 1000;
    const fillRate = capacity / windowSec;

    if (!tokenBucketState.has(ip)) {
        tokenBucketState.set(ip, {
            tokens: capacity,
            lastRefill: now
        });
    }

    const bucket = tokenBucketState.get(ip);

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * fillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        recordAccess(req.path, true);
        setImmediate(() => insertLog(req.path, req.method, ip, 200, 'token-bucket'));
        next();
    } else {
        const retryAfter = Math.ceil((1 - bucket.tokens) / fillRate);

        recordAccess(req.path, false);
        setImmediate(() => insertLog(req.path, req.method, ip, 429, 'token-bucket'));
        return res.status(429).json({
            error: '请求太频繁，请稍后再试',
            retryAfter: retryAfter + '秒',
            limit: capacity,
            window: windowSec + '秒',
            algorithm: 'token-bucket'
        });
    }
}
