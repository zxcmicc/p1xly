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

const MASTER_ACCOUNTS = [
    { 
        id: 'acc_1', 
        name: 'pixly 1', 
        session: '1AQAOMTQ5LjE1NC4xNzUuNTQBu8NmatwI1BUYCCdqJwhJu13VDV4sb/xmET0blo+3QjtgRpECpf8U3WUqzN2/6qNGpRKt3wMraVWfddZ2PyOrUIUAxWYOXpa272NuPpdVEjJK8cLSro54OYhcHQVsxJe+GQDtFExN25aUjtwTTluAWhkW1CUPH/Ht8YHuS8y7vDRaFGfodn0bB8dwBYgjh9h1nAg5fkfPJ+eBFjvsuFmAZQS7GF8/dSVqiDlEWgllbkG8/wMsWyrOfGe7GfJqRYRX2DDqBEB8PzsjuNokEoYH+XHpKH+1eaMZXfe2Kb/2ghWqaGp5RD8SBeUYyr8zjzPAdnSmgHbphjyj9LiSfss422=' 
    }
];

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

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, title TEXT, url TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS promocodes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, days INTEGER, uses_left INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (user_id TEXT PRIMARY KEY, expires_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS bots (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, category TEXT, description TEXT, link TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS tabs (id TEXT PRIMARY KEY, name TEXT, title TEXT, sub_title TEXT, is_enabled INTEGER DEFAULT 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS scammers (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, reason TEXT, proof TEXT)`);

    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('bio', 'для покупки промокода @zxc_micc')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('app_title', 'P1xly Dashboard')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('launcher_title', '🚀 P1xly System')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('launcher_desc', 'Центр управления автоматизацией и сервисами')`);
    db.run(`INSERT OR IGNORE INTO promocodes (code, days, uses_left) VALUES ('BRO2026', 7, 10)`);

    const defaultTabs = [
        ['catalog', 'Каталог', 'Доступные модули', 'Выберите бота или утилиту'],
        ['sender', 'Отправка (MTProto)', 'Мульти-аккаунт отправка', 'Отправляй сообщения по промокоду'],
        ['scammers', 'База скамеров', 'Черный список / Скамеры', 'Проверка пользователей'],
        ['owner', 'О владельце', 'Информация о владельце', 'Обо мне и мои контакты'],
        ['sub', 'Подписка', 'Активация подписки', 'Введи промокод для разблокировки']
    ];
    defaultTabs.forEach(t => {
        db.run(`INSERT OR IGNORE INTO tabs (id, name, title, sub_title) VALUES (?, ?, ?, ?)`, t);
    });
});

const isAuth = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.status(401).json({ error: 'Необходима авторизация' });
};

app.get('/ping', (req, res) => res.status(200).send('Alive'));

app.get('/api/data', (req, res) => {
    db.all(`SELECT key, value FROM settings`, (err, settingsRows) => {
        let settings = {};
        if (settingsRows) settingsRows.forEach(r => settings[r.key] = r.value);

        db.all(`SELECT * FROM tabs WHERE is_enabled = 1`, (err, tabs) => {
            db.all(`SELECT * FROM links`, (err, links) => {
                db.all(`SELECT * FROM bots`, (err, bots) => {
                    db.all(`SELECT * FROM scammers`, (err, scammers) => {
                        res.json({
                            settings: settings,
                            tabs: tabs || [],
                            links: links || [],
                            bots: bots || [],
                            scammers: scammers || []
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/check-sub', (req, res) => {
    const { userId } = req.body;
    if (userId) {
        db.run(`INSERT INTO activity_logs (user_id, action) VALUES (?, ?)`, [userId, 'Зашел на сайт / проверка сессии']);
    }

    db.get(`SELECT expires_at FROM subscriptions WHERE user_id = ?`, [userId], (err, row) => {
        const active = row && new Date(row.expires_at) > new Date();
        const safeAccounts = MASTER_ACCOUNTS.map(acc => ({ id: acc.id, name: acc.name }));
        res.json({ active, accounts: safeAccounts });
    });
});

app.post('/api/activate-promo', (req, res) => {
    const { userId, code } = req.body;
    db.get(`SELECT * FROM promocodes WHERE code = ?`, [code], (err, promo) => {
        if (!promo) return res.status(400).json({ success: false, message: 'Такого промокода нет' });
        if (promo.uses_left <= 0) return res.status(400).json({ success: false, message: 'Промокод исчерпал лимиты.' });

        db.get(`SELECT expires_at FROM subscriptions WHERE user_id = ?`, [userId], (err, sub) => {
            let now = new Date();
            let currentExpiry = sub && new Date(sub.expires_at) > now ? new Date(sub.expires_at) : now;
            currentExpiry.setDate(currentExpiry.getDate() + promo.days);

            db.run(`INSERT OR REPLACE INTO subscriptions (user_id, expires_at) VALUES (?, ?)`, [userId, currentExpiry.toISOString()], () => {
                db.run(`UPDATE promocodes SET uses_left = uses_left - 1 WHERE id = ?`, [promo.id], () => {
                    db.run(`INSERT INTO activity_logs (user_id, action) VALUES (?, ?)`, [userId, `Активировал промокод: ${code}`]);
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

        const account = MASTER_ACCOUNTS.find(acc => acc.id === accountId);
        if (!account) return res.status(400).json({ success: false, message: 'Выбранный аккаунт не найден!' });

        try {
            const client = new TelegramClient(new StringSession(account.session), API_ID, API_HASH, { connectionRetries: 5 });
            await client.connect();

            await client.sendMessage(recipient, { message });
            db.run(`INSERT INTO activity_logs (user_id, action) VALUES (?, ?)`, [userId, `Отправил сообщение через ${account.name}`]);
            res.json({ success: true, message: `Успешно отправлено с аккаунта: ${account.name}` });
        } catch (e) {
            res.status(400).json({ success: false, message: 'Ошибка Telegram API: ' + e.message });
        }
    });
});

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (bcrypt.compareSync(password, ADMIN_HASH)) {
        req.session.isAdmin = true;
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Неверный пароль' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/admin/settings', isAuth, (req, res) => {
    const { key, value } = req.body;
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value], () => res.json({ success: true }));
});

app.post('/api/admin/tabs', isAuth, (req, res) => {
    const { id, name, title, sub_title } = req.body;
    db.run(`UPDATE tabs SET name = ?, title = ?, sub_title = ? WHERE id = ?`, [name, title, sub_title, id], () => res.json({ success: true }));
});

app.post('/api/admin/bots', isAuth, (req, res) => {
    const { title, category, description, link } = req.body;
    db.run(`INSERT INTO bots (title, category, description, link) VALUES (?, ?, ?, ?)`, [title, category, description, link], function() {
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/admin/bots/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM bots WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/admin/scammers', isAuth, (req, res) => {
    const { username, reason, proof } = req.body;
    db.run(`INSERT INTO scammers (username, reason, proof) VALUES (?, ?, ?)`, [username, reason, proof], function() {
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/admin/scammers/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM scammers WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/admin/links', isAuth, (req, res) => {
    db.run(`INSERT INTO links (category, title, url) VALUES (?, ?, ?)`, [req.body.category, req.body.title, req.body.url], function() {
        res.json({ id: this.lastID });
    });
});

app.delete('/api/admin/links/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM links WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/admin/promocodes', isAuth, (req, res) => {
    const { code, days, uses } = req.body;
    db.run(`INSERT INTO promocodes (code, days, uses_left) VALUES (?, ?, ?)`, [code, days, uses], () => res.json({ success: true }));
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
