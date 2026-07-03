/**
 * 异常检测模块 — 移动平均 + 标准差
 *
 * 算法：
 *   1. 维护过去 60 秒的 QPS 历史（每秒一个采样点）
 *   2. 计算滑动窗口的均值 mean 和标准差 stdDev
 *   3. |当前QPS - mean| > 2*stdDev → 异常
 *   4. 前 30 秒为学习期，不触发告警
 */

const HISTORY_SIZE = 60;       // 60 秒滑动窗口
const LEARNING_PERIOD = 30000; // 30 秒学习期
const SPIKE_THRESHOLD = 2;     // 2 个标准差
const DETECT_INTERVAL = 5000;  // 每 5 秒检测一次

let qpsHistory = [];
let anomalyEvents = [];
let startedAt = 0;
let currentStatus = 'normal';
let baseline = { mean: 0, stdDev: 0, sampleSize: 0 };
let intervalId = null;
let anomalyCallbacks = [];

export function onAnomaly(callback) {
    anomalyCallbacks.push(callback);
}

/**
 * 初始化异常检测器，开始定时检测
 * @param {Function} getQpsFn - 返回当前 QPS 的函数
 */
export function initAnomalyDetector(getQpsFn) {
    startedAt = Date.now();
    qpsHistory = [];
    anomalyEvents = [];
    currentStatus = 'normal';
    baseline = { mean: 0, stdDev: 0, sampleSize: 0 };

    if (intervalId) clearInterval(intervalId);

    intervalId = setInterval(() => {
        runDetection(getQpsFn);
    }, DETECT_INTERVAL);
}

function runDetection(getQpsFn) {
    const now = Date.now();
    const qps = getQpsFn();

    console.log('[异常检测采样] QPS回调返回=' + qps.toFixed(2) +
        '  启动后=' + ((now - startedAt) / 1000).toFixed(1) + 's' +
        '  历史长度=' + qpsHistory.length);

    qpsHistory.push({ time: now, qps });
    while (qpsHistory.length > 0 && now - qpsHistory[0].time > HISTORY_SIZE * 1000) {
        qpsHistory.shift();
    }

    // 学习期内不告警
    if (now - startedAt < LEARNING_PERIOD) {
        console.log('[异常检测] 学习期还剩 ' + ((LEARNING_PERIOD - (now - startedAt)) / 1000).toFixed(0) + 's');
        return;
    }
    if (qpsHistory.length < 5) {
        console.log('[异常检测] 样本不足 ' + qpsHistory.length + '/5');
        return;
    }

    const values = qpsHistory.map(p => p.qps);
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    baseline = { mean: Math.round(mean * 100) / 100, stdDev: Math.round(stdDev * 100) / 100, sampleSize: n };

    console.log('[异常检测] 基线: mean=' + baseline.mean.toFixed(2) +
        ' stdDev=' + baseline.stdDev.toFixed(2) +
        ' samples=' + n +
        ' 当前QPS=' + qps.toFixed(2));

    if (stdDev === 0) {
        console.log('[异常检测] stdDev=0，跳过（所有样本值相同）');
        return;
    }

    const deviation = (qps - mean) / stdDev;
    console.log('[异常检测] 偏离=' + deviation.toFixed(2) + 'σ  (阈值=' + SPIKE_THRESHOLD + 'σ)');

    if (Math.abs(deviation) <= SPIKE_THRESHOLD) {
        const recentCount = anomalyEvents.filter(e => now - e.time < 10000).length;
        console.log('[异常检测] 无异常，最近10s事件=' + recentCount);
        if (recentCount === 0 && currentStatus !== 'normal') {
            console.log('[异常检测] 状态恢复: ' + currentStatus + ' → normal');
            currentStatus = 'normal';
        }
        return;
    }

    const absDev = Math.abs(deviation);
    const type = deviation > 0 ? 'spike' : 'drop';
    currentStatus = absDev > 3 ? 'critical' : 'warning';

    console.log('[异常检测] ★ 检测到异常: type=' + type +
        ' severity=' + absDev.toFixed(1) + 'σ' +
        ' status=' + currentStatus +
        ' QPS=' + qps.toFixed(2));

    const event = {
        time: now,
        qps,
        type,
        severity: Math.round(absDev * 10) / 10,
        status: currentStatus
    };

    anomalyEvents.unshift(event);

    // 通知所有注册的回调
    for (const cb of anomalyCallbacks) {
        try { cb(event); } catch (e) { /* ignore */ }
    }

    if (anomalyEvents.length > 100) {
        anomalyEvents.length = 100;
    }
}

export function getAnomalyEvents() {
    return anomalyEvents;
}

export function getBaseline() {
    return baseline;
}

export function getCurrentStatus() {
    return currentStatus;
}

export function reset() {
    qpsHistory = [];
    anomalyEvents = [];
    startedAt = Date.now();
    currentStatus = 'normal';
    baseline = { mean: 0, stdDev: 0, sampleSize: 0 };
}
