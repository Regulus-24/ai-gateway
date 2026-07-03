import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rateLimiter, requestCounts } from '../../src/middleware/rate-limiter.js';

function mockReq(ip) {
    return { ip };
}

function mockRes() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
}

describe('rate-limiter 固定窗口', () => {
    let middleware;
    let req;
    let res;
    let next;

    beforeEach(() => {
        requestCounts.clear();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
        middleware = rateLimiter({ maxRequests: 3, windowMs: 10000 });
        req = mockReq('127.0.0.1');
        res = mockRes();
        next = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('正常通过：未达限额时放行', () => {
        it('应在限额内放行所有请求', () => {
            for (let i = 0; i < 3; i++) {
                middleware(req, res, next);
            }
            expect(next).toHaveBeenCalledTimes(3);
            expect(res.status).not.toHaveBeenCalled();
        });
    });

    describe('触发限流：超过限额返回429', () => {
        it('第4个请求应返回429', () => {
            for (let i = 0; i < 3; i++) {
                middleware(req, res, next);
            }
            middleware(req, res, next);

            expect(next).toHaveBeenCalledTimes(3);
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: '请求太频繁，请稍后再试' })
            );
        });
    });

    describe('窗口过期：新窗口计数器归零', () => {
        it('窗口过期后请求应重新放行', () => {
            // 先耗尽限额
            for (let i = 0; i < 3; i++) {
                middleware(req, res, next);
            }
            // 确认第4次被拒
            middleware(req, res, next);
            expect(res.status).toHaveBeenCalledWith(429);

            // 进入新窗口
            vi.advanceTimersByTime(10001);
            next.mockClear();
            const res2 = mockRes();

            for (let i = 0; i < 3; i++) {
                middleware(req, res2, next);
            }
            expect(next).toHaveBeenCalledTimes(3);
            expect(res2.status).not.toHaveBeenCalled();
        });
    });

    describe('不同IP独立计数', () => {
        it('IP1被限不应影响IP2', () => {
            const req1 = mockReq('1.1.1.1');
            const req2 = mockReq('2.2.2.2');
            const res1 = mockRes();
            const res2 = mockRes();
            const next1 = vi.fn();
            const next2 = vi.fn();

            // IP1 耗尽限额
            for (let i = 0; i < 3; i++) {
                middleware(req1, res1, next1);
            }
            // IP1 第4次被拒
            middleware(req1, res1, next1);
            expect(next1).toHaveBeenCalledTimes(3);
            expect(res1.status).toHaveBeenCalledWith(429);

            // IP2 应该正常通过
            middleware(req2, res2, next2);
            expect(next2).toHaveBeenCalledTimes(1);
            expect(res2.status).not.toHaveBeenCalled();
        });
    });

    describe('自定义参数：maxRequests和windowMs可配置', () => {
        it('应使用自定的限额和窗口', () => {
            const custom = rateLimiter({ maxRequests: 5, windowMs: 2000 });
            const r = mockReq('10.0.0.1');
            const s = mockRes();
            const n = vi.fn();

            for (let i = 0; i < 5; i++) {
                custom(r, s, n);
            }
            expect(n).toHaveBeenCalledTimes(5);

            custom(r, s, n);
            expect(s.status).toHaveBeenCalledWith(429);
        });
    });

    describe('窗口内精确计数：刚好maxRequests次通过，+1次拒绝', () => {
        it('边界计数应精确', () => {
            const precise = rateLimiter({ maxRequests: 2, windowMs: 5000 });
            const r = mockReq('10.0.0.2');
            const s = mockRes();
            const n = vi.fn();

            precise(r, s, n);
            precise(r, s, n);
            expect(n).toHaveBeenCalledTimes(2);

            precise(r, s, n);
            expect(s.status).toHaveBeenCalledWith(429);
        });
    });
});
