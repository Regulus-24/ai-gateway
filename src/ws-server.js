import { WebSocketServer } from 'ws';

let wss = null;
let statsInterval = null;

/**
 * 初始化 WebSocket 服务
 * @param {http.Server} httpServer
 * @param {Function} getAnomalyEvents - 获取异常事件
 * @param {Function} onAnomaly - 注册异常回调
 */
export function initWebSocket(httpServer, getStatsFn) {
    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress;
        console.log('[WebSocket] 客户端连接: ' + clientIp + '  当前连接数: ' + wss.clients.size);

        ws.on('close', () => {
            console.log('[WebSocket] 客户端断开: ' + clientIp + '  当前连接数: ' + wss.clients.size);
        });

        ws.on('error', (err) => {
            console.log('[WebSocket] 客户端错误: ' + err.message);
        });
    });

    // 每2秒推送 stats
    statsInterval = setInterval(() => {
        if (wss.clients.size === 0) return;
        try {
            const data = getStatsFn();
            broadcast({ type: 'stats', data, timestamp: Date.now() });
        } catch (e) {
            console.error('[WebSocket] stats 推送失败: ' + e.message);
        }
    }, 2000);

    console.log('[WebSocket] 服务已启动，端口复用 HTTP Server');
}

/**
 * 推送告警消息给所有客户端
 */
export function broadcastAlert(anomalyEvent) {
    broadcast({
        type: 'alert',
        data: {
            qps: anomalyEvent.qps,
            anomalyType: anomalyEvent.type,
            severity: anomalyEvent.severity,
            status: anomalyEvent.status,
            time: anomalyEvent.time
        },
        timestamp: Date.now()
    });
}

function broadcast(message) {
    if (!wss) return;
    const payload = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(payload);
        }
    });
}
