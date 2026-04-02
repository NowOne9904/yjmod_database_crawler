/**
 * 영재컴퓨터 PC 자동 크롤러
 * - 매일 자동 실행 (GitHub Actions cron)
 * - 클라우드 IP 차단 우회: Node.js HTTPS로 직접 접근
 * - 결과를 Supabase youngjae_pc 테이블에 upsert
 */

const https = require('https');

const BASE_HOST = 'www.youngjaecomputer.com';

// 환경변수에서 읽기 (GitHub Secrets → SAVE_URL)
const SAVE_URL_FULL = process.env.SAVE_URL || 'https://kaewzfjssmcxeofgezww.supabase.co/functions/v1/save-products';
const _saveUrl = new URL(SAVE_URL_FULL);
const SAVE_HOST = _saveUrl.hostname;
const SAVE_PATH = _saveUrl.pathname;

const ALL_VI = [
  2,3,4,5,86,87,88,138,148,171,189,190,214,319,334,339,
  356,373,374,375,376,378,379,381,382,383,384,385,386,387,388,
  393,394,396,397,398,399,400,401,402,403,404,405,406,
  408,409,410,411,412,413,414,415
];

const REQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Referer': 'https://www.youngjaecomputer.com/'
};

// HTTP GET
function get(host, path, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: host, path, headers: REQ_HEADERS }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const u = new URL(res.headers.location);
          return resolve(get(u.hostname, u.pathname + u.search, timeout));
        } catch { return resolve(''); }
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', e => resolve(''));
    req.setTimeout(timeout, () => { req.destroy(); resolve(''); });
  });
}

// HTTP POST (JSON)
function post(host, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 상품 HTML 파싱
function parseProduct(itId, html) {
  if (!html || html.length < 500) return null;

  // 상품명
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/);
  const name = titleMatch
    ? titleMatch[1].replace(/\s*[:|]\s*(영재컴퓨터|YJMOD)[\s\S]*/i, '').trim()
    : null;

  // 판매가
  // 1순위: id="r_1set_price" (raw HTML에 존재, 조립PC 총액)
  let sellingPrice = null;
  const r1setMatch = html.match(/id="r_1set_price"[^>]*>([\d,]+)\s*원/);
  if (r1setMatch) sellingPrice = parseInt(r1setMatch[1].replace(/,/g, ''));

  // 2순위: r_1set_price 다른 형태 (텍스트 노드 사이 공백 있을 수 있음)
  if (!sellingPrice || sellingPrice === 0) {
    const r1setMatch2 = html.match(/id="r_1set_price"[^>]*>\s*([\d,]+)\s*원/);
    if (r1setMatch2) sellingPrice = parseInt(r1setMatch2[1].replace(/,/g, ''));
  }

  // 3순위: input[name="it_price"] (일부 표준 상품)
  if (!sellingPrice || sellingPrice === 0) {
    const inputMatch = html.match(/name="it_price"[^>]*value="(\d+)"/);
    if (inputMatch && parseInt(inputMatch[1]) > 0) sellingPrice = parseInt(inputMatch[1]);
  }

  // 4순위: 페이지 내 가격 텍스트 패턴 (마지막 수단)
  if (!sellingPrice || sellingPrice === 0) {
    const textMatch = html.match(/판매가[\s\S]{0,200}?([\d,]{6,})\s*원/);
    if (textMatch) sellingPrice = parseInt(textMatch[1].replace(/,/g, ''));
  }

  // 혜택가
  const benefitMatch = html.match(/혜택가[\s\S]{0,300}?([\d,]{5,})\s*원/);
  const benefitPrice = benefitMatch ? parseInt(benefitMatch[1].replace(/,/g, '')) : null;

  // 품절 여부
  const isSoldout = !sellingPrice || sellingPrice === 0 ||
    /class="[^"]*btn_soldout[^"]*"|품절된 상품/.test(html);

  // 스펙 파싱 (CombiTopOption)
  const spec = {};
  const blocks = [];
  const re = /class="[^"]*CombiTopOption[^"]*"[^>]*>([\s\S]*?)(?=class="[^"]*CombiTopOption|id="sit_|<\/form>)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  }
  for (const t of blocks) {
    const lc = t.toLowerCase();
    if (!spec.cpu        && /(인텔|intel|코어.{0,8}(i[3579]|울트라)|라이젠|amd|제온|threadripper)/.test(lc)) spec.cpu        = t.slice(0,300);
    else if (!spec.memory     && /(\d+\s*gb.{0,15}ddr|ddr\d.{0,20}\d+\s*gb)/.test(lc))                   spec.memory     = t.slice(0,200);
    else if (!spec.graphics   && /(rtx\s*\d|gtx\s*\d|rx\s*\d{3,}|geforce|radeon)/.test(lc))              spec.graphics   = t.slice(0,300);
    else if (!spec.ssd        && /(ssd|nvme|m\.2)/.test(lc))                                               spec.ssd        = t.slice(0,200);
    else if (!spec.hdd        && /hdd/.test(lc))                                                           spec.hdd        = t.slice(0,200);
    else if (!spec.mainboard  && /(메인보드|mainboard)/.test(lc))                                          spec.mainboard  = t.slice(0,200);
    else if (!spec.case_name  && /케이스/.test(lc))                                                        spec.case_name  = t.slice(0,200);
    else if (!spec.power      && /(파워|power supply|\d+w\b)/.test(lc))                                    spec.power      = t.slice(0,200);
    else if (!spec.os         && /(windows|윈도)/.test(lc))                                                spec.os         = t.slice(0,100);
  }

  return {
    it_id: itId, name,
    selling_price: (sellingPrice && sellingPrice > 0) ? sellingPrice : null,
    benefit_price: (benefitPrice && benefitPrice > 0) ? benefitPrice : null,
    is_soldout: isSoldout,
    image_url: `https://admin.youngjaecomputer.com/data/item/${itId}_l`,
    detail_url: `https://www.youngjaecomputer.com/shop/item.php?it_id=${itId}`,
    ...spec,
    crawled_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

// 배치 병렬 실행
async function runBatched(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = await Promise.allSettled(items.slice(i, i + size).map(fn));
    results.push(...batch);
  }
  return results;
}

async function main() {
  const start = Date.now();
  console.log(`\n========================================`);
  console.log(`[${new Date().toISOString()}] 크롤링 시작`);
  console.log(`========================================`);

  // ── Step 1: 상품 ID 수집 ──────────────────────
  const allIds = new Set();

  // 메인페이지
  const mainHtml = await get(BASE_HOST, '/');
  for (const m of mainHtml.matchAll(/item\.php\?it_id=(\w+)/g)) allIds.add(m[1]);
  console.log(`메인페이지: ${allIds.size}개`);

  // recommendPC 1페이지 전체 병렬
  const p1 = await Promise.allSettled(
    ALL_VI.map(vi =>
      get(BASE_HOST, `/shop/recommendPC.php?ca_id=h0&ca_id_vi=${vi}&ca_id_index=1`)
        .then(h => ({ vi, h }))
    )
  );
  const activeVis = [];
  for (const r of p1) {
    if (r.status !== 'fulfilled') continue;
    const { vi, h } = r.value;
    const ms = [...h.matchAll(/go_item\('(\w+)'\)/g)];
    if (ms.length > 0) { ms.forEach(m => allIds.add(m[1])); activeVis.push(vi); }
  }

  // 활성 vi의 추가 페이지
  for (const vi of activeVis) {
    for (let idx = 2; idx <= 20; idx++) {
      const h = await get(BASE_HOST, `/shop/recommendPC.php?ca_id=h0&ca_id_vi=${vi}&ca_id_index=${idx}`);
      const ms = [...h.matchAll(/go_item\('(\w+)'\)/g)];
      if (ms.length === 0) break;
      ms.forEach(m => allIds.add(m[1]));
    }
  }

  const ids = [...allIds];
  console.log(`총 ID 발견: ${ids.length}개`);

  if (ids.length === 0) {
    console.error('❌ 상품 ID 0개 — 사이트 접근 차단 가능성. 종료.');
    process.exit(1);
  }

  // ── Step 2: 상품 상세 크롤 ───────────────────
  console.log(`상품 상세 크롤 중...`);
  const crawlResults = await runBatched(ids, 8, id =>
    get(BASE_HOST, `/shop/item.php?it_id=${id}`).then(h => parseProduct(id, h))
  );
  const products = crawlResults
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
  console.log(`크롤링 완료: ${products.length}/${ids.length}개`);

  // ── Step 3: Supabase 저장 ────────────────────
  console.log(`Supabase 저장 중...`);
  const saveResult = await post(SAVE_HOST, SAVE_PATH, { products });
  console.log(`저장 결과:`, JSON.stringify(saveResult));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ 완료 — ${elapsed}초 소요`);
  console.log(`   발견: ${ids.length}개 | 크롤: ${products.length}개 | 저장: ${saveResult.saved ?? '?'}개`);

  if (saveResult.failed > 0) {
    console.warn(`⚠️  저장 실패: ${saveResult.failed}개`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
