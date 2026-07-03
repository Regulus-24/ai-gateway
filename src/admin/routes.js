import { Router } from 'express';
import { ConfigRepository } from '../db/config-repo.js';
import { refreshConfigCache, flushIpCache } from '../middleware/dispatcher.js';
import { addRule, removeRule, getAllRules } from '../db/ip-repo.js';
import { loginAuth, tokenAuth } from '../middleware/auth.js';

const router = Router();
const configRepo = new ConfigRepository();

// 登录接口 — 不需要认证
router.post('/api/admin/login', loginAuth);

// 以下所有管理API需要认证
router.use('/api/admin', tokenAuth);

// 获取所有限流配置
router.get('/api/admin/rate-limits', (req, res) => {
    const configs = configRepo.getAllConfigs();
    res.json(configs);
});

// 添加或更新某条配置
router.post('/api/admin/rate-limits', (req, res) => {
    const { path, method, maxRequests, windowMs, algorithm } = req.body;

    if (!path || !maxRequests || !windowMs) {
        return res.status(400).json({
            error: '缺少必要参数：path, maxRequests, windowMs'
        });
    }

    const config = configRepo.upsertConfig({
        path,
        method: method || 'GET',
        maxRequests,
        windowMs,
        algorithm: algorithm || 'sliding-window'
    });

    refreshConfigCache();

    res.json({
        message: '配置已更新',
        config
    });
});

// 启用/禁用或切换算法
router.patch('/api/admin/rate-limits/toggle', (req, res) => {
    const { path, method, enabled, algorithm } = req.body;
    const m = method || 'GET';

    if (algorithm) {
        const existing = configRepo.getConfig(path, m);
        if (existing) {
            configRepo.upsertConfig({
                path,
                method: m,
                maxRequests: existing.max_requests,
                windowMs: existing.window_ms,
                algorithm
            });
        }
    }

    if (enabled !== undefined) {
        configRepo.toggleConfig(path, m, enabled ? 1 : 0);
    }

    refreshConfigCache();
    res.json({ message: '配置已更新' });
});

// 删除某条配置
router.delete('/api/admin/rate-limits', (req, res) => {
    const { path, method } = req.body;

    configRepo.deleteConfig(path, method || 'GET');
    refreshConfigCache();
    res.json({ message: '配置已删除' });
});

// IP黑白名单
router.get('/api/admin/ip-rules', (req, res) => {
    res.json(getAllRules());
});

router.post('/api/admin/ip-rules', (req, res) => {
    const { ip, action, note } = req.body;
    if (!ip || !action) {
        return res.status(400).json({ error: '缺少必要参数：ip, action' });
    }
    const rules = addRule({ ip, action, note: note || '' });
    flushIpCache();
    res.json({ message: '规则已添加', rules });
});

router.delete('/api/admin/ip-rules/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const rules = removeRule(id);
    flushIpCache();
    res.json({ message: '规则已删除', rules });
});

export default router;
