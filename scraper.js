// scraper.js - سحب الفصول آلياً عبر MangaDex API
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'noby.sqlite');
const db = new sqlite3.Database(dbPath);

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

// دالة جلب روابط صور الفصل
async function importChapter(chapterId, mangaDbId, chapterNum, chapterTitle) {
  try {
    const serverData = await fetchJson(`https://api.mangadex.org/at-home/server/${chapterId}`);
    const host = serverData.baseUrl;
    const hash = serverData.chapter.hash;
    const files = serverData.chapter.data;

    // تجميع روابط الصور المباشرة (رابط في كل سطر)
    const imageUrls = files.map(file => `${host}/data/${hash}/${file}`).join('\n');

    // إدراج الفصل في قاعدة بيانات نوبي
    db.run(
      `INSERT INTO chapters (manga_id, chapter_num, title, pages) VALUES (?, ?, ?, ?)`,
      [mangaDbId, chapterNum, chapterTitle || `الفصل ${chapterNum}`, imageUrls],
      function (err) {
        if (err) console.error('خطأ في إدخال الفصل:', err.message);
        else console.log(`تم سحب وإضافة الفصل ${chapterNum} بنجاح!`);
      }
    );
  } catch (error) {
    console.error('خطأ أثناء جلب صفحات الفصل:', error.message);
  }
}

module.exports = { importChapter };
  
