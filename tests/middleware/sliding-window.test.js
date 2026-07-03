import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetAllConfigs } = vi.hoisted(() => ({
    mockGetAllConfigs: vi.fn(),
}));

vi.mock('../../src/db/config-repo.js', () => ({
    ConfigRepository: vi.fn(function () {
        this.getAllConfigs = mockGetAllConfigs;
    }),
}));

import { slidingWindowLimiter, ipTimestamps } from '../../src/middleware/sliding-window.js';

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
    max_requests: 3,
    window_ms: 10000,
    algorithm: 'sliding-window',
    enabled: 1,
};

describe('sliding-window 滑动窗口', () => {
    let middleware;
    let req;
    let res;
    let next;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        ipTimestamps.clear();
        mockGetAllConfigs.mockReturnValue([BASE_CONFIG]);
        middleware = slidingWindowLimiter();
        req = mockReq('127.0.0.1');
        res = mockRes();
        next = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('正常通过：窗口内请求数未达限额', () => {
        it('限额内应放行', () => {
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
        });

        it('不放行未匹配路由', () => {
            const noMatch = mockReq('10.0.0.1', '/no-config');
            const resNoMatch = mockRes();
            const nextNoMatch = vi.fn();

            middleware(noMatch, resNoMatch, nextNoMatch);
            expect(nextNoMatch).toHaveBeenCalled();
            expect(resNoMatch.status).not.toHaveBeenCalled();
        });
    });

    describe('窗口滑动：旧请求过期后释放额度', () => {
        it('所有旧请求过期后应恢复满额', () => {
            // 发送3个请求耗尽限额
            for (let i = 0; i < 3; i++) {
                middleware(req, res, next);
            }
            // 确认被限
            middleware(req, res, next);
            expect(res.status).toHaveBeenCalledWith(429);

            // 时间推进，所有旧请求过期
            vi.advanceTimersByTime(10001);
            const res2 = mockRes();
            const next2 = vi.fn();

            for (let i = 0; i < 3; i++) {
                middleware(req, res2, next2);
            }
            expect(next2).toHaveBeenCalledTimes(3);
        });
    });

    describe('精密边界：区别于固定窗口的滑动语义', () => {
        it('窗口末尾+开头各发一批不会双倍通过', () => {
            const configPath = '/api/burst';
            const config = {
                ...BASE_CONFIG,
                route_path: configPath,
                max_requests: 3,
                window_ms: 2000,
            };
            mockGetAllConfigs.mockReturnValue([config]);
            const mw = slidingWindowLimiter();
            const r = mockReq('10.0.0.5', configPath);

            // T=0: 发2个
            const s1 = mockRes();
            const n1 = vi.fn();
            mw(r, s1, n1);
            mw(r, s1, n1);
            expect(n1).toHaveBeenCalledTimes(2);

            // T=1500ms: 窗口未过期，前2个还在窗口内
            vi.advanceTimersByTime(1500);
            const s2 = mockRes();
            const n2 = vi.fn();

            // 第3个请求应通过（刚好3个在窗口内）
            mw(r, s2, n2);
            expect(n2).toHaveBeenCalledTimes(1);

            // 第4个请求应被拒（窗口内有3个，超过限额）
            mw(r, s2, n2);
            expect(s2.status).toHaveBeenCalledWith(429);
        });
    });

    describe('不同IP独立', () => {
        it('IP1被限不影响IP2', () => {
            const req1 = mockReq('1.1.1.1');
            const req2 = mockReq('2.2.2.2');
            const res1 = mockRes();
            const res2 = mockRes();
            const next1 = vi.fn();
            const next2 = vi.fn();

            // IP1 耗尽
            for (let i = 0; i < 3; i++) {
                middleware(req1, res1, next1);
            }
            middleware(req1, res1, next1);
            expect(res1.status).toHaveBeenCalledWith(429);

            // IP2 正常
            middleware(req2, res2, next2);
            expect(next2).toHaveBeenCalledTimes(1);
            expect(res2.status).not.toHaveBeenCalledWith(429);
        });
    });

    describe('时间戳清理：过期时间戳被shift移除', () => {
        it('过期后数组长度应正确', () => {
            // 发3个请求
            for (let i = 0; i < 3; i++) {
                middleware(req, res, next);
            }
            expect(ipTimestamps.get('127.0.0.1').length).toBe(3);

            // 过期
            vi.advanceTimersByTime(10001);

            // 再发1个，触发清理
            const res2 = mockRes();
            const next2 = vi.fn();
            middleware(req, res2, next2);

            // 旧3个被清理，只剩新1个
            expect(ipTimestamps.get('127.0.0.1').length).toBe(1);
        });
    });
});
