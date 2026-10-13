const path = require('path');
const { openLocalDb } = require('./local-db');

async function importFullManga(mangaUrl) {
  try {
    // 1. استخراج معرف المانجا
    const match = mangaUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!match) throw new Error('رابط MangaDex غير صالح');
    const mangaId = match[0];

    const options = {
      headers: {
        'User-Agent': 'NobyMangaApp/2.0 (https://noby-svr9.onrender.com)',
        'Accept': 'application/json'
      }
    };

    // 2. جلب تفاصيل المانجا الأساسية
    const res = await fetch(`https://api.mangadex.org/manga/${mangaId}`, options);
    if (!res.ok) throw new Error('MangaDex رفض الاتصال، تأكد من الرابط');
    const mangaData = await res.json();
    
    const attr = mangaData.data.attributes;
    const titleEn = attr.title.en || Object.values(attr.title)[0] || 'بدون عنوان';
    let titleAr = titleEn;
    if (attr.altTitles) {
      const arTitle = attr.altTitles.find(t => t.ar);
      if (arTitle) titleAr = arTitle.ar;
    }

    // 3. جلب الغلاف
    let coverUrl = '';
    const coverRel = mangaData.data.relationships.find(r => r.type === 'cover_art');
    if (coverRel) {
      const coverRes = await fetch(`https://api.mangadex.org/cover/${coverRel.id}`, options);
      if (coverRes.ok) {
        const coverData = await coverRes.json();
        const fileName = coverData.data.attributes.fileName;
        coverUrl = `https://uploads.mangadex.org/covers/${mangaId}/${fileName}`;
      }
    }

    // 4. جلب قائمة الفصول (حتى 500 فصل) - نركز على الإنجليزية والعربية لتجنب التكرار
    const feedRes = await fetch(`https://api.mangadex.org/manga/${mangaId}/feed?limit=500&translatedLanguage[]=en&translatedLanguage[]=ar&order[chapter]=asc`, options);
    let chaptersList = [];
    if (feedRes.ok) {
      const feedData = await feedRes.json();
      chaptersList = feedData.data || [];
    }

    // 5. حفظ البيانات في قاعدة البيانات
    const dbPath = path.join(__dirname, 'data', 'noby.sqlite');
    const db = await openLocalDb(dbPath);
    
    // إدخال المانجا
    const stmtManga = db.prepare('INSERT INTO manga (title_ar, title_en, cover_url, rating) VALUES (?, ?, ?, ?)');
    const info = stmtManga.run(titleAr, titleEn, coverUrl, 9.0);
    const newMangaId = info.lastInsertRowid; // الحصول على رقم المانجا الجديد في قاعدة بياناتك

    // إدخال الفصول وربطها بالمانجا
    let savedChaptersCount = 0;
    if (chaptersList.length > 0) {
      const stmtChap = db.prepare('INSERT INTO chapters (manga_id, chapter_num, title) VALUES (?, ?, ?)');
      const seenChapters = new Set(); // لمنع تكرار نفس رقم الفصل
      
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
