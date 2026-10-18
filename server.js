const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Пароль от админки (поменяй на свой!)
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

    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('bio', 'Кодер. Пишу ботов, софт и скрипты.')`);
    
    db.get(`SELECT COUNT(*) as count FROM links`, (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO links (category, title, url) VALUES ('bots', '@p1xly_dev_bot', 'https://t.me/p1xly_dev_bot')`);
            db.run(`INSERT INTO links (category, title, url) VALUES ('channels', 'p1xly_dev', 'https://t.me/p1xly_dev')`);
            db.run(`INSERT INTO links (category, title, url) VALUES ('contacts', 'Telegram (Личка)', 'https://t.me/zxc_micc')`);
        }
    });
});

const isAuth = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.status(401).json({ error: 'Необходима авторизация' });
};

app.get('/api/data', (req, res) => {
    db.get(`SELECT value FROM settings WHERE key = 'bio'`, (err, bioRow) => {
        db.all(`SELECT * FROM links`, (err, links) => {
            res.json({ bio: bioRow ? bioRow.value : '', links: links || [] });
        });
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

app.post('/api/admin/bio', isAuth, (req, res) => {
    const { bio } = req.body;
    db.run(`UPDATE settings SET value = ? WHERE key = 'bio'`, [bio], () => {
        res.json({ success: true });
    });
});

app.post('/api/admin/links', isAuth, (req, res) => {
    const { category, title, url } = req.body;
    db.run(`INSERT INTO links (category, title, url) VALUES (?, ?, ?)`, [category, title, url], function() {
        res.json({ id: this.lastID });
    });
});

app.delete('/api/admin/links/:id', isAuth, (req, res) => {
    db.run(`DELETE FROM links WHERE id = ?`, [req.params.id], () => {
        res.json({ success: true });
    });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => console.log(`Server started on http://localhost:${PORT}`));
