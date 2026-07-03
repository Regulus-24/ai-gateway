import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetAllConfigs } = vi.hoisted(() => ({
    mockGetAllConfigs: vi.fn(),
}));

vi.mock('../../src/db/config-repo.js', () => ({
    ConfigRepository: vi.fn(function () {
        this.getAllConfigs = mockGetAllConfigs;
    }),
}));

import { tokenBucketLimiter, ipBuckets } from '../../src/middleware/token-bucket.js';

function mockReq(ip, path = '/api/test') {
    return { ip, path, method: 'GET' };
}

function mockRes() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
}

const BASE_CONFIG = {
    route_path: '/api/test',
    route_method: 'GET',
    max_requests: 10,      // capacity = 10
    window_ms: 10000,       // 10s → fillRate = 1 token/sec
    algorithm: 'token-bucket',
    enabled: 1,
};

describe('token-bucket 令牌桶', () => {
    let middleware;
    let req;
    let res;
    let next;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        ipBuckets.clear();
        mockGetAllConfigs.mockReturnValue([BASE_CONFIG]);
        middleware = tokenBucketLimiter();
        req = mockReq('127.0.0.1');
        res = mockRes();
        next = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('正常消费：有令牌时放行', () => {
        it('令牌充足时应放行所有请求', () => {
            for (let i = 0; i < 10; i++) {
                middleware(req, res, next);
            }
            expect(next).toHaveBeenCalledTimes(10);
            expect(res.status).not.toHaveBeenCalled();
        });
    });

    describe('限流拒绝：无令牌时返回429', () => {
        it('令牌耗尽后应返回429', () => {
            for (let i = 0; i < 10; i++) {
                middleware(req, res, next);
            }
            middleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(10);
            expect(res.status).toHaveBeenCalledWith(429);
        });
    });

    describe('令牌补充：等待后令牌自动恢复', () => {
        it('等待足够时间后应恢复令牌', () => {
            // 耗尽令牌
            for (let i = 0; i < 10; i++) {
                middleware(req, res, next);
            }
            // 确认无令牌
            middleware(req, res, next);
            expect(res.status).toHaveBeenCalledWith(429);

            // 等待3秒 → 恢复3个令牌（fillRate=1/sec）
            vi.advanceTimersByTime(3000);

            const res2 = mockRes();
            const next2 = vi.fn();

            for (let i = 0; i < 3; i++) {
                middleware(req, res2, next2);
            }
            expect(next2).toHaveBeenCalledTimes(3);

            // 第4个应被拒（只有3个令牌恢复）
            middleware(req, res2, next2);
            expect(res2.status).toHaveBeenCalledWith(429);
        });
    });

    describe('突发流量：桶满时可以瞬间消耗所有令牌', () => {
        it('应允许瞬间消耗全部容量', () => {
            for (let i = 0; i < 10; i++) {
                middleware(req, res, next);
            }
            expect(next).toHaveBeenCalledTimes(10);
        });
    });

    describe('填充速率：等待时间精确对应恢复令牌数', () => {
        it('填充速率应精确', () => {
            // 容量5, 窗口5s → fillRate=1/sec
            const config = {
                ...BASE_CONFIG,
                max_requests: 5,
                window_ms: 5000,
            };
            mockGetAllConfigs.mockReturnValue([config]);
            const mw = tokenBucketLimiter();
            const r = mockReq('10.0.0.10', '/api/test');
            const s = mockRes();
            const n = vi.fn();

            // 消耗5个令牌
            for (let i = 0; i < 5; i++) {
                mw(r, s, n);
            }
            expect(n).toHaveBeenCalledTimes(5);

            // 等待2秒 → 恢复2个令牌
            vi.advanceTimersByTime(2000);

            const s2 = mockRes();
            const n2 = vi.fn();

            mw(r, s2, n2);
            mw(r, s2, n2);
            expect(n2).toHaveBeenCalledTimes(2);

            // 第3个应被拒
            mw(r, s2, n2);
            expect(s2.status).toHaveBeenCalledWith(429);
        });
    });

    describe('容量上限：令牌数不超过capacity', () => {
        it('长时间等待后令牌不应超过capacity', () => {
            // 容量5, 填充率5/sec → 长时间等待后最多5个令牌
            const config = {
                ...BASE_CONFIG,
                max_requests: 5,
                window_ms: 1000,
            };
            mockGetAllConfigs.mockReturnValue([config]);
            const mw = tokenBucketLimiter();
            const r = mockReq('10.0.0.20', '/api/test');
            const s = mockRes();
            const n = vi.fn();

            // 消耗所有令牌
            for (let i = 0; i < 5; i++) {
                mw(r, s, n);
            }

            // 等待10秒（远超过填充满所需时间）
            vi.advanceTimersByTime(10000);

            const s2 = mockRes();
            const n2 = vi.fn();

            // 应最多放行5个
            for (let i = 0; i < 5; i++) {
                mw(r, s2, n2);
            }
            expect(n2).toHaveBeenCalledTimes(5);

            // 第6个应被拒
            mw(r, s2, n2);
            expect(s2.status).toHaveBeenCalledWith(429);
        });
    });

    describe('不同IP独立桶', () => {
        it('IP1令牌耗尽不影响IP2', () => {
            const req1 = mockReq('1.1.1.1');
            const req2 = mockReq('2.2.2.2');
            const res1 = mockRes();
            const res2 = mockRes();
            const next1 = vi.fn();
            const next2 = vi.fn();

            // IP1 耗尽令牌
            for (let i = 0; i < 10; i++) {
                middleware(req1, res1, next1);
            }
            middleware(req1, res1, next1);
            expect(res1.status).toHaveBeenCalledWith(429);

            // IP2 应有满令牌
            middleware(req2, res2, next2);
            expect(next2).toHaveBeenCalledTimes(1);
            expect(res2.status).not.toHaveBeenCalledWith(429);
        });
    });
});
