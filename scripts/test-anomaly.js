/**
 * 异常检测验证脚本
 *
 * Phase 1 — autocannon 持续35s → 覆盖学习期 + 建立基线
 * Phase 2 — autocannon 高压10s → 触发 spike
 * Phase 3 — 停止15s → 触发 drop
 * Phase 4 — 汇总
 *
 * 用法：node scripts/test-anomaly.js
 * 前置：node src/app.js 已启动
 */

import autocannon from 'autocannon';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);

const API = 'http://localhost:8080';
const PATH = '/api/users';

// ==================== 工具 ====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGet(url) {
    try {
        const res = await fetch(url);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        return { ok: res.status === 200, status: res.status, data, raw: text.substring(0, 200) };
    } catch (e) {
        return { ok: false, status: 0, error: e.message, data: null };
    }
}

async function safePost(url, body) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        return { ok: res.status === 200, status: res.status, data };
    } catch (e) {
        return { ok: false, status: 0, error: e.message, data: null };
    }
}

function runAc(label, conn, dur) {
    return new Promise((resolve, reject) => {
        process.stdout.write('  ' + label + '...');
        const inst = autocannon({
            url: API + PATH,
            connections: conn,
            duration: dur,
            timeout: 10
        }, (err, r) => {
            if (err) return reject(err);
            console.log(' done (' + r.requests.total + ' req, QPS=' +
                Math.round(r.requests.average) + ', 2xx=' + (r['2xx'] || 0) + ')');
            resolve(r);
        });
        autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false });
    });
}

// ==================== 安全取值 ====================

function ev(list) { return Array.isArray(list) ? list : []; }

function bl(obj) {
    if (!obj || !obj.data || !obj.data.baseline) return { mean: 0, stdDev: 0, samples: 0 };
    const b = obj.data.baseline;
    return {
        mean:    typeof b.mean === 'number'      ? b.mean : 0,
        stdDev:  typeof b.stdDev === 'number'    ? b.stdDev : 0,
        samples: typeof b.sampleSize === 'number' ? b.sampleSize : 0
    };
}

function st(obj) {
    if (!obj || !obj.data) return 'unknown';
    const s = obj.data.currentStatus;
    return (s === 'normal' || s === 'warning' || s === 'critical') ? s : 'unknown';
}

function se(s) {
    if (s === 'normal') return '正常';
    if (s === 'warning') return '警告';
    if (s === 'critical') return '严重';
    return s;
}

// ==================== 主流程 ====================

async function main() {
    console.log('═══════════════════════════════════════');
    console.log('  异常检测模块验证');
    console.log('  目标: ' + API + PATH);
    console.log('═══════════════════════════════════════');

    // ====== 诊断 ======
    console.log('\n--- 诊断：原始 API 响应 ---');
    const diagS = await safeGet(API + '/api/stats');
    if (!diagS.ok) { console.error('服务器不可达'); process.exit(1); }
    console.log('  GET /api/stats → ' + JSON.stringify(diagS.data));

    const diagA = await safeGet(API + '/api/anomalies');
    console.log('  GET /api/anomalies → ' + JSON.stringify(diagA.data));
    console.log('  baseline: mean=' + bl(diagA).mean.toFixed(2) +
        ' stdDev=' + bl(diagA).stdDev.toFixed(2) +
        ' samples=' + bl(diagA).samples);

    // ====== 准备 ======
    console.log('\n--- 准备环境 ---');
    console.log('  放宽限流到 5000次/10秒...');
    await safePost(API + '/api/admin/rate-limits', {
        path: PATH, method: 'GET', maxRequests: 5000, windowMs: 10000, algorithm: 'sliding-window'
    });
    console.log('  重置学习期...');
    await safePost(API + '/api/anomalies/reset', {});
    await sleep(2000);

    // ====== Phase 1: 基础基线（35s autocannon，覆盖30s学习期） ======
    console.log('\n══════ Phase 1: 建立基线（autocannon 10并发 35s）══════');
    console.log('  （学习期30s + 5样本×5s = 55s 才能开始检测，');
    console.log('   35s流量确保学习期后有足够样本）');
    await runAc('baseline 10c/35s', 10, 35);

    // 等最后几次采样
    console.log('  等待采样（10s）...');
    await sleep(10000);

    let r = await safeGet(API + '/api/anomalies');
    let b = bl(r);
    console.log('  基线: mean=' + b.mean.toFixed(2) +
        ' stdDev=' + b.stdDev.toFixed(2) +
        ' samples=' + b.samples +
        ' status=' + se(st(r)));

    // ====== Phase 2: Spike（50并发 10s 高压） ======
    console.log('\n══════ Phase 2: 突发 Spike（autocannon 50并发 10s）══════');
    await runAc('spike 50c/10s', 50, 10);

    console.log('  等待异常检测采样（15s / 3周期）...');
    for (let i = 1; i <= 3; i++) {
        await sleep(5000);
        r = await safeGet(API + '/api/anomalies');
        const events = ev(r.data ? r.data.recentEvents : null);
        const spikes = events.filter(e => e.type === 'spike');
        console.log('  [' + i + '/3] status=' + se(st(r)) +
            ' events=' + events.length + ' spikes=' + spikes.length);
    }

    r = await safeGet(API + '/api/anomalies');
    const spikeEvents = ev(r.data ? r.data.recentEvents : null).filter(e => e.type === 'spike');
    console.log('  最终 spike 事件: ' + spikeEvents.length);
    spikeEvents.slice(0, 3).forEach(function(e) {
        console.log('    +' + e.severity + 'σ QPS=' + e.qps +
            ' time=' + new Date(e.time).toLocaleTimeString());
    });

    // ====== Phase 3: Drop（停止 15s） ======
    console.log('\n══════ Phase 3: 流量骤降（停止 15s）══════');
    for (let i = 1; i <= 3; i++) {
        await sleep(5000);
        r = await safeGet(API + '/api/anomalies');
        const events = ev(r.data ? r.data.recentEvents : null);
        const drops = events.filter(e => e.type === 'drop');
        console.log('  [' + i + '/3] status=' + se(st(r)) +
            ' events=' + events.length + ' drops=' + drops.length);
    }

    r = await safeGet(API + '/api/anomalies');
    const dropEvents = ev(r.data ? r.data.recentEvents : null).filter(e => e.type === 'drop');
    console.log('  最终 drop 事件: ' + dropEvents.length);
    dropEvents.slice(0, 3).forEach(function(e) {
        console.log('    -' + e.severity + 'σ QPS=' + e.qps +
            ' time=' + new Date(e.time).toLocaleTimeString());
    });

    // ====== Phase 4: 汇总 ======
    r = await safeGet(API + '/api/anomalies');
    b = bl(r);
    const all = ev(r.data ? r.data.recentEvents : null);
    const spikes = all.filter(function(e) { return e.type === 'spike'; });
    const drops = all.filter(function(e) { return e.type === 'drop'; });
    const criticals = all.filter(function(e) { return e.severity >= 3; });

    console.log('\n═══════════════════════════════════════');
    console.log('  验证结果汇总');
    console.log('═══════════════════════════════════════');
    console.log('');
    console.log('  基线: mean=' + b.mean.toFixed(2) +
        ' stdDev=' + b.stdDev.toFixed(2) +
        ' samples=' + b.samples);
    console.log('  状态: ' + se(st(r)));
    console.log('  事件总数: ' + all.length +
        ' (spike=' + spikes.length +
        ' drop=' + drops.length +
        ' critical=' + criticals.length + ')');
    console.log('');

    const spikeOk = spikes.length > 0;
    const dropOk = drops.length > 0;
    console.log('  ╔══════════════════════╗');
    console.log('  ║ ' + (spikeOk ? 'PASS' : 'FAIL') + ' Spike 检测      ║');
    console.log('  ║ ' + (dropOk  ? 'PASS' : 'FAIL') + ' Drop  检测      ║');
    console.log('  ╚══════════════════════╝');

    if (!spikeOk || !dropOk) {
        console.log('\n  排查建议:');
        console.log('  - 检查终端 [computeQps] 和 [异常检测采样] 日志');
        console.log('  - QPS采样率5s，突发需持续 ≥5s');
        console.log('  - 学习期30s + 最少5样本 = 启动后55s才检测');
    }

    // 恢复
    await safePost(API + '/api/admin/rate-limits', {
        path: PATH, method: 'GET', maxRequests: 200, windowMs: 60000, algorithm: 'sliding-window'
    });
    console.log('\n验证完成。');
}

if (process.argv[1] === __filename) {
    main().catch(function(err) {
        console.error('验证致命错误:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
}
