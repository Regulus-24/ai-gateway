import { ConfigRepository } from '../db/config-repo.js';

const ipTimestamps = new Map();
export { ipTimestamps };
const configRepo = new ConfigRepository();

/**
 * 基于数据库配置的滑动窗口限流中间件
 * 支持按路由路径匹配不同的限流策略
 */
export function slidingWindowLimiter() {
    let configCache = configRepo.getAllConfigs();
    
    setInterval(() => {
        configCache = configRepo.getAllConfigs();
        console.log('限流配置已刷新，当前配置数：', configCache.length);
    }, 30 * 1000);
    
    return function(req, res, next) {
       
        const ip = req.ip;
        const now = Date.now();
        
        // 1. 匹配配置
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
        
        // 从配置对象中取值
        const maxRequests = config.max_requests;
        const windowMs = config.window_ms;
        
        // console.log(`限流参数: ${maxRequests}次/${windowMs/1000}秒`);
        
        // 2. 获取该IP的时间戳数组
        if (!ipTimestamps.has(ip)) {
            ipTimestamps.set(ip, []);
        }
        const timestamps = ipTimestamps.get(ip);
        
        // 3. 清理过期记录
        while (timestamps.length > 0 && now - timestamps[0] > windowMs) {
            timestamps.shift();
        }
        
        // 4. 判断限流
        if (timestamps.length >= maxRequests) {
            const oldestInWindow = timestamps[0];
            const retryAfter = Math.ceil(
                (oldestInWindow + windowMs - now) / 1000
            );
            
            console.log(`限流拒绝！当前请求数: ${timestamps.length}, 限额: ${maxRequests}`);
            
            return res.status(429).json({
                error: '请求太频繁，请稍后再试',
                retryAfter: retryAfter + '秒',
                limit: maxRequests,
                window: windowMs / 1000 + '秒'
            });
        }
        
        // 5. 放行
        timestamps.push(now);
        next();
    };
}