// scraper.js - سحب العمل بالكامل من MangaDex
const https = require('https');
const { openLocalDb } = require('./local-db');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NobyApp/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// استخراج المعرف من الرابط
function extractMangaId(urlOrId) {
  const match = urlOrId.match(/title\/([a-f0-9-]+)/i);
  return match ? match[1] : urlOrId.trim();
}

async function importFullManga(urlOrId) {
  const mangaId = extractMangaId(urlOrId);
  const db = await openLocalDb();

  // 1. جلب بيانات المانجا والغلاف
  const mangaRes = await fetchJson(`https://api.mangadex.org/manga/${mangaId}?includes[]=cover_art`);
  const mangaData = mangaRes.data;
  const attrs = mangaData.attributes;

  const titleAr = attrs.title.ar || attrs.title.en || Object.values(attrs.title)[0] || 'بدون عنوان';
  const titleEn = attrs.title.en || Object.values(attrs.title)[0] || '';
  const desc = attrs.description.ar || attrs.description.en || Object.values(attrs.description)[0] || '';
  
  // التصنيفات
  const tags = attrs.tags.map(t => t.attributes.name.en).slice(0, 5).join(', ');

  // رابط الغلاف
  const coverRel = mangaData.relationships.find(r => r.type === 'cover_art');
  const coverFileName = coverRel ? coverRel.attributes.fileName : '';
  const coverUrl = coverFileName 
    ? `https://uploads.mangadex.org/covers/${mangaId}/${coverFileName}.512.jpg`
    : 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=400';

  // 2. إدخال العمل في قاعدة البيانات
  const insertManga = db.prepare(`
    INSERT INTO manga (title_ar, title_en, cover_url, rating) 
    VALUES (?, ?, ?, ?)
  `).run(titleAr, titleEn, coverUrl, 9.0);

  const newMangaDbId = insertManga.lastInsertRowid;
  console.log(`تم إضافة العمل [${titleAr}] برقم ID: ${newMangaDbId}`);

  return { success: true, mangaId: newMangaDbId, title: titleAr };
}

module.exports = { importFullManga };
