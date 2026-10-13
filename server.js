const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { openLocalDb } = require('./local-db');

const app = express();
const PORT = process.env.PORT || 10000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'noby.sqlite');
const SESSION_DAYS = 30;

let db;

function clean(val, max = 255) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, max);
}

function parseCookies(cookieHeader = '') {
  const list = {};
  cookieHeader.split(';').forEach(c => {
    const parts = c.split('=');
    if (parts.length >= 2) list[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
  });
  return list;
}

function setCookie(res, name, value, maxAgeSec) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`);
}

function admin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.noby_admin === '1') return next();
  return res.status(403).json({ error: 'غير مصرح: يتطلب صلاحية المدير' });
}

function auth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const userId = cookies.noby_session;
  if (!userId) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });
  try {
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!u) return res.status(401).json({ error: 'الجلسة غير صالحة' });
    req.user = u;
    next();
  } catch (e) {
    return res.status(500).json({ error: 'خطأ في قاعدة البيانات' });
  }
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, database: 'local-sqlite' });
});

app.get('/api/manga', (req, res) => {
  const search = clean(req.query.search, 80);
  let rows;
  if (search) {
    rows = db.prepare('SELECT * FROM manga WHERE title_ar LIKE ? OR title_en LIKE ? ORDER BY id DESC').all(`%${search}%`, `%${search}%`);
  } else {
    rows = db.prepare('SELECT * FROM manga ORDER BY id DESC').all();
  }
  res.json(rows);
});

app.get('/api/manga/:id/chapters', (req, res) => {
  const rows = db.prepare('SELECT * FROM chapters WHERE manga_id = ? ORDER BY chapter_num ASC').all(req.params.id);
  res.json(rows);
});

// تسجيل مستخدم جديد (معدل ليتوافق مع قاعدة البيانات القديمة)
app.post('/api/auth/register', (req, res) => {
  const username = clean(req.body.email || req.body.username, 160).toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });

  try {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(400).json({ error: 'المستخدم مسجل مسبقاً، جرب تسجيل الدخول' });

    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    setCookie(res, 'noby_session', info.lastInsertRowid, 60 * 60 * 24 * SESSION_DAYS);
    res.json({ ok: true, user: { id: info.lastInsertRowid, username } });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الحفظ: ' + err.message });
  }
});

// تسجيل الدخول (معدل ليتوافق مع قاعدة البيانات القديمة)
app.post('/api/auth/login', (req, res) => {
  const loginInput = clean(req.body.username || req.body.email, 160).toLowerCase();
  const password = String(req.body.password || '');
  if (!loginInput || !password) return res.status(400).json({ error: 'يرجى إدخال الحساب وكلمة المرور' });

  try {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(loginInput);
    if (!u || !bcrypt.compareSync(password, u.password)) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    setCookie(res, 'noby_session', u.id, 60 * 60 * 24 * SESSION_DAYS);
    
    if (!process.env.ADMIN_EMAIL || u.username === process.env.ADMIN_EMAIL) {
      setCookie(res, 'noby_admin', '1', 60 * 60 * 24 * SESSION_DAYS);
    }

    res.json({ ok: true, user: { id: u.id, username: u.username } });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الاستعلام: ' + err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const userId = cookies.noby_session;
  if (!userId) return res.json({ user: null, isAdmin: false });
  try {
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    res.json({ user: u || null, isAdmin: cookies.noby_admin === '1' });
  } catch (err) {
    res.json({ user: null, isAdmin: false });
  }
});

app.post('/api/admin/manga', admin, (req, res) => {
  const title_ar = clean(req.body.title_ar, 255);
  const title_en = clean(req.body.title_en, 255);
  const cover_url = clean(req.body.cover_url, 1000);
  const rating = Number(req.body.rating) || 9.0;
  if (!title_ar) return res.status(400).json({ error: 'العنوان العربي مطلوب' });

  try {
    const info = db.prepare('INSERT INTO manga (title_ar, title_en, cover_url, rating) VALUES (?, ?, ?, ?)').run(title_ar, title_en, cover_url, rating);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في قاعدة البيانات' });
  }
});

app.post('/api/admin/auto-import-manga', admin, async (req, res) => {
  try {
    const { mangaUrl } = req.body;
    if (!mangaUrl) return res.status(400).json({ ok: false, error: 'الرابط مطلوب' });
    const { importFullManga } = require('./scraper.js');
    const result = await importFullManga(mangaUrl);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

(async () => {
  try {
    db = await openLocalDb(DB_FILE);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Noby Server] running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
  }
})();
    
