import db from './init.js';

const insertStmt = db.prepare(
    `INSERT INTO api_logs (route_path, route_method, ip, status_code, algorithm)
     VALUES (@path, @method, @ip, @status, @algorithm)`
);

const selectStmt = db.prepare(
    `SELECT * FROM api_logs
     WHERE (? IS NULL OR created_at >= datetime('now', '-' || ? || ' hours'))
       AND (? IS NULL OR status_code = ?)
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
);

const countStmt = db.prepare(
    `SELECT COUNT(*) as total FROM api_logs
     WHERE (? IS NULL OR created_at >= datetime('now', '-' || ? || ' hours'))
       AND (? IS NULL OR status_code = ?)`
);

const distStmt = db.prepare(
    `SELECT route_path, route_method, COUNT(*) as count
     FROM api_logs
     WHERE created_at >= datetime('now', '-' || ? || ' hours')
     GROUP BY route_path, route_method
     ORDER BY count DESC`
);

export function insertLog(path, method, ip, statusCode, algorithm) {
    insertStmt.run({
        path, method, ip,
        status: statusCode,
        algorithm: algorithm || null
    });
}

export function getLogs({ hours = null, status = null, limit = 100, offset = 0 } = {}) {
    const statusInt = status !== null ? parseInt(status, 10) : null;
    const hoursStr = hours !== null ? String(hours) : null;

    const rows = selectStmt.all(
        hoursStr, hoursStr,
        statusInt, statusInt,
        limit, offset
    );
    const { total } = countStmt.get(
        hoursStr, hoursStr,
        statusInt, statusInt
    );
    return { total, rows };
}

export function getPathDistribution(hours = 1) {
    const rows = distStmt.all(String(hours));
    return rows;
}
