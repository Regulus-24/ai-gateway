import db from './init.js';

/**
 * 限流配置数据仓库
 * 封装所有对 rate_limit_configs 表的操作
 */
export class ConfigRepository {
    constructor() {
        // 预编译语句
        this.findAllStmt = db.prepare(
            'SELECT * FROM rate_limit_configs WHERE enabled = 1'
        );
        
        this.findByPathStmt = db.prepare(
            `SELECT * FROM rate_limit_configs 
             WHERE route_path = ? AND route_method = ? AND enabled = 1`
        );
        
        this.insertStmt = db.prepare(
            `INSERT INTO rate_limit_configs (route_path, route_method, max_requests, window_ms, algorithm)
             VALUES (@path, @method, @maxRequests, @windowMs, @algorithm)`
        );
        
        this.updateStmt = db.prepare(
            `UPDATE rate_limit_configs
             SET max_requests = @maxRequests,
                 window_ms = @windowMs,
                 algorithm = @algorithm,
                 updated_at = CURRENT_TIMESTAMP
             WHERE route_path = @path AND route_method = @method`
        );
        
        this.toggleStmt = db.prepare(
            `UPDATE rate_limit_configs 
             SET enabled = @enabled, updated_at = CURRENT_TIMESTAMP
             WHERE route_path = @path AND route_method = @method`
        );
        
        this.deleteStmt = db.prepare(
            'DELETE FROM rate_limit_configs WHERE route_path = ? AND route_method = ?'
        );
    }
    
    // 获取所有启用的配置
    getAllConfigs() {
        return this.findAllStmt.all();
    }
    
    // 查找特定路径的配置
    getConfig(path, method = 'GET') {
        return this.findByPathStmt.get(path, method);
    }
    
    // 添加或更新配置（路径+方法组合唯一）
    upsertConfig({ path, method = 'GET', maxRequests, windowMs, algorithm = 'sliding-window' }) {
        const existing = this.getConfig(path, method);
        
        if (existing) {
            // 已存在 → 更新
            this.updateStmt.run({
                path, method, maxRequests, windowMs, algorithm
            });
        } else {
            // 不存在 → 插入
            this.insertStmt.run({
                path, method, maxRequests, windowMs, algorithm
            });
        }
        
        return this.getConfig(path, method);
    }
    
    // 启用/禁用某条配置
    toggleConfig(path, method = 'GET', enabled) {
        return this.toggleStmt.run({ path, method, enabled });
    }
    
    // 删除配置
    deleteConfig(path, method = 'GET') {
        return this.deleteStmt.run(path, method);
    }
}