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
        name: '𝑺𝑩𝑷 | Като 🎲', 
        session: '1AQAOMTQ5LjE1NC4xNzUuNTQBu8NmatwI1BUYCCdqJwhJu13VDV4sb/xmET0blo+3QjtgRpECpf8U3WUqzN2/6qNGpRKt3wMraVWfddZ2PyOrUIUAxWYOXpa272NuPpdVEjJK8cLSro54OYhcHQVsxJe+GQDtFExN25aUjtwTTluAWhkW1CUPH/Ht8YHuS8y7vDRaFGfodn0bB8dwBYgjh9h1nAg5fkfPJ+eBFjvsuFmAZQS7GF8/dSVqiDlEWgllbkG8/wMsWyrOfGe7GfJqRYRX2DDqBEB8PzsjuNokEoYH+XHpKH+1eaMZXfe2Kb/2ghWqaGp5RD8SBeUYyr8zjzPAdnSmgHbphjyj9LiSfss4228=' 
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
    // Таблица для логирования активности юзеров (кто зашел, кто активировал)
    db.run(`CREATE TABLE IF NOT EXISTS activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('bio', 'для покупки промокода @zxc_micc')`);
    // Дефолтный промокод
    db.run(`INSERT OR IGNORE INTO promocodes (code, days, uses_left) VALUES ('BRO2026', 7, 10)`);
});

const isAuth = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.status(401).json({ error: 'Необходима авторизация' });
};

app.get('/ping', (req, res) => res.status(200).send('Alive'));

app.get('/api/data', (req, res) => {
    db.get(`SELECT value FROM settings WHERE key = 'bio'`, (err, bioRow) => {
        db.all(`SELECT * FROM links`, (err, links) => {
            res.json({ bio: bioRow ? bioRow.value : '', links: links || [] });
        });
    });
});

// Логирование входа юзера на сайт / проверку подписки
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

// Активация промокода с записью в логи
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

// Отправка сообщения
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

// Админка: Авторизация
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (bcrypt.compareSync(password, ADMIN_HASH)) {
        req.session.isAdmin = true;
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Неверный пароль' });
    }
});

// Админка: Выход (логенезер / логаут админа)
app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// Админка: Создание нового промокода
app.post('/api/admin/promocodes', isAuth, (req, res) => {
    const { code, days, uses } = req.body;
    if (!code || !days || !uses) return res.status(400).json({ success: false, message: 'Заполни все поля для промокода!' });

    db.run(`INSERT INTO promocodes (code, days, uses_left) VALUES (?, ?, ?)`, [code, days, uses], function() {
        res.json({ success: true, id: this.lastID });
    });
});

// Админка: Получить список созданных промокодов и логов активности
app.get('/api/admin/data', isAuth, (req, res) => {
    db.all(`SELECT * FROM promocodes`, (err, promos) => {
        db.all(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT 50`, (err, logs) => {
            res.json({ promocodes: promos, logs: logs });
        });
    });
});

app.post('/api/admin/bio', isAuth, (req, res) => {
    db.run(`UPDATE settings SET value = ? WHERE key = 'bio'`, [req.body.bio], () => res.json({ success: true }));
});

app.post('/api/admin/links', isAuth, (req, res) => {
    db.run(`INSERT INTO links (category, title, url) VALUES (?, ?, ?)`, [req.body.category, req.body.title, req.body.url], function() {
        res.json({ id: this.lastID });
    });
});

app.delete('/api/admin/links/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM links WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
