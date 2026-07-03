import { ConfigRepository } from './config-repo.js';

const configRepo = new ConfigRepository();

console.log('插入默认限流配置...');

// 全局默认：所有GET请求，60秒内100次
configRepo.upsertConfig({
    path: '*',              // '*' 表示匹配所有路径
    method: 'GET',
    maxRequests: 100,
    windowMs: 60000,
    algorithm: 'sliding-window'
});

// 用户API：更宽松
configRepo.upsertConfig({
    path: '/api/users',
    method: 'GET',
    maxRequests: 200,
    windowMs: 60000,
    algorithm: 'sliding-window'
});

// 商品API：正常
configRepo.upsertConfig({
    path: '/api/products',
    method: 'GET',
    maxRequests: 50,
    windowMs: 30000,
    algorithm: 'sliding-window'
});

// 管理员API：严格限制（为以后准备）
configRepo.upsertConfig({
    path: '/api/admin',
    method: 'GET',
    maxRequests: 5,
    windowMs: 60000,
    algorithm: 'sliding-window'
});

const allConfigs = configRepo.getAllConfigs();
console.log('当前限流配置：');
allConfigs.forEach(c => {
    console.log(`  ${c.route_method} ${c.route_path}: ${c.max_requests}次/${c.window_ms/1000}秒`);
});