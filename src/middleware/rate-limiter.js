/**
 * 固定窗口限流中间件
 * 
 * 原理：每个IP在一个固定时间窗口内只能请求N次
 * 窗口结束，计数器自动清零
 * 
 * 使用方式：
 * import { rateLimiter } from './middleware/rate-limiter.js';
 * app.use(rateLimiter({ maxRequests: 10, windowMs: 60000 }));
 */

// Map 放在模块顶层，所有请求共享同一个计数器
// 注意：这是模块的单例状态，整个应用只有一个 requestCounts
const requestCounts = new Map();
export { requestCounts };

/**
 * 创建限流中间件
 * @param {Object} options - 配置项
 * @param {number} options.maxRequests - 窗口内最大请求数
 * @param {number} options.windowMs - 时间窗口大小（毫秒）
 * @returns {Function} Express中间件函数
 */
export function rateLimiter(options = {}) {
    // 解构参数，设置默认值
    const { 
        maxRequests = 10,      // 默认10次
        windowMs = 60 * 1000   // 默认60秒
    } = options;
    
    /**
     * Express中间件函数
     * 这个函数会被Express在每个请求时调用
     */
    return function(req, res, next) {
        const ip = req.ip;
        
        // 1. 初始化：新IP首次访问
        if (!requestCounts.has(ip)) {
            requestCounts.set(ip, {
                count: 0,
                windowStart: Date.now()
            });
        }
        
        // 2. 获取该IP的记录
        const record = requestCounts.get(ip);
        const now = Date.now();
        
        // 3. 窗口过期检查
        if (now - record.windowStart > windowMs) {
            // 进入新窗口，重置
            record.count = 0;
            record.windowStart = now;
        }
        
        // 4. 限流判断
        if (record.count >= maxRequests) {
            // 计算还需等待多少秒才能重试
            const retryAfter = Math.ceil(
                (record.windowStart + windowMs - now) / 1000
            );
            
            return res.status(429).json({
                error: '请求太频繁，请稍后再试',
                retryAfter: retryAfter + '秒'
            });
        }
        
        // 5. 放行：计数+1
        record.count++;
        next();
    };
}