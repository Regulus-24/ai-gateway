import db from './init.js';

const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO ip_rules (ip, action, note) VALUES (@ip, @action, @note)'
);
const allStmt = db.prepare('SELECT * FROM ip_rules ORDER BY created_at DESC');
const checkStmt = db.prepare(
    'SELECT * FROM ip_rules WHERE ip = @ip AND action = @action LIMIT 1'
);
const deleteStmt = db.prepare('DELETE FROM ip_rules WHERE id = ?');

export function addRule({ ip, action, note = '' }) {
    insertStmt.run({ ip, action, note });
    return allStmt.all();
}

export function removeRule(id) {
    deleteStmt.run(id);
    return allStmt.all();
}

export function getAllRules() {
    return allStmt.all();
}

export function checkIp(ip) {
    // 优先检查 deny
    const deny = checkStmt.get({ ip, action: 'deny' });
    if (deny) return deny;
    const allow = checkStmt.get({ ip, action: 'allow' });
    if (allow) return allow;
    return null;
}
