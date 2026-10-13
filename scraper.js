const path = require('path');
const https = require('https');
const { openLocalDb } = require('./local-db');

// دالة مدرعة للاتصال بالمواقع بدون استخدام fetch الذي يعلق في Render
function secureGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('فشل في قراءة بيانات الموقع'));
          }
        } else {
          reject(new Error(`MangaDex رفض الاتصال (كود: ${res.statusCode})`));
        }
      });
    }).on('error', err => reject(new Error('فشل الاتصال بالشبكة')));
  });
}

async function importFullManga(mangaUrl) {
  try {
    const match = mangaUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!match) throw new Error('رابط MangaDex غير صالح');
    const mangaId = match[0];

    // 1. جلب البيانات الأساسية
    const mangaData = await secureGet(`https://api.mangadex.org/manga/${mangaId}`);
    const attr = mangaData.data.attributes;
    const titleEn = attr.title.en || Object.values(attr.title)[0] || 'بدون عنوان';
    let titleAr = titleEn;
    if (attr.altTitles) {
      const arTitle = attr.altTitles.find(t => t.ar);
      if (arTitle) titleAr = arTitle.ar;
    }

    // 2. جلب الغلاف (محمي بـ try/catch كي لا يتوقف السحب إذا فشل الغلاف)
    let coverUrl = '';
    const coverRel = mangaData.data.relationships.find(r => r.type === 'cover_art');
    if (coverRel) {
      try {
        const coverData = await secureGet(`https://api.mangadex.org/cover/${coverRel.id}`);
        const fileName = coverData.data.attributes.fileName;
        coverUrl = `https://uploads.mangadex.org/covers/${mangaId}/${fileName}`;
      } catch (e) {
        console.log('فشل جلب الغلاف، سيتم الاستمرار');
      }
    }

    // 3. جلب الفصول (100 فصل كحد أقصى لحماية ذاكرة السيرفر المجاني)
    let chaptersList = [];
    try {
      const feedData = await secureGet(`https://api.mangadex.org/manga/${mangaId}/feed?limit=100&translatedLanguage[]=en&translatedLanguage[]=ar&order[chapter]=asc`);
      chaptersList = feedData.data || [];
    } catch (e) {
      console.log('فشل جلب الفصول، سيتم الاستمرار');
    }

    // 4. الحفظ في قاعدة البيانات الخاصة بك
    const dbPath = path.join(__dirname, 'data', 'noby.sqlite');
    const db = await openLocalDb(dbPath);
    
    // حفظ اسم المانجا
    const stmtManga = db.prepare('INSERT INTO manga (title_ar, title_en, cover_url, rating) VALUES (?, ?, ?, ?)');
    const info = stmtManga.run(titleAr, titleEn, coverUrl, 9.0);
    const newMangaId = info.lastInsertRowid;

    // حفظ الفصول إن وجدت
    let savedChaptersCount = 0;
    if (chaptersList.length > 0) {
      const stmtChap = db.prepare('INSERT INTO chapters (manga_id, chapter_num, title) VALUES (?, ?, ?)');
      const seenChapters = new Set();
      
      for (const ch of chaptersList) {
        const chAttr = ch.attributes;
        const chNumStr = chAttr.chapter || '0';
        const chNum = Number(chNumStr) || 0;
        
        if (!seenChapters.has(chNum)) {
          seenChapters.add(chNum);
          const chTitle = chAttr.title || `الفصل ${chNumStr}`;
          stmtChap.run(newMangaId, chNum, chTitle);
          savedChaptersCount++;
        }
      }
    }

    return { 
      title: titleAr, 
      mangaId: mangaId, 
      chaptersSaved: savedChaptersCount 
    };
  } catch (err) {
    console.error('Scraper Error:', err);
    throw new Error(err.message);
  }
}

module.exports = { importFullManga };
        
