import db from './init.js';

console.log('开始插入测试数据...');

// 预编译插入语句（SQL解析一次，多次使用）
const insertUser = db.prepare(
    'INSERT INTO users (name, role) VALUES (?, ?)'
);

const insertProduct = db.prepare(
    'INSERT INTO products (name, price) VALUES (?, ?)'
);

// 使用事务批量插入（要么全成功，要么全失败）
const seedData = db.transaction(() => {
    // 先清空旧数据
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM products');
    
    // 插入用户数据
    insertUser.run('张三', 'admin');
    insertUser.run('李四', 'user');
    insertUser.run('王五', 'user');
    
    // 插入商品数据
    insertProduct.run('商品A', 99);
    insertProduct.run('商品B', 199);
    
    console.log('数据插入完成');
});

// 执行事务
seedData();

// 验证：查询并打印所有用户
const allUsers = db.prepare('SELECT * FROM users').all();
console.log('当前数据库中的用户：', allUsers);

// 插入IP黑白名单测试数据
const insertIpRule = db.prepare(
    'INSERT OR IGNORE INTO ip_rules (ip, action, note) VALUES (?, ?, ?)'
);
insertIpRule.run('192.168.1.100', 'deny', '测试封禁IP');
console.log('测试IP规则已添加（deny 192.168.1.100），可自行删除');