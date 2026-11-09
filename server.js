const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const pendingLogins = {};

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS links (id SERIAL PRIMARY KEY, category TEXT, title TEXT, url TEXT);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS promocodes (id SERIAL PRIMARY KEY, code TEXT, days INTEGER, uses_left INTEGER);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (user_id TEXT PRIMARY KEY, expires_at TIMESTAMPTZ);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS activity_logs (id SERIAL PRIMARY KEY, user_id TEXT, ip TEXT, device TEXT, action TEXT, timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bots (id SERIAL PRIMARY KEY, title TEXT, category TEXT, description TEXT, link TEXT);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS tabs (id TEXT PRIMARY KEY, name TEXT, title TEXT, is_enabled INTEGER DEFAULT 1);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS scammers (id SERIAL PRIMARY KEY, username TEXT, reason TEXT, proof TEXT);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, name TEXT, session TEXT, is_alive INTEGER DEFAULT 1);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS faq (id SERIAL PRIMARY KEY, question TEXT, answer TEXT);`);

        await pool.query(`INSERT INTO settings (key, value) VALUES ('bio', 'для покупки промокода @zxc_micc') ON CONFLICT (key) DO NOTHING;`);
        await pool.query(`INSERT INTO settings (key, value) VALUES ('app_title', 'P1xly Dashboard') ON CONFLICT (key) DO NOTHING;`);
        await pool.query(`INSERT INTO settings (key, value) VALUES ('launcher_title', '🚀 P1xly System') ON CONFLICT (key) DO NOTHING;`);
        await pool.query(`INSERT INTO settings (key, value) VALUES ('launcher_desc', 'Центр управления автоматизацией и сервисами') ON CONFLICT (key) DO NOTHING;`);

        const defaultTabs = [
            ['catalog', 'Каталог', 'Доступные модули', 1],
            ['sender', 'Отправка (MTProto)', 'Мульти-аккаунт отправка', 1],
            ['scammers', 'База скамеров', 'Черный список / Скамеры', 1],
            ['faq', 'Инструкция', 'FAQ и гайды', 1],
            ['owner', 'О владельце', 'Информация о владельце', 1],
            ['sub', 'Подписка', 'Активация подписки', 1]
        ];

        for (const t of defaultTabs) {
            await pool.query(`INSERT INTO tabs (id, name, title, is_enabled) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING;`, t);
        }

        const defaultFaq = [
            ['Как получить session-файл?', 'Используйте специальный бот для выгрузки сессий, после чего добавьте её через админ-панель.'],
            ['Что делать при ошибке PEER_FLOOD?', 'Это ограничение от Telegram. Аккаунт получил временный флуд-контроль, нужно дать ему отлеживаться от 24 до 72 часов.'],
            ['Как активировать промокод?', 'Перейдите во вкладку «Подписка», введите рабочий промокод и нажмите кнопку активации. Дни добавятся автоматически.']
        ];
        for (const f of defaultFaq) {
            await pool.query(`INSERT INTO faq (question, answer) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM faq WHERE question = $1);`, f);
        }

    } catch (e) {
        console.error('Ошибка инициализации БД:', e);
    }
}
initDb();

const isAuth = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.status(401).json({ error: 'Необходима авторизация' });
};

async function logActivity(userId, req, action) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const device = req.headers['user-agent'] || 'Unknown Device';
    try {
        await pool.query(`INSERT INTO activity_logs (user_id, ip, device, action) VALUES ($1, $2, $3, $4)`, [userId || 'guest', ip, device, action]);
    } catch (e) { console.error(e); }
}

app.get('/ping', (req, res) => res.status(200).send('Alive'));
app.get('/api/check-auth', (req, res) => res.json({ isAdmin: !!req.session.isAdmin }));

app.get('/api/data', async (req, res) => {
    try {
        const settingsRes = await pool.query(`SELECT key, value FROM settings`);
        let settings = {};
        settingsRes.rows.forEach(r => settings[r.key] = r.value);

        const tabsRes = await pool.query(`SELECT * FROM tabs`);
        const botsRes = await pool.query(`SELECT * FROM bots`);
        const scammersRes = await pool.query(`SELECT * FROM scammers`);
        const accountsRes = await pool.query(`SELECT id, name, is_alive FROM accounts`);
        const promosRes = await pool.query(`SELECT * FROM promocodes`);
        const faqRes = await pool.query(`SELECT * FROM faq`);
        const logsRes = await pool.query(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT 50`);

        const stats = {
            botsCount: botsRes.rows.length,
            accountsCount: accountsRes.rows.filter(a => a.is_alive).length,
            scammersCount: scammersRes.rows.length
        };

        res.json({
            settings, stats,
            tabs: tabsRes.rows || [],
            bots: botsRes.rows || [],
            scammers: scammersRes.rows || [],
            accounts: accountsRes.rows || [],
            promocodes: promosRes.rows || [],
            faq: faqRes.rows || [],
            logs: logsRes.rows || []
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/check-sub', async (req, res) => {
    const { userId } = req.body;
    logActivity(userId, req, 'Проверка подписки');
    try {
        const subRes = await pool.query(`SELECT expires_at FROM subscriptions WHERE user_id = $1`, [userId]);
        const row = subRes.rows[0];
        const active = row && new Date(row.expires_at) > new Date();

        const accRes = await pool.query(`SELECT id, name FROM accounts WHERE is_alive = 1`);
        res.json({ active, accounts: accRes.rows || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/activate-promo', async (req, res) => {
    const { userId, code } = req.body;
    try {
        const promoRes = await pool.query(`SELECT * FROM promocodes WHERE code = $1`, [code]);
        const promo = promoRes.rows[0];
        if (!promo || promo.uses_left <= 0) {
            return res.status(400).json({ success: false, message: 'Неверный или исчерпанный промокод' });
        }
        const subRes = await pool.query(`SELECT expires_at FROM subscriptions WHERE user_id = $1`, [userId]);
        const sub = subRes.rows[0];
        let now = new Date();
        let currentExpiry = sub && new Date(sub.expires_at) > now ? new Date(sub.expires_at) : now;
        currentExpiry.setDate(currentExpiry.getDate() + promo.days);

        await pool.query(`INSERT INTO subscriptions (user_id, expires_at) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET expires_at = $2`, [userId, currentExpiry.toISOString()]);
        await pool.query(`UPDATE promocodes SET uses_left = uses_left - 1 WHERE id = $1`, [promo.id]);

        logActivity(userId, req, `Активировал промокод: ${code}`);
        res.json({ success: true, message: `Подписка активирована до ${currentExpiry.toLocaleDateString()}` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/tg/send', async (req, res) => {
    const { userId, accountId, recipient, message } = req.body;
    try {
        const subRes = await pool.query(`SELECT expires_at FROM subscriptions WHERE user_id = $1`, [userId]);
        const row = subRes.rows[0];
        if (!row || new Date(row.expires_at) <= new Date()) {
            return res.status(403).json({ success: false, message: 'Нет активной подписки!' });
        }
        const accRes = await pool.query(`SELECT * FROM accounts WHERE id = $1 AND is_alive = 1`, [accountId]);
        const account = accRes.rows[0];
        if (!account) return res.status(400).json({ success: false, message: 'Аккаунт мертв or не найден!' });

        const client = new TelegramClient(new StringSession(account.session), API_ID, API_HASH, { connectionRetries: 3 });
        await client.connect();
        await client.sendMessage(recipient, { message });

        logActivity(userId, req, `Отправил сообщение через ${account.name}`);
        res.json({ success: true, message: `Успешно отправлено!` });
    } catch (e) {
        res.status(400).json({ success: false, message: 'Telegram Error: ' + e.message });
    }
});

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (bcrypt.compareSync(password, ADMIN_HASH)) {
        req.session.isAdmin = true;
        logActivity('ADMIN', req, 'Вход в админку');
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Неверный пароль' });
    }
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

// АДМИНСКИЕ РУЧКИ
app.post('/api/admin/settings', isAuth, async (req, res) => {
    const { key, value } = req.body;
    await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, value]);
    res.json({ success: true });
});

app.post('/api/admin/tabs', isAuth, async (req, res) => {
    const { id, name, title, is_enabled } = req.body;
    await pool.query(`UPDATE tabs SET name = $1, title = $2, is_enabled = $3 WHERE id = $4`, [name, title, is_enabled, id]);
    res.json({ success: true });
});

app.post('/api/admin/promocodes', isAuth, async (req, res) => {
    const { code, days, uses } = req.body;
    await pool.query(`INSERT INTO promocodes (code, days, uses_left) VALUES ($1, $2, $3)`, [code, days, uses]);
    res.json({ success: true });
});
app.delete('/api/admin/promocodes/:id', isAuth, async (req, res) => {
    await pool.query(`DELETE FROM promocodes WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/bots', isAuth, async (req, res) => {
    await pool.query(`INSERT INTO bots (title, category, description, link) VALUES ($1, $2, $3, $4)`, [req.body.title, req.body.category, req.body.description, req.body.link]);
    res.json({ success: true });
});
app.delete('/api/admin/bots/:id', isAuth, async (req, res) => {
    await pool.query(`DELETE FROM bots WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/scammers', isAuth, async (req, res) => {
    await pool.query(`INSERT INTO scammers (username, reason, proof) VALUES ($1, $2, $3)`, [req.body.username, req.body.reason, req.body.proof]);
    res.json({ success: true });
});
app.delete('/api/admin/scammers/:id', isAuth, async (req, res) => {
    await pool.query(`DELETE FROM scammers WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/faq', isAuth, async (req, res) => {
    await pool.query(`INSERT INTO faq (question, answer) VALUES ($1, $2)`, [req.body.question, req.body.answer]);
    res.json({ success: true });
});
app.delete('/api/admin/faq/:id', isAuth, async (req, res) => {
    await pool.query(`DELETE FROM faq WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/accounts/toggle/:id', isAuth, async (req, res) => {
    await pool.query(`UPDATE accounts SET is_alive = CASE WHEN is_alive = 1 THEN 0 ELSE 1 END WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
});
app.delete('/api/admin/accounts/:id', isAuth, async (req, res) => {
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/auth/send-code', isAuth, async (req, res) => {
    const { phone } = req.body;
    try {
        const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 3 });
        await client.connect();
        const { phoneCodeHash } = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone, false);
        const sessionId = 'session_' + Date.now();
        pendingLogins[sessionId] = { client, phone, phoneCodeHash };
        res.json({ success: true, sessionId, message: 'Код отправлен!' });
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
        const accountName = `${me.firstName || ''} (@${me.username || phone})`.trim();
        await pool.query(`INSERT INTO accounts (name, session, is_alive) VALUES ($1, $2, 1)`, [accountName, stringSession]);
        delete pendingLogins[sessionId];
        res.json({ success: true, message: `Аккаунт ${accountName} добавлен!` });
    } catch (e) {
        res.status(400).json({ success: false, message: 'Ошибка: ' + e.message });
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
