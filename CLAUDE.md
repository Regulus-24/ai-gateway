# API网关智能管理平台 - 项目上下文

## 当前技术栈
- Node.js 18+，ES模块（"type": "module"）
- Express 5.2.x（注意：不是 Express 4）
- better-sqlite3（同步驱动）
- Chart.js 4.4.x（CDN，仪表盘图表）
- autocannon 8.x（devDependency，压测）

## 启动方式
```bash
node src/app.js          # 服务器 → http://localhost:8080
node scripts/benchmark.js     # 压测（需服务器已启动）
node scripts/test-anomaly.js  # 异常检测验证（需服务器已启动）
```

## 项目结构
```
src/
├── middleware/
│   ├── rate-limiter.js          # 固定窗口（独立使用）
│   ├── sliding-window.js        # 滑动窗口（独立使用）
│   ├── token-bucket.js          # 令牌桶（独立使用）
│   └── dispatcher.js            # 算法分发器（主入口，替换三个独立中间件）
│       ├── exports refreshConfigCache()    # 供 admin API 强制刷新
│       ├── exports algorithmDispatcher()   # Express 中间件工厂
│       └── 内部三个算法函数：applyFixedWindow / applySlidingWindow / applyTokenBucket
├── db/
│   ├── init.js                  # 建表 + WAL模式
│   ├── config-repo.js           # ConfigRepository 类（预编译语句）
│   ├── seed.js                  # users/products 测试数据
│   └── seed-config.js           # 4条限流默认配置
├── admin/
│   └── routes.js                # 管理API（每次变更后调 refreshConfigCache()）
├── routes/
│   └── stats.js                 # 统计 + 异常检测API
│       ├── exports recordAccess(path, passed)  # 请求埋点
│       ├── exports computeQps(windowMs)         # QPS计算（返回浮点，非整数）
│       ├── GET /api/stats
│       ├── GET /api/anomalies
│       └── POST /api/anomalies/reset
├── ml/
│   └── anomaly-detector.js      # 异常检测核心
│       ├── exports initAnomalyDetector(getQpsFn)
│       ├── exports getAnomalyEvents() / getBaseline() / getCurrentStatus()
│       └── exports reset()
└── app.js                       # 主入口
web/
└── index.html                   # 仪表盘（4卡片 + QPS折线 + 异常事件表 + 配置表）
scripts/
├── benchmark.js                 # 三算法压测：Test A突发 / Test B边界攻击 / Test C负载
└── test-anomaly.js              # 异常检测验证：Phase1基线 / Phase2 spike / Phase3 drop
docs/
└── benchmark-report.md          # 压测报告（含算法适用场景建议）
```

## 所有 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | / | 仪表盘（web/index.html） |
| GET | /api/users | 用户列表 |
| GET | /api/users/:id | 单个用户 |
| GET | /api/stats | 统计：totalRequests, rejectedRequests, qps, qpsHistory[60], apiDistribution |
| GET | /api/anomalies | 异常：baseline{mean,stdDev,sampleSize}, recentEvents[], currentStatus |
| POST | /api/anomalies/reset | 重置异常检测学习期 |
| GET | /api/admin/rate-limits | 所有限流配置（仅 enabled=1） |
| POST | /api/admin/rate-limits | 新增/更新配置（body: path, method, maxRequests, windowMs, algorithm） |
| PATCH | /api/admin/rate-limits/toggle | 切换启停或算法（body: path, method, enabled?, algorithm?） |
| DELETE | /api/admin/rate-limits | 删除配置（body: path, method） |

## 中间件加载顺序（app.js）

```
express.json() → express.static('web') → algorithmDispatcher() → adminRouter → statsRouter → 业务路由
```

注意：admin 和 stats API 也会经过 algorithmDispatcher 限流。静态文件在白名单之前，不受限流影响。

## 数据库表

```sql
rate_limit_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_path TEXT NOT NULL,          -- '*' 表示通配
    route_method TEXT DEFAULT 'GET',
    max_requests INTEGER NOT NULL,     -- 窗口内最大请求数 / 令牌桶 capacity
    window_ms INTEGER NOT NULL,        -- 时间窗口毫秒
    algorithm TEXT DEFAULT 'sliding-window',  -- fixed-window | sliding-window | token-bucket
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

## 异常检测数据流（关键！曾出过bug）

```
请求到达
  → dispatcher.js: recordAccess(req.path, true/false)
  → stats.js: recentTimestamps.push(Date.now())
  → anomaly-detector.js setInterval(5s): getQpsFn() → computeQps(5000)
  → stats.js: 遍历 recentTimestamps 数最近5秒内的条数 / 5 = 平均QPS（浮点数）
  → anomaly-detector.js: qpsHistory.push({time, qps})
  → 学习期30s + 最少5样本 → 计算 mean/stdDev → |当前QPS - mean| > 2σ → 异常
```

注意事项：
- computeQps 返回**浮点数**（曾经 Math.round() 导致低QPS全变成0）
- 学习期30秒，最少5个样本（5×5s=25s），所以启动后**约55秒**才开始检测
- QPS是最近5秒的平均值，不是瞬时值
- 服务器重启后异常检测器的历史数据全部丢失

## 已有诊断日志

- `[computeQps]` — stats.js 每次调用打印：窗口大小、时间戳总数、窗口内计数、QPS
- `[异常检测采样]` — anomaly-detector.js 每次采样打印：QPS、启动时长、历史长度
- `[异常检测]` — 学习期/样本不足/基线计算/偏离值/异常检测/状态恢复 全部打印

## 代码规范
- 文件命名：kebab-case
- 变量/函数：camelCase
- 数据库字段：snake_case
- 每个模块导出函数或类，不导出单例
- 从config对象取值时用 config.field_name，不做解构
- JavaScript 字符串格式化用 toFixed(2) 和模板字符串，**不能用** printf 风格的 %.2f
- 脚本文件用 `if (process.argv[1] === __filename)` 守卫，防止 import 时自动执行
