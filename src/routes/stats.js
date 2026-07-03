import { Router } from 'express';
import { getAnomalyEvents, getBaseline, getCurrentStatus, reset as resetDetector } from '../ml/anomaly-detector.js';
import { getLogs, getPathDistribution } from '../db/log-repo.js';

const router = Router();

const stats = {
    total: 0,
    rejected: 0,
    apiDistribution: new Map()
};

const recentTimestamps = [];

export function recordAccess(path, passed) {
    stats.total++;
    if (!passed) stats.rejected++;

    const now = Date.now();
    recentTimestamps.push(now);

const cutoff = now - 60_000;
    while (recentTimestamps.length > 0 && recentTimestamps[0] < cutoff) {
        recentTimestamps.shift();
    }

    const count = stats.apiDistribution.get(path) || 0;
    stats.apiDistribution.set(path, count + 1);
}

export function computeQps(windowMs = 1000) {
    const now = Date.now();
    const cutoff = now - windowMs;
    let count = 0;
    for (const ts of recentTimestamps) {
        if (ts > cutoff) count++;
    }
    const qps = count / (windowMs / 1000);
    console.log('[computeQps] 窗口=' + windowMs + 'ms  时间戳总数=' + recentTimestamps.length +
        '  窗口内=' + count + '  QPS=' + qps.toFixed(2));
    return qps;
}

router.get('/api/stats', (req, res) => {
    const now = Date.now();
    const cutoff = now - 60000;

    while (recentTimestamps.length > 0 && recentTimestamps[0] < cutoff) {
        recentTimestamps.shift();
    }

    const qpsHistory = [];
    let currentQps = 0;

    for (let i = 59; i >= 0; i--) {
        const bucketEnd = now - i * 1000;
        const bucketStart = bucketEnd - 1000;
        let count = 0;
        for (const ts of recentTimestamps) {
            if (ts > bucketStart && ts <= bucketEnd) count++;
        }
        qpsHistory.push({ time: bucketEnd, count });
        if (i === 0) currentQps = count;
    }

    const apiDistribution = {};
    for (const [path, count] of stats.apiDistribution) {
        apiDistribution[path] = count;
    }

    res.json({
        totalRequests: stats.total,
        rejectedRequests: stats.rejected,
        qps: currentQps,
        qpsHistory,
        apiDistribution
    });
});

// 异常检测接口
router.get('/api/anomalies', (req, res) => {
    res.json({
        baseline: getBaseline(),
        recentEvents: getAnomalyEvents(),
        currentStatus: getCurrentStatus()
    });
});

// 调用日志接口
router.get('/api/logs', (req, res) => {
    const hours = req.query.hours || null;
    const status = req.query.status || null;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const { total, rows } = getLogs({ hours, status, limit, offset });
    const distribution = getPathDistribution(hours || 1);

    res.json({ total, rows, distribution });
});

// 重置学习期
router.post('/api/anomalies/reset', (req, res) => {
    resetDetector();
    res.json({ message: '学习期已重置' });
});

export default router;
