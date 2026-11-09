const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
const PORT = process.env.PORT || 3000;

const API_ID = 32502099;
const API_HASH = "3fa8973b6667b46079478646dc1f10e2";

const ADMIN_PASSWORD = "gagajka3300"; 
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'p1xly_super_secret_key',
    resave: false,
    saveUninitialized: false
}));

const db = new sqlite3.Database('./database.sqlite');
const pendingLogins = {};

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, title TEXT, url TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS promocodes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, days INTEGER, uses_left INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (user_id TEXT PRIMARY KEY, expires_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, ip TEXT, device TEXT, action TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS bots (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, category TEXT, description TEXT, link TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS tabs (id TEXT PRIMARY KEY, name TEXT, title TEXT, is_enabled INTEGER DEFAULT 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS scammers (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, reason TEXT, proof TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, session TEXT)`);

    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('bio', 'для покупки промокода @zxc_micc')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('app_title', 'P1xly Dashboard')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('launcher_title', '🚀 P1xly System')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('launcher_desc', 'Центр управления автоматизацией и сервисами')`);
    db.run(`INSERT OR IGNORE INTO promocodes (code, days, uses_left) VALUES ('BRO2026', 7, 10)`);

    const defaultTabs = [
        ['catalog', 'Каталог', 'Доступные модули', 1],
        ['sender', 'Отправка (MTProto)', 'Мульти-аккаунт отправка', 1],
        ['scammers', 'База скамеров', 'Черный список / Скамеры', 1],
        ['owner', 'О владельце', 'Информация о владельце', 1],
        ['sub', 'Подписка', 'Активация подписки', 1]
    ];
    defaultTabs.forEach(t => {
        db.run(`INSERT OR IGNORE INTO tabs (id, name, title, is_enabled) VALUES (?, ?, ?, ?)`, t);
    });
});

const isAuth = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.status(401).json({ error: 'Необходима авторизация' });
};

// Функция записи логов
function logActivity(userId, req, action) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const device = req.headers['user-agent'] || 'Unknown Device';
    db.run(`INSERT INTO activity_logs (user_id, ip, device, action) VALUES (?, ?, ?, ?)`, [userId || 'guest', ip, device, action]);
}

app.get('/ping', (req, res) => res.status(200).send('Alive'));

app.get('/api/check-auth', (req, res) => {
    res.json({ isAdmin: !!req.session.isAdmin });
});

app.get('/api/data', (req, res) => {
    db.all(`SELECT key, value FROM settings`, (err, settingsRows) => {
        let settings = {};
        if (settingsRows) settingsRows.forEach(r => settings[r.key] = r.value);

        db.all(`SELECT * FROM tabs`, (err, tabs) => {
            db.all(`SELECT * FROM links`, (err, links) => {
                db.all(`SELECT * FROM bots`, (err, bots) => {
                    db.all(`SELECT * FROM scammers`, (err, scammers) => {
                        db.all(`SELECT id, name FROM accounts`, (err, accounts) => {
                            db.all(`SELECT * FROM promocodes`, (err, promocodes) => {
                                db.all(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT 50`, (err, logs) => {
                                    res.json({
                                        settings,
                                        tabs: tabs || [],
                                        links: links || [],
                                        bots: bots || [],
                                        scammers: scammers || [],
                                        accounts: accounts || [],
                                        promocodes: promocodes || [],
                                        logs: logs || []
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/check-sub', (req, res) => {
    const { userId } = req.body;
    logActivity(userId, req, 'Зашел на сайт / проверка сессии');

    db.get(`SELECT expires_at FROM subscriptions WHERE user_id = ?`, [userId], (err, row) => {
        const active = row && new Date(row.expires_at) > new Date();
        db.all(`SELECT id, name FROM accounts`, (err, accounts) => {
            res.json({ active, accounts: accounts || [] });
        });
    });
});

app.post('/api/activate-promo', (req, res) => {
    const { userId, code } = req.body;
    db.get(`SELECT * FROM promocodes WHERE code = ?`, [code], (err, promo) => {
        if (!promo || promo.uses_left <= 0) return res.status(400).json({ success: false, message: 'Неверный или исчерпанный промокод' });

        db.get(`SELECT expires_at FROM subscriptions WHERE user_id = ?`, [userId], (err, sub) => {
            let now = new Date();
            let currentExpiry = sub && new Date(sub.expires_at) > now ? new Date(sub.expires_at) : now;
            currentExpiry.setDate(currentExpiry.getDate() + promo.days);

            db.run(`INSERT OR REPLACE INTO subscriptions (user_id, expires_at) VALUES (?, ?)`, [userId, currentExpiry.toISOString()], () => {
                db.run(`UPDATE promocodes SET uses_left = uses_left - 1 WHERE id = ?`, [promo.id], () => {
                    logActivity(userId, req, `Активировал промокод: ${code}`);
                    res.json({ success: true, message: `Подписка активирована до ${currentExpiry.toLocaleDateString()}` });
                });
            });
        });
    });
});

app.post('/api/tg/send', async (req, res) => {
    const { userId, accountId, recipient, message } = req.body;

    db.get(`SELECT expires_at FROM subscriptions WHERE user_id = ?`, [userId], async (err, row) => {
        if (!row || new Date(row.expires_at) <= new Date()) {
            return res.status(403).json({ success: false, message: 'Нет активной подписки!' });
        }

        db.get(`SELECT * FROM accounts WHERE id = ?`, [accountId], async (err, account) => {
            if (!account) return res.status(400).json({ success: false, message: 'Аккаунт не найден!' });

            try {
                const client = new TelegramClient(new StringSession(account.session), API_ID, API_HASH, { connectionRetries: 3 });
                await client.connect();
                await client.sendMessage(recipient, { message });
                logActivity(userId, req, `Отправил сообщение через ${account.name} пользователю ${recipient}`);
                res.json({ success: true, message: `Успешно отправлено с аккаунта: ${account.name}` });
            } catch (e) {
                res.status(400).json({ success: false, message: 'Telegram API Error: ' + e.message });
            }
        });
    });
});

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (bcrypt.compareSync(password, ADMIN_HASH)) {
        req.session.isAdmin = true;
        logActivity('ADMIN', req, 'Успешный вход в админ-панель');
        res.json({ success: true });
    } else {
        logActivity('ANONYMOUS', req, 'Неудачная попытка входа в админку (неверный пароль)');
        res.status(400).json({ error: 'Неверный пароль' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// Админские ручки
app.post('/api/admin/settings', isAuth, (req, res) => {
    const { key, value } = req.body;
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value], () => res.json({ success: true }));
});

app.post('/api/admin/tabs', isAuth, (req, res) => {
    const { id, name, title, is_enabled } = req.body;
    db.run(`UPDATE tabs SET name = ?, title = ?, is_enabled = ? WHERE id = ?`, [name, title, is_enabled, id], () => res.json({ success: true }));
});

app.post('/api/admin/promocodes', isAuth, (req, res) => {
    const { code, days, uses } = req.body;
    db.run(`INSERT INTO promocodes (code, days, uses_left) VALUES (?, ?, ?)`, [code, days, uses], () => res.json({ success: true }));
});

app.delete('/api/admin/promocodes/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM promocodes WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/admin/auth/send-code', isAuth, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Введите номер телефона' });

    try {
        const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 3 });
        await client.connect();
        
        const { phoneCodeHash } = await client.sendCode({
            apiId: API_ID,
            apiHash: API_HASH,
        }, phone, false);

        const sessionId = 'session_' + Date.now();
        pendingLogins[sessionId] = { client, phone, phoneCodeHash };

        res.json({ success: true, sessionId, message: 'Код отправлен в Telegram!' });
    } catch (e) {
        res.status(400).json({ success: false, message: 'Ошибка: ' + e.message });
    }
});

app.post('/api/admin/auth/verify-code', isAuth, async (req, res) => {
    const { sessionId, code, password } = req.body;
    const loginData = pendingLogins[sessionId];

    if (!loginData) return res.status(400).json({ success: false, message: 'Сессия устарела.' });

    try {
        const { client, phone } = loginData;
        
        await client.start({
            phoneNumber: async () => phone,
            phoneCode: async () => code,
            password: async () => password || '',
            onError: (err) => { throw err; },
        });

        const stringSession = client.session.save();
        const me = await client.getMe();
        const accountName = `${me.firstName || ''} ${me.lastName || ''} (@${me.username || phone})`.trim();

        db.run(`INSERT INTO accounts (name, session) VALUES (?, ?)`, [accountName, stringSession], function() {
            delete pendingLogins[sessionId];
            res.json({ success: true, message: `Аккаунт ${accountName} успешно добавлен!` });
        });
    } catch (e) {
        res.status(400).json({ success: false, message: 'Ошибка авторизации: ' + e.message });
    }
});

app.delete('/api/admin/accounts/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM accounts WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/admin/bots', isAuth, (req, res) => {
    db.run(`INSERT INTO bots (title, category, description, link) VALUES (?, ?, ?, ?)`, [req.body.title, req.body.category, req.body.description, req.body.link], () => res.json({ success: true }));
});

app.delete('/api/admin/bots/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM bots WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/admin/scammers', isAuth, (req, res) => {
    db.run(`INSERT INTO scammers (username, reason, proof) VALUES (?, ?, ?)`, [req.body.username, req.body.reason, req.body.proof], () => res.json({ success: true }));
});

app.delete('/api/admin/scammers/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM scammers WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/admin/links', isAuth, (req, res) => {
    db.run(`INSERT INTO links (category, title, url) VALUES (?, ?, ?)`, [req.body.category, req.body.title, req.body.url], () => res.json({ success: true }));
});

app.delete('/api/admin/links/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM links WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
