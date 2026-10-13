const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const cors = require('cors');
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
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const parts = c.split('=');
      if (parts.length >= 2) list[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
    });
  }
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

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' })); // توسيع الذاكرة لاستقبال مئات الفصول

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/register', (req, res) => {
  const email = clean(req.body.email || req.body.username, 160).toLowerCase();
  const username = email.split('@')[0];
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'البريد وكلمة المرور مطلوبة' });

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) return res.status(400).json({ error: 'الحساب موجود مسبقاً، يرجى تسجيل الدخول' });

    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hash);
    setCookie(res, 'noby_session', info.lastInsertRowid, 60 * 60 * 24 * SESSION_DAYS);
    setCookie(res, 'noby_admin', '1', 60 * 60 * 24 * SESSION_DAYS);
    res.json({ ok: true, user: { id: info.lastInsertRowid, username, email } });
  } catch (err) {
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء الحساب' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const loginInput = clean(req.body.username || req.body.email, 160).toLowerCase();
  const password = String(req.body.password || '');
  if (!loginInput || !password) return res.status(400).json({ error: 'يرجى إدخال الحساب وكلمة المرور' });

  try {
    const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(loginInput, loginInput);
    if (!u || !bcrypt.compareSync(password, u.password)) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    setCookie(res, 'noby_session', u.id, 60 * 60 * 24 * SESSION_DAYS);
    setCookie(res, 'noby_admin', '1', 60 * 60 * 24 * SESSION_DAYS);
    res.json({ ok: true, user: { id: u.id, username: u.username, email: u.email } });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في قاعدة البيانات' });
  }
});

// المسار الجديد: يستلم البيانات الجاهزة من متصفحك ويحفظها فوراً
app.post('/api/admin/save-scraped-manga', admin, (req, res) => {
  try {
    const { mangaId, title_ar, title_en, cover_url, chapters } = req.body;
    if (!title_ar) return res.status(400).json({ error: 'العنوان مطلوب' });

    const stmtManga = db.prepare('INSERT INTO manga (title_ar, title_en, cover_url, rating) VALUES (?, ?, ?, ?)');
    const info = stmtManga.run(title_ar, title_en, cover_url, 9.0);
    const newMangaId = info.lastInsertRowid;

    let savedCount = 0;
    if (chapters && Array.isArray(chapters)) {
      const stmtChap = db.prepare('INSERT INTO chapters (manga_id, chapter_num, title) VALUES (?, ?, ?)');
      const seen = new Set();
      for (const ch of chapters) {
        const chNum = Number(ch.num) || 0;
        if (!seen.has(chNum)) {
          seen.add(chNum);
          stmtChap.run(newMangaId, chNum, ch.title || `الفصل ${chNum}`);
          savedCount++;
        }
      }
    }
    res.json({ ok: true, title: title_ar, mangaId, chaptersSaved: savedCount });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في حفظ البيانات في القاعدة' });
  }
});

app.post('/api/admin/manga', admin, (req, res) => {
  try {
    const title_ar = clean(req.body.title_ar, 255);
    const title_en = clean(req.body.title_en, 255);
    const cover_url = clean(req.body.cover_url, 1000);
    const rating = Number(req.body.rating) || 9.0;
    if (!title_ar) return res.status(400).json({ error: 'العنوان العربي مطلوب' });

    const info = db.prepare('INSERT INTO manga (title_ar, title_en, cover_url, rating) VALUES (?, ?, ?, ?)').run(title_ar, title_en, cover_url, rating);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في حفظ العمل' });
  }
});

// جلب البيانات لصفحة الزوار
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

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function ensureDatabaseTables() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, email TEXT, password TEXT);
      CREATE TABLE IF NOT EXISTS manga (id INTEGER PRIMARY KEY AUTOINCREMENT, title_ar TEXT, title_en TEXT, cover_url TEXT, rating REAL);
      CREATE TABLE IF NOT EXISTS chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, manga_id INTEGER, chapter_num REAL, title TEXT);
    `);
  } catch (e) { console.error(e); }
}

(async () => {
  try {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = await openLocalDb(DB_FILE);
    ensureDatabaseTables();
    app.listen(PORT, '0.0.0.0', () => console.log(`[Noby Server] running on port ${PORT}`));
  } catch (err) { console.error(err); }
})();
