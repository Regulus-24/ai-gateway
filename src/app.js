import express from 'express';
import http from 'http';
import db from './db/init.js';
import { rateLimiter } from './middleware/rate-limiter.js';
import { slidingWindowLimiter } from './middleware/sliding-window.js';
import { tokenBucketLimiter } from './middleware/token-bucket.js';
import { algorithmDispatcher } from './middleware/dispatcher.js';
import adminRouter from './admin/routes.js';
import statsRouter, { computeQps } from './routes/stats.js';
import { initAnomalyDetector, onAnomaly, getAnomalyEvents, getBaseline, getCurrentStatus } from './ml/anomaly-detector.js';
import { initWebSocket, broadcastAlert } from './ws-server.js';

const app = express();
const httpServer = http.createServer(app);

// 启动异常检测器（每5秒采样一次QPS，取最近5秒平均值）
initAnomalyDetector(() => computeQps(5000));

// 异常检测到事件时，通过 WebSocket 推送告警
onAnomaly((event) => {
    broadcastAlert(event);
});

// 解析JSON请求体（管理API需要）
app.use(express.json());

// 静态文件托管 - 仪表盘前端
app.use(express.static('web'));

// 根据数据库配置动态选择限流算法
app.use(algorithmDispatcher());

// 管理API路由
app.use(adminRouter);

// 统计API路由
app.use(statsRouter);

// 业务路由
app.get('/api/users', (req, res) => {
    const users = db.prepare('SELECT * FROM users').all();
    res.json(users);
});

app.get('/api/users/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (user) {
        res.json(user);
    } else {
        res.status(404).json({ error: '用户不存在' });
    }
});

// 初始化 WebSocket（复用 HTTP Server）
initWebSocket(httpServer, () => ({
    totalRequests: 0,
    rejectedRequests: 0,
    qps: computeQps(1000),
    currentStatus: getCurrentStatus(),
    baseline: getBaseline(),
    recentEvents: getAnomalyEvents().slice(0, 5)
}));

const PORT = process.env.PORT || 8080;

httpServer.listen(PORT, () => {
    console.log(`服务器启动成功：http://localhost:${PORT}`);
    console.log(`WebSocket：ws://localhost:${PORT}`);
    console.log(`管理API：http://localhost:${PORT}/api/admin/rate-limits`);
});