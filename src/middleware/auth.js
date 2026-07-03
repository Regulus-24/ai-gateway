import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'gateway-secret-key';
const TOKEN_EXPIRY = '24h';

const USERS = {
    admin: 'admin123',
};

/**
 * 登录验证中间件 — 处理 POST /api/admin/login
 */
export function loginAuth(req, res, next) {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '缺少用户名或密码' });
    }

    if (USERS[username] && USERS[username] === password) {
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
        return res.json({ token, expiresIn: '24h' });
    }

    return res.status(401).json({ error: '用户名或密码错误' });
}

/**
 * Token 验证中间件 — 保护管理API
 */
export function tokenAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未授权访问' });
    }

    const token = authHeader.slice(7);

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: '未授权访问' });
    }
}
