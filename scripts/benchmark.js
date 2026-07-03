/**
 * 限流算法压测脚本
 *
 * Test A — 突发容量：高限额对比令牌桶低延迟优势
 * Test B — 窗口边界攻击：autocannon 两轮短压测模拟，暴露固定窗口缺陷
 * Test C — 极限负载参考：标准参数三算法综合对比
 *
 * 用法：node scripts/benchmark.js
 * 前置：node src/app.js 已启动
 */

import autocannon from 'autocannon';
import http from 'http';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);

const API = 'http://localhost:8080';
const PATH = '/api/users';

// ==================== 工具函数 ====================

function sleep(sec) { return new Promise(r => setTimeout(r, sec * 1000)); }

async function apiPost(path, body) {
    const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

async function setConfig(algo, maxReq, windowMs) {
    await apiPost('/api/admin/rate-limits', {
        path: PATH, method: 'GET', maxRequests: maxReq, windowMs, algorithm: algo
    });
    console.log('  配置: ' + algo + ' ' + maxReq + '次/' + (windowMs / 1000) + 's');
}

function runAc(label, conn, dur) {
    return new Promise((resolve, reject) => {
        const inst = autocannon({
            url: `${API}${PATH}`,
            connections: conn,
            duration: dur,
            timeout: 10
        }, (err, r) => err ? reject(err) : resolve(r));
        autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false });
        process.stdout.write('  ' + label + '...');
        inst.on('done', () => console.log(' done'));
    });
}

function httpGet() {
    return new Promise(resolve => {
        http.get(`${API}${PATH}`, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); })
            .on('error', () => resolve(0));
    });
}

function pad(s, n) { return String(s).padStart(n); }

function printRow(cols, widths) {
    let line = '  ';
    for (let i = 0; i < cols.length; i++) {
        line += pad(String(cols[i]), widths[i]) + ' | ';
    }
    console.log(line.replace(/\| $/, ''));
}

function printSep(widths) {
    let line = '  ';
    for (let i = 0; i < widths.length; i++) {
        line += '-'.repeat(widths[i]) + '-+-';
    }
    console.log(line.replace(/-$/, ''));
}

// ==================== Test A: 突发容量 ====================

async function testA() {
    console.log('');
    console.log('═══ Test A: 突发容量（10000次/10s, 200并发, 5s）═══');

    const algos = ['fixed-window', 'sliding-window', 'token-bucket'];
    const labels = ['固定窗口', '滑动窗口', '令牌桶'];
    const rows = [];

    for (let i = 0; i < algos.length; i++) {
        console.log('');
        console.log('  [' + labels[i] + ']');
        await setConfig(algos[i], 10000, 10000);
        await sleep(2);

        const r = await runAc(labels[i], 200, 5);
        const total = r.requests.total;
        const s2xx = r['2xx'] || 0;
        const s429 = r['4xx'] || 0;
        rows.push({
            label: labels[i],
            total,
            ok: s2xx,
            reject: s429,
            qps: Math.round(r.requests.average),
            avg: (r.latency.average).toFixed(2),
            p99: (r.latency.p99).toFixed(2)
        });
    }

    console.log('');
    const w = [12, 10, 8, 8, 8, 10, 10];
    printRow(['算法', '总请求', '2xx', '429', 'QPS', '平均ms', 'P99ms'], w);
    printSep(w);
    for (const r of rows) {
        printRow([r.label, r.total, r.ok, r.reject, r.qps, r.avg, r.p99], w);
    }
    console.log('  令牌桶无需维护时间戳数组 → 内存和 CPU 最优');
    return rows;
}

// ==================== Test B: 窗口边界攻击 ====================

async function testB() {
    console.log('');
    console.log('═══ Test B: 窗口边界攻击（100次/10s）═══');
    console.log('  原理：在10s窗口末尾和开头各压一轮，固定窗口两轮都大量放行');

    const configs = [
        { algo: 'fixed-window',   label: '固定窗口' },
        { algo: 'sliding-window', label: '滑动窗口' }
    ];
    const rows = [];

    for (const cfg of configs) {
        console.log('');
        console.log('  [' + cfg.label + ']');
        await setConfig(cfg.algo, 100, 10000);
        await sleep(2);

        // 初始化窗口：发一个请求作为时间起点
        await httpGet();
        console.log('  窗口已初始化，等待 9.5s 接近窗口末尾...');
        await sleep(9.5);

        // 第一轮 autocannon：窗口末尾 → 跨越边界
        // 50 并发 × 2 秒 = 足够在边界两侧产生大量请求
        console.log('  第一轮压测（窗口末尾→跨越边界）...');
        const r1 = await runAc('burst-1 50c/2s', 50, 2);

        const b1ok = r1['2xx'] || 0;
        const b1lim = r1['4xx'] || 0;
        console.log('    第一轮: 2xx=' + b1ok + '  429=' + b1lim);

        // 短暂暂停，确保在新窗口内
        await sleep(1);

        // 第二轮 autocannon：新窗口开头
        console.log('  第二轮压测（新窗口开头）...');
        const r2 = await runAc('burst-2 50c/2s', 50, 2);

        const b2ok = r2['2xx'] || 0;
        const b2lim = r2['4xx'] || 0;
        console.log('    第二轮: 2xx=' + b2ok + '  429=' + b2lim);

        const totalOk = b1ok + b2ok;
        console.log('  两轮合计放行: ' + totalOk + '（限额100次/10s）');

        rows.push({
            label: cfg.label,
            b1ok, b1lim, b2ok, b2lim,
            totalOk,
            verdict: cfg.algo === 'fixed-window'
                ? (totalOk > 150 ? '边界漏洞 ✗' : '正常')
                : (totalOk > 150 ? '异常' : '平滑限流 ✓')
        });

        await sleep(2);
    }

    console.log('');
    const w2 = [12, 12, 12, 12, 12, 16];
    printRow(['算法', '第一轮2xx', '第一轮429', '第二轮2xx', '第二轮429', '合计放行'], w2);
    printSep(w2);
    for (const r of rows) {
        printRow([r.label, r.b1ok, r.b1lim, r.b2ok, r.b2lim, r.totalOk + ' ' + r.verdict], w2);
    }
    console.log('  结论：固定窗口在边界两侧各能放行一批 → 实际限定失效');
    console.log('        滑动窗口任何时刻窗口内请求数不超限额 → 精确控流');
    return rows;
}

// ==================== Test C: 极限负载参考 ====================

async function testC() {
    console.log('');
    console.log('═══ Test C: 极限负载参考（100次/10s, 100并发, 10s）═══');

    const algos = ['fixed-window', 'sliding-window', 'token-bucket'];
    const labels = ['固定窗口', '滑动窗口', '令牌桶'];
    const rows = [];

    for (let i = 0; i < algos.length; i++) {
        console.log('');
        console.log('  [' + labels[i] + ']');
        await setConfig(algos[i], 100, 10000);
        await sleep(2);

        const r = await runAc(labels[i], 100, 10);
        const total = r.requests.total;
        const s2xx = r['2xx'] || 0;
        const s429 = r['4xx'] || 0;
        rows.push({
            label: labels[i],
            total,
            ok: s2xx,
            reject: s429,
            rejectPct: total > 0 ? (s429 / total * 100).toFixed(1) + '%' : '0%',
            qps: Math.round(r.requests.average),
            avg: (r.latency.average).toFixed(2),
            p99: (r.latency.p99).toFixed(2)
        });
        await sleep(2);
    }

    console.log('');
    const w = [12, 10, 8, 8, 7, 8, 10, 10];
    printRow(['算法', '总请求', '2xx', '429', '429%', 'QPS', '平均ms', 'P99ms'], w);
    printSep(w);
    for (const r of rows) {
        printRow([r.label, r.total, r.ok, r.reject, r.rejectPct, r.qps, r.avg, r.p99], w);
    }
    console.log('  固定窗口：窗口开头集中放行→末尾集中拒绝 → 429率最高');
    console.log('  滑动窗口：持续平滑限流 → 429均匀分布、延迟稳定');
    console.log('  令牌桶  ：允许突发，桶空后按速率放行 → 折中方案');
    return rows;
}

// ==================== 主流程 ====================

async function main() {
    console.log('═══════════════════════════════════════');
    console.log('  API 网关限流算法压测');
    console.log('  目标: ' + API + PATH);
    console.log('═══════════════════════════════════════');

    // 启动诊断
    console.log('\n--- 启动诊断 ---');
    try {
        const statsRes = await fetch(API + '/api/stats');
        const stats = await statsRes.json();
        console.log('  /api/stats → total=' + stats.totalRequests + ' qps=' + stats.qps);

        const anomRes = await fetch(API + '/api/anomalies');
        const anom = await anomRes.json();
        console.log('  /api/anomalies → status=' + anom.currentStatus +
            ' baseline=' + JSON.stringify(anom.baseline) +
            ' events=' + (anom.recentEvents ? anom.recentEvents.length : 0));
    } catch (e) {
        console.error('  服务器不可达，请先运行 node src/app.js');
        console.error('  ' + e.message);
        process.exit(1);
    }

    // 依次运行三项测试，互不阻断
    const results = {};

    try { results.A = await testA(); }
    catch (e) { console.error('Test A 失败:', e.message, e.stack); }

    try { results.B = await testB(); }
    catch (e) { console.error('Test B 失败:', e.message, e.stack); }

    try { results.C = await testC(); }
    catch (e) { console.error('Test C 失败:', e.message, e.stack); }

    // 恢复默认
    console.log('\n恢复默认配置...');
    await apiPost('/api/admin/rate-limits', {
        path: PATH, method: 'GET',
        maxRequests: 200, windowMs: 60000, algorithm: 'sliding-window'
    });
    console.log('压测完成。');
}

if (process.argv[1] === __filename) {
    main().catch(err => {
        console.error('压测致命错误:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
}
