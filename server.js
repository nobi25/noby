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

// دوال التنظيف والحماية (تمت مراجعتها)
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

// صلاحيات المدير
function admin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.noby_admin === '1') return next();
  return res.status(403).json({ error: 'غير مصرح: يتطلب صلاحية المدير' });
}

// إعدادات الحماية الأساسية
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

// مسار فحص صحة السيرفر
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 1. إنشاء الحساب (محصن ضد الأخطاء)
app.post('/api/auth/register', (req, res) => {
  const email = clean(req.body.email || req.body.username, 160).toLowerCase();
  const username = email.split('@')[0]; // يستخرج الاسم من الإيميل تلقائياً
  const password = String(req.body.password || '');
  
  if (!email || !password) return res.status(400).json({ error: 'البريد وكلمة المرور مطلوبة' });

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) return res.status(400).json({ error: 'الحساب موجود مسبقاً، يرجى تسجيل الدخول' });

    const hash = bcrypt.hashSync(password, 10);
    // إدخال البيانات في 3 خانات مطابقة للجدول
    const info = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hash);
    
    setCookie(res, 'noby_session', info.lastInsertRowid, 60 * 60 * 24 * SESSION_DAYS);
    setCookie(res, 'noby_admin', '1', 60 * 60 * 24 * SESSION_DAYS); // إعطاء صلاحية المدير فوراً
    
    res.json({ ok: true, user: { id: info.lastInsertRowid, username, email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء الحساب' });
  }
});

// 2. تسجيل الدخول
app.post('/api/auth/login', (req, res) => {
  const loginInput = clean(req.body.username || req.body.email, 160).toLowerCase();
  const password = String(req.body.password || '');
  
  if (!loginInput || !password) return res.status(400).json({ error: 'يرجى إدخال الحساب وكلمة المرور' });

  try {
    const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(loginInput, loginInput);
    if (!u || !bcrypt.compareSync(password, u.password)) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    setCookie(res, 'noby_session', u.id, 60 * 60 * 24 * SESSION_DAYS);
    setCookie(res, 'noby_admin', '1', 60 * 60 * 24 * SESSION_DAYS);
    
    res.json({ ok: true, user: { id: u.id, username: u.username, email: u.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ في قاعدة البيانات' });
  }
});

// 3. مسار السحب التلقائي
app.post('/api/admin/auto-import-manga', admin, async (req, res) => {
  try {
    const { mangaUrl } = req.body;
    if (!mangaUrl) return res.status(400).json({ ok: false, error: 'الرابط مطلوب' });
    const { importFullManga } = require('./scraper.js');
    const result = await importFullManga(mangaUrl);
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4. مسار الإضافة اليدوية
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
    console.error(err);
    res.status(500).json({ error: 'خطأ في حفظ العمل' });
  }
});

// 5. توجيه ملفات الواجهة
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- الجدار الواقي (الدالة التي تحمينا من خطأ no such table) ---
function ensureDatabaseTables() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        email TEXT,
        password TEXT
      );
      CREATE TABLE IF NOT EXISTS manga (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title_ar TEXT,
        title_en TEXT,
        cover_url TEXT,
        rating REAL
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manga_id INTEGER,
        chapter_num REAL,
        title TEXT
      );
    `);
    console.log('✅ تم فحص وبناء جداول قاعدة البيانات بنجاح.');
  } catch (e) {
    console.error('❌ خطأ أثناء إنشاء الجداول:', e);
  }
}

// 6. تشغيل السيرفر
(async () => {
  try {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    db = await openLocalDb(DB_FILE);
    ensureDatabaseTables(); // تنفيذ جدار الحماية فور تشغيل السيرفر

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Noby Server] running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
  }
})();
    
