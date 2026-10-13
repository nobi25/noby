// scraper.js - سحب الفصول آلياً عبر MangaDex API
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

// دالة جلب روابط صور الفصل
async function importChapter(chapterId, mangaDbId, chapterNum, chapterTitle) {
  try {
    const serverData = await fetchJson(`https://api.mangadex.org/at-home/server/${chapterId}`);
    const host = serverData.baseUrl;
    const hash = serverData.chapter.hash;
    const files = serverData.chapter.data;

    // تجميع روابط الصور المباشرة
    const imageUrls = files.map(file => `${host}/data/${hash}/${file}`).join('\n');

    const db = await openLocalDb();
    db.prepare(`INSERT INTO chapters (manga_id, chapter_num, title, pages) VALUES (?, ?, ?, ?)`).run(
      mangaDbId,
      chapterNum,
      chapterTitle || `الفصل ${chapterNum}`,
      imageUrls
    );
    console.log(`تم سحب وإضافة الفصل ${chapterNum} بنجاح!`);
  } catch (error) {
    console.error('خطأ أثناء جلب صفحات الفصل:', error.message);
  }
}

module.exports = { importChapter };
