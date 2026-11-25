// Deterministic renderer session tests. No Electron, network, timers, or source patches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as indicators from '../indicators.js';
import * as backtest from '../backtest.js';
import * as marketCheck from '../market-check.js';
import { rendererSource } from './_renderer.mjs';

// 렌더러 소스 — renderer/*.js 를 index.html 의 태그 순서로 이은 글자(예전 renderer.js 한 파일과 같다, tests/_renderer.mjs)
const source = rendererSource();
// 렌더러를 자르는 표식(주석 · 선언). 없거나 둘 이상이면 원인을 알 수 없는 전체 실패가 났다 — 주석 문구만 다듬어도
// prelude 가 파일 거의 전체가 되어 "document.addEventListener is not a function" 하나로 103개가 다 깨졌다. 바로 알린다.
const mark = (text) => {
  const i = source.indexOf(text);
  assert.ok(i >= 0, `렌더러 표식 없음: ${text}`);
  assert.equal(source.indexOf(text, i + 1), -1, `렌더러 표식이 둘 이상: ${text}`);
  return i;
};
const prelude = source.slice(0, mark('// 과열도 단계'));
// 가격 포맷(fmt · money · curOf …). 화살표 함수라 realFunction 으로 못 꺼내 구획째 넣는다.
const formatting = source.slice(mark('// --- 포맷'), mark('// 색은 CSS 변수 한 곳에서만'));
function realFunction(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `renderer function ${name} exists`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return source.slice(start, end + 2);
}

const NOW = Date.parse('2026-09-10T09:30:00Z');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
function harness(extra = []) {
  const elements = new Map();
  const timers = [];
  const notifications = [];
  const errors = [];
  const c = vm.createContext({
    Date: FixedDate,
    console: { error: (...args) => errors.push(args) },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, innerHTML: '', textContent: '', title: '' });
      return elements.get(id);
    } },
    // venueDays: 국내 일봉 캔들의 통합(KRX + NXT) 지난 날 값 — 기본은 NXT 거래가 없는 것처럼 빈 값(캔들 = 받은 값)
    api: { notify: (n) => notifications.push(n), venueDays: async () => ({ ok: true, days: {} }) },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout: () => {},
  });
  // 계산 함수는 통째로 넣는다 — 이름을 하나씩 나열하면 새 함수를 부를 때마다
  // ReferenceError 가 나고 목록을 손으로 늘려야 한다.
  // daysAgo 만 기본 인자를 하네스 시각으로 묶는다. 주입된 함수는 vm 밖에서
  // 만들어져 Date.now() 가 FixedDate 가 아니라 진짜 지금을 읽는다.
  Object.assign(c, indicators, backtest, marketCheck, {
    daysAgo: (ms, now = NOW) => indicators.daysAgo(ms, now),
    // loadChart 는 다른 종목 · 기간으로 넘어갈 때 옛 차트를 지운다 — 차트가 없는 하네스에서는 할 일이 없다.
    // 진짜가 필요한 테스트는 extra 에 'clearChart' 를 넣는다(아래 선언이 이것을 덮는다).
    clearChart: () => {},
    renderMetrics: () => {},
    renderFlow: () => {}, // 수급 확대 창(renderer/flow.js) — 받은 뒤 다시 그린다. tests/flow.mjs 가 본다
    renderSearchPopular: () => {}, // 빈 검색창의 인기 목록 — 인기 순위를 받으면 다시 그린다. tests/popular-search.mjs 가 본다
    renderRank: () => {},
    loadEvents: async () => {}, // 갱신이 부르는 관심종목 일정 — 진짜는 extra 로
    loadDaumInfo: async () => {}, // 갱신이 부르는 관심종목 위험 상태 · 52주(다음 금융) — 진짜는 extra 로
    cssVar: (n) => n, // 0 · 값 없음의 색(plColor) — 화면이 없는 하네스에서는 변수 이름 그대로
  });
  const names = ['quoteSession', 'tradingState', 'isDomestic', 'isUs', 'isOverseas', 'pollingIsOpen', 'priceSessionOf',
    'renderUpdated', 'intradayEnd', 'kstClockMs', 'infoTip', 'benchReturn', 'benchmarkOf', 'benchLine', 'alignByDay', 'catchUpDaily', 'tipBases', 'marketDay', 'chartTf', 'rankPct', 'plColor', 'rankCount', 'rankKey', 'rankBackHtml', 'venueCandles', 'venueDaysFor',
    'riskChip', 'marketDayNote', 'loadMarketDays', ...extra]; // 다음 금융(2026-11-24) — 목록 줄의 위험 칩 · 상태 표시의 휴장
  vm.runInContext(prelude + '\n' + [...new Set(names)].map(realFunction).join('\n'), c);
  const run = (code) => vm.runInContext(code, c);
  run(`state = { watchlist: [{symbol:'005930.KS', name:'삼성전자'},
    {symbol:'000660.KS', name:'SK하이닉스'}], selected:'005930.KS', timeframe:'1D',
    holdings:{}, maPeriods:[], alerts:{enabled:true, targets:{}} };`);
  return { c, run, elements, timers, notifications, errors };
}
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`OK ${name}`);
}

await test('five session labels; missing quotes stay unknown; legacy open/session fallback', () => {
  const { run } = harness();
  for (const [session, label] of Object.entries({regular:'정규장', pre:'프리마켓',
    after:'애프터마켓', closed:'장마감', unknown:'확인중'})) {
    assert.equal(run(`SESSION_TEXT[quoteSession({session:'${session}'})]`), label);
  }
  assert.equal(run('quoteSession(null)'), 'unknown');
  assert.equal(run('quoteSession({open:true})'), 'regular');
  assert.equal(run('quoteSession({open:false})'), 'closed');
  assert.equal(run("tradingState({session:'after',open:false})"), true);
  assert.equal(run("tradingState({session:'pre',open:false})"), true);
  assert.equal(run("tradingState({session:'regular',isTrading:null})"), null);
  assert.equal(run("tradingState({session:'regular',isTrading:false})"), false);
  assert.equal(run('tradingState({price:100})'), null);
});

await test('polling: any active/missing/unknown domestic stays fast; only all closed slows', () => {
  const { c } = harness();
  const symbols = ['005930.KS', '000660.KS'];
  const closed = { session:'closed', isTrading:false };
  assert.equal(c.pollingIsOpen(symbols, {'005930':closed,'000660':closed}), false);
  for (const q of [{session:'regular',isTrading:true}, {session:'pre',isTrading:true},
    {session:'after',isTrading:true}, {session:'unknown',isTrading:null}, {}, undefined]) {
    assert.equal(c.pollingIsOpen(symbols, {'005930':closed,'000660':q}), true);
  }
  assert.equal(c.pollingIsOpen(symbols, {'005930':{open:false},'000660':{open:false}}), false);
  assert.equal(c.pollingIsOpen(symbols, {'005930':closed,'000660':{session:'after',open:false}}), true);
  assert.equal(c.isDomestic('0095N0.KS'), true);
  assert.equal(c.isDomestic('ABC.kq'), true);
  assert.equal(c.isDomestic('005930'), true);
  assert.equal(c.isDomestic('TOOLONGSYMB.KS'), false);
  assert.equal(c.pollingIsOpen(['0095N0.KS'], {'0095N0':closed}), false);
  assert.equal(c.pollingIsOpen(['005930.KS','0095N0.KS'], {'005930':closed}), true);
  assert.equal(c.pollingIsOpen(['AAPL','BRK-B'], {}), true);
  assert.equal(c.pollingIsOpen([], {}), true);
});

await test('fetch failures/empty/partial results clear stale closure; partial symbol fetch keeps aggregate', async () => {
  const { c, run } = harness(['fetchLive']);
  const symbols = ['005930.KS','000660.KS'];
  c.api.realtimeQuotes = async () => ({ok:true,quotes:{'005930':{session:'closed'},'000660':{session:'closed'}}});
  await c.fetchLive(symbols);
  assert.equal(run('marketOpen'), false);
  for (const result of [{ok:false}, {ok:true,quotes:{}}, {ok:true,quotes:{'005930':{session:'closed'}}}]) {
    c.api.realtimeQuotes = async () => result;
    run('marketOpen = false; isLive = true;');
    await c.fetchLive(symbols);
    assert.equal(run('marketOpen'), true);
    if (!result.ok) assert.equal(run('isLive'), false);
  }
  c.api.realtimeQuotes = async () => { throw new Error('offline'); };
  run('marketOpen = false; isLive = true;');
  assert.equal(Object.keys(await c.fetchLive(symbols)).length, 0);
  assert.equal(run('marketOpen'), true);
  assert.equal(run('isLive'), false);
  run("quotes['000660.KS'] = {session:'after',isTrading:true};");
  c.api.realtimeQuotes = async () => ({ok:true,quotes:{'005930':{session:'closed',isTrading:false}}});
  await c.fetchLive(['005930.KS']);
  assert.equal(run('marketOpen'), true);
});

// 장 전(NXT 프리마켓 08:00~)과 개장 직후에는 야후 일봉의 마지막 봉이 아직 어제다(20분 지연 + 30분
// 캐시). 그 자리에 오늘 가격을 덮으면 어제 봉의 이동평균 끝점이 오늘 가격으로 틀어진다 — 차트의
// 어제 캔들은 실제 종가라 둘이 어긋났다. 오늘 봉을 덧붙이면 RSI 는 지금 가격을 따르고 어제 종가는 남는다.
await test('before Yahoo has today\'s bar, the live price is added as today instead of replacing yesterday', async () => {
  const { c, run } = harness(['loadQuote', 'maFor']);
  let clock;
  c.Date = class extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  };
  const at = (d) => Date.parse(`${d}T00:00:00Z`); // KRX 일봉 시각 = 09:00 KST
  const days = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']; // 월~목
  const closes = [100, 102, 104, 108];
  c.dailyFor = async () => ({ price: 108, closes, times: days.map(at), currency: 'KRW' });
  const live = (price, tradedAt) => ({ price, prevClose: 108, open: true, session: 'pre', priceSession: 'pre',
    isTrading: true, source: 'Naver', tradedAt });

  clock = Date.parse('2026-09-11T08:30:00+09:00'); // 금요일 프리마켓, 야후 마지막 봉은 목요일
  await c.loadQuote({ symbol: '005930.KS' }, live(112, '2026-09-11T08:29:00+09:00'));
  let d = run("quotes['005930.KS'].daily");
  assert.equal(JSON.stringify(d.closes), '[100,102,104,108,112]', 'Thursday keeps its close, Friday is added');
  assert.equal(d.times.at(-1), at('2026-09-11'), 'stamped as Friday 09:00 KST like a Yahoo daily bar');
  assert.equal(run(`maFor('005930.KS', [${at('2026-09-10')}], 2)[0]`), 106, "Thursday's MA2 is (104 + 108) / 2");
  assert.equal(closes.length, 4, 'the cached series is not touched');

  // 야후에 오늘 봉이 이미 있으면 지금처럼 그 봉을 지금 가격으로 맞춘다
  c.dailyFor = async () => ({ price: 110, closes: [...closes, 110], times: [...days, '2026-09-11'].map(at), currency: 'KRW' });
  clock = Date.parse('2026-09-11T10:00:00+09:00');
  await c.loadQuote({ symbol: '005930.KS' }, live(113, '2026-09-11T09:59:00+09:00'));
  d = run("quotes['005930.KS'].daily");
  assert.equal(JSON.stringify(d.closes), '[100,102,104,108,113]');

  // 휴장일(토요일)에는 실시간 값도 금요일 것이다 — 토요일 봉을 지어내지 않는다
  clock = Date.parse('2026-09-12T10:00:00+09:00');
  await c.loadQuote({ symbol: '005930.KS' }, live(113, '2026-09-11T20:00:00+09:00'));
  d = run("quotes['005930.KS'].daily");
  assert.equal(d.closes.length, 5, 'no Saturday bar');
});

await test('loadQuote carries metadata, zero close delta, timestamp, and delayed fallback', async () => {
  const { c, run } = harness(['loadQuote']);
  c.dailyFor = async () => ({price:99,closes:[90,100,99],times:[1,2,3],currency:'KRW'});
  const live = {price:102,prevClose:100,change:2,open:false,session:'closed',priceSession:'after',
    isTrading:false,regularClose:102,fromClose:0,market:'NXT',source:'Naver',tradedAt:'2026-09-10T09:29:00Z',
    closeTime:'1530'};
  await c.loadQuote({symbol:'005930.KS'}, live);
  const q = run("quotes['005930.KS']");
  for (const field of Object.keys(live)) assert.equal(q[field], live[field], field);
  assert.equal(q.fetchedAt, NOW);
  assert.equal(q.live, true);
  assert.equal(q.daily.closes.at(-1), 102);
  await c.loadQuote({symbol:'000660.KS'}, {price:105,prevClose:100,open:false,session:'after'});
  assert.equal(run("quotes['000660.KS'].isTrading"), true);
  assert.equal(run("quotes['000660.KS'].priceSession"), 'after');
  await c.loadQuote({symbol:'005930.KS'});
  const fallback = run("quotes['005930.KS']");
  assert.equal(fallback.session, 'unknown');
  assert.equal(fallback.isTrading, null);
  assert.equal(fallback.fromClose, null);
  assert.equal(fallback.regularClose, null);
  assert.equal(fallback.priceSession, 'unknown');
  assert.equal(fallback.market, null);
  assert.equal(fallback.source, 'Yahoo');
  assert.equal(fallback.tradedAt, null);
  assert.equal(fallback.live, false);
  c.dailyFor = async () => ({error:'offline'});
  await c.loadQuote({symbol:'005930.KS'}, live);
  assert.equal(run("quoteSession(quotes['005930.KS'])"), 'unknown');
});

await test('selected detail updates header, independent of aggregate; quote and fetch time differ', () => {
  const { c, run, elements } = harness(['renderDetail']);
  Object.assign(c, {
    curOf: () => 'KRW', money: (v) => v == null ? '—' : String(v),
    sectors: new Map([['005930.KS',''],['000660.KS','']]),
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
    levelOf: () => ({label:'—',color:'#000000'}), cssVar: () => '#000000',
  });
  run(`quotes['005930.KS'] = {price:102, live:true, session:'closed', priceSession:'after',
    market:'NXT', source:'Naver', tradedAt:'2026-09-10T09:29:00Z', fetchedAt:Date.now()};
    quotes['000660.KS'] = {price:103, live:true, session:'after', market:'NXT', source:'Naver',
    tradedAt:'2026-09-10T09:29:30Z', fetchedAt:Date.now()}; marketOpen = true;`);
  c.renderDetail();
  const header = elements.get('updated');
  assert.match(header.innerHTML, /장마감/);
  assert.match(header.title, /소스: 실시간 · Naver · NXT/);
  assert.match(header.title, /조회 완료: 2026-09-10T09:30:00.000Z/);
  assert.match(header.title, /시세 시각: 2026-09-10T09:29:00Z/);
  run("state.selected = '000660.KS';");
  c.renderDetail();
  assert.match(header.innerHTML, /애프터마켓/);
  assert.match(header.title, /시세 시각: 2026-09-10T09:29:30Z/);
  run("quotes['000660.KS'] = {price:100,live:false,session:'unknown',source:'Yahoo',fetchedAt:Date.now()};");
  c.renderDetail();
  assert.match(header.innerHTML, /20분지연/);
  assert.match(header.title, /20분지연 · Yahoo/);
  assert.match(header.title, /세션: 확인중/);
  assert.match(header.title, /시세 시각: 확인 불가/);
  run("quotes['000660.KS'].live = true;");
  c.renderUpdated();
  assert.match(header.innerHTML, /확인중/);
  run("state.selected = null;");
  c.renderUpdated();
  assert.match(header.innerHTML, /확인중/);
  assert.doesNotMatch(header.title, /NXT|실시간|20분지연/);
  // 시세를 아예 못 받았으면(오류) 받는 중(확인중)과 구분한다
  run("state.selected = 'ERR.KS'; quotes['ERR.KS'] = { error: 'HTTP 429', fetchedAt: Date.now() };");
  c.renderUpdated();
  assert.match(header.innerHTML, /조회 실패/);
  // 접혀 있으면 갱신 때마다 손잡이 툴팁(세 줄 미리보기)도 새로 쓴다
  run("state.selected = '000660.KS'; state.infoOpen = false;");
  c.renderDetail();
  assert.equal(elements.get('infoToggle').title, '누르면 펼칩니다');
  // 업종 오른쪽의 시장(2026-11-18) — 야후 기호 끝으로(.KS 코스피 · .KQ 코스닥), 미국 · 지수는 비운다
  assert.equal(elements.get('dmarket').textContent, '코스피');
  run("state.watchlist.push({ symbol: '247540.KQ', name: '에코프로비엠' }, { symbol: 'AAPL', name: '애플' }); state.selected = '247540.KQ';");
  c.sectors.set('247540.KQ', '').set('AAPL', '');
  c.renderDetail();
  assert.equal(elements.get('dmarket').textContent, '코스닥');
  run("state.selected = 'AAPL';");
  c.renderDetail();
  assert.equal(elements.get('dmarket').textContent, '', '미국 종목에는 없다');
});

await test('1D appends only active regular; pre/after lines retain price origin after close', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const bars = {ok:true,closes:[98,100],times:[1,2],volumes:[10,20],highs:[99,101],lows:[97,99]};
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  for (const [session, priceSession, open, size, label] of [
    ['regular','regular',true,3,null], ['regular','regular',false,2,null],
    ['pre','pre',false,2,'프리'], ['after','after',false,2,'애프터'],
    ['after','after',true,2,'애프터'], ['closed','after',false,2,'애프터'],
    ['closed','regular',false,2,null], ['unknown','unknown',false,2,null],
  ]) {
    run(`lastDrawSig = null; quotes['005930.KS'] = {price:102,prevClose:95,change:7,live:true,
      open:${open},session:'${session}',priceSession:'${priceSession}'};`);
    await c.loadChart();
    const chart = draws.at(-1);
    assert.equal(chart.closes.length, size, session);
    assert.equal(chart.times.length, size);
    assert.equal(chart.highs.length, size);
    assert.equal(chart.volumes.length, size);
    const line = chart.hLines.find((l) => l.varName === '--over-line');
    assert.equal(line?.label || null, label, session);
    if (line) assert.equal(line.value, 102);
  }
  assert.deepEqual(bars.closes, [98,100], 'original regular bars remain unchanged');
  run("lastDrawSig = null; quotes['005930.KS'] = {price:102,live:true,open:false,session:'pre'};");
  await c.loadChart();
  assert.equal(draws.at(-1).hLines[0].label, '프리', 'legacy fallback without prevClose');
  const before = draws.length;
  run("quotes['005930.KS'].session = 'after';");
  await c.loadChart();
  assert.equal(draws.length, before + 1, 'same price but changed label redraws');
  assert.equal(draws.at(-1).hLines[0].label, '애프터');
  run("state.timeframe = '1M'; lastDrawSig = null;");
  await c.loadChart();
  assert.equal(draws.at(-1).closes.length, 2);
  assert.equal(draws.at(-1).hLines.length, 0);
});

// 국내 1D 정규장을 네이버 실시간 분봉으로 받으면(main.js 가 realtime 을 단다) 봉이 이미 지금까지 있다 — 현재가 ·
// 종가를 끝에 덧붙이지 않는다. 덧붙이면 마지막 봉 뒤에 같은 순간의 점이 하나 더 생긴다. 야후로 그렸을 때는 그대로 붙인다.
// 다만 받은 지 차트 캐시만큼 지나 끝이 헤더와 달랐다(2026-10-27 SK하이닉스 1,368,000 vs 1,365,000) — 장중이면 오늘
// 마지막 봉을 현재가로 맞춘다(점은 더하지 않는다).
await test('1D from Naver real-time bars: no end point is added; while trading the last bar follows the header price', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const bars = { ok: true, realtime: true, closes: [98, 100], times: [NOW - 600000, NOW - 300000], volumes: [10, 20],
    highs: [99, 101], lows: [97, 99] };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  const quote = (session, open) => run(`lastDrawSig = null; quotes['005930.KS'] = {price:102,prevClose:95,change:7,live:true,
    open:${open},session:'${session}',priceSession:'${session}',tradedAt:new Date().toISOString(),closeTime:'1530'};`);
  quote('regular', true);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 102], '장중: 마지막 봉 = 헤더 현재가, 봉 수는 그대로');
  assert.deepEqual([draws.at(-1).highs[1], draws.at(-1).lows[1]], [102, 99], '고가를 넓힌다');
  quote('closed', false);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 100], '장 마감 뒤: 받은 봉 그대로(15:30 봉이 공식 종가)');
  bars.times = [NOW - 2 * 86400000, NOW - 2 * 86400000 + 300000]; // 장 전 · 휴장 — 지난 날 봉
  quote('regular', true);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 100], '지난 날 봉은 건드리지 않는다');
  bars.times = [NOW - 600000, NOW - 300000];
  delete bars.realtime; // 야후로 그린 차트 — 장중 현재가를 덧붙인다
  run("lastDrawSig = null; quotes['005930.KS'] = {price:102,prevClose:95,change:7,live:true,open:true,session:'regular',priceSession:'regular'};");
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 100, 102]);
});

// 15:30 에 정규장이 끝나면 KRX 는 휴지(OPEN + break)이고 가격은 NXT 애프터마켓에서 온다(세션 애프터마켓).
// 야후는 종가를 거래량 0 인 마지막 봉으로 싣는데 20분 늦어 15:50쯤 온다(2026-10-13 실측: regularMarketTime
// 15:30:12). 예전에는 그사이 1D 차트가 20분 전 봉에서 멈췄다 — 확인된 종가로 끝낸다.
await test('1D ends at the verified close until Yahoo\'s close bar arrives; never at an after price', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const bars = { ok: true, closes: [98, 100], times: [1, 2], volumes: [10, 20], highs: [99, 101], lows: [97, 99] };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  // 하네스 시각은 2026-09-10 18:30 KST. 15:56 은 tests/fixtures/naver-break-20260915.json 과 같은 상태다.
  const quote = (patch = {}) => run(`lastDrawSig = null; quotes['005930.KS'] = ${JSON.stringify({ price: 102, prevClose: 95,
    change: 7, live: true, open: false, session: 'after', priceSession: 'after', isTrading: true,
    tradedAt: '2026-09-10T15:56:03+09:00', regularClose: 101, closeTime: '1530', ...patch })};`);
  const draw = async (patch) => { quote(patch); await c.loadChart(); return draws.at(-1); };

  let d = await draw();
  assert.deepEqual(d.closes, [98, 100, 101], '종가로 끝난다 (애프터 가격 102 가 아니다)');
  assert.equal(d.times.at(-1), Date.parse('2026-09-10T15:30:00+09:00'), '이름표는 거래소가 알려 준 종료 시각');
  assert.equal(d.volumes.length, 3);
  assert.equal(d.hLines.find((l) => l.varName === '--over-line')?.value, 102, '애프터 가격은 점선 그대로');
  d = await draw({ closeTime: null });
  assert.equal(d.times.at(-1), NOW, '종료 시각을 모르면 지금');

  // 야후 종가 봉(거래량 0)이 들어오면 점을 더하지 않고 그 봉을 거래소 종가로 맞춘다 — 틱 차이로 끝이 둘이 되지 않게
  Object.assign(bars, { closes: [98, 100, 100.5], times: [1, 2, 3], volumes: [10, 20, 0], highs: [99, 101, 100.5],
    lows: [97, 99, 100.5] });
  d = await draw();
  assert.deepEqual(d.closes, [98, 100, 101]);
  assert.deepEqual(d.times, [1, 2, 3]);
  assert.deepEqual(bars.closes, [98, 100, 100.5], '받은 봉은 그대로');
  // ETF 는 애프터마켓이 없어 15:30 뒤 장마감이다 — 가격이 정규장 것이어도 확인된 종가가 있으면 같은 규칙
  d = await draw({ price: 101, session: 'closed', priceSession: 'regular', isTrading: false });
  assert.deepEqual(d.closes, [98, 100, 101], 'ETF: 종가 봉이 한 번만');

  Object.assign(bars, { closes: [98, 100], times: [1, 2], volumes: [10, 20], highs: [99, 101], lows: [97, 99] });
  // 단일가 · 일시정지처럼 정규장 가격이 멈춰 있고 아직 종가가 없으면 그 가격으로 끝낸다
  d = await draw({ price: 99, session: 'closed', priceSession: 'regular', isTrading: false, regularClose: null,
    tradedAt: '2026-09-10T15:25:00+09:00' });
  assert.deepEqual(d.closes, [98, 100, 99]);
  assert.equal(d.times.at(-1), NOW);
  // 지수에는 애프터마켓이 없다 — 마감 뒤 값이 곧 종가다
  d = await draw({ price: 103, session: 'closed', priceSession: 'closed', isTrading: false, regularClose: null,
    closeTime: null, tradedAt: '2026-09-10T15:30:05+09:00' });
  assert.deepEqual(d.closes, [98, 100, 103]);

  // 종가를 모르는 애프터 · 프리 가격, 어제 가격(장 전 · 휴일), 지연 시세는 붙이지 않는다
  for (const patch of [{ regularClose: null }, { session: 'pre', priceSession: 'pre', regularClose: null },
    { tradedAt: '2026-09-09T15:56:03+09:00' }, { session: 'closed', priceSession: 'closed', tradedAt: '2026-09-09T15:30:05+09:00' },
    { live: false }, { tradedAt: null }]) {
    assert.deepEqual((await draw(patch)).closes, [98, 100], JSON.stringify(patch));
  }
});

// 미국 종목은 네이버 해외 시세가 현재가 · 등락 · 세션을 준다(2026-10-14 실측 SOXL 프리마켓 17:03 KST:
// 정규장 종가 127.57 에서 126.20). 야후 미국 시세는 늦지 않지만 정규장 가격뿐이라 프리 · 애프터가 안 보였다.
await test('US live quote: price from Naver; Yahoo daily untouched and cached briefly', async () => {
  const { c, run } = harness(['loadQuote']);
  const ttls = [];
  c.dailyFor = async (_s, ttl) => { ttls.push(ttl); return { price: 127.57, closes: [128.4, 127.57], times: [1, 2], currency: 'USD' }; };
  const live = { price: 126.2, prevClose: 127.57, change: -1.37, open: false, session: 'pre', priceSession: 'pre',
    isTrading: true, regularClose: 127.57, fromClose: null, market: 'AMEX', source: 'naver-us-over',
    tradedAt: '2026-10-14T04:03:01-04:00' };
  await c.loadQuote({ symbol: 'SOXL' }, live);
  const q = run("quotes['SOXL']");
  assert.equal(q.price, 126.2);
  assert.equal(q.prevClose, 127.57);
  assert.equal(q.session, 'pre');
  assert.equal(q.live, true);
  // 프리 · 애프터 가격을 정규장 봉에 넣지 않는다. 한국 날짜로 오늘 봉을 덧붙이지도 않는다.
  assert.equal(JSON.stringify(q.daily.closes), '[128.4,127.57]');
  assert.equal(ttls.at(-1), 60000, 'Yahoo US daily is not delayed, so it keeps the RSI current');
  await c.loadQuote({ symbol: '005930.KS' }, { ...live, price: 250000, prevClose: 249000, tradedAt: '2026-09-10T18:29:00+09:00' });
  assert.equal(ttls.at(-1), run('DAILY_TTL'), 'domestic live keeps the long cache');
  // 미국 지수 · 환율(지수 줄)도 일봉을 건드리지 않는다. 캐시는 길게 — 세 개를 1분마다 5년치씩 받지 않는다.
  await c.loadQuote({ symbol: '^IXIC', name: '나스닥' }, { ...live, price: 130, session: 'regular', priceSession: 'regular' });
  assert.equal(JSON.stringify(run("quotes['^IXIC'].daily.closes")), '[128.4,127.57]', '지수 줄의 미국 지수도 한국 날짜로 봉을 덧붙이지 않는다');
  assert.equal(ttls.at(-1), run('DAILY_TTL'));
  // 실시간이 없는 지수 항목(달러 인덱스 — 네이버 값이 없다)은 5분 — 1분마다 5년치를 받지 않는다
  await c.loadQuote({ symbol: 'DX-Y.NYB', name: '달러 인덱스' }, undefined);
  assert.equal(ttls.at(-1), 5 * 60000);
});

await test('US header: never 20분지연 — the Naver session when live, 확인중 on Yahoo\'s regular price', () => {
  const { run, elements } = harness();
  const header = () => elements.get('updated');
  run(`state.selected = 'SOXL'; quotes['SOXL'] = {price:126.2, live:true, session:'pre', source:'naver-us-over',
    market:'AMEX', fetchedAt:Date.now()};`);
  run('renderUpdated()');
  assert.match(header().innerHTML, /프리마켓/);
  assert.match(header().title, /소스: 실시간 · naver-us-over · AMEX/);
  run("quotes['SOXL'] = {price:127.57, live:false, session:'unknown', source:'Yahoo', fetchedAt:Date.now()};");
  run('renderUpdated()');
  assert.doesNotMatch(header().innerHTML, /20분지연/);
  assert.match(header().innerHTML, /확인중/);
  assert.match(header().title, /소스: 정규장 가격 · Yahoo/);
  run("quotes['SOXL'].stale = true;");
  run('renderUpdated()');
  assert.match(header().innerHTML, /갱신 실패/);
  assert.match(header().title, /마지막으로 받은 값/);
  // 국내 종목 · 지수의 야후 값은 그대로 20분지연이다
  for (const s of ['005930.KS', '^KS11']) {
    run(`state.selected = '${s}'; quotes['${s}'] = {price:100, live:false, session:'unknown', source:'Yahoo', fetchedAt:Date.now()};`);
    run('renderUpdated()');
    assert.match(header().innerHTML, /20분지연/, s);
  }
  // 미국 지수 · 환율(지수 줄)의 야후 값은 늦지 않다
  for (const s of ['^GSPC', 'KRW=X']) {
    run(`state.selected = '${s}'; quotes['${s}'] = {price:100, live:false, session:'unknown', source:'Yahoo', fetchedAt:Date.now()};`);
    run('renderUpdated()');
    assert.doesNotMatch(header().innerHTML, /20분지연/, s);
  }
});

// 선물 · 유가는 거래소가 10분 늦게 준다(네이버 · 야후 같다) — 거래 중에는 정규장 · 실시간이 아니라 10분지연. 금리는 실시간이다.
await test('futures and oil say 10분지연 while trading and 장마감 when closed; the 10-year yield stays real-time', () => {
  const { run, elements } = harness();
  const header = () => elements.get('updated');
  for (const s of ['NQ=F', 'CL=F']) {
    run(`state.selected = '${s}'; quotes['${s}'] = {price:100, live:true, session:'regular', source:'Naver', fetchedAt:Date.now()};`);
    run('renderUpdated()');
    assert.match(header().innerHTML, /^<span class="delay">10분지연<\/span>/, s);
    assert.match(header().title, /소스: 10분 지연 · Naver/, s);
    run(`quotes['${s}'].session = 'closed';`);
    run('renderUpdated()');
    assert.match(header().innerHTML, /^<span class="closed">장마감<\/span>/, s);
  }
  run("state.selected = '^TNX'; quotes['^TNX'] = {price:4.97, live:true, session:'regular', source:'Naver', fetchedAt:Date.now()};");
  run('renderUpdated()');
  assert.match(header().innerHTML, /^<span class="live">정규장<\/span>/);
  assert.match(header().title, /소스: 실시간 · Naver/);
});

// 선물(=F)의 하루는 CME 하루(18:00 ET ~ 다음 날 17:00 ET)이고 야후 일봉 시각은 끝 날 00:00 ET — 서머타임이든 아니든
// 그 하루가 일봉과 같은 날짜로 떨어져야 1W 툴팁 등락률 · 전일 고저가 앞 거래일을 본다.
await test('marketDay: a CME futures session (18:00 ET to 17:00 ET) is the day its Yahoo daily bar is stamped, summer or winter', () => {
  const { c } = harness();
  const day = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86400000);
  for (const [at, want] of [
    ['2026-10-22T22:00:00Z', '2026-10-23'], // 10/22 18:00 EDT — 10/23 하루의 첫 봉
    ['2026-10-23T04:00:00Z', '2026-10-23'], // 10/23 00:00 EDT — 10/23 일봉의 시각
    ['2026-10-23T20:55:00Z', '2026-10-23'], // 10/23 16:55 EDT — 마지막 봉
    ['2026-12-01T23:00:00Z', '2026-12-02'], // 12/01 18:00 EST
    ['2026-12-02T05:00:00Z', '2026-12-02'], // 12/02 00:00 EST — 일봉
    ['2026-12-02T21:55:00Z', '2026-12-02'], // 12/02 16:55 EST
  ]) {
    for (const s of ['NQ=F', 'CL=F']) assert.equal(c.marketDay(Date.parse(at), s), day(want), `${s} ${at}`);
  }
  // 미국채 10년(^TNX)은 미국 지수처럼 -5시간 — 08:20 ET 일봉도 그날
  assert.equal(c.marketDay(Date.parse('2026-10-22T12:20:00Z'), '^TNX'), day('2026-10-22'));
});

await test('polling: a US stock counts by its own Naver session, not the Korean market', () => {
  const { c } = harness();
  const closed = { session: 'closed', isTrading: false };
  const pre = { session: 'pre', isTrading: true };
  assert.equal(c.pollingIsOpen(['SOXL', 'AAPL'], { SOXL: closed, AAPL: closed }), false);
  assert.equal(c.pollingIsOpen(['005930.KS', 'SOXL'], { '005930': closed, SOXL: pre }), true, 'US pre-market while KRX is closed');
  assert.equal(c.pollingIsOpen(['005930.KS', 'BRK-B'], { '005930': closed }), true, 'a US stock Naver does not have stays fast');
  assert.equal(c.isUs('SOXL'), true);
  assert.equal(c.isUs('BRK-B'), true);
  assert.equal(c.isUs('005930.KS'), false);
  assert.equal(c.isUs('^KS11'), false);
});

// 야후 미국 분봉은 늦지 않아 1D 끝을 맞출 것이 없다. intradayEnd 의 날짜 · 종료 시각은 한국 기준이기도 하다.
await test('1D US chart: no end point from the live quote; the over-market line still shows', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const bars = { ok: true, closes: [128, 127.57], times: [1, 2], volumes: [10, 20], highs: [129, 128], lows: [127, 127] };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'USD',
    drawChart: (data) => draws.push(data),
  });
  run("let lastDrawSig = null; state.watchlist.push({symbol:'SOXL', name:'SOXL'}); state.selected = 'SOXL';");
  for (const patch of [{ session: 'regular', priceSession: 'regular', open: true, isTrading: true },
    { session: 'after', priceSession: 'after', isTrading: true, regularClose: 127.6 }]) {
    run(`lastDrawSig = null; quotes['SOXL'] = ${JSON.stringify({ price: 127.78, prevClose: 128.4, change: -0.62,
      live: true, open: false, tradedAt: '2026-09-10T18:29:00+09:00', ...patch })};`);
    await c.loadChart();
    assert.deepEqual(draws.at(-1).closes, [128, 127.57], patch.session);
  }
  assert.equal(draws.at(-1).hLines.find((l) => l.varName === '--over-line')?.label, '애프터');
  // 지수 줄의 미국 지수도 같다 — 열려 있어도 끝점을 덧붙이지 않는다
  run(`lastDrawSig = null; state.selected = '^IXIC'; quotes['^IXIC'] = { price: 130, prevClose: 128, change: 2, live: true,
    open: true, session: 'regular', priceSession: 'regular', isTrading: true };`);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [128, 127.57], '^IXIC');
});

// 1D 에 시간외 봉이 붙으면(main.js: 국내 NXT 프리 · 애프터, 미국 야후) 정규장 끝점(확인된 종가 · 현재가)은
// 마지막 칸이 아니라 정규장 마지막 봉 자리에 맞춰야 한다. 끝에 붙이면 선이 애프터에서 종가로 되돌아간다.
await test('1D with extended bars: the regular end point sits before the after bars, arrays stay aligned', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const T = (s) => Date.parse(`2026-09-10T${s}:00+09:00`);
  const hm = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(11, 16);
  let bars;
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  const quote = (patch = {}) => run(`quotes['005930.KS'] = ${JSON.stringify({ price: 103, prevClose: 95, change: 8,
    live: true, open: false, session: 'after', priceSession: 'after', isTrading: true,
    tradedAt: '2026-09-10T16:05:00+09:00', regularClose: 101, closeTime: '1530', ...patch })};`);
  const series = (closes, at, ext, volumes) => ({ ok: true, closes, times: at.map(T), volumes, ext,
    opens: closes.slice(), highs: closes.map((v) => v + 1), lows: closes.map((v) => v - 1) });
  const draw = async (patch) => { run('lastDrawSig = null;'); quote(patch); await c.loadChart(); return draws.at(-1); };

  bars = series([99, 98, 100, 102, 103], ['08:00', '09:00', '15:00', '15:40', '15:45'],
    ['pre', null, null, 'after', 'after'], [5, 10, 20, 7, 3]);
  let d = await draw();
  assert.deepEqual(d.closes, [99, 98, 100, 101, 102, 103], '확인된 종가가 15:30 자리에');
  assert.deepEqual(d.times.map(hm), ['08:00', '09:00', '15:00', '15:30', '15:40', '15:45']);
  assert.deepEqual(d.ext, ['pre', null, null, null, 'after', 'after'], '끼운 끝점은 정규장');
  assert.deepEqual(d.volumes, [5, 10, 20, 0, 7, 3]);
  assert.deepEqual([d.opens[3], d.highs[3], d.lows[3]], [101, 101, 101]);
  assert.deepEqual([d.highs[4], d.lows[4]], [103, 101], '뒤의 애프터 봉은 제 값 그대로');
  assert.deepEqual(bars.closes, [99, 98, 100, 102, 103], '받은 봉은 그대로');

  // 종가가 바뀌면(마지막 칸은 그대로여도) 다시 그린다
  const before = draws.length;
  quote({ regularClose: 101.5 });
  await c.loadChart();
  assert.equal(draws.length, before + 1, 'redraws when only the middle end point changes');

  // 야후 종가 봉(거래량 0)이 들어오면 그 봉을 맞춘다 — 마지막 애프터 봉이 아니라
  bars = series([99, 98, 100, 100.5, 102, 103], ['08:00', '09:00', '15:00', '15:30', '15:40', '15:45'],
    ['pre', null, null, null, 'after', 'after'], [5, 10, 20, 0, 7, 3]);
  d = await draw();
  assert.deepEqual(d.closes, [99, 98, 100, 101, 102, 103]);

  // 종료 시각을 몰라 "지금" 으로 가는 끝점은 애프터 봉 뒤에 붙이지 않는다
  bars = series([99, 98, 100, 102, 103], ['08:00', '09:00', '15:00', '15:40', '15:45'],
    ['pre', null, null, 'after', 'after'], [5, 10, 20, 7, 3]);
  d = await draw({ closeTime: null });
  assert.deepEqual(d.closes, [99, 98, 100, 102, 103]);

  // 장 시작 직후 야후가 비어 프리 봉만 있으면 현재가는 그 뒤에 붙는다
  bars = series([99, 98.5], ['08:00', '08:45'], ['pre', 'pre'], [5, 4]);
  d = await draw({ session: 'regular', priceSession: 'regular', open: true, price: 104, regularClose: null });
  assert.deepEqual(d.closes, [99, 98.5, 104]);
  assert.deepEqual(d.ext, ['pre', 'pre', null]);
});

// 보조 지표(설정의 칩): 볼린저 밴드 · VWAP · 거래량 평균 · 전일 고저. 기본은 모두 꺼짐.
await test('indicators: saved value is cleaned; chips toggle, save and redraw', () => {
  const { c, run, elements } = harness(['renderIndChips']);
  assert.equal(JSON.stringify(run("cleanIndicators({ bb: true, vwap: 'yes', bogus: true })")),
    '{"bb":true,"vwap":false,"volAvg":false,"prevHL":false,"vp":false,"rel":false,"sar":false,"rsi":false,"stoch":false}', '아는 키만, true 일 때만');
  assert.equal(JSON.stringify(run('cleanIndicators(undefined)')),
    '{"bb":false,"vwap":false,"volAvg":false,"prevHL":false,"vp":false,"rel":false,"sar":false,"rsi":false,"stoch":false}');
  const kids = [];
  const paneKids = [];
  let saves = 0;
  let loads = 0;
  c.document.createElement = () => ({ style: {} });
  c.document.getElementById('indChips').appendChild = (b) => kids.push(b);
  c.document.getElementById('paneChips').appendChild = (b) => paneKids.push(b);
  Object.assign(c, { save: () => { saves++; }, loadChart: () => { loads++; }, cssVar: (n) => n });
  run("state.indicators = cleanIndicators({ bb: true });");
  run('renderIndChips()');
  const shown = () => kids.slice(-7);
  const pane = () => paneKids.slice(-2);
  assert.deepEqual(shown().map((b) => b.textContent), ['볼린저', 'VWAP', '거래량 평균', '전일 고저', '매물대', '지수 대비', 'SAR'], '상단 지표');
  assert.deepEqual(pane().map((b) => b.textContent), ['RSI', '스토캐스틱'], '하단 지표(차트 아래 칸)는 따로');
  // 하네스는 1D — 볼린저는 일봉 기간에만 그려 켜져 있어도 흐리다(이동평균 칩처럼). 툴팁 끝에 이유
  assert.equal(shown()[0].className, 'on off');
  assert.match(shown()[0].title, /\n1D 에서는 그리지 않는다$/);
  assert.equal(shown()[0].style.color, '--bb-line', '켜진 칩은 그 선의 색');
  assert.equal(shown()[1].className, undefined, 'VWAP 는 1D 에 그려 흐리지 않다');
  assert.equal(shown()[1].title, run('INDICATORS[1].title'), '그리는 기간이면 툴팁 그대로');
  shown()[1].onclick();
  assert.equal(run('state.indicators.vwap'), true);
  assert.equal(run('state.indicators.bb'), true, '다른 칩은 그대로');
  assert.equal(saves, 1);
  assert.equal(loads, 1);
  assert.equal(shown()[1].className, 'on', '칩을 다시 그린다');
  // RSI · 스토캐스틱은 차트 아래 한 칸을 같이 써서 하나만 켜진다
  pane()[0].onclick();
  pane()[1].onclick();
  assert.ok(run('state.indicators.stoch') === true && run('state.indicators.rsi') === false, '스토캐스틱을 켜면 RSI 칩이 꺼진다');
  assert.equal(pane()[0].className, undefined);
  assert.equal(pane()[1].className, 'on');
  assert.ok(elements.get('indChips') && elements.get('paneChips'));
  // 전체 — SAR · RSI · 스토캐스틱 · 볼린저 · 매물대 · 1D 지표는 그리지 않아 흐리고, 거래량 평균 · 지수 대비는 그린다
  run("state.timeframe = '전체'; renderIndChips();");
  assert.deepEqual([...shown(), ...pane()].map((b) => b.className || ''),
    ['on off', 'on off', '', 'off', 'off', '', 'off', 'off', 'on off'], '켜진 칩 · 꺼진 칩 모두 그리는 기간이 아니면 흐리다');
  assert.ok(run('INDICATORS.every((i) => !i.tfs || (i.tfs.length && i.tfs.every((t) => Object.hasOwn(TF, t))))'), 'tfs 는 있는 기간 이름만');
});

await test('indicators: loadChart passes only the enabled overlays — bands and volume average on daily, VWAP and previous high/low on 1D', async () => {
  const { c, run } = harness(['loadChart', 'alignByDay', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const draws = [];
  let bars;
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  const day = 86400000;
  // 국내 일봉 시각 = 09:00 KST. 마지막 일봉이 아래 1D 의 날(9/10)이라, 볼린저를 1D 에 잘못 그리면 값이 잡힌다.
  const t0 = Date.parse('2026-07-28T00:00:00Z');
  const N = 45; // 차트 첫 봉(끝에서 22번째) 앞에 20봉이 넘게 있다
  const T = Array.from({ length: N }, (_, i) => t0 + i * day);
  const C = Array.from({ length: N }, (_, i) => 100 + (i % 5));
  const V = Array.from({ length: N }, (_, i) => (i === N - 1 ? 5000 : 1000));
  run(`quotes['005930.KS'] = { price: ${C[N - 1]}, prevClose: 100, change: 4, live: true,
    daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} },
    dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(V)} },
    dailyHL: { times: [${Date.parse('2026-09-09T00:00:00Z')}, ${Date.parse('2026-09-10T00:00:00Z')}], highs: [110, 120], lows: [90, 95] } };`);
  const daily = { ok: true, closes: C.slice(-22), times: T.slice(-22), volumes: V.slice(-22),
    opens: C.slice(-22), highs: C.slice(-22), lows: C.slice(-22) };
  const draw = async (tf, ind, b) => {
    bars = b;
    run(`state.timeframe = '${tf}'; state.indicators = cleanIndicators(${JSON.stringify(ind)});`);
    await c.loadChart();
    return draws.at(-1);
  };

  let d = await draw('1M', {}, daily);
  assert.equal(d.bands, null);
  assert.equal(d.vwapLine, null);
  assert.equal(d.volAvg, null, '꺼 두면 아무것도 넘기지 않는다');

  const before = draws.length;
  d = await draw('1M', { bb: true, volAvg: true, vp: true }, daily);
  assert.equal(draws.length, before + 1, '칩만 바꿔도 다시 그린다');
  assert.equal(d.profile, true, '매물대는 일봉 기간에 그린다(구간은 drawChart 가 정한다)');
  const full = c.bollinger(C, 20, 2);
  assert.equal(d.bands.upper.length, 22);
  assert.equal(d.bands.upper[21], full.upper[N - 1], '5년치 일봉으로 계산해 차트 날짜에 맞춘다');
  assert.equal(d.bands.lower[0], full.lower[N - 22], '1M 첫 봉부터 그려진다');
  assert.equal(d.volAvg[21], (19 * 1000 + 5000) / 20, '일봉 거래량 20일 평균');
  assert.equal(d.volAvg[0], 1000);
  assert.equal(d.vwapLine, null, 'VWAP 는 1D 만');

  // 1D: 프리 · 정규장 · 애프터 봉. VWAP 와 거래량 평균은 정규장 봉만, 전일 고저는 어제 일봉에서
  const T1 = (s) => Date.parse(`2026-09-10T${s}:00+09:00`);
  const oneDay = { ok: true, closes: [99, 100, 102, 101, 103], times: ['08:00', '09:00', '09:05', '15:00', '15:40'].map(T1),
    volumes: [10, 100, 300, 0, 50], opens: [99, 100, 102, 101, 103], highs: [99, 101, 103, 101, 103], lows: [99, 99, 101, 101, 103],
    ext: ['pre', null, null, null, 'after'] };
  d = await draw('1D', { bb: true, vwap: true, prevHL: true, vp: true }, oneDay);
  assert.equal(d.bands, null, '볼린저는 일봉 기간만');
  assert.equal(d.profile, false, '매물대도 일봉 기간만');
  const tp1 = (101 + 99 + 100) / 3;
  const tp2 = (103 + 101 + 102) / 3;
  assert.equal(d.vwapLine[0], null, '프리 봉은 빼고 그 칸은 비운다');
  assert.equal(d.vwapLine[1], tp1);
  assert.equal(d.vwapLine[2], (tp1 * 100 + tp2 * 300) / 400);
  assert.equal(d.vwapLine[3], d.vwapLine[2], '거래량 0 인 봉은 직전 값');
  assert.equal(d.vwapLine[4], null, '애프터 봉도 비운다');
  const hl = d.hLines.filter((l) => l.label === '전고' || l.label === '전저');
  assert.equal(JSON.stringify(hl.map((l) => [l.label, l.value])), '[["전고",110],["전저",90]]', '오늘(9/10) 앞의 9/9 일봉');
  assert.equal(JSON.stringify(hl.map((l) => l.varName)), '["--prevhi-line","--prevlo-line"]', '전고 옅은 빨강 · 전저 옅은 파랑');

  d = await draw('1D', { vwap: false, prevHL: false }, oneDay);
  assert.equal(d.vwapLine, null);
  assert.equal(d.hLines.some((l) => l.label === '전고'), false);

  // 목표가 알림의 상한 · 하한도 점선(2026-11-17 사용자 요청) — 알림을 꺼 둬도 넣어 둔 값이면, 일봉 기간에도. 차트만 보기면 빠진다
  run("state.alerts = { enabled: false, targets: { '005930.KS': { up: 130, down: 80 } } };");
  const goals = (x) => JSON.stringify(x.hLines.filter((l) => l.varName === '--target-line').map((l) => [l.label, l.value]));
  d = await draw('1M', {}, daily);
  assert.equal(goals(d), '[["목표↑",130],["목표↓",80]]', '상한 · 하한 — 상한가와 헷갈리지 않게 목표↑ · 목표↓');
  run("state.alerts.targets['005930.KS'] = { down: 80 };");
  d = await draw('1D', {}, oneDay);
  assert.equal(goals(d), '[["목표↓",80]]', '한쪽만 넣었으면 그 선만');
  run('state.plainChart = true;');
  d = await draw('1D', {}, oneDay);
  assert.equal(goals(d), '[]', '차트만 보기');
  run('state.plainChart = false; state.alerts.targets = {};');
  assert.match(realFunction('renderAlerts'), /save\(\);\s*if \(item\.symbol === state\.selected\) loadChart\(\)/, '설정에서 목표가를 바꾸면 차트를 바로 다시 그린다');

  // 1D 거래량 평균은 6봉(30분) — 20봉이면 장 초반 거래에 끌려 오후까지 내려가기만 했다(2026-11-06)
  const eight = { ok: true, closes: new Array(8).fill(100), volumes: new Array(8).fill(100), opens: new Array(8).fill(100),
    highs: new Array(8).fill(100), lows: new Array(8).fill(100), ext: new Array(8).fill(null),
    times: Array.from({ length: 8 }, (_, i) => T1(`09:${String(i * 5).padStart(2, '0')}`)) };
  d = await draw('1D', { volAvg: true }, eight);
  assert.equal(d.volAvg[4], null, '다섯째 봉까지는 아직 평균이 없다');
  assert.equal(d.volAvg[5], 100, '1D 는 여섯째 봉(30분)부터 평균');
});

await test('indicators: volume average leaves out extended and zero-volume bars; previous day uses the market\'s own date', () => {
  const { c, run } = harness(['seriesVolAvg', 'prevDayRange']);
  const vols = Array.from({ length: 25 }, (_, i) => (i < 2 ? 5 : 100));
  const ext = vols.map((_, i) => (i < 2 ? 'pre' : null));
  vols[10] = 0; // 끼운 끝점처럼 거래량 0
  const avg = c.seriesVolAvg(vols, ext);
  assert.equal(avg[0], null, '시간외 봉은 평균에 넣지도, 칸을 채우지도 않는다');
  assert.equal(avg[10], null, '거래량 0 인 봉도');
  // 쓰는 봉: 2~9, 11~ → 20번째는 22번 칸
  assert.equal(avg[22], 100, '정규장 봉 20개가 모인 첫 칸');
  assert.equal(avg[21], null, '아직 19개');

  // 국내 1D 프리 봉(08:30 KST)은 UTC 로 전날이다 — 한국 날짜로 세야 어제(10/14) 일봉을 고른다
  run(`quotes['005930.KS'] = { dailyHL: { times: [${Date.parse('2026-10-13T00:00:00Z')}, ${Date.parse('2026-10-14T00:00:00Z')}],
    highs: [200, 210], lows: [190, 195] } };`);
  assert.deepEqual({ ...c.prevDayRange('005930.KS', [Date.parse('2026-10-15T08:30:00+09:00')]) }, { high: 210, low: 195 });
  // 미국 1D 애프터 봉(08:55 KST = 뉴욕 10/14 19:55)은 UTC 날짜가 뉴욕 날짜다 — 10/14 일봉은 그날이라 빼고 10/13
  run(`quotes.SOXL = { dailyHL: { times: [${Date.parse('2026-10-13T13:30:00Z')}, ${Date.parse('2026-10-14T13:30:00Z')}],
    highs: [128, 130], lows: [115, 110] } };`);
  assert.deepEqual({ ...c.prevDayRange('SOXL', [Date.parse('2026-10-15T08:55:00+09:00')]) }, { high: 128, low: 115 });
  // 서머타임이 끝나면(11/1~) 뉴욕 19:00~20:00 이 UTC 로 다음 날이다 — 11/17 19:55 EST 봉에서 11/17 일봉(그날)을 고르면 안 된다
  run(`quotes.SOXL = { dailyHL: { times: [${Date.parse('2026-11-16T14:30:00Z')}, ${Date.parse('2026-11-17T14:30:00Z')}],
    highs: [128, 130], lows: [115, 110] } };`);
  assert.deepEqual({ ...c.prevDayRange('SOXL', [Date.parse('2026-11-18T00:55:00Z')]) }, { high: 128, low: 115 }, '겨울(EST) 애프터 끝');
  assert.equal(c.prevDayRange('000660.KS', [1]), null, '일봉이 없으면 그리지 않는다');
});

await test('indicators: drawChart draws the band as a filled pair, VWAP on the price axis, the average on the volume axis', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: (_hex, a) => `a${a}`, cssVar: (n) => n,
  });
  run(`state.timeframe = '1D';
    var C_ = [100, 101, 102, 103];
    var arg_ = { closes: C_, times: [1, 2, 3, 4], up: true, volumes: [10, 10, 50, 10], highs: C_, lows: C_,
      bands: { upper: [110, 111, 112, 113], lower: [90, 91, 92, 93] }, vwapLine: [100, 100.5, 101, 101.5],
      volAvg: [null, 10, 20, 15] };`);
  run('drawChart(arg_);');
  const sets = configs.at(-1).data.datasets;
  const up = sets.findIndex((d) => d.borderColor === '--bb-line' && d.fill === '+1');
  assert.ok(up >= 0, '위쪽 경계가 아래쪽까지 채운다');
  assert.equal(sets[up + 1].borderColor, '--bb-line', '아래쪽 경계가 바로 다음 데이터셋이다(fill +1)');
  assert.equal(JSON.stringify(sets[up + 1].data), '[90,91,92,93]');
  const vw = sets.find((d) => d.borderColor === '--vwap-line');
  assert.equal(vw.yAxisID, 'y');
  const avg = sets.find((d) => d.borderColor === '--vol-avg');
  assert.equal(avg.yAxisID, 'yVol', '거래량 평균은 거래량 축');
  // 보이는 평균의 최저(10)~최고(20)를 막대 칸(0~최대 거래량 50)의 10~100% 로 늘린다 — 막대와 같은 눈금이면 거의 직선이었다
  assert.equal(JSON.stringify(avg.data.map((v) => (v == null ? v : Math.round(v * 1000) / 1000))), '[null,5,50,27.5]',
    '평균선은 늘고 주는 모양이 보이게 늘려 그린다');
  const vol = sets.find((d) => d.isVolume);
  assert.equal(JSON.stringify(vol.backgroundColor), '["a0.2","a0.2","a0.55","a0.2"]', '평균의 2배 넘는 막대만 진하게');

  run('arg_.bands = null; arg_.vwapLine = null; arg_.volAvg = null; drawChart(arg_);');
  const off = configs.at(-1).data.datasets;
  assert.equal(off.some((d) => ['--bb-line', '--vwap-line', '--vol-avg'].includes(d.borderColor)), false);
  assert.equal(off.find((d) => d.isVolume).backgroundColor, 'a0.2', '끄면 막대 색은 예전처럼 하나');
});

await test('indicators: legend shows BB low~high on hover, VWAP its latest value until hovered', () => {
  const { c, run, elements } = harness(['renderMaLegend']);
  run(formatting);
  const box = c.document.getElementById('maLegend');
  const items = [];
  const node = () => ({ style: {}, kids: [], append(t) { this.text = t; }, appendChild(k) { this.kids.push(k); } });
  c.document.createElement = () => node();
  box.appendChild = (s) => items.push(s);
  Object.assign(c, { cssVar: (n) => n, maColor: () => '#000' });
  run('lastProfile = null;');
  run(`lastChart = { cur: 'KRW', mas: [], trends: [], bands: { upper: [110, 120], lower: [90, 95] },
    vwapLine: [100, 102, null] };`);
  const read = () => items.map((s) => `${s.text}=${s.kids[0].textContent}`);
  run('hoverIdx = null; renderMaLegend();');
  assert.equal(elements.get('maLegend').hidden, false, '지표만 켜져 있어도 범례가 보인다');
  assert.deepEqual([...read()], ['BB=', 'VWAP=102'], '마우스를 안 올리면 VWAP 는 마지막 값(애프터 칸 앞), BB 는 비움');
  items.length = 0;
  run('hoverIdx = 0; renderMaLegend();');
  assert.deepEqual([...read()], ['BB=90~110', 'VWAP=100']);
  items.length = 0;
  run('lastChart.bands = null; lastChart.vwapLine = null; renderMaLegend();');
  assert.equal(elements.get('maLegend').hidden, true);
  // 매물대는 가장 많이 거래된 가격대를 늘 보인다
  items.length = 0;
  run('lastProfile = { lo: 100, step: 5, poc: 2, vols: [1, 2, 9] }; renderMaLegend();');
  assert.equal(elements.get('maLegend').hidden, false);
  assert.deepEqual([...read()], ['매물대=110~115']);
});

// 파라볼릭 SAR(보조 지표). 일봉 기간은 차트 첫날 앞의 5년치 일봉 고 · 저를 이어 계산한다 — SAR 은 지난 흐름을
// 이어받아서, 차트 첫 봉에서 새로 시작하면 1M 은 대부분 다른 값이 된다. 1D 는 정규장 봉만, 그날 첫 봉부터.
await test('indicators: SAR continues from the daily history on daily charts and uses regular bars only on 1D', () => {
  const { c, run } = harness(['sarFor']);
  const day = 86400000;
  const t0 = Date.parse('2026-08-01T00:00:00Z');
  const N = 40;
  const T = Array.from({ length: N }, (_, i) => t0 + i * day);
  const H = Array.from({ length: N }, (_, i) => 101 + 10 * Math.sin(i / 4));
  const L = H.map((v) => v - 2);
  run(`quotes.X = { dailyHL: { times: ${JSON.stringify(T)}, highs: ${JSON.stringify(H)}, lows: ${JSON.stringify(L)} } };`);
  // 차트는 마지막 10일. 오늘 봉은 실시간 캔들로 맞춘 값이라 일봉과 다를 수 있다 — 차트 쪽 값을 쓴다.
  const cH = H.slice(-10); const cL = L.slice(-10);
  cH[9] += 5;
  const r = run(`sarFor('X', ${JSON.stringify(T.slice(-10))}, ${JSON.stringify(cH)}, ${JSON.stringify(cL)})`);
  const full = c.parabolicSar([...H.slice(0, 30), ...cH], [...L.slice(0, 30), ...cL]);
  assert.equal(JSON.stringify(r.data), JSON.stringify(full.sar.slice(30)), '5년치 흐름을 이어 받은 값');
  assert.equal(JSON.stringify(r.up), JSON.stringify(full.up.slice(30)));
  let k = full.up.length - 1;
  while (full.up[k - 1] === full.up.at(-1)) k--;
  assert.equal(r.rising, full.up.at(-1));
  assert.equal(r.since, full.up.length - k, '전환 봉부터 센 봉 수');
  assert.equal(r.flipAt, [...T.slice(0, 30), ...T.slice(-10)][k], '전환 봉의 시각(차트 밖일 수도 있다)');
  const alone = c.parabolicSar(cH, cL);
  assert.notEqual(JSON.stringify(r.data), JSON.stringify(alone.sar), '차트 봉만으로 새로 시작한 값과 다르다');

  // 1D: 정규장 봉만으로 계산하고 시간외 칸은 비운다. 일봉 흐름은 잇지 않는다(그날 첫 봉부터).
  const t1 = Date.parse('2026-09-10T08:00:00+09:00');
  const times = [0, 1, 2, 3, 4, 5].map((i) => t1 + i * 300000);
  const h1 = [50, 101, 103, 104, 102, 60];
  const l1 = [49, 99, 101, 102, 98, 59];
  const ext = ['pre', null, null, null, null, 'after'];
  const d = run(`sarFor('X', ${JSON.stringify(times)}, ${JSON.stringify(h1)}, ${JSON.stringify(l1)}, ${JSON.stringify(ext)})`);
  const reg = c.parabolicSar(h1.slice(1, 5), l1.slice(1, 5));
  assert.equal(JSON.stringify(d.data), JSON.stringify([null, ...reg.sar, null]), '시간외 칸은 비우고 정규장 봉만으로');
  assert.equal(d.up[0], null);
  assert.equal(d.up[5], null);

  run('delete quotes.X;');
  const bare = run(`sarFor('X', ${JSON.stringify(T.slice(-10))}, ${JSON.stringify(cH)}, ${JSON.stringify(cL)})`);
  assert.equal(JSON.stringify(bare.data), JSON.stringify(alone.sar), '일봉이 없으면 차트 봉만으로');
  assert.equal(run('sarFor("X", [1], [1], [1])'), null, '봉이 모자라면 없다');
});

await test('indicators: loadChart passes SAR on 1D, 1W and the daily periods only, and only when the chip is on', async () => {
  const { c, run } = harness(['loadChart', 'sarFor']);
  const draws = [];
  let bars;
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '', renderPeriod: () => {},
    renderMaChips: () => {}, renderCrossBadge: () => {}, curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run("let lastDrawSig = null; quotes['005930.KS'] = { price: 104, prevClose: 100, change: 4 };");
  const series = (n) => ({ ok: true, closes: Array.from({ length: n }, (_, i) => 100 + (i % 4)),
    times: Array.from({ length: n }, (_, i) => Date.parse('2026-09-01T00:00:00Z') + i * 86400000),
    volumes: new Array(n).fill(1), opens: Array.from({ length: n }, (_, i) => 100 + (i % 4)),
    highs: Array.from({ length: n }, (_, i) => 101 + (i % 4)), lows: Array.from({ length: n }, (_, i) => 99 + (i % 4)) });
  const show = async (tf, on) => {
    bars = series(8);
    run(`lastDrawSig = null; state.timeframe = '${tf}'; state.indicators = cleanIndicators({ sar: ${on} });`);
    await c.loadChart();
    return draws.at(-1).sar;
  };
  for (const tf of ['1D', '1W', '1M', '3M', '1Y', '3Y']) assert.ok(await show(tf, true), `${tf} 에는 그린다`);
  assert.equal((await show('1M', true)).data.length, 8);
  assert.equal(await show('전체', true), null, '전체(월봉 · 분기봉)도 그리지 않는다');
  assert.equal(await show('1M', false), null, '칩을 끄면 없다');
});

await test('loadChart redraws when only a quote-derived overlay changes (first chart drawn before the daily quote)', async () => {
  // 켠 직후 첫 차트는 시세 없이 그린다. 이동평균 칩을 다 끈 1M 은 봉 · 가로선이 그대로라, 손으로 고른 서명으로는
  // 일봉이 와도 다시 그리지 않아 볼린저가 빠진 채 남았다(2026-11-05).
  const { c, run } = harness(['loadChart', 'bandFor', 'alignByDay']);
  const draws = [];
  const day = (i) => Date.parse('2026-08-01T00:00:00Z') + i * 86400000;
  const n = 8;
  const bars = { ok: true, closes: Array.from({ length: n }, (_, i) => 100 + (i % 4)),
    times: Array.from({ length: n }, (_, i) => day(35 + i)), volumes: new Array(n).fill(1),
    opens: Array.from({ length: n }, (_, i) => 100 + (i % 4)),
    highs: Array.from({ length: n }, (_, i) => 101 + (i % 4)), lows: Array.from({ length: n }, (_, i) => 99 + (i % 4)) };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '', renderPeriod: () => {},
    renderMaChips: () => {}, renderCrossBadge: () => {}, curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run("let lastDrawSig = null; delete quotes['005930.KS']; state.timeframe = '1M'; state.indicators = cleanIndicators({ bb: true });");
  await c.loadChart();
  assert.equal(draws.length, 1);
  assert.equal(draws[0].bands, null, '일봉이 오기 전에는 밴드가 없다');
  run(`quotes['005930.KS'] = { price: 103, prevClose: 102, change: 1, daily: {
    times: ${JSON.stringify(Array.from({ length: 43 }, (_, i) => day(i)))},
    closes: ${JSON.stringify(Array.from({ length: 43 }, (_, i) => 100 + (i % 5)))} } };`);
  await c.loadChart();
  assert.equal(draws.length, 2, '일봉이 오면 다시 그린다');
  assert.ok(draws[1].bands, '다시 그린 차트에는 밴드가 있다');
  await c.loadChart();
  assert.equal(draws.length, 2, '값이 그대로면 다시 그리지 않는다');
});

await test('indicators: SAR legend shows the direction and how long it has held, the value on hover', () => {
  const { c, run } = harness(['renderMaLegend', 'labelFor']);
  run(formatting);
  const box = c.document.getElementById('maLegend');
  const items = [];
  const node = () => ({ style: {}, kids: [], append(t) { this.text = t; }, appendChild(k) { this.kids.push(k); } });
  c.document.createElement = () => node();
  box.appendChild = (s) => items.push(s);
  Object.assign(c, { cssVar: (n) => n, maColor: () => '#000' });
  const flip = Date.parse('2026-10-09T00:00:00Z');
  run(`lastProfile = null; state.timeframe = '1M';
    lastChart = { cur: 'KRW', mas: [], trends: [], sar: { data: [null, 95000, 96000], up: [null, false, false],
      rising: false, since: 4, flipAt: ${flip} } };`);
  const read = () => items.map((s) => `${s.text}=${s.kids[0].textContent}`);
  run('hoverIdx = null; renderMaLegend();');
  assert.equal(c.document.getElementById('maLegend').hidden, false, 'SAR 만 켜져 있어도 범례가 보인다');
  assert.deepEqual([...read()], ['SAR=하락 4일째']);
  assert.equal(items[0].kids[1].style.background, '--sar-down', '하락이면 파랑 점의 색');
  assert.equal(items[0].title, `파라볼릭 SAR — ${run(`labelFor(${flip}, '1M')`)} 하락 전환 (가속 0.02 · 최대 0.2). 상승 추세면 점이 봉 아래, 하락 추세면 봉 위`
    + `\n\n${run('SAR_EVIDENCE')}`, '과거 검증 — 매매 신호가 아니었다(2026-11-03)');
  assert.match(items[0].title, /\n· 빨강 · 파랑은 방향\(위로 · 아래로\)일 뿐 매매 신호가 아니었다$/);
  items.length = 0;
  run('hoverIdx = 1; renderMaLegend();');
  assert.deepEqual([...read()], ['SAR=95,000'], '마우스를 올리면 그 봉의 SAR');
  items.length = 0;
  const at = Date.parse('2026-10-15T13:20:00+09:00');
  run(`hoverIdx = null; state.timeframe = '1D'; lastChart.sar.rising = true; lastChart.sar.flipAt = ${at}; renderMaLegend();`);
  assert.deepEqual([...read()], [`SAR=상승 · ${run(`labelFor(${at}, '1D')`)}부터`], '1D 는 일 대신 전환 시각');
  assert.equal(items[0].kids[1].style.background, '--sar-up');
  items.length = 0;
  run("state.timeframe = '1W'; renderMaLegend();");
  assert.deepEqual([...read()], [`SAR=상승 · ${run(`labelFor(${at}, '1W')`)}부터`], '1W 도 전환 시각(1W 축과 같은 날짜 · 시)');
});

await test('indicators: drawChart draws SAR as dots on the price axis, red below a rising trend and blue above a falling one', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: (_hex, a) => `a${a}`, cssVar: (n) => n,
  });
  run(`state.timeframe = '1M';
    var C_ = [100, 101, 102, 103];
    var arg_ = { closes: C_, times: [1, 2, 3, 4], up: true, volumes: [1, 1, 1, 1], highs: C_, lows: C_,
      sar: { data: [null, 99, 100, 104], up: [null, true, true, false] } };`);
  run('drawChart(arg_);');
  const dots = configs.at(-1).data.datasets.find((d) => d.showLine === false);
  assert.ok(dots, '선 없이 점만');
  assert.equal(dots.yAxisID, 'y');
  assert.equal(JSON.stringify(dots.data), '[null,99,100,104]');
  assert.equal(JSON.stringify(dots.pointBackgroundColor.slice(1)), '["--sar-up","--sar-up","--sar-down"]');
  assert.ok(dots.pointRadius > 0 && dots.pointHitRadius === 0, '점은 보이되 마우스 대상은 아니다');
  run('arg_.sar = null; drawChart(arg_);');
  assert.equal(configs.at(-1).data.datasets.some((d) => d.showLine === false), false);
});

// RSI · 시그널(보조 지표). 일봉 기간은 5년치 일봉 종가로 계산해 날짜로 맞춘다(첫 봉부터 값). 1D 는 앞 거래일 5분봉을 앞에
// 이어 장 초반부터 값이 있고 날을 넘어 이어진다. 교차는 확정된 것만(마지막 봉은 진행 중) — 골든 · 데드와 같은 규칙.
await test('indicators: RSI continues from the daily history, 1D from the earlier bars, and marks only finished crosses', () => {
  const { c, run } = harness(['rsiFor']);
  const day = 86400000;
  const t0 = Date.parse('2026-06-01T00:00:00Z');
  const N = 80;
  const T = Array.from({ length: N }, (_, i) => t0 + i * day);
  const C = Array.from({ length: N }, (_, i) => 100 + 8 * Math.sin(i / 2.5) + (i % 3));
  // 마지막 봉(진행 중)에서 RSI 가 시그널을 뚫게 만든다 — 표시하지 않아야 한다
  {
    const r = c.rsiSeries(C); const g = c.rsiSignal(r);
    C[N - 1] = C[N - 2] * (r[N - 2] < g[N - 2] ? 1.5 : 0.5);
  }
  const full = c.rsiSeries(C);
  const sig = c.rsiSignal(full);
  run(`quotes.X = { daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} } }; state.timeframe = '1M';`);
  const r = run(`rsiFor('X', ${JSON.stringify(T.slice(-20))}, ${JSON.stringify(C.slice(-20))}, null)`);
  assert.equal(JSON.stringify(r.data), JSON.stringify(full.slice(-20)), '5년치 흐름을 이어 받은 값 — 첫 봉부터 있다');
  assert.equal(JSON.stringify(r.signal), JSON.stringify(sig.slice(-20)));
  const raw = c.crossings(full.slice(-20), sig.slice(-20));
  assert.equal(raw.at(-1).i, 19, '마지막 봉에서 뚫었다');
  const done = raw.filter((x) => x.i < 19);
  assert.ok(done.length >= 2, '이 가짜 주가에는 확정된 교차가 있다');
  assert.equal(JSON.stringify(r.crosses.map((x) => [x.i, x.golden])), JSON.stringify(done.map((x) => [x.i, x.golden])),
    '마지막 봉의 교차는 빼고');
  assert.equal(r.rising, done.at(-1).golden, '마지막 확정 교차의 방향');
  assert.equal(r.since, 20 - done.at(-1).i, '교차한 봉부터 센 봉 수');
  assert.equal(r.flipAt, T.slice(-20)[done.at(-1).i]);
  assert.equal(r.pending, null, '일봉 기간은 진행 중인 교차를 보이지 않는다(오늘 봉이 하루 내내 진행 중이다)');

  // 1D: 앞 거래일 봉(warm)을 앞에 잇는다 — 첫 봉부터 RSI · 시그널, 교차도 이은 흐름에서
  run("state.timeframe = '1D';");
  const d = run(`rsiFor('X', ${JSON.stringify(T.slice(60))}, ${JSON.stringify(C.slice(60))}, { closes: ${JSON.stringify(C.slice(0, 60))} })`);
  assert.equal(JSON.stringify(d.data), JSON.stringify(full.slice(60)), '앞 거래일을 이은 값');
  assert.equal(JSON.stringify(d.signal), JSON.stringify(sig.slice(60)));
  assert.ok(d.data[0] != null && d.signal[0] != null, '장 초반(첫 봉)부터 있다');
  const want = c.crossings(full, sig).filter((x) => x.i >= 60 && x.i < N - 1).map((x) => x.i - 60);
  assert.equal(JSON.stringify(d.crosses.map((x) => x.i)), JSON.stringify(want));
  // 1D 는 진행 중인 마지막 봉의 교차를 따로 준다 — drawChart 가 테두리 점으로 그린다(확정 교차 · 범례에는 넣지 않는다)
  assert.equal(JSON.stringify(d.pending && [d.pending.i, d.pending.golden]), JSON.stringify([19, raw.at(-1).golden]));
  assert.ok(!d.crosses.some((x) => x.i === 19));
  const calm = run(`rsiFor('X', ${JSON.stringify(T.slice(60, 79))}, ${JSON.stringify(C.slice(60, 79))}, { closes: ${JSON.stringify(C.slice(0, 60))} })`);
  assert.equal(calm.pending, null, '마지막 봉에서 뚫지 않았으면 없다');
  run("state.timeframe = '1W';");
  assert.equal(run(`rsiFor('X', ${JSON.stringify(T.slice(60))}, ${JSON.stringify(C.slice(60))}, { closes: ${JSON.stringify(C.slice(0, 60))} })`).pending,
    null, '1W 도 보이지 않는다(1D 만)');
  run("state.timeframe = '1D';");
  // 앞 거래일 봉을 못 받으면 오늘 봉만으로 — 앞 14봉은 빈다
  const bare = run(`rsiFor('X', ${JSON.stringify(T.slice(60))}, ${JSON.stringify(C.slice(60))}, null)`);
  assert.ok(bare.data.slice(0, 14).every((v) => v === null) && bare.data[14] != null);
  assert.equal(run(`rsiFor('X', [1, 2], [1, 2], null)`), null, '봉이 모자라면 없다');

  run("state.timeframe = '1M'; delete quotes.X;");
  assert.equal(run(`rsiFor('X', ${JSON.stringify(T.slice(-20))}, ${JSON.stringify(C.slice(-20))}, null)`), null, '일봉이 없으면 없다');
});

await test('indicators: a daily-period RSI cross on the first visible bar counts — compared with the trading day before, like 1D', () => {
  // 보이는 구간만 잘라 견주던 때는 첫 봉에서 뚫은 교차가 늘 빠졌다 — 그것뿐이면 범례가 "확정된 교차가 없습니다" 였다(2026-11-06)
  const { c, run } = harness(['rsiFor']);
  const t0 = Date.parse('2026-06-01T00:00:00Z');
  const N = 80;
  const T = Array.from({ length: N }, (_, i) => t0 + i * 86400000);
  const C = Array.from({ length: N }, (_, i) => 100 + 8 * Math.sin(i / 2.5) + (i % 3));
  const full = c.rsiSeries(C);
  const at = c.crossings(full, c.rsiSignal(full)).find((x) => x.i >= 30 && x.i < N - 5);
  assert.ok(at, '이 가짜 주가에는 가운데쯤 교차가 있다');
  run(`quotes.X = { daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} } }; state.timeframe = '1M';`);
  const r = run(`rsiFor('X', ${JSON.stringify(T.slice(at.i))}, ${JSON.stringify(C.slice(at.i))}, null)`);
  assert.equal(JSON.stringify(r.crosses[0] && [r.crosses[0].i, r.crosses[0].golden]), JSON.stringify([0, at.golden]),
    '첫 봉의 교차도 점과 범례에 든다');
});

await test('indicators: 1D RSI warm-up asks 5 days of 5-minute bars once a day and keeps those before the chart', async () => {
  const { c, run } = harness(['rsiWarmFor']);
  const asked = [];
  let reply;
  c.api.fetchChart = async (req) => { asked.push(req); return reply; };
  const t = (hhmm, d = '10') => Date.parse(`2026-09-${d}T${hhmm}:00+09:00`); // 하네스의 지금은 9/10 18:30
  reply = { ok: true, times: [t('15:20', '09'), t('15:25', '09'), t('09:00'), t('09:05')], closes: [1, 2, 3, 4],
    highs: [5, 6, 7, 8], lows: [0, 1, 2, 3] };
  // 스토캐스틱도 같은 봉을 쓴다 — 고가 · 저가도 함께
  assert.equal(JSON.stringify(await c.rsiWarmFor('X', t('09:00'))), '{"closes":[1,2],"highs":[5,6],"lows":[0,1]}', '차트 첫 봉 앞의 봉만');
  assert.deepEqual(asked.map((q) => ({ ...q })), [{ symbol: 'X', range: '5d', interval: '5m' }]);
  assert.deepEqual([...(await c.rsiWarmFor('X', t('09:00'))).closes], [1, 2]);
  assert.equal(asked.length, 1, '차트 첫 봉 뒤에 받은 것이면 다시 받지 않는다 — 지난 날 봉은 바뀌지 않는다');
  await c.rsiWarmFor('X', t('09:00', '11'));
  assert.equal(asked.length, 2, '다음 날 차트(첫 봉이 받은 시각보다 뒤)는 새로 받는다');
  reply = { ok: false, error: 'HTTP 429' };
  assert.equal(await c.rsiWarmFor('Y', t('09:00')), null, '실패하면 null — 오늘 봉만으로 계산한다');
  assert.equal(await c.rsiWarmFor('Y', t('09:00')), null);
  assert.equal(asked.length, 3, '실패한 뒤 잠시는 다시 묻지 않는다');
  run(`rsiWarmCache.get('Y 5m').at -= RSI_WARM_RETRY;`);
  await c.rsiWarmFor('Y', t('09:00'));
  assert.equal(asked.length, 4, '조금 지나면 다시 묻는다');
  // 1W 는 한 달치 30분봉 — 1D 의 5분봉과 따로 기억한다
  run("state.timeframe = '1W';");
  reply = { ok: true, times: [t('15:00', '02'), t('15:30', '02'), t('09:00')], closes: [7, 8, 9] };
  assert.equal(JSON.stringify(await c.rsiWarmFor('X', t('09:00'))), '{"closes":[7,8],"highs":[7,8],"lows":[7,8]}',
    '고가 · 저가가 없으면 종가로');
  assert.deepEqual({ ...asked.at(-1) }, { symbol: 'X', range: '1mo', interval: '30m' });
  assert.equal(asked.length, 5, '1D 에 받은 5분봉을 쓰지 않는다');
});

await test('indicators: loadChart passes RSI on 1D, 1W and the daily periods only, warming 1D and 1W up with the earlier bars', async () => {
  const { c, run } = harness(['loadChart', 'rsiFor']);
  const draws = [];
  const warms = [];
  let bars;
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '', renderPeriod: () => {},
    renderMaChips: () => {}, renderCrossBadge: () => {}, curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
    rsiWarmFor: async (symbol, first) => { warms.push([symbol, first]); return { closes: Array.from({ length: 30 }, (_, i) => 100 + (i % 7)) }; },
  });
  const n = 20;
  const T = Array.from({ length: n }, (_, i) => Date.parse('2026-08-20T00:00:00Z') + i * 86400000);
  const C = Array.from({ length: n }, (_, i) => 100 + (i % 4));
  const D = Array.from({ length: 60 }, (_, i) => Date.parse('2026-07-11T00:00:00Z') + i * 86400000);
  run(`let lastDrawSig = null; quotes['005930.KS'] = { price: 104, prevClose: 100, change: 4,
    daily: { times: ${JSON.stringify(D)}, closes: ${JSON.stringify(D.map((_, i) => 100 + (i % 5)))} } };`);
  const show = async (tf, on) => {
    bars = { ok: true, closes: C.slice(), times: T.slice(), volumes: new Array(n).fill(1), opens: C.slice(),
      highs: C.map((v) => v + 1), lows: C.map((v) => v - 1) };
    run(`lastDrawSig = null; state.timeframe = '${tf}'; state.indicators = cleanIndicators({ rsi: ${on} });`);
    await c.loadChart();
    return draws.at(-1).rsi;
  };
  for (const tf of ['1D', '1W', '1M', '3M', '1Y', '3Y']) assert.ok(await show(tf, true), `${tf} 에는 그린다`);
  assert.deepEqual(warms, [['005930.KS', T[0]], ['005930.KS', T[0]]], '앞 거래일 봉은 1D · 1W 에서만, 차트 첫 봉 시각으로 묻는다');
  assert.ok((await show('1D', true)).data[0] != null, '1D 는 첫 봉부터');
  assert.ok((await show('1W', true)).data[0] != null, '1W 도 첫 봉부터');
  assert.equal(await show('전체', true), null, '전체(월봉 · 분기봉)는 그리지 않는다');
  warms.length = 0;
  assert.equal(await show('1D', false), null, '칩을 끄면 없다');
  assert.equal(warms.length, 0, '칩이 꺼져 있으면 앞 거래일 봉도 받지 않는다');
});

// 스토캐스틱(14 · 1 · 3)은 RSI 칸 자리에 — 일봉 기간은 SAR 처럼 차트 앞 일봉 고 · 저 · 종을, 1D · 1W 는 RSI 의 앞 거래일 봉을 이어
// 첫 봉부터 값이 있다. RSI 와 함께 켜져 오면(백업) RSI 만.
await test('indicators: loadChart passes the stochastic in the RSI pane spot, warmed up so it starts at the first bar', async () => {
  const { c, run } = harness(['loadChart', 'rsiFor', 'stochFor']);
  const draws = [];
  const warms = [];
  let bars;
  const W = Array.from({ length: 30 }, (_, i) => 100 + (i % 7));
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '', renderPeriod: () => {},
    renderMaChips: () => {}, renderCrossBadge: () => {}, curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
    rsiWarmFor: async (symbol, first) => { warms.push(first); return { closes: W, highs: W.map((v) => v + 2), lows: W.map((v) => v - 2) }; },
  });
  const n = 20;
  const T = Array.from({ length: n }, (_, i) => Date.parse('2026-08-20T00:00:00Z') + i * 86400000);
  const C = Array.from({ length: n }, (_, i) => 100 + (i % 4));
  const D = Array.from({ length: 60 }, (_, i) => Date.parse('2026-07-11T00:00:00Z') + i * 86400000); // 앞 40일이 차트 앞
  const DC = D.map((_, i) => 100 + (i % 5));
  run(`let lastDrawSig = null; quotes['005930.KS'] = { price: 104, prevClose: 100, change: 4,
    daily: { times: ${JSON.stringify(D)}, closes: ${JSON.stringify(DC)} },
    dailyHL: { times: ${JSON.stringify(D)}, highs: ${JSON.stringify(DC.map((v) => v + 3))}, lows: ${JSON.stringify(DC.map((v) => v - 3))} } };`);
  const show = async (tf, ind) => {
    bars = { ok: true, closes: C.slice(), times: T.slice(), volumes: new Array(n).fill(1), opens: C.slice(),
      highs: C.map((v) => v + 1), lows: C.map((v) => v - 1) };
    run(`lastDrawSig = null; state.timeframe = '${tf}'; state.chartMode = 'line'; state.indicators = cleanIndicators(${JSON.stringify(ind)});`);
    await c.loadChart();
    return draws.at(-1);
  };
  const m = await show('1M', { stoch: true });
  assert.equal(m.rsi, null);
  // 차트 앞 40일의 일봉 고 · 저 · 종을 앞에 이은 값
  const want = indicators.stochSeries([...DC.slice(0, 40).map((v) => v + 3), ...C.map((v) => v + 1)],
    [...DC.slice(0, 40).map((v) => v - 3), ...C.map((v) => v - 1)], [...DC.slice(0, 40), ...C]);
  assert.deepEqual([...m.stoch.k], want.k.slice(40), '일봉 기간은 차트 앞 일봉을 이어 첫 봉부터');
  assert.deepEqual([...m.stoch.d], want.d.slice(40));
  assert.ok(m.stoch.k[0] != null && m.stoch.d[0] != null);
  assert.equal(warms.length, 0, '일봉 기간은 앞 거래일 봉을 받지 않는다');
  const day = await show('1D', { stoch: true });
  assert.ok(day.stoch.k[0] != null, '1D 는 앞 거래일 봉을 이어 첫 봉부터');
  assert.deepEqual(warms, [T[0]], '스토캐스틱만 켜도 앞 거래일 봉을 받는다');
  assert.equal((await show('전체', { stoch: true })).stoch, null, '전체(월봉 · 분기봉)는 그리지 않는다');
  assert.equal((await show('1M', { stoch: false })).stoch, null, '칩을 끄면 없다');
  const both = await show('1M', { rsi: true, stoch: true });
  assert.ok(both.rsi && both.stoch === null, '둘 다 켜져 오면(백업) RSI 만');
});

await test('indicators: RSI legend says which side of the signal RSI has stayed on since the last cross', () => {
  const { c, run } = harness(['renderMaLegend', 'labelFor']);
  run(formatting);
  const box = c.document.getElementById('maLegend');
  const items = [];
  const node = () => ({ style: {}, kids: [], append(t) { this.text = t; }, appendChild(k) { this.kids.push(k); } });
  c.document.createElement = () => node();
  box.appendChild = (s) => items.push(s);
  Object.assign(c, { cssVar: (n) => n, maColor: () => '#000' });
  const flip = Date.parse('2026-10-09T00:00:00Z');
  run(`lastProfile = null; state.timeframe = '1M';
    lastChart = { cur: 'KRW', mas: [], trends: [], rsi: { data: [null, 40, 55, 60], signal: [null, 45, 50, 52],
      crosses: [{ i: 2, golden: true }], rising: true, since: 2, flipAt: ${flip} } };`);
  const read = () => items.map((s) => `${s.text}=${s.kids[0].textContent}`);
  run('hoverIdx = null; renderMaLegend();');
  assert.equal(box.hidden, false, 'RSI 만 켜져 있어도 범례가 보인다');
  assert.deepEqual([...read()], ['RSI=상향 2일째']);
  assert.equal(items[0].kids[1].style.background, '--rsi-line');
  assert.equal(items[0].title, `RSI(14) · 시그널(RSI 9봉 평균) — ${run(`labelFor(${flip}, '1M')`)} 상향 교차. `
    + `차트 아래 칸에 선, 시그널을 위로 뚫은 봉은 빨강 · 아래로 뚫은 봉은 파랑 점\n\n${run('RSI_CROSS_EVIDENCE')}`, '과거 검증(2026-11-03)');
  items.length = 0;
  run('hoverIdx = 1; renderMaLegend();');
  assert.deepEqual([...read()], ['RSI=상향 2일째'], '마우스를 올려도 그대로 — 그 봉의 값은 툴팁에 있다');
  items.length = 0;
  const at = Date.parse('2026-10-15T13:20:00+09:00');
  run(`hoverIdx = null; state.timeframe = '1D'; lastChart.rsi.rising = false; lastChart.rsi.flipAt = ${at}; renderMaLegend();`);
  assert.deepEqual([...read()], [`RSI=하향 · ${run(`labelFor(${at}, '1D')`)}부터`], '1D 는 교차 시각');
  items.length = 0;
  run('lastChart.rsi.rising = null; lastChart.rsi.since = null; lastChart.rsi.flipAt = null; renderMaLegend();');
  assert.deepEqual([...read()], ['RSI=60 · 시그널 52'], '확정된 교차가 없으면 지금 값');
});

await test('indicators: drawChart puts RSI and its signal in their own pane under the price, with dots on finished crosses', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: (_hex, a) => `a${a}`, cssVar: (n) => n,
  });
  run(`state.timeframe = '1M';
    var C_ = [100, 101, 102, 103];
    var arg_ = { closes: C_, times: [1, 2, 3, 4], up: true, volumes: [1, 1, 1, 1], highs: C_, lows: C_,
      rsi: { data: [null, 40, 55, 60], signal: [null, 45, 50, 52], crosses: [{ i: 2, y: 55, golden: true }],
        rising: true, since: 2, flipAt: 3 } };`);
  run('drawChart(arg_);');
  const cfg = configs.at(-1);
  const axis = cfg.options.scales.yRsi;
  const { y, yVol } = cfg.options.scales;
  // 눈금은 보이는 RSI · 시그널의 최저~최고(rsiScale) — 0~100 이면 선이 납작했다. 숫자는 rsiScale 이 고른 자리에만,
  // 가격 눈금과 같은 오른쪽 줄에. 격자 · 축 선은 없다(기준선은 데이터셋)
  const want = run('rsiScale([null, 40, 55, 60, null, 45, 50, 52])');
  assert.equal(axis.min, want.min);
  assert.equal(axis.max, want.max);
  assert.ok(axis.max - axis.min < 100, '0~100 보다 좁다');
  const tickAxis = {};
  axis.afterBuildTicks(tickAxis);
  assert.deepEqual([...tickAxis.ticks].map((t) => t.value), [...want.ticks], '눈금 숫자');
  assert.equal(axis.ticks.autoSkip, false, '칸이 낮아도 숫자를 건너뛰지 않는다');
  assert.equal(axis.grid.display, false);
  assert.equal(axis.border.display, false);
  // 가격 축(y)과 같은 오른쪽 stack 에 쌓는다 — 위가 가격 칸, 아래가 RSI 칸(RSI_PANE 만큼)
  assert.equal(axis.position, 'right');
  assert.ok(axis.stack && axis.stack === y.stack, 'y 와 같은 stack');
  assert.equal(axis.stackWeight, run('RSI_PANE'));
  const ctx = { chart: { height: 195 } }; // 기본 창 높이에서 RSI 를 켰을 때의 차트 상자
  const pw = y.stackWeight(ctx);
  assert.equal(pw, 195 - 22 - run('RSI_PANE'), '그림 높이(날짜 줄 · 여백 약 22px 제외)에서 RSI 칸을 뺀 나머지가 가격 칸');
  assert.ok(Math.abs(axis.stackWeight / (pw + axis.stackWeight) * (195 - 22) - run('RSI_PANE')) < 1e-9, 'RSI 칸이 약 RSI_PANE px');
  assert.equal(y.stackWeight({ chart: { height: 30 } }), run('RSI_PANE'), '아주 작아도 가격 칸이 사라지지 않는다');
  // 거래량 축은 그림 전체 높이 — 바닥을 음수로 내려 0 이 가격 칸 바닥(아래에서 RSI 칸 비율)에 온다. 천장은 그대로 4배
  const vmin = yVol.min(ctx);
  assert.equal(yVol.max, 4, '거래량 최댓값(1)의 4배');
  assert.ok(Math.abs(-vmin / (yVol.max - vmin) - axis.stackWeight / (pw + axis.stackWeight)) < 1e-9, '거래량 0 = 가격 칸 바닥');
  assert.ok(Math.abs(1 / (yVol.max - vmin) - (1 / 4) * pw / (pw + axis.stackWeight)) < 1e-9, '막대는 가격 칸 아래 1/4');
  // RSI 크게 보기 — RSI 칸이 RSI_TALL. 상자가 그만큼 커져(240px) 가격 칸은 그대로다
  run('rsiTall = true; drawChart(arg_);');
  const tall = configs.at(-1).options.scales;
  const tctx = { chart: { height: 195 - run('RSI_PANE') + run('RSI_TALL') } };
  assert.equal(run('RSI_TALL'), 90, 'RSI 칸의 2배');
  assert.equal(tall.yRsi.stackWeight, run('RSI_TALL'));
  assert.equal(tall.y.stackWeight(tctx), pw, '가격 칸은 크게 보기 전과 같다');
  const tvmin = tall.yVol.min(tctx);
  assert.ok(Math.abs(-tvmin / (tall.yVol.max - tvmin) - run('RSI_TALL') / (pw + run('RSI_TALL'))) < 1e-9, '거래량 0 = 가격 칸 바닥');
  run('rsiTall = false;');
  const on = cfg.data.datasets.filter((d) => d.yAxisID === 'yRsi');
  assert.ok(on.every((d) => d.order < 0 && d.order > -1), '거래량 평균선(0) 위');
  assert.ok(on.every((d) => !d.pointHitRadius), '마우스 대상은 주가선 하나다');
  const line = on.find((d) => JSON.stringify(d.data) === '[null,40,55,60]' && d.showLine !== false);
  assert.equal(line.borderColor, 'a0.7', 'RSI 는 옅은 실선');
  assert.equal(line.borderDash, undefined);
  const sig = on.find((d) => JSON.stringify(d.data) === '[null,45,50,52]');
  assert.ok(sig.borderDash, '시그널은 점선');
  assert.ok(!on.some((d) => d.data.every((v) => v === 30 || v === 70)), '범위(38~62) 밖 기준선은 그리지 않는다 — 그리면 가격 칸에 그어진다');
  const dots = on.find((d) => d.showLine === false);
  assert.equal(JSON.stringify(dots.data), '[null,null,55,null]', '확정된 교차 봉에만 점');
  assert.equal(dots.pointBackgroundColor[2], run('UP'), '위로 뚫으면 빨강');
  assert.equal(dots.pointBorderWidth[2], 0, '확정된 교차는 속이 찬 점');
  // 1D 진행 중인 마지막 봉의 교차(pending)는 테두리만 — 봉이 끝나 확정되면 속이 찬 점이 된다
  run('arg_.rsi = { ...arg_.rsi, pending: { i: 3, golden: false } }; drawChart(arg_);');
  const open = configs.at(-1).data.datasets.find((d) => d.yAxisID === 'yRsi' && d.showLine === false);
  assert.equal(JSON.stringify(open.data), '[null,null,55,60]', '진행 중인 교차 봉에도 점');
  assert.equal(open.pointBackgroundColor[3], 'transparent', '속은 비우고');
  assert.equal(open.pointBorderColor[3], run('DOWN'), '테두리는 방향 색');
  assert.ok(open.pointBorderWidth[3] > 0);
  assert.equal(open.pointBackgroundColor[2], run('UP'), '확정된 점은 그대로');
  run('arg_.rsi = { ...arg_.rsi, pending: null };');
  const footer = cfg.options.plugins.tooltip.callbacks.footer([{ datasetIndex: 0, dataIndex: 2, dataset: {} }]);
  assert.ok(footer.includes('RSI 55.0 · 시그널 50.0'), '툴팁에 그 봉의 RSI · 시그널');
  assert.equal(cfg.options.plugins.tooltip.callbacks.footer([{ datasetIndex: 0, dataIndex: 0, dataset: {} }])
    .some((l) => l.startsWith('RSI')), false, '값이 없는 봉은 줄이 없다');
  run('arg_.rsi = { ...arg_.rsi, crosses: [{ i: 1, y: 40, golden: false }] }; drawChart(arg_);');
  assert.equal(configs.at(-1).data.datasets.find((d) => d.yAxisID === 'yRsi' && d.showLine === false).pointBackgroundColor[1],
    run('DOWN'), '아래로 뚫으면 파랑');
  run('arg_.rsi = { ...arg_.rsi, data: [null, 40, 85, 60] }; drawChart(arg_);');
  const wide = configs.at(-1).data.datasets.filter((d) => d.yAxisID === 'yRsi');
  assert.ok(wide.some((d) => d.data.every((v) => v === 70)), '70 이 범위 안이면 기준선');
  assert.ok(!wide.some((d) => d.data.every((v) => v === 30)), '30 은 아직 범위 밖');
  run('arg_.rsi = null; drawChart(arg_);');
  assert.equal(configs.at(-1).data.datasets.some((d) => d.yAxisID === 'yRsi'), false);
  assert.equal(configs.at(-1).options.scales.yRsi, undefined, 'RSI 를 끄면 축도 없다');
  assert.equal(configs.at(-1).options.scales.y.stack, undefined, '가격이 그림 전체 높이를 쓴다');
  assert.equal(configs.at(-1).options.scales.yVol.min, undefined, '거래량도 예전처럼 그림 바닥부터');
});

// 가격 축은 보이는 봉의 고 · 저 · 종가에만 맞춘다 — 볼린저 · 지수 비교선 · 이동평균까지 넣으면 범위가 넓어지고 눈금 반올림
// (최대 4개, 1 · 2 · 5 단위)으로 또 넓어져 같은 차트가 덧그림을 켜면 3배 넘게 납작했다(2026-11-04 KB금융 1M).
await test('chart: the price axis fits the visible prices only, so overlays do not flatten the line', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: () => 'x', cssVar: (n) => n,
  });
  run(`state.timeframe = '1M';
    var C_ = [150, 160, 155, 152];
    var arg_ = { closes: C_, times: [1, 2, 3, 4], up: true, volumes: [1, 1, 1, 1], highs: [152, 162, 157, 153], lows: [148, 158, 150, 151],
      mas: [{ p: 60, data: [180, 180, 180, 180] }], bands: { upper: [190, 190, 190, 190], mid: [170, 170, 170, 170], lower: [120, 120, 120, 120] },
      benchLine: { name: '코스피', data: [150, 140, 130, 120] } };
    drawChart(arg_);`);
  // Chart.js 가 덧그림까지 넣어 정한 끝(120~190)을 afterDataLimits 가 주가 범위로 바꾼다. 못 박지는 않는다(min · max 없음) —
  // 그래야 Chart.js 가 1 · 2 · 5 단위로 넓혀 눈금을 2개 넘게 단다
  const fit = () => { const y = configs.at(-1).options.scales.y; const s = { min: 120, max: 190 }; y.afterDataLimits(s); return [y.min, y.max, s.min, s.max]; };
  assert.deepEqual(fit(), [undefined, undefined, 148, 162], '저가 148 ~ 고가 162');
});

await test('indicators: the RSI pane fits the visible bars when zoomed, like the price axis', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: () => 'x', cssVar: (n) => n,
  });
  const day = 86400000;
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  // 앞 10봉은 RSI 90, 그 뒤는 40~59
  run(`state.timeframe = '1Y';
    var T_ = Array.from({ length: 30 }, (_, i) => ${t0} + i * ${day});
    var C_ = Array.from({ length: 30 }, (_, i) => 100 + i);
    var arg_ = { closes: C_, times: T_, up: true, volumes: C_.map(() => 10), highs: C_, lows: C_,
      rsi: { data: C_.map((_, i) => (i < 10 ? 90 : 40 + (i % 20))), signal: C_.map(() => null), crosses: [] } };`);
  run('drawChart(arg_);');
  assert.ok(configs.at(-1).options.scales.yRsi.max > 90, '전체면 90 까지');
  run('zoom = { start: T_[10], end: T_[19] }; drawChart(arg_);');
  const axis = configs.at(-1).options.scales.yRsi;
  const want = run('rsiScale([50, 51, 52, 53, 54, 55, 56, 57, 58, 59])');
  assert.equal(axis.min, want.min, '확대하면 보이는 봉(50~59)으로');
  assert.equal(axis.max, want.max);
  // 가격 축도 보이는 봉(10~19번째, 110~119)으로
  const s = { min: 0, max: 999 };
  configs.at(-1).options.scales.y.afterDataLimits(s);
  assert.deepEqual([s.min, s.max], [110, 119], '확대하면 가격 축도 보이는 봉으로');
});

// 스토캐스틱은 RSI 칸 자리(같은 축 yRsi · 같은 높이)에 K 실선 · D 점선 · 20 · 80 기준선. 늘 0~100 을 거의 다 써서 눈금은 0~100 에
// 20 · 80. 교차 점은 없다. 범례는 지금 K · D, 툴팁은 그 봉의 K · D.
await test('indicators: the stochastic takes the RSI pane with K, D and the 20 / 80 guides, and shows in the legend and tooltip', () => {
  const { c, run } = harness(['drawChart', 'labelFor', 'renderMaLegend']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, bindChartLeave() {}, maColor: () => '#000',
    hexA: (_hex, a) => `a${a}`, cssVar: (n) => n,
  });
  const items = [];
  const node = () => ({ style: {}, kids: [], append(t) { this.text = t; }, appendChild(k) { this.kids.push(k); } });
  c.document.createElement = () => node();
  c.document.getElementById('maLegend').appendChild = (s) => items.push(s);
  run(`state.timeframe = '1M'; lastProfile = null;
    var C_ = [100, 101, 102, 103];
    var arg_ = { closes: C_, times: [1, 2, 3, 4], up: true, volumes: [1, 1, 1, 1], highs: C_, lows: C_, mas: [], trends: [],
      stoch: { k: [null, 40, 72.4, 30], d: [null, null, 65.2, 47.5] } };
    drawChart(arg_);`);
  const cfg = configs.at(-1);
  const axis = cfg.options.scales.yRsi;
  assert.equal(axis.min, 0);
  assert.equal(axis.max, 100);
  const tickAxis = {};
  axis.afterBuildTicks(tickAxis);
  assert.deepEqual([...tickAxis.ticks].map((t) => t.value), [20, 80], '눈금 숫자는 20 · 80');
  assert.equal(axis.stackWeight, run('RSI_PANE'), 'RSI 칸과 같은 높이');
  assert.ok(axis.stack && axis.stack === cfg.options.scales.y.stack, '가격 칸 아래에 쌓는다');
  const on = cfg.data.datasets.filter((d) => d.yAxisID === 'yRsi');
  const k = on.find((d) => JSON.stringify(d.data) === '[null,40,72.4,30]');
  assert.equal(k.borderColor, 'a0.7', 'K 는 옅은 실선');
  assert.equal(k.borderDash, undefined);
  assert.ok(on.find((d) => JSON.stringify(d.data) === '[null,null,65.2,47.5]').borderDash, 'D 는 점선');
  assert.ok(on.some((d) => d.data.every((v) => v === 20)) && on.some((d) => d.data.every((v) => v === 80)), '20 · 80 기준선');
  assert.ok(!on.some((d) => d.showLine === false), '교차 점은 없다');
  assert.ok(on.every((d) => d.order < 0 && d.order > -1 && !d.pointHitRadius));
  const footer = cfg.options.plugins.tooltip.callbacks.footer([{ datasetIndex: 0, dataIndex: 2, dataset: {} }]);
  assert.ok(footer.includes('스토 K 72.4 · D 65.2'), '툴팁에 그 봉의 K · D');
  assert.equal(cfg.options.plugins.tooltip.callbacks.footer([{ datasetIndex: 0, dataIndex: 0, dataset: {} }])
    .some((l) => l.startsWith('스토')), false, '값이 없는 봉은 줄이 없다');
  const legend = items.map((s) => `${s.text}=${s.kids[0].textContent}`);
  assert.deepEqual(legend, ['스토=K 30 · D 48'], '범례는 지금 K · D');
  assert.equal(items[0].kids[1].style.background, '--stoch-line');
  assert.equal(c.document.getElementById('maLegend').hidden, false, '스토캐스틱만 켜져 있어도 범례가 보인다');
  run('arg_.stoch = null; drawChart(arg_);');
  assert.equal(configs.at(-1).options.scales.yRsi, undefined, '끄면 칸도 없다');
});

// 지수 대비 수익률(보조 지표): 기간 배지에 종목 수익률 - 같은 기간 지수 수익률(%p).
await test('indicators: period badge adds the excess return over the index, with the index return in its tooltip', () => {
  const { run, elements } = harness(['renderPeriod']);
  run(formatting);
  run("hexA = () => 'bg'; cssVar = () => '#888';");
  const el = () => elements.get('period');
  run("state.timeframe = '1M'; renderPeriod(100, 105.2, { name: '코스피', pct: 2.1 });");
  assert.equal(el().hidden, false);
  assert.match(el().innerHTML, /^1M \+5\.20%<span style="color:#e24b4a"> · 초과 \+3\.10%p<\/span>$/, el().innerHTML);
  assert.equal(el().title, '같은 기간 코스피 +2.10% — 종목이 3.10%포인트 앞섬');
  run("renderPeriod(100, 101, { name: '코스닥', pct: 4 });");
  assert.match(el().innerHTML, /초과 -3\.00%p/);
  assert.match(el().innerHTML, /color:#185fa5/, '뒤처지면 파랑');
  assert.match(el().title, /3\.00%포인트 뒤처짐/);
  run('renderPeriod(100, 101);');
  assert.equal(el().innerHTML, '1M +1.00%', '끄면 예전 그대로');
  assert.equal(el().title, '');
  run("state.timeframe = '1D'; renderPeriod(100, 101, { name: '코스피', pct: 1 });");
  assert.equal(el().hidden, true, '1D 는 기간 배지가 없다');
});

await test('indicators: loadChart fetches the matching index with the chart — KOSPI, KOSDAQ or S&P 500 — and uses the live index value', async () => {
  const { c, run } = harness(['loadChart', 'alignByDay', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const asked = [];
  const periods = [];
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  const series = (closes) => ({ ok: true, closes, times: closes.map((_, i) => day(`2026-09-0${i + 1}`)),
    volumes: closes.map(() => 1), opens: closes, highs: closes, lows: closes });
  const charts = { '^KS11': series([2000, 2100]), '^KQ11': series([800, 760]), '^GSPC': series([5000, 5100]) };
  Object.assign(c, {
    fetchChartCached: async (s) => { asked.push(s); return charts[s] || series([100, 110]); },
    err: () => {}, quoteErrText: () => '', renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW', drawChart: () => {},
    renderPeriod: (first, last, rel) => periods.push({ first, last, rel }),
  });
  run("let lastDrawSig = null; state.watchlist = [{ symbol: '005930.KS', name: 'a' }, { symbol: '247540.KQ', name: 'b' }, { symbol: 'SOXL', name: 'c' }];");
  const view = async (symbol, tf = '1M', rel = true) => {
    asked.length = 0;
    run(`lastDrawSig = null; state.selected = '${symbol}'; state.timeframe = '${tf}';
      state.indicators = cleanIndicators({ rel: ${rel} }); quotes['${symbol}'] = { price: 110, prevClose: 100, change: 10 };`);
    await c.loadChart();
    return periods.at(-1);
  };
  let p = await view('005930.KS');
  assert.deepEqual([...asked], ['005930.KS', '^KS11'], '코스피 상장은 코스피');
  assert.equal(p.rel.name, '코스피');
  assert.equal(p.rel.pct, 5, '지수 차트 마지막 값으로');
  run("quotes['^KS11'] = { price: 2200 };"); // 위 지수 줄의 실시간 값
  p = await view('005930.KS');
  assert.equal(p.rel.pct, 10, '국내 지수는 실시간 지수 값을 쓴다');
  p = await view('247540.KQ');
  assert.deepEqual([...asked], ['247540.KQ', '^KQ11'], '코스닥 상장은 코스닥');
  assert.equal(p.rel.pct, -5);
  p = await view('SOXL');
  assert.deepEqual([...asked], ['SOXL', '^GSPC'], '미국은 S&P 500');
  assert.equal(p.rel.name, 'S&P 500');
  p = await view('SOXL', '1M', false);
  assert.deepEqual([...asked], ['SOXL'], '끄면 지수를 받지 않는다');
  assert.equal(p.rel, null);
  p = await view('SOXL', '1D');
  assert.deepEqual([...asked], ['SOXL'], '1D 는 기간 배지가 없어 받지 않는다');
  run("state.selected = '^KS11'; state.timeframe = '1M'; quotes['^KS11'] = { price: 2200 }; lastDrawSig = null;");
  asked.length = 0;
  await c.loadChart();
  assert.deepEqual([...asked], ['^KS11'], '지수 자체를 볼 때는 비교하지 않는다');
});

// 지표 보기(차트 대신): 오늘 거래량 배수 · 기간 수익률 · 투자자별 매매동향 · 실적 · 가치 지표 · 컨센서스 · 동종 업종.
// 데이터는 main 의 naver:detail(tests/detail.mjs), 배수 · 수익률은 이미 받은 일봉으로 렌더러가 센다.
// 렌더러의 const 한 문장(끝 표시까지). 소스는 CRLF 라 줄 끝을 가리지 않는다.
const block = (name, end = /\r?\n\};\r?\n/) => {
  const i = source.indexOf(`const ${name} = `);
  assert.notEqual(i, -1, name);
  const m = end.exec(source.slice(i));
  assert.ok(m, `${name} 의 끝`);
  return source.slice(i, i + m.index + m[0].length);
};
const helpers = () => formatting + block('fmtVol') + block('esc', /\}\[c\]\)\);/);
const text = (h) => h.replace(/<[^>]+>/g, ''); // 태그를 뺀 글자 — 항목마다 줄바꿈을 막는 span 을 건너뛰고 읽는다
const kst = (d) => Date.parse(`${d}T09:00:00+09:00`); // 국내 일봉 시각(00:00 UTC)
const days = (from, n) => Array.from({ length: n }, (_, i) => kst(from) + i * 86400000);
// 지표 화면 HTML 이 부르는 함수들 — 기법 점검(techHtml)까지
const METRICS_FNS = ['metricsHtml', 'metricsVolume', 'periodReturns', 'techHtml', 'holdWeight', 'heldRows', 'dailyVolumesOf'];

await test('metrics: today volume against the 20 trading days before its own date (KRX), US by its own date', () => {
  const { run } = harness(['metricsVolume']);
  // 25일: 앞 4일 500, 그다음 20일 1,000, 마지막(오늘 10/16) 9,999 — 오늘 봉은 평균에서 뺀다
  const T = days('2026-09-22', 25);
  const V = [500, 500, 500, 500, ...new Array(20).fill(1000), 9999];
  run(`quotes['005930.KS'] = { dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(V)} } };`);
  const r = run("metricsVolume('005930.KS', { volume: 550, at: '2026-10-16T13:30:41+09:00' })");
  assert.equal(r.avg, 1000, '그날 앞의 20일');
  assert.equal(r.ratio, 0.55);
  // 거래량 0 인 날(휴장 · 빈 봉)은 평균에서 뺀다
  V[23] = 0;
  run(`quotes['005930.KS'].dailyVolume.volumes = ${JSON.stringify(V)};`);
  assert.equal(run("metricsVolume('005930.KS', { volume: 550, at: '2026-10-16T13:30:41+09:00' })").avg, (19 * 1000 + 500) / 20);
  assert.equal(run("metricsVolume('005930.KS', { volume: null, at: null })"), null, '거래량이 없으면 없다');
  assert.equal(run("metricsVolume('NONE', { volume: 5, at: '2026-10-16T13:30:41+09:00' })"), null, '일봉이 없으면 없다');

  // 미국: 장 전에는 어제(뉴욕) 거래량이 온다 — 그날 앞의 20일로 센다. 날짜는 UTC(뉴욕과 같다)
  const U = Array.from({ length: 22 }, (_, i) => Date.parse('2026-09-15T13:30:00Z') + i * 86400000);
  const UV = [...new Array(21).fill(2000), 7777];
  run(`quotes.SOXL = { dailyVolume: { times: ${JSON.stringify(U)}, volumes: ${JSON.stringify(UV)} } };`);
  const at = new Date(U[21]).toISOString().slice(0, 10) + 'T16:00:00-04:00';
  const u = run(`metricsVolume('SOXL', { volume: 4000, at: '${at}' })`);
  assert.equal(u.avg, 2000, '거래량의 날(뉴욕 마감) 봉은 빼고 그 앞 20일');
  assert.equal(u.ratio, 2);
});

await test('metrics: period returns from the daily closes — 1W · 1M · 3M · YTD · 1Y, empty when the history is shorter', () => {
  const { run } = harness(['periodReturns']);
  // 2025-10-01 ~ 2026-10-16 매일 한 봉, 종가 = 1000 + 날짜 번호
  const T = days('2025-10-01', 381);
  const C = T.map((_, i) => 1000 + i);
  run(`quotes.X = { price: 2000, daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} } };`);
  const at = (d) => 1000 + T.indexOf(kst(d));
  const pct = (base) => ((2000 - base) / base) * 100;
  const r = run("periodReturns('X')");
  assert.deepEqual([...r.map((x) => x.label)], ['1주', '1개월', '3개월', '올해', '1년']);
  assert.equal(r[0].pct, pct(at('2026-10-09')), '1주 — 7일 전 봉부터, 마지막은 현재가');
  assert.equal(r[1].pct, pct(at('2026-09-16')));
  assert.equal(r[2].pct, pct(at('2026-07-16')));
  assert.equal(r[3].pct, pct(at('2025-12-31')), '올해 — 작년 마지막 봉부터');
  assert.equal(r[4].pct, pct(at('2025-10-16')));
  // 한 달치뿐이면 3개월 · 올해 · 1년은 없다(첫 봉부터 센 값이 그 기간 수익률로 읽히면 안 된다)
  run(`quotes.X.daily = { times: ${JSON.stringify(T.slice(-31))}, closes: ${JSON.stringify(C.slice(-31))} };`);
  const short = run("periodReturns('X')");
  assert.deepEqual([...short.map((x) => x.pct == null)], [false, false, true, true, true]);
  assert.equal(run("periodReturns('NONE')").length, 0);
  // 3/31 의 한 달 전은 2/28 이다(2/31 이 3/3 으로 넘어가지 않게)
  const M = days('2026-01-01', 90); // ~ 2026-03-31
  run(`quotes.X.daily = { times: ${JSON.stringify(M)}, closes: ${JSON.stringify(M.map((_, i) => 1000 + i))} };`);
  assert.equal(run("periodReturns('X')")[1].pct, pct(1000 + M.indexOf(kst('2026-02-28'))), '그달에 그날이 없으면 그달 마지막 날');
});

const KR_DETAIL = {
  ok: true, market: 'kr', kind: 'stock',
  today: { volume: 11822115, at: '2026-10-16T13:30:41+09:00', totalVolume: 21217698, value: '4조 5,732억', marketValue: '1,280조 3,350억', foreignRate: '45.98%' },
  valuation: [{ label: 'PER', value: '9.82배' }, { label: 'PBR', value: '2.54배' }],
  consensus: { target: 495227, high: null, low: null, opinion: 4, date: '2026-10-15', currency: 'KRW' },
  trend: Array.from({ length: 20 }, (_, i) => ({ date: `202610${String(15 - (i % 10)).padStart(2, "0")}`, foreign: i < 5 ? -100000 : 10000, organ: 20000, individual: 0, foreignRatio: 45 })),
  ir: { title: '2026년 3분기 경영실적 발표', date: '2026-10-29', dday: 13 },
  quarters: { unit: '억원', cols: [{ title: '25.12', estimate: false }, { title: '26.03', estimate: false }, { title: '26.06', estimate: false }, { title: '26.09', estimate: true }, { title: '26.12', estimate: true }],
    rows: [{ title: '매출액', values: [938374, 1338734, 1714995, 2007657, null] }, { title: '영업이익', values: [-5000, 572328, 894924, 1069435, null] }] },
  peers: [{ name: 'SK하이닉스', pct: 3.25, code: '000660' }, { name: '<b>가짜</b>', pct: -1.5 }],
  etf: null,
};

await test('metrics: panel for a Korean stock — volume multiple, returns, investor table with 5/20-day sums, earnings, valuation, consensus, peers', () => {
  const { c, run } = harness(METRICS_FNS);
  run(helpers());
  const T = days('2026-09-15', 32);
  run(`quotes['005930.KS'] = { price: 219000, currency: 'KRW',
    daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(T.map(() => 200000))} },
    dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(T.map(() => 21495000))} } };`);
  c.D = KR_DETAIL;
  const html = run("metricsHtml({ symbol: '005930.KS', name: '삼성전자' }, D, quotes['005930.KS'])");
  assert.match(html, /거래량 <b>1,182만 주<\/b> · 20일 평균의 <b>0\.55배<\/b>/, '오늘 거래량(KRX)과 배수');
  assert.match(html, /10\/16 13:30/, '그 거래량의 시각');
  assert.match(text(html), /NXT 포함 2,122만 · 대금 4조 5,732억 · 시총 1,280조 3,350억 · 외국인 소진율 45\.98%/);
  assert.match(html, /<span class="mxi">외국인 소진율 45\.98%<\/span>/, '항목 하나는 줄바꿈하지 않는다(외국인 / 소진율로 쪼개지지 않게)');
  assert.match(html, /<span class="mxi">1주 <b/, '기간 수익률도 항목마다(1 / 년으로 쪼개지지 않게)');
  assert.match(html, /1주 <b style="color:#e24b4a">\+9\.50%<\/b>/, '기간 수익률(빨강 = 상승)');
  // 매매동향: 앞 5일 외국인 -10만 × 5 = -50만, 20일 = -50만 + 1만 × 15 = -35만. 기관 2만 × 5 = +10만, × 20 = +40만
  assert.match(html, /<td>5일<\/td><td style="color:#185fa5">-50만<\/td><td style="color:#e24b4a">\+10만<\/td><td style="color:--flat">0<\/td>/, '5일 합(0 은 목록처럼 회색)');
  assert.match(html, /<td>20일<\/td><td style="color:#185fa5">-35만<\/td><td style="color:#e24b4a">\+40만<\/td>/, '20일 합');
  assert.equal((html.match(/<tr class="day">/g) || []).length, 10, '날짜별은 최근 10일');
  assert.match(html, /<tr class="day"><td>10\/15<\/td><td style="color:#185fa5">-10만<\/td>/, '최근이 먼저, MM/DD');
  assert.match(html, /2026년 3분기 경영실적 발표 <b>10\/29<\/b> · D-13/, '실적 발표 일정');
  assert.match(html, /<th>26\.03<\/th><th>26\.06<\/th><th>26\.09E<\/th><th>26\.12E<\/th>/, '분기는 최근 4개, 추정치는 E');
  assert.match(html, /<td>매출액<\/td><td>133\.9조<\/td><td>171\.5조<\/td><td>200\.8조<\/td><td>—<\/td>/, '억원 → 조, 빈 값은 —');
  assert.match(html, /<td>영업이익<\/td><td>57\.2조<\/td>/);
  assert.match(text(html), /PER 9\.82배 · PBR 2\.54배/);
  assert.match(html, /목표가 평균 <b>495,227원<\/b> \(현재가 대비 \+126\.13%\) · 의견 4\.00 \/ 5/, '컨센서스와 현재가 대비');
  assert.match(html, /10\/15 기준 · 증권사 추정치, 참고용/);
  assert.match(html, /<span class="mxpeer" data-peer="000660" data-name="SK하이닉스" title="[^"]+">SK하이닉스<\/span> <b style="color:#e24b4a">\+3\.25%<\/b>/,
    '동종 업종 — 코드가 있으면 누를 수 있다(pickPeer)');
  assert.ok(html.includes('&lt;b&gt;가짜&lt;/b&gt;') && !html.includes('<b>가짜</b>'), '이름은 이스케이프한다');
  assert.ok(html.includes('<span class="mxi">&lt;b&gt;가짜&lt;/b&gt; <b'), '코드가 없으면 글자만');
  assert.ok(html.includes('<p class="mxmute" id="peerMsg"></p>'), '넣는 중 · 못 넣은 이유를 적을 자리');
});

// 동종 업종 종목을 누르면 순위 패널처럼 — 관심종목에 있으면 그 종목으로, 없으면 넣고 연다(되돌리기 줄). 응답에는 네이버 코드만 있어
// (코스피 · 코스닥 구분 없음) 넣을 때는 검색으로 야후 기호를 찾는다(2026-11-12 사용자 요청)
await test('metrics: clicking a peer goes to it if it is in the watchlist, otherwise looks it up, adds it with an undo, or says why not', async () => {
  const { c, run, elements } = harness(['pickPeer']);
  const log = [];
  let found = [{ symbol: '0369300.KQ', name: '다른 종목' }, { symbol: '036930.KQ', name: '주성엔지니어링(검색 이름)' }];
  let addErr;
  Object.assign(c, {
    select: async (s) => { log.push(`select ${s}`); },
    addSymbol: async (it) => {
      log.push(`add ${it.symbol} ${it.name}`);
      if (addErr) return addErr;
      run(`state.watchlist.push({ symbol: '${it.symbol}', name: '${it.name}' });`);
    },
    showUndo: (s) => { log.push(`undo ${s.item.symbol} added=${s.added} prev=${s.prev}`); },
  });
  c.api.search = async (q) => { log.push(`search ${q}`); return found ? { ok: true, items: found } : { ok: false, error: 'HTTP 500' }; };
  const msg = () => elements.get('peerMsg').textContent;
  c.document.getElementById('peerMsg');

  await c.pickPeer('000660', 'SK하이닉스');
  assert.deepEqual(log.splice(0), ['select 000660.KS'], '이미 있으면 찾지도 넣지도 않고 그 종목으로');
  await c.pickPeer('036930', '주성엔지니어링');
  assert.deepEqual(log.splice(0), ['search 036930', 'add 036930.KQ 주성엔지니어링', 'undo 036930.KQ added=true prev=005930.KS'],
    '없으면 코드로 찾아(코스닥 .KQ) 넣고 되돌리기 — 코드가 정확히 같은 결과만');
  // 검색은 국내 · 미국만 준다 — 도쿄 상장(소니 그룹 6758)은 못 넣는다
  found = [];
  await c.pickPeer('6758', '소니 그룹');
  assert.deepEqual(log.splice(0), ['search 6758']);
  assert.equal(msg(), '소니 그룹: 추가하지 못했습니다 (국내 · 미국 종목만 넣을 수 있습니다)');
  found = [{ symbol: 'DELL', name: '델테크놀로지' }];
  addErr = 'No data found';
  await c.pickPeer('DELL', '델테크놀로지');
  assert.deepEqual(log.splice(0), ['search DELL', 'add DELL 델테크놀로지'], '미국 종목은 티커 그대로');
  assert.equal(msg(), '델테크놀로지: 추가하지 못했습니다 (No data found)', '시세를 못 받은 이유');
  found = null;
  await c.pickPeer('STX', '씨게이트');
  assert.equal(msg(), '씨게이트: 추가하지 못했습니다 (HTTP 500)', '검색 실패');
  assert.match(source, /getElementById\('metricsView'\)\.onclick = \(e\) => \{[\s\S]*?const p = e\.target\.closest\('\[data-peer\]'\);\s*if \(p\) pickPeer\(p\.dataset\.peer, p\.dataset\.name\)/);
});

await test('metrics: US stock shows no investor table, consensus range in dollars; ETF shows NAV instead of valuation; loading and failure states', () => {
  const { c, run } = harness(METRICS_FNS);
  run(helpers());
  run("quotes.AAPL = { price: 330, currency: 'USD' }; quotes['069500.KS'] = { price: 87025, currency: 'KRW' };");
  c.US = { ...KR_DETAIL, market: 'us', trend: null, ir: null,
    today: { volume: 39767256, at: '2026-10-15T16:00:00-04:00', totalVolume: null, value: '137억 USD', marketValue: '4조 9,912억 USD', foreignRate: null },
    consensus: { target: 324.89, high: 405, low: 215, opinion: 3.7, date: '2026-10-08', currency: 'USD' },
    quarters: { unit: 'USD 백만', cols: [{ title: '26.06', estimate: false }], rows: [{ title: '영업이익(EBIT)', values: [35695] }] } };
  const us = run("metricsHtml({ symbol: 'AAPL', name: '애플' }, US, quotes.AAPL)");
  assert.match(us, /투자자별 매매동향은 국내 종목만 있습니다/);
  assert.doesNotMatch(us, /NXT/, '미국은 NXT 줄이 없다');
  assert.match(text(us), /대금 137억 USD · 시총 4조 9,912억 USD/);
  assert.match(us, /목표가 평균 <b>\$324\.89<\/b> \(현재가 대비 -1\.55%\) · 의견 3\.70 \/ 5 · 최저 \$215\.00 ~ 최고 \$405\.00/);
  assert.match(us, /<td>영업이익\(EBIT\)<\/td><td>35\.7B<\/td>/, 'USD 백만 → B');
  assert.doesNotMatch(us, /실적 발표/, '일정이 없으면 그 줄이 없다');

  c.ETF = { ...KR_DETAIL, kind: 'etf', valuation: [], consensus: null, ir: null, quarters: null, peers: [],
    etf: { nav: 87038.98, deviation: -0.02, issuer: '삼성자산운용(ETF)', baseIndex: '코스피 200', dividendYield: 0.98 } };
  const etf = run("metricsHtml({ symbol: '069500.KS', name: 'KODEX 200' }, ETF, quotes['069500.KS'])");
  assert.match(text(etf), /NAV 87,038\.98 · 괴리율 -0\.02% · 분배율 0\.98% · 코스피 200 · 삼성자산운용\(ETF\)/);
  assert.doesNotMatch(etf, /가치 지표|동종 업종|실적/, '없는 칸은 제목까지 뺀다');
  assert.doesNotMatch(etf, /NXT/, 'ETF 는 NXT 에 없어 NXT 포함 거래량을 적지 않는다');

  assert.match(run("metricsHtml({ symbol: 'AAPL', name: '애플' }, undefined, quotes.AAPL)"), /불러오는 중/);
  const bad = run("metricsHtml({ symbol: 'AAPL', name: '애플' }, { ok: false, error: '<x>' }, quotes.AAPL)");
  assert.match(bad, /지표를 불러오지 못했습니다 \(&lt;x&gt;\)/, '실패 — 이유는 이스케이프');
});

await test('metrics: shareholders — major holders table, foreign stake and free float, common-share basis for a preferred stock, no section without data', () => {
  const { c, run } = harness(METRICS_FNS);
  run(helpers());
  run("quotes['005930.KS'] = { price: 219000, currency: 'KRW' };");
  const H = { date: '2026-10-27', common: null, foreign: 46.1, float: 74.98,
    rows: [{ name: '삼성생명보험 외 17인', pct: 19.69 }, { name: '국민연금공단', pct: 7.84 }, { name: '<i>x</i> 외 15인', pct: 5.14 }, { name: '자사주', pct: 2.34 }] };
  const html = (symbol, holders) => { c.D = { ...KR_DETAIL, holders }; return run(`metricsHtml({ symbol: '${symbol}', name: '' }, D, quotes['005930.KS'])`); };

  const h = html('005930.KS', H);
  assert.match(h, /<h5>주주 구성 <span>\(10\/27 기준\)<\/span><\/h5>/, '제목에 기준일');
  assert.match(h, /<tr><td>삼성생명보험 외 17인<\/td><td>19\.69%<\/td><\/tr><tr><td>국민연금공단<\/td><td>7\.84%<\/td><\/tr>/, '주요주주는 이름 · 지분율 표');
  assert.ok(h.includes('&lt;i&gt;x&lt;/i&gt; 외 15인') && !h.includes('<i>x</i>'), '이름은 이스케이프한다');
  assert.match(text(h), /외국인 46\.10% · 유동주식 74\.98%/, '외국인 지분율 · 유동비율');
  assert.match(h, /최대주주 · 5% 이상 주주 · 자사주만 공시됩니다 \(기관 · 개인 지분율은 없음\)/, '표에 없는 것을 적는다');
  // 외국인 · 유동주식은 전체 주식 대비로 따로 잰 비율이라 위 주주와 겹친다 — 더하면 100% 를 넘었다(2026-11-02 사용자 질문, SK하이닉스)
  assert.match(h, /외국인 · 유동주식은 전체 주식 대비로 따로 잰 비율이라 위 주주와 겹칩니다 \(더하면 100%를 넘을 수 있음\)/);
  assert.ok(h.indexOf('투자자별 순매수') < h.indexOf('주주 구성') && h.indexOf('주주 구성') < h.indexOf('<h5>실적'), '매매동향 다음, 실적 앞');

  assert.match(html('005935.KS', { ...H, common: '005930' }), /<h5>주주 구성 <span>\(보통주 기준, 10\/27\)<\/span><\/h5>/,
    '우선주는 회사(보통주) 값이라고 적는다');
  const bare = html('005930.KS', { ...H, date: null, foreign: null, float: null });
  assert.match(bare, /<h5>주주 구성<\/h5>/, '기준일이 없으면 제목만');
  assert.doesNotMatch(text(bare), /유동주식|외국인 \d/, '없는 값은 적지 않는다');
  assert.doesNotMatch(html('005930.KS', null), /주주 구성/, '주주 구성이 없으면(ETF · 실패) 단락이 없다');
});

// 거래원(다음 금융, 2026-10-30 사용자 요청) — 오늘 매도 · 매수 상위 10개사(주), 외국계 표시, 목록 안 외국계 합과 그 차이(외국인
// 매매를 어림한 것 — 종목의 장중 투자자별 수급은 무료 출처에 없다).
await test('metrics: brokers — today\'s top sellers and buyers side by side, foreign brokers marked, foreign sums and the estimated net', () => {
  const { c, run } = harness(METRICS_FNS);
  run(helpers());
  run("quotes['005930.KS'] = { price: 219000, currency: 'KRW' };");
  const T = { date: '20261030',
    buy: [{ name: '한국증권', volume: 1718002, foreign: false }, { name: '골드만', volume: 458984, foreign: true }, { name: 'JP모간', volume: 331515, foreign: true }],
    sell: [{ name: 'BNK증권', volume: 1535498, foreign: false }, { name: '<i>x</i>', volume: 999036, foreign: true }], foreignBuy: 790499, foreignSell: 999036 };
  const holders = { date: '2026-10-27', common: null, foreign: 46.1, float: 74.98, rows: [{ name: '국민연금공단', pct: 7.84 }] };
  const html = (traders) => { c.D = { ...KR_DETAIL, traders, holders }; return run("metricsHtml({ symbol: '005930.KS', name: '삼성전자' }, D, quotes['005930.KS'])"); };
  const h = html(T);
  assert.match(h, /<h5>거래원 <span>\(10\/30 상위 10개사 · 주\)<\/span><\/h5>/);
  assert.match(h, /<tr><th>매도 상위<\/th><th><\/th><th class="nm">매수 상위<\/th><th><\/th><\/tr>/);
  assert.match(h, /<tr><td>BNK증권<\/td><td>154만<\/td><td class="nm">한국증권<\/td><td>172만<\/td><\/tr>/, '같은 순위끼리 한 줄, 수량은 만 주');
  assert.match(h, /<td>&lt;i&gt;x&lt;\/i&gt;\(외\)<\/td><td>100만<\/td><td class="nm">골드만\(외\)<\/td><td>46만<\/td>/, '외국계는 (외), 이름은 이스케이프');
  assert.match(h, /<tr><td><\/td><td><\/td><td class="nm">JP모간\(외\)<\/td><td>33만<\/td><\/tr>/, '한쪽이 짧으면 빈칸');
  assert.match(text(h), /외국계 매수 79만 · 매도 100만 · 순매수 -21만 주 \(추정\)/);
  assert.match(h, /순매수 <b style="color:#185fa5">-21만 주<\/b>/, '파는 쪽이면 파랑');
  assert.match(h, /<p title="[^"]*상위 10개사 안의 외국계[^"]*">외국계 매수/, '추정의 한계를 툴팁에');
  assert.ok(h.indexOf('투자자별 순매수') < h.indexOf('<h5>거래원') && h.indexOf('<h5>거래원') < h.indexOf('주주 구성'), '매매동향 다음, 주주 구성 앞');
  assert.doesNotMatch(html(null), /거래원/, '없으면(미국 · 실패) 단락이 없다');
  assert.doesNotMatch(text(html({ ...T, foreignBuy: null })), /외국계 매수/, '합이 없으면 그 줄은 없다');
});

// 최근 공시(국내, 2026-11-17 사용자 요청) — 다음 금융의 DART 목록 10건(main 의 recentFilings, tests/detail.mjs 9번). 줄을 누르면 DART 원문
await test('metrics: recent filings — date and title per line after earnings, title escaped, receipt number for DART; no section without data', () => {
  const { c, run } = harness(METRICS_FNS);
  run(helpers());
  run("quotes['005930.KS'] = { price: 219000, currency: 'KRW' };");
  const html = (filings) => { c.D = { ...KR_DETAIL, filings }; return run("metricsHtml({ symbol: '005930.KS', name: '삼성전자' }, D, quotes['005930.KS'])"); };
  const h = html([{ no: '20261116001482', day: '2026-11-16', name: '분기보고서 (2026.09)' }, { no: '20261113801115', day: '2026-11-13', name: '<i>x</i>' }]);
  assert.match(h, /<h5>최근 공시 <span>\(DART · 다음 금융\)<\/span><\/h5><ul class="mxfil"><li data-dart="20261116001482" title="분기보고서 \(2026\.09\) — 누르면 DART 원문 \(브라우저\)"><span class="mxmute">11\/16<\/span> 분기보고서 \(2026\.09\)<\/li>/);
  assert.ok(h.includes('&lt;i&gt;x&lt;/i&gt;') && !h.includes('<i>x</i>'), '제목은 이스케이프한다');
  assert.ok(h.indexOf('<h5>실적') < h.indexOf('최근 공시') && h.indexOf('최근 공시') < h.indexOf('<h5>가치 지표'), '실적 다음, 가치 지표 앞');
  assert.doesNotMatch(html(null), /최근 공시/, '없으면(미국 · 실패) 단락이 없다');
  assert.doesNotMatch(html([]), /최근 공시/);
  assert.match(source, /const f = e\.target\.closest\('\[data-dart\]'\);\s*if \(f\) \{ api\.openDart\(f\.dataset\.dart\); return; \}/, '누르면 main 에 번호만 넘긴다');
});

// 기법 점검 — 받아 둔 일봉으로 추세 추종 · 모멘텀 · 적립식 · 보유 비중 · 반등 점검 · 코스톨라니 달걀(계산은 tests/techniques.mjs).
// 셀 수 없는 줄은 빠지고, 줄마다 툴팁에 규칙이 있다. 2026-10-29 사용자 요청.
await test('metrics: 기법 점검 lists trend following, 12-1 momentum with its watchlist rank, DCA, holding weight, rebound and the egg', () => {
  const { c, run } = harness(METRICS_FNS);
  run(helpers());
  const T = days('2025-05-01', 400);
  // 380봉 동안 100 → 289.5 로 오르고, 10봉에 걸쳐 -20%, 다시 10봉 반등. 거래량은 하락 때 2배, 반등 때 1.5배
  const C = [...Array.from({ length: 380 }, (_, i) => 100 + i * 0.5),
    ...Array.from({ length: 10 }, (_, i) => 289.5 * (1 - 0.02 * (i + 1))), ...Array.from({ length: 10 }, (_, i) => 231.6 + (i + 1) * 3)];
  const V = C.map((_, i) => (i < 380 ? 1000 : i < 390 ? 2000 : 1500));
  const C2 = T.map((_, i) => 100 + i); // 하이닉스 — 더 많이 올랐다
  run(`quotes['005930.KS'] = { price: ${C.at(-1)}, currency: 'KRW', daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} },
      dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(V)} } };
    quotes['000660.KS'] = { price: 499, currency: 'KRW', daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C2)} } };
    state.holdings = { '005930.KS': { qty: 10, avg: 200 }, '000660.KS': { qty: 1, avg: 400 } };`);
  c.D = { ok: true, market: 'kr', kind: 'stock' };
  const html = run("metricsHtml({ symbol: '005930.KS', name: '삼성전자' }, D, quotes['005930.KS'])");
  const won = (v) => run(`money(${v}, 'KRW')`);
  const pct = (v) => run(`fmtPct(${v})`);
  const tf = indicators.trendFollow(C, 200);
  const mom = indicators.momentum(T, C);
  const dca = indicators.dcaCost(T, C, 12);
  const rb = indicators.reboundCheck(C, V, 60, 15);
  const egg = indicators.eggPhase(C, V);
  assert.match(html, /<h5>기법 점검 <span>\(참고용\)<\/span><\/h5>/);
  const t = text(html);
  assert.ok(t.includes(`추세 추종 200일선 ${won(tf.ma)} ${tf.above ? '위' : '아래'} · ${tf.above ? '보유' : '현금'} 구간 ${tf.days}일째`), t);
  assert.ok(t.includes(`모멘텀 12-1개월 ${pct(mom)} · 관심종목 2/2위`), '하이닉스가 더 올라 2위');
  assert.ok(t.includes(`적립식 12개월 매달 같은 금액(12회) · 평단 ${won(dca.avg)} · 지금 ${pct(dca.pct)}`));
  assert.ok(t.includes('비중 보유 2종목 중 84.0% · 균등이면 50.0%'), '2,616 / (2,616 + 499)');
  assert.ok(t.includes(`반등 점검 고점 ${won(289.5)} → 저점 ${won(rb.low)} (${pct(rb.dropPct)}) · ${rb.retrace.toFixed(0)}% 되돌림`));
  assert.ok(t.includes(`20일선 ${rb.aboveMa20 ? '위' : '아래'} · RSI ${rb.rsi.toFixed(0)} · 반등 거래량 하락 때의 ${rb.volRatio.toFixed(1)}배`));
  // '20일선 위 · RSI 50 위 · 거래량 실린 반등일수록 힘이 있다' 는 검증에서 앞 둘이 반대로 나왔다 — 검증 결과로 바꾼다(2026-11-02 점검 2단계)
  assert.doesNotMatch(html, /힘이 있다고 봅니다/);
  // 툴팁 문체(2026-11-02 3단계): 한 줄에 한 생각, 검증은 머리 줄(대상 · 견준 것) 아래 '· ' 목록, %포인트, 말끝 '~다'
  const head = run('EVIDENCE_HEAD');
  assert.equal(head, '과거 10년(대형주 25 · 지수 4) 검증 — 20거래일 뒤, 평소 대비 %포인트');
  const rbEv = run('REBOUND_EVIDENCE');
  assert.equal(rbEv, `${head}\n· 반등 중인 날: +0.8 (29곳 중 21곳 나음)\n`
    + '· 20일선 위 +0.6 · RSI 50 위 +0.4 — 오히려 그 아래(+1.0 · +1.0)보다 작았다\n'
    + '· 거래량이 실린 반등 +1.2 — 그렇지 않은 반등(+0.6)보다 컸다\n· 차이는 20거래일 흔들림(±8~10%)에 비해 작다');
  assert.ok(html.includes(`결론은 내리지 않는다\n\n${rbEv}"><span class="mxmute">반등 점검`), '반등 점검 툴팁 끝에 과거 검증');
  // 급락(RSI 30 아래)으로 B3 에 들었고, 반등 중이어도 20일선이 아직 60일선 아래라 B3 — 다음은 A1
  assert.equal(`${egg.prev} → ${egg.phase} · 다음 ${egg.next}`, 'B1 → B3 · 다음 A1', JSON.stringify(egg));
  assert.ok(t.includes(`코스톨라니 B1 → B3 · ${egg.days}일째 · 투매 · 다음 A1 (해석)`), '직전 → 지금 · 일수 · 다음');
  assert.equal((html.match(/<p title="[^"]+"><span class="mxmute">/g) || []).length, 6, '여섯 줄 모두 툴팁에 규칙');
  const follow = run('FOLLOW_EVIDENCE');
  assert.match(follow, /^과거 10년\(대형주 25 · 지수 4\) 검증 — 200일선 위에서만 보유했다면\n· 가장 크게 빠진 폭: 평균 −55\.9% → −43\.3% \(29곳 중 27곳 덜 빠짐\)/);
  assert.ok(html.includes(`추세 추종: 종가가 200일선 위면 보유, 아래면 현금으로 보는 규칙\n일수는 그 상태가 이어진 거래일(오늘 포함)\n횡보장에서는 자주 바뀐다\n\n${follow}"><span class="mxmute">추세 추종`),
    '추세 추종 툴팁 — 규칙 / 일수 / 검증');
  // 모멘텀도 과거 검증 — 우리 검증에서 효과가 거의 0 이었는데 툴팁은 '경향을 봅니다' 만 적었다(2026-11-02 점검)
  const mEv = run('MOMENTUM_EVIDENCE');
  assert.equal(mEv, `${head}\n· 12-1개월 모멘텀이 높았을 때(상위): 약 0 — 평소와 거의 같았다\n· 이 종목들에서는 그 경향이 보이지 않았다`);
  assert.ok(html.includes('많이 오른 종목이 한동안 더 오른다는 경향을 쓰는 규칙 — 미국 주식 연구(Jegadeesh · Titman, 1993)')
    && html.includes(`관심종목 중 이 값이 있는 종목끼리\n\n${mEv}"><span class="mxmute">모멘텀`), '모멘텀 툴팁 — 경향의 출처와 우리 검증');
  assert.match(html, /title="코스톨라니 달걀\(해석\): B3 투매\nB1\(꼭대기 뒤 하락 초기\)에서 B3로 바뀐 지 \d+거래일째\(오늘 포함\)\n다음은 A1\(바닥 뒤 상승 초기\) — 20일선이 다시 60일선 위로 올라서면\n\n지금: 20일선이 60일선 아래\(하락\) · 거래량 20일 평균이 60일 평균의 1\.39배 · RSI 54\n/);
  assert.ok(html.includes(`B1(꼭대기 뒤 하락 초기)에서 B3로 바뀐 지 ${egg.days}거래일째(오늘 포함)`), '툴팁에 바뀐 때');
  assert.ok(html.includes(`원래 이론에는 숫자 기준이 없어 이 기준은 해석이다\n\n${run('EGG_EVIDENCE')}"`), '해석이라는 줄 뒤에 과거 검증');
  // 툴팁 말끝은 '~다' — 예전 '~습니다' 가 남지 않게
  assert.doesNotMatch(html.match(/title="[^"]*"/g).join(''), /습니다|입니다/);
  // 기법 점검은 기간 수익률 다음
  assert.ok(html.indexOf('기간 수익률') < html.indexOf('기법 점검'));

  // 보유가 하나뿐이면 비중은 늘 100% 라 빼고, 관심종목에 모멘텀을 셀 수 있는 종목이 하나면 순위도 뺀다
  run("delete state.holdings['000660.KS']; quotes['000660.KS'].daily.closes = [1, 2];");
  const one = text(run("metricsHtml({ symbol: '005930.KS', name: '삼성전자' }, D, quotes['005930.KS'])"));
  assert.ok(!one.includes('비중') && one.includes(`모멘텀 12-1개월 ${pct(mom)}`) && !one.includes('관심종목'), one);
  // 달러 종목이 섞였는데 환율을 아직 못 받았으면 비중을 내지 않는다
  run("state.holdings['000660.KS'] = { qty: 1, avg: 400 }; quotes['000660.KS'].currency = 'USD'; var fxRate = null;");
  assert.equal(run("holdWeight('005930.KS')"), null);
  run('fxRate = 1000;');
  assert.ok(Math.abs(run("holdWeight('005930.KS')").pct - (2616 / (2616 + 499000)) * 100) < 1e-9, '달러는 환율로 원화 환산');
  // 일봉이 짧으면(최근 상장) 단락이 없다
  run(`quotes['005930.KS'].daily = { times: ${JSON.stringify(T.slice(-30))}, closes: ${JSON.stringify(C.slice(-30))} }; state.holdings = {};`);
  assert.doesNotMatch(run("metricsHtml({ symbol: '005930.KS', name: '삼성전자' }, D, quotes['005930.KS'])"), /기법 점검/);
});

await test('metrics: the button swaps the chart for the panel, hides for indices, fetches on open, reuses for a minute and drops a late reply for another symbol', async () => {
  const { c, run, elements } = harness(['renderMetrics', 'loadMetrics']);
  const asked = [];
  const replies = [];
  c.api.detail = (symbol) => { asked.push(symbol); return new Promise((r) => replies.push(r)); };
  c.metricsHtml = (item, d) => (d ? `${item.symbol}:${d.ok ? d.n : "fail"}` : 'LOADING');
  const settle = () => new Promise((r) => setImmediate(r));
  const btn = () => elements.get('metricsBtn');
  const panel = () => elements.get('metricsView');

  run('renderMetrics();');
  assert.equal(btn().hidden, false, '종목이면 버튼이 있다');
  assert.equal(btn().textContent, '지표', '제목줄의 작은 글자 버튼');
  assert.equal(panel().hidden, true, '처음에는 차트');
  assert.equal(asked.length, 0, '닫혀 있으면 받지 않는다');

  run('metricsOn = true; renderMetrics();');
  assert.equal(panel().hidden, false);
  assert.equal(btn().className, 'mxbtn on');
  assert.equal(btn().textContent, '차트', '열려 있으면 차트로 돌아가는 버튼');
  assert.equal(panel().innerHTML, 'LOADING');
  assert.deepEqual([...asked], ['005930.KS'], '열면 받는다');
  run('renderMetrics();');
  assert.equal(asked.length, 1, '받는 중이면 또 묻지 않는다');
  replies.shift()({ ok: true, n: 1 });
  await settle();
  assert.equal(panel().innerHTML, '005930.KS:1', '받으면 다시 그린다');

  run('renderMetrics();');
  assert.equal(asked.length, 1, '1분 안에는 받은 것을 쓴다');
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => NOW + 61000; // 하네스 시각 + 61초
  run('renderMetrics();');
  assert.equal(asked.length, 2, '1분이 지나면 다시 받는다');
  assert.equal(panel().innerHTML, '005930.KS:1', '받는 동안은 있던 것을 보인다');
  replies.shift()({ ok: false, error: 'x' });
  await settle();
  assert.equal(panel().innerHTML, '005930.KS:1', '다시 받다 실패하면 있던 것을 둔다');

  // 다른 종목으로 넘어간 뒤 늦게 온 응답은 그 종목 캐시에만 넣고 화면은 고치지 않는다
  run("state.selected = '000660.KS'; renderMetrics();");
  assert.equal(asked.at(-1), '000660.KS');
  run("state.selected = '005930.KS'; renderMetrics();");
  replies.shift()({ ok: true, n: 7 });
  await settle();
  assert.equal(panel().innerHTML, '005930.KS:1', '고른 종목이 아니면 화면을 고치지 않는다');
  run("state.selected = '000660.KS'; renderMetrics();");
  assert.equal(panel().innerHTML, '000660.KS:7', '그 종목으로 돌아오면 받아 둔 것을 쓴다');

  run("state.selected = '^KS11'; renderMetrics();");
  assert.equal(btn().hidden, true, '지수는 버튼이 없다');
  assert.equal(panel().hidden, true, '지수로 가면 차트로 돌아간다');
  run("state.selected = '005930.KS'; metricsOn = false; renderMetrics();");
  assert.equal(panel().hidden, true);
  assert.equal(btn().className, 'mxbtn');
  assert.equal(btn().textContent, '지표');
  // 상세를 그릴 때(종목 바꾸기 · 30초 갱신 · 삭제)마다 지표 화면도 고른 종목에 맞춘다
  assert.match(realFunction('renderDetail'), /\n  renderMetrics\(\);/, 'renderDetail 이 renderMetrics 를 부른다');
  c.Date.now = realNow;
});

// 시장 순위(헤더의 순위 버튼이 여는 패널). 데이터는 main 의 naver:rank(tests/rank.mjs) — 렌더러는 목록을 그리고,
// 국내 / 미국과 탭을 바꾸고, 누르면 관심종목에 넣거나 그 종목으로 간다.
const KR_RANK = { ok: true, market: 'kr', kind: 'up', filtered: true, at: '2026-10-16T14:22:23+09:00', items: [
  { symbol: '005930.KS', name: '삼성전자', price: 219000, pct: 4.29, value: 3043864000000, cap: 1280335015152000, currency: 'KRW' },
  { symbol: '196170.KQ', name: '<i>알테오젠</i>', price: 239500, pct: -1.5, value: 101876000000, cap: 16682400000000, currency: 'KRW' },
  { symbol: '000001.KS', name: '보합', price: 1000, pct: 0, value: 1e9, cap: 1e11, currency: 'KRW' }] };

await test('rank: list shows rank, name with a check for watchlist stocks, price, colored change and trading value; the note says the basis and filter', () => {
  const { c, run } = harness(['rankHtml']);
  run(helpers());
  c.D = KR_RANK;
  const html = run("rankHtml(D, 'kr', 'up')");
  assert.equal((html.match(/class="hit rrow"/g) || []).length, 3);
  assert.match(html, /<div class="hit rrow" data-i="0"><span class="rk">1<\/span><span class="hname"><span class="rin" title="관심종목에 있음">✓<\/span>삼성전자<\/span><span class="rpx">219,000<\/span><span class="rpct" style="color:#e24b4a">\+4\.29%<\/span><span class="rval">3\.0조<\/span><\/div>/,
    '관심종목에 있으면 ✓, 거래대금 원 → 조');
  assert.match(html, /<span class="hname">&lt;i&gt;알테오젠&lt;\/i&gt;<\/span>/, '이름은 이스케이프한다, 관심종목이 아니면 ✓ 없음');
  assert.match(html, /<span class="rpct" style="color:#185fa5">-1\.50%<\/span><span class="rval">1,019억<\/span>/, '1조 미만은 억');
  assert.match(html, /<span class="rpct" style="color:--flat">0\.00%<\/span>/, '보합은 목록 · 지수 줄처럼 회색(--flat)');
  assert.match(text(html), /^10\/16 14:22 기준 · 일반 주식만\(ETF · ETN · 우선주 제외\) · 거래대금 10억 원 이상 · 코스피 \+ 코스닥1/,
    '기준 문구는 목록 맨 위 — 열자마자 보인다(스크롤해야 보이면 지난 장 순위인지 모른다)');
  assert.ok(html.indexOf('rnote') < html.indexOf('rrow'), '기준 문구가 첫 줄보다 위');
  assert.equal(run(`esc("L'Oreal & <b>")`), 'L&#39;Oreal &amp; &lt;b&gt;', '홑따옴표도 — 속성에 홑따옴표를 쓰는 곳이 생겨도 깨지지 않게');
  c.D = { ...KR_RANK, kind: 'search', filtered: false };
  assert.match(text(run("rankHtml(D, 'kr', 'search')")), /^[^가-힣]*기준 · 네이버 인기 검색 순1/);

  c.D = { ok: true, market: 'us', kind: 'cap', filtered: true, at: '2026-10-15T16:00:00-04:00', items: [
    { symbol: 'NVDA', name: '엔비디아', price: 210.5, pct: -1.84, value: 9348515000, cap: 5235200000000, currency: 'USD' },
    { symbol: 'INDP', name: '인댑터스', price: 3.1, pct: 28.96, value: 12000000, cap: 400000000, currency: 'USD' }] };
  const us = run("rankHtml(D, 'us', 'cap')");
  assert.match(us, /<span class="rpx">210\.50<\/span>.*?<span class="rval">\$5\.2T<\/span>/, '시총 상위 탭은 시총, 달러는 T · B · M');
  assert.match(us, /<span class="rval">\$400M<\/span>/);
  assert.match(text(us), /^10\/16 05:00 기준 · 일반 주식만 · 나스닥 \+ 뉴욕1/, '미국 시각도 한국 시각으로, 시총 상위는 시총으로 거르지 않는다');
  assert.match(text(run("rankHtml(D, 'us', 'value')")), /\$9\.3B/, '다른 탭은 거래대금');
  assert.match(text(run("rankHtml(D, 'us', 'up')")), /^[^가-힣]*기준 · 일반 주식만 · 시총 3억 달러 이상 · 나스닥 \+ 뉴욕1/);

  assert.match(run("rankHtml(undefined, 'kr', 'up')"), /순위를 불러오는 중/);
  assert.match(run("rankHtml({ ok: false, error: '<x>' }, 'kr', 'up')"), /순위를 불러오지 못했습니다 \(&lt;x&gt;\)/);
  c.D = { ...KR_RANK, items: [] };
  assert.match(run("rankHtml(D, 'kr', 'down')"), /조건에 맞는 종목이 없습니다/);
});

await test('plColor: up red, down blue, zero and missing grey — the one rule every view colours changes with', () => {
  // 0 이 목록 · 지수 줄은 회색, 순위 · 지표 화면은 기본 글자색이었다 — 화면마다 따로 쓰던 규칙을 이것 하나로(2026-11-05)
  const { run } = harness();
  assert.equal(run('plColor(0.01)'), run('UP'));
  assert.equal(run('plColor(-0.01)'), run('DOWN'));
  for (const v of ['0', 'null', 'undefined', 'NaN']) assert.equal(run(`plColor(${v})`), '--flat', `${v} 는 회색(파랑이 아니다)`);
});

await test('rank: market and tab switch fetch only what is shown, reuse it for a minute, and a late reply does not replace another tab', async () => {
  const { c, run, elements } = harness(['renderRank', 'loadRank', 'setRankView']);
  const asked = [];
  const replies = [];
  c.api.rank = (q) => { asked.push(`${q.market}/${q.kind}`); return new Promise((r) => replies.push(r)); };
  c.rankHtml = (d, m, k) => (d ? `${m}/${k}:${d.n}` : `LOADING ${m}/${k}`);
  const settle = () => new Promise((r) => setImmediate(r));
  const list = () => elements.get('rankList').innerHTML;
  const tabs = () => elements.get('rankTabs').innerHTML;

  c.document.getElementById('rank').hidden = true;
  run('renderRank();');
  assert.equal(asked.length, 0, '닫혀 있으면 받지 않는다');

  c.document.getElementById('rank').hidden = false;
  run('renderRank();');
  assert.deepEqual([...asked], ['kr/search'], '처음은 국내 인기 검색');
  assert.equal(list(), 'LOADING kr/search');
  assert.match(tabs(), /<button data-kind="search" class="on">인기 검색<\/button><button data-kind="up">급등<\/button><button data-kind="down">급락<\/button><button data-kind="value">거래대금<\/button><button data-kind="industry">업종<\/button><button data-kind="theme">테마<\/button>/);
  assert.match(elements.get('rankMarket').innerHTML, /<button data-market="kr" class="on">국내<\/button><button data-market="us">미국<\/button>/);
  run('renderRank();');
  assert.equal(asked.length, 1, '받는 중이면 또 묻지 않는다');
  assert.equal(elements.get('rankRefresh').disabled, true, '받는 동안 창의 ↻ 를 끈다(2026-11-18)');
  replies.shift()({ ok: true, n: 1 });
  await settle();
  assert.equal(list(), 'kr/search:1');
  assert.equal(elements.get('rankRefresh').disabled, false, '받으면 다시 켠다');

  run("setRankView('us');");
  assert.equal(asked.at(-1), 'us/up', '미국에는 인기 검색이 없어 첫 탭(급등)으로');
  assert.doesNotMatch(tabs(), /인기 검색/);
  assert.match(tabs(), /<button data-kind="cap">시총 상위<\/button>/);
  run("setRankView('us', 'cap');");
  assert.equal(asked.at(-1), 'us/cap');
  replies.shift()({ ok: true, n: 2 }); // 늦게 온 급등 — 지금 보는 것은 시총 상위
  await settle();
  assert.equal(list(), 'LOADING us/cap', '다른 탭의 늦은 응답은 화면을 바꾸지 않는다');
  replies.shift()({ ok: true, n: 3 });
  await settle();
  assert.equal(list(), 'us/cap:3');
  run("setRankView('us', 'up');");
  assert.equal(list(), 'us/up:2', '받아 둔 탭은 다시 묻지 않는다');
  assert.equal(asked.length, 3);

  run("setRankView('kr');");
  assert.equal(asked.at(-1), 'kr/up', '시장을 바꿔도 지금 탭(급등)이 그 시장에도 있으면 그대로');
  replies.shift()({ ok: true, n: 4 });
  await settle();
  assert.equal(list(), 'kr/up:4');
  run("setRankView('us', 'cap'); setRankView('kr');");
  assert.match(tabs(), /data-kind="search" class="on"/, '그 시장에 없는 탭(시총 상위)이면 첫 탭으로');
  assert.equal(list(), 'kr/search:1', '받아 둔 국내 인기 검색');
  assert.equal(asked.length, 4);
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => NOW + 61000; // 하네스 시각 + 61초
  run('renderRank();');
  assert.equal(asked.at(-1), 'kr/search', '1분이 지나면 다시 받는다');
  assert.equal(list(), 'kr/search:1', '받는 동안은 있던 것을 보인다');
  replies.shift()({ ok: false, error: 'x' });
  await settle();
  assert.equal(list(), 'kr/search:1', '다시 받다 실패하면 있던 것을 둔다');
  c.Date.now = realNow;
});

// 국내 업종 · 테마(tests/rank.mjs): 묶음 순위와, 누르면 그 묶음 안의 종목. 묶음 등락률은 평균이라 오른 · 내린 종목 수를 같이 보인다.
await test('rank groups: the industry/theme list shows rank, name, colored change and up/down counts; inside a group the note says how stocks are picked', () => {
  const { c, run } = harness(['rankHtml']);
  run(helpers());
  c.D = { ok: true, market: 'kr', kind: 'industry', groups: [
    { no: 278, name: '반도체와반도체장비', pct: 4.41, count: 173, up: 126, down: 40 },
    { no: 1, name: '<b>x</b>', pct: -1.2, count: 8, up: 2, down: 5 }] };
  const html = run("rankHtml(D, 'kr', 'industry')");
  assert.match(html, /<div class="hit rrow" data-g="0" title="173종목 중 오른 126 · 내린 40 — 누르면 종목"><span class="rk">1<\/span><span class="hname">반도체와반도체장비<\/span><span class="rpct" style="color:#e24b4a">\+4\.41%<\/span><span class="rcnt"><span style="color:#e24b4a">↑126<\/span> <span style="color:#185fa5">↓40<\/span><\/span><\/div>/);
  assert.match(html, /<span class="hname">&lt;b&gt;x&lt;\/b&gt;<\/span><span class="rpct" style="color:#185fa5">-1\.20%<\/span>/, '이름은 이스케이프한다');
  assert.match(text(html), /^네이버 업종 등락률 순 · 5종목 이상 · ↑오른 ↓내린 종목 수1/, '기준 문구가 맨 위');
  assert.match(text(run("rankHtml({ ...D, kind: 'theme' }, 'kr', 'theme')")), /^네이버 테마 등락률 순/);
  c.D = { ok: true, market: 'kr', kind: 'theme', groups: [] };
  assert.match(run("rankHtml(D, 'kr', 'theme')"), /조건에 맞는 테마가 없습니다/);
  c.D = { ...KR_RANK, kind: 'industry' };
  assert.match(text(run("rankHtml(D, 'kr', 'industry')")),
    /^10\/16 14:22 기준 · 등락률 순 · 일반 주식만\(ETF · ETN · 우선주 제외\) · 거래대금 10억 원 이상1/, '묶음 안의 종목 — 급등처럼 거른다');
});

await test('rank groups: clicking a group opens its stocks under a back row, back returns to the cached list, a stock click still picks it, and switching tabs leaves the group', async () => {
  const { c, run, elements } = harness(['renderRank', 'loadRank', 'setRankView', 'rankKey', 'rankClick', 'rankBackHtml']);
  run(helpers());
  const asked = [];
  c.api.rank = async (q) => {
    asked.push(JSON.stringify(q));
    return q.no ? { ok: true, items: [{ symbol: '000660.KS', name: 'SK하이닉스' }] }
      : { ok: true, groups: [{ no: 278, name: '반도체', pct: 4.4, count: 173, up: 126, down: 40 }] };
  };
  c.rankHtml = (d, m, k) => (d ? `${m}/${k}:${d.groups ? 'groups' : 'items'}` : `LOADING ${m}/${k}`);
  const picked = [];
  c.pickRank = async (it) => { picked.push(it.symbol); };
  const settle = () => new Promise((r) => setImmediate(r));
  const list = () => elements.get('rankList').innerHTML;
  // 누른 곳 — closest('[data-x]') 가 그 속성이 있으면 그 요소
  const at = (data) => ({ closest: (sel) => (/\[data-([\w-]+)\]/.exec(sel)[1] in data ? { dataset: data } : null) });

  c.document.getElementById('rank').hidden = false;
  run("setRankView('kr', 'industry');");
  await settle();
  assert.equal(asked.at(-1), JSON.stringify({ market: 'kr', kind: 'industry' }));
  assert.equal(list(), 'kr/industry:groups');

  c.rankClick(at({ g: '0' }));
  await settle();
  assert.equal(asked.at(-1), JSON.stringify({ market: 'kr', kind: 'industry', no: 278 }), '누른 묶음의 종목을 묻는다');
  assert.match(list(), /^<div class="hit rback" data-back="1" title="업종 목록으로">← <span class="hname">반도체<\/span><span class="rpct" style="color:#e24b4a">\+4\.40%<\/span><span class="rcnt"><span style="color:#e24b4a">↑126<\/span> <span style="color:#185fa5">↓40<\/span><\/span><\/div>kr\/industry:items$/,
    '맨 위에 돌아가는 줄(묶음 이름 · 등락률 · 오른 · 내린)');
  assert.match(elements.get('rankTabs').innerHTML, /data-kind="industry" class="on"/, '탭은 업종 그대로');

  c.rankClick(at({ i: '0' }));
  assert.deepEqual(picked, ['000660.KS'], '묶음 안의 종목도 누르면 관심종목으로');

  c.rankClick(at({ back: '1' }));
  assert.equal(list(), 'kr/industry:groups', '← 는 받아 둔 묶음 목록으로');
  assert.equal(asked.length, 2, '다시 묻지 않는다');

  c.rankClick(at({ g: '0' }));
  run("setRankView('kr', 'theme');");
  await settle();
  assert.equal(asked.at(-1), JSON.stringify({ market: 'kr', kind: 'theme' }), '탭을 바꾸면 묶음 밖 — 테마 목록');
  assert.equal(list(), 'kr/theme:groups');
});

await test('rank: clicking a stock already in the watchlist goes to it; a new one is added and opened with an undo; a failed add says why and keeps the panel', async () => {
  const { c, run, elements } = harness(['pickRank']);
  run(source.match(/^const adding = .*$/m)[0]); // 넣는 중인 종목(addSymbol)
  const log = [];
  Object.assign(c, {
    select: async (s) => { log.push(`select ${s}`); },
    closeRank: () => { log.push('close'); },
    addSymbol: async (it) => {
      log.push(`add ${it.symbol} ${it.name}`);
      if (it.symbol === 'BAD') return 'No data found'; // addSymbol 은 못 넣은 이유를 돌려준다
      run(`state.watchlist.push({ symbol: '${it.symbol}', name: '${it.name}' });`);
    },
    showUndo: (s) => { log.push(`undo ${s.item.symbol} added=${s.added} prev=${s.prev}`); },
  });
  await c.pickRank({ symbol: '005930.KS', name: '삼성전자' });
  assert.deepEqual(log.splice(0), ['close', 'select 005930.KS'], '이미 있으면 넣지 않고 그 종목으로');
  await c.pickRank({ symbol: 'NVDA', name: '엔비디아' });
  assert.deepEqual(log.splice(0), ['add NVDA 엔비디아', 'close', 'undo NVDA added=true prev=005930.KS'],
    '없으면 넣고(넣으면서 연다) 패널을 닫는다 — 구경하려던 것일 수 있어 되돌리기(빼고 보던 종목으로)');
  await c.pickRank({ symbol: 'BAD', name: '없는' });
  assert.deepEqual(log.splice(0), ['add BAD 없는'], '못 넣었으면 패널을 둔다');
  assert.equal(elements.get('rankMsg').textContent, '없는: 추가하지 못했습니다 (No data found)', '실제 이유를 적는다');
  assert.equal(elements.get('rankMsg').hidden, false);
  // 같은 줄을 또 눌렀다 — 먼저 누른 것이 넣는 중이면(addSymbol 이 바로 돌아온다) 실패로 적지 않는다
  run("adding.add('AMD'); document.getElementById('rankMsg').textContent = 'AMD 추가하는 중…';");
  await c.pickRank({ symbol: 'AMD', name: 'AMD' });
  assert.deepEqual(log.splice(0), [], '넣는 중이면 아무것도 하지 않는다');
  assert.equal(elements.get('rankMsg').textContent, 'AMD 추가하는 중…');
});

await test('rank: the three panels (search, settings, rank) close each other, and a widget opened from compact folds back only when all are closed', () => {
  const { c, run } = harness(['openPanel', 'closePanel']);
  const folds = [];
  Object.assign(c, { searchEl: { hidden: true }, alertsEl: { hidden: true }, rankEl: { hidden: true },
    setCompact: (on) => { folds.push(on); run(`compact = ${on};`); } });
  run('var compact = true; var expandedForPanel = false;');
  run('openPanel(rankEl);');
  assert.deepEqual(folds.splice(0), [false], '접혀 있으면 펼쳐서 연다');
  assert.equal(c.rankEl.hidden, false);
  run('openPanel(searchEl);');
  assert.equal(c.rankEl.hidden, true, '다른 패널을 열면 순위 패널은 닫힌다');
  assert.equal(c.searchEl.hidden, false);
  run('openPanel(rankEl);');
  assert.equal(c.searchEl.hidden, true, '순위 패널을 열면 검색은 닫힌다');
  c.searchEl.hidden = false; // 둘이 같이 열린 경우(검색에서 종목을 넣는 동안)
  run('closePanel(searchEl);');
  assert.deepEqual(folds.splice(0), [], '순위 패널이 아직 열려 있으면 다시 접지 않는다');
  run('closePanel(rankEl);');
  assert.deepEqual(folds.splice(0), [true], '모두 닫히면 다시 접는다');
  // Esc · 접기 버튼도 순위 패널을 안다
  assert.match(source, /if \(!rankEl\.hidden\) \{\s*if \(e\.key === 'Escape'\) closeRank\(\);\s*return;\s*\}/, 'Esc 로 닫는다');
  assert.match(realFunction('refreshAll'), /\n    renderRank\(\);/, '30초 갱신 때 열린 순위 패널도 고친다(1분 지난 탭을 다시 받는다)');
  assert.match(source, /if \(!searchEl\.hidden \|\| !alertsEl\.hidden \|\| !rankEl\.hidden\) \{\s*expandedForPanel = false;\s*closeSearch\(\);\s*closeAlerts\(\);\s*closeRank\(\);/, '접기를 누르면 모두 닫는다');
});

// 검색에서 이미 있는 종목은 눌러도 반응이 없었고, Enter 는 그것을 건너뛰어 다음 결과(삼성전자우)를 넣었다 — 그 종목으로 간다
await test('search: a stock already in the watchlist goes to it on click or Enter instead of adding the next result', async () => {
  const { c, run } = harness(['runSearch', 'renderSearchItems']);
  run('let searchSeq = 0;');
  const kids = [];
  const log = [];
  Object.assign(c, {
    qEl: { value: '삼성전자' }, searchEl: { hidden: false }, hint() {}, esc: (s) => s,
    resultsEl: { innerHTML: '', appendChild: (el) => kids.push(el) },
    closeSearch: () => log.push('close'), select: async (s) => { log.push(`select ${s}`); },
    addSymbol: (it) => { log.push(`add ${it.symbol}`); },
  });
  c.api.search = async () => ({ ok: true, items: [{ symbol: '005930.KS', name: '삼성전자', market: 'KOSPI' },
    { symbol: '005935.KS', name: '삼성전자우', market: 'KOSPI' }] });
  c.document.createElement = () => ({ setAttribute() {} });
  await c.runSearch();
  assert.deepEqual(kids.map((k) => k.className), ['hit dup', 'hit']);
  kids[0].onclick();
  kids[1].onclick();
  assert.deepEqual(log, ['close', 'select 005930.KS', 'add 005935.KS'], '이미 있으면 닫고 그 종목으로, 없으면 넣는다');
  assert.match(source, /const first = qEl\.value\.trim\(\) \? resultsEl\.querySelector\('\.hit'\) : null;/,
    'Enter 는 첫 결과(이미 있는 종목이어도 건너뛰지 않는다) — 빈 검색창의 인기 목록은 고르지 않는다');
});

// 지표 화면을 연 채 기간을 바꾸면 탭 강조만 바뀌고 차트는 덮인 채였다 — 차트로 돌아간다
await test('picking a timeframe closes the metrics view and goes back to the chart', () => {
  const { c, run } = harness(['pickTimeframe', 'setTimeframe']);
  const log = [];
  Object.assign(c, { save() {}, renderTabs() {}, renderMetrics: () => log.push(`metrics ${run('metricsOn')}`),
    loadChart: () => log.push('chart') });
  run("metricsOn = true; pickTimeframe('3M');");
  assert.deepEqual(log, ['metrics false', 'chart']);
  assert.equal(run('state.timeframe'), '3M');
});

// 차트만 보기는 차트 위 버튼이라 설정에서는 보이지 않는다 — 켜 둔 채 칩을 켜면 아무것도 안 그려져 설정에 이유를 적는다
await test('settings: a hint says plain chart is on; opening also redraws the indicator chips for the current timeframe', () => {
  const { c, run, elements } = harness(['openAlerts']);
  let chips = 0;
  const notes = [];
  Object.assign(c, { alertsEl: {}, openPanel() {}, renderAlerts() {}, renderMaChips() {}, renderIndChips: () => { chips++; },
    sortNote: (t) => notes.push(t) });
  run("sortBefore = ['앞 순서'];");
  run('state.plainChart = true; openAlerts();');
  assert.equal(elements.get('plainHint').hidden, false);
  assert.equal(chips, 1, '기간이 바뀌었을 수 있어 열 때마다 칩을 다시 그린다');
  run('state.plainChart = false; openAlerts();');
  assert.equal(elements.get('plainHint').hidden, true);
  assert.ok(run('sortBefore') === null && notes.at(-1) === '', '열 때 지난 정렬 안내 · 되돌리기를 비운다(그 사이 종목이 바뀔 수 있다)');
});

// 차트만 보기: 버튼 하나로 덧그림(이동평균 · 보조 지표 · 교차 · 가로선 · 기간 배지)을 다 끈다.
// 칩 설정은 그대로라 다시 누르면 돌아온다. 가격과 거래량 막대는 남는다.
await test('plain chart: one switch hides every overlay and keeps price and volume; switching back restores them', async () => {
  const { c, run, elements } = harness(['loadChart', 'alignByDay', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange', 'maFor', 'rsiFor']);
  const draws = [];
  const asked = [];
  const periods = [];
  const badges = [];
  let bars;
  Object.assign(c, {
    fetchChartCached: async (s) => { asked.push(s); return s === '005930.KS' ? bars : { ok: false, error: 'x' }; },
    err: () => {}, quoteErrText: () => '', renderMaChips: () => {}, curOf: () => 'KRW',
    renderPeriod: (...a) => periods.push(a),
    renderCrossBadge: (x) => badges.push(`cross ${x.length}`),
    drawChart: (data) => draws.push(data), rsiWarmFor: async () => null,
  });
  const day = 86400000;
  const t0 = Date.parse('2026-07-28T00:00:00Z');
  const N = 45;
  const T = Array.from({ length: N }, (_, i) => t0 + i * day);
  const C = Array.from({ length: N }, (_, i) => 100 + (i % 5));
  const V = Array.from({ length: N }, () => 1000);
  run(`let lastDrawSig = null; quotes['005930.KS'] = { price: ${C[N - 1]}, prevClose: 100, change: 4, live: true,
    daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} },
    dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(V)} },
    dailyHL: { times: [${Date.parse('2026-09-09T00:00:00Z')}, ${Date.parse('2026-09-10T00:00:00Z')}], highs: [110, 120], lows: [90, 95] } };
    state.maPeriods = [5]; state.holdings = { '005930.KS': { qty: 1, avg: 101 } };
    state.indicators = cleanIndicators({ bb: true, vwap: true, volAvg: true, prevHL: true, vp: true, rel: true, rsi: true });`);
  const daily = { ok: true, closes: C.slice(-22), times: T.slice(-22), volumes: V.slice(-22),
    opens: C.slice(-22), highs: C.slice(-22), lows: C.slice(-22) };
  const T1 = (s) => Date.parse(`2026-09-10T${s}:00+09:00`);
  const oneDay = { ok: true, closes: [100, 102, 101], times: ['09:00', '09:05', '09:10'].map(T1),
    volumes: [100, 300, 50], opens: [100, 102, 101], highs: [101, 103, 101], lows: [99, 101, 100] };
  const show = async (tf, plain, b) => {
    bars = b;
    asked.length = 0;
    run(`state.timeframe = '${tf}'; state.plainChart = ${plain};`);
    await c.loadChart();
    return draws.at(-1);
  };

  let d = await show('3M', false, daily);
  assert.ok(d.mas.length && d.bands && d.volAvg && d.profile && d.rsi && d.hLines.length, '켜 둔 덧그림이 다 있다');
  assert.deepEqual([...asked], ['005930.KS', '^KS11']);
  const drawn = draws.length;
  const shownPeriods = periods.length;
  c.document.getElementById('period').hidden = false;

  d = await show('3M', true, daily);
  assert.equal(draws.length, drawn + 1, '켜기만 해도 다시 그린다');
  assert.deepEqual([d.mas.length, d.crosses.length, d.hLines.length], [0, 0, 0]);
  assert.equal(d.bands, null);
  assert.equal(d.volAvg, null);
  assert.equal(d.vwapLine, null);
  assert.equal(d.profile, false);
  assert.equal(d.rsi, null);
  assert.deepEqual([...d.closes], C.slice(-22), '가격은 그대로');
  assert.deepEqual([...d.volumes], V.slice(-22), '거래량 막대는 남는다');
  assert.deepEqual([...asked], ['005930.KS'], '지수 대비를 안 보이므로 지수 차트도 받지 않는다');
  assert.equal(elements.get('period').hidden, true, '기간 · 지수 대비 배지도 숨긴다');
  assert.equal(periods.length, shownPeriods);
  assert.deepEqual(badges.slice(-1), ['cross 0'], '교차 배지도 비운다');
  assert.equal(JSON.stringify(run('state.indicators')),
    '{"bb":true,"vwap":true,"volAvg":true,"prevHL":true,"vp":true,"rel":true,"sar":false,"rsi":true,"stoch":false}', '칩 설정은 지우지 않는다');
  assert.equal(JSON.stringify(run('state.maPeriods')), '[5]');

  d = await show('1D', true, oneDay);
  assert.equal(d.hLines.length, 0, '1D 의 평단 · 전일 · 전고 · 전저도 끈다');
  assert.equal(d.vwapLine, null);
  assert.equal(d.volAvg, null);
  d = await show('1D', false, oneDay);
  assert.deepEqual([...d.hLines.map((l) => l.label)], ['평단', '전일', '전고', '전저'], '다시 누르면 돌아온다');
  assert.ok(d.vwapLine && d.volAvg);
  d = await show('3M', false, daily);
  assert.ok(d.mas.length && d.bands, '일봉 덧그림도 돌아온다');
});

await test('plain chart: the switch beside the candle/line icon shows its state and hides with the chart', () => {
  const { c, run, elements } = harness(['renderChartMode']);
  c.MODE_ICON = { candle: 'C', line: 'L' };
  run("state.chartMode = 'line'; state.plainChart = false; renderChartMode(30, true);");
  const b = elements.get('plainChart');
  assert.equal(b.hidden, false);
  assert.equal(b.className, 'on', '덧그림이 보이면 또렷하게 — RSI 칸 · 정규장/전체 버튼처럼 켜져 있으면 또렷');
  assert.equal(b.title, '차트만 보기 — 이동평균 · 보조 지표 · 기준선 끄기');
  run('state.plainChart = true; renderChartMode(30, true);');
  assert.equal(b.className, '', '차트만 보기로 덧그림을 껐으면 흐리게');
  assert.equal(b.title, '덧그림 다시 보기');
  assert.match(source, /function clearChart\(\) \{[\s\S]*?getElementById\('plainChart'\)\.hidden = true;[\s\S]*?\n\}/, '차트를 지우면 같이 숨는다');
});

// 정규장 / 전체(장전 · 장후 포함) — 1D · 1W 는 정규장만 보기(state.extHours === false)가 아니면 시간외 봉까지
// 묻는다(main.js 가 미국은 야후 프리 · 애프터, 국내는 NXT 분봉을 붙인다). 두 응답은 캐시에서 따로 둔다.
await test('ext hours: 1D · 1W ask for pre/after-hours bars unless the regular-only view is on, and the cache keeps the two apart', async () => {
  const { c, run } = harness(['fetchChartCached']);
  const asked = [];
  c.api.fetchChart = async (a) => { asked.push(JSON.stringify(a)); return { ok: true, closes: [1], times: [1] }; };
  run('var chartCache = new Map(); var chartTtl = () => 60000; state.extHours = true;');
  const ask = (tf) => c.fetchChartCached('005930.KS', c.chartTf(tf));
  await ask('1W');
  assert.equal(asked.at(-1), JSON.stringify({ symbol: '005930.KS', range: '5d', interval: '30m', extended: true }));
  run('state.extHours = false;');
  await ask('1W');
  assert.equal(asked.length, 2, '정규장만 보기는 다른 응답이다 — 받아 둔 전체를 꺼내지 않는다');
  assert.equal(asked.at(-1), JSON.stringify({ symbol: '005930.KS', range: '5d', interval: '30m', extended: false }));
  await ask('1D');
  assert.equal(asked.at(-1), JSON.stringify({ symbol: '005930.KS', range: '1d', interval: '5m', extended: false }));
  run('state.extHours = true;');
  await ask('1W');
  assert.equal(asked.length, 3, '전체로 돌아오면 받아 둔 것을 쓴다');
  await ask('1M');
  assert.equal(asked.at(-1), JSON.stringify({ symbol: '005930.KS', range: '1mo', interval: '1d' }), '일봉은 시간외가 없다');
});

await test('ext hours: the 정규장/전체 switch shows only on 1D · 1W for stocks, names the view and hides with the chart', () => {
  const { c, run, elements } = harness(['renderChartMode']);
  c.MODE_ICON = { candle: 'C', line: 'L' };
  run(`state.watchlist = [{ symbol: '005930.KS', name: '삼성전자' }]; state.selected = '005930.KS';
    state.timeframe = '1W'; state.extHours = true; renderChartMode(0, false);`);
  const b = elements.get('extHours');
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, '전체');
  assert.equal(b.className, 'on', '시간외를 켠 전체면 또렷하게 — RSI 칸 버튼처럼 켜져 있으면 또렷');
  assert.equal(b.title, '전체(장전 · 장후 포함) — 누르면 정규장만');
  run('state.extHours = false; renderChartMode(0, false);');
  assert.equal(b.textContent, '정규장');
  assert.equal(b.className, '', '정규장만이면 흐리게');
  assert.equal(b.title, '정규장만 — 누르면 장전 · 장후까지');
  run("state.timeframe = '1M'; renderChartMode(20, true);");
  assert.equal(b.hidden, true, '일봉은 정규장만 있다');
  run("state.timeframe = '1D'; state.selected = '^KS11'; renderChartMode(0, false);");
  assert.equal(b.hidden, true, '지수 · 환율은 시간외가 없다');
  run("state.selected = '005930.KS'; renderChartMode(0, false);");
  assert.equal(b.hidden, false);
  assert.match(source, /function clearChart\(\) \{[\s\S]*?getElementById\('extHours'\)\.hidden = true;[\s\S]*?\n\}/, '차트를 지우면 같이 숨는다');
});

await test('ext hours: the switch flips the view, saves it and redraws', async () => {
  const { c, run } = harness(['toggleExtHours']);
  const log = [];
  Object.assign(c, { save: () => log.push('save'), loadChart: async () => log.push(`load:${run('state.extHours')}`) });
  run('state.extHours = true;');
  await c.toggleExtHours();
  assert.deepEqual(log.splice(0), ['save', 'load:false']);
  await c.toggleExtHours();
  assert.deepEqual(log.splice(0), ['save', 'load:true']);
});

// 아래 칸 양옆 ‹ ›(#paneNav) — Chart.js 배치가 끝난 뒤 위아래는 그 칸(yRsi), 좌우는 그림 영역 바로 바깥(버튼 폭만큼)에
// 맞추고, 칸이 없으면 숨는다. 칸 안 양끝에 두니 양끝 봉을 가렸다.
// 켜고 끄기는 설정 칩만이라 차트 위 RSI · 스토 버튼은 없앴다(사용자 결정, 2026-11-09).
await test('pane nav: the side arrows sit on the lower pane and hide without it or the chart', () => {
  const { run, elements } = harness();
  run(source.match(/^const PANE_NAV_W = .*$/m)[0]);
  run(source.match(/^const paneNavPlugin = \{[\s\S]*?\n\};/m)[0]);
  run('paneNavPlugin').afterLayout({ chartArea: { left: 2, right: 300 }, scales: { yRsi: { top: 150, bottom: 195 } } });
  const el = elements.get('paneNav');
  assert.equal(el.hidden, false);
  assert.equal(run('PANE_NAV_W'), 11, 'index.html .panenav button 폭과 같다');
  assert.deepEqual({ ...el.style }, { left: '-9px', width: '320px', top: '150px', height: '45px' }, '그림 영역 바로 바깥 양옆 · 아래 칸 위아래');
  run('paneNavPlugin').afterLayout({ chartArea: { left: 2, right: 300 }, scales: {} });
  assert.equal(el.hidden, true, '아래 칸이 없으면(둘 다 꺼짐 · 전체 · 차트만 보기) 숨는다');
  assert.match(realFunction('drawChart'), /plugins: \[[^\]]*paneNavPlugin\]/, '차트마다 붙는다');
  assert.match(source, /function clearChart\(\) \{[\s\S]*?getElementById\('paneNav'\)\.hidden = true;[\s\S]*?\n\}/, '차트를 지우면 같이 숨는다');
  assert.match(source, /getElementById\('paneNav'\)\.onclick = \(e\) => \{ if \(e\.target\.closest\('button'\)\) flipPane\(\)/, '‹ · › 둘 다 바꾸기');
  assert.ok(!/rsiPane|stochPane|togglePane/.test(source), '차트 위 버튼은 없다');
});

// ‹ › — RSI ↔ 스토캐스틱. 설정 칩과 같은 값이라 칩도 다시 그린다. 같은 칸이라 하나만 켜진다(사용자 결정, 2026-11-09).
await test('pane nav: the arrows flip RSI and stochastic, save, update the chips and redraw', async () => {
  const { c, run } = harness(['flipPane']);
  const log = [];
  Object.assign(c, { save: () => log.push('save'), renderIndChips: () => log.push('chips'),
    loadChart: async () => log.push(`load:${run('state.indicators.rsi')}/${run('state.indicators.stoch')}`) });
  run('state.indicators = { sar: true, rsi: true, stoch: false };');
  await c.flipPane();
  assert.deepEqual(log.splice(0), ['save', 'chips', 'load:false/true'], 'RSI → 스토캐스틱');
  assert.equal(run('state.indicators.sar'), true, '다른 지표는 그대로');
  await c.flipPane();
  assert.deepEqual(log.splice(0), ['save', 'chips', 'load:true/false'], '스토캐스틱 → RSI');
  // 설정 칩도 같은 규칙(withIndicator)이다. 저장 · 백업에서 둘 다 켜져 오면 RSI 만(cleanIndicators)
  assert.match(realFunction('renderIndChips'), /state\.indicators = withIndicator\(ind\.key, !on\)/);
  run('state.indicators = { rsi: true, stoch: false, bb: true };');
  assert.equal(JSON.stringify(run("withIndicator('bb', false)")), '{"rsi":true,"stoch":false,"bb":false}', '다른 지표는 서로 상관없다');
  assert.equal(JSON.stringify(run("withIndicator('stoch', false)")), '{"rsi":true,"stoch":false,"bb":true}', '끄는 것은 다른 쪽을 건드리지 않는다');
  assert.equal(JSON.stringify(run("withIndicator('stoch', true)")), '{"rsi":false,"stoch":true,"bb":true}', '켜면 다른 쪽을 끈다');
  const both = run('cleanIndicators({ rsi: true, stoch: true })');
  assert.ok(both.rsi === true && both.stoch === false);
  assert.equal(run('cleanIndicators({ stoch: true })').stoch, true);
});

await test('rsi pane: the chart box grows by the RSI pane while RSI is on, loading or not', () => {
  const { run } = harness();
  run('state.indicators = { rsi: true };');
  assert.equal(run('chartBoxClass()'), 'chartbox sub');
  assert.equal(run('chartBoxClass(true)'), 'chartbox sub loading');
  run('state.indicators = { rsi: false };');
  assert.equal(run('chartBoxClass()'), 'chartbox');
  assert.equal(run('chartBoxClass(true)'), 'chartbox loading');
  run('state.indicators = { rsi: false, stoch: true };');
  assert.equal(run('chartBoxClass()'), 'chartbox sub', '스토캐스틱도 같은 칸');
  run('delete state.indicators;');
  assert.equal(run('chartBoxClass()'), 'chartbox', '지표 설정이 없어도');
  // RSI 크게 보기(#rsiTall)를 켜면 RSI 칸이 RSI_TALL 이라 상자도 그만큼(tall) — RSI 를 끄면 상관없다
  run('state.indicators = { rsi: true }; rsiTall = true;');
  assert.equal(run('chartBoxClass()'), 'chartbox sub tall');
  assert.equal(run('chartBoxClass(true)'), 'chartbox sub tall loading');
  run('state.indicators = { rsi: false };');
  assert.equal(run('chartBoxClass()'), 'chartbox');
});

// RSI 크게 보기 버튼(차트 왼쪽 위, RSI 버튼 옆) — RSI 칸이 보일 때만. 켜면 RSI 칸이 RSI_PANE 에서 RSI_TALL 로 커지고 차트
// 상자도 그만큼 커진다(가격 칸 그대로, 관심종목 목록이 줄어든다 — 사용자가 정함). 저장하지 않고(앱을 다시 켜면 꺼짐),
// 데이터는 그대로라 상자 높이만 맞추고 다시 그린다.
await test('rsi tall: the switch shows only with the RSI pane, names its state, resizes the box and redraws without saving', () => {
  const { c, run, elements } = harness(['renderChartMode', 'toggleRsiTall']);
  run(source.match(/^let lastChart = .*$/m)[0]);
  c.MODE_ICON = { candle: 'C', line: 'L' };
  const drawn = [];
  Object.assign(c, { save: () => drawn.push('save'), drawChart: (d) => drawn.push(d) });
  run("state.timeframe = '1D'; state.plainChart = false; state.indicators = { rsi: false }; renderChartMode(0, false);");
  const b = elements.get('rsiTall');
  assert.equal(b.hidden, true, 'RSI 칸이 꺼져 있으면 숨는다');
  run('state.indicators = { stoch: true }; renderChartMode(0, false);');
  assert.equal(b.hidden, false, '스토캐스틱 칸에도');
  run('state.indicators = { rsi: true }; renderChartMode(0, false);');
  assert.equal(b.hidden, false);
  assert.equal(b.className, '', '처음에는 꺼짐');
  assert.equal(b.title, '아래 칸 크게 보기 — RSI · 스토캐스틱 칸을 2배로(관심종목 목록이 그만큼 줄어든다)');
  run("state.timeframe = '전체'; renderChartMode(20, true);");
  assert.equal(b.hidden, true, 'RSI 를 그리지 않는 기간');
  run("state.timeframe = '1Y'; state.plainChart = true; renderChartMode(20, true);");
  assert.equal(b.hidden, true, '차트만 보기');
  run("state.plainChart = false; lastChart = { id: 'last' }; document.getElementById('chartBox').className = 'chartbox sub';");
  c.toggleRsiTall();
  assert.equal(run('rsiTall'), true);
  assert.equal(elements.get('chartBox').className, 'chartbox sub tall', '상자를 키운다');
  assert.deepEqual(drawn.map((d) => d.id || d), ['last'], '저장하지 않고 다시 그린다');
  run('renderChartMode(20, true);');
  assert.equal(b.className, 'on', '켜져 있으면 또렷하게');
  assert.equal(b.title, '아래 칸 원래 크기로');
  run("document.getElementById('chartBox').className = 'chartbox sub tall loading';");
  c.toggleRsiTall();
  assert.equal(elements.get('chartBox').className, 'chartbox sub loading', '받는 중이면 불러오는 중은 그대로');
  run('lastChart = null;');
  c.toggleRsiTall();
  assert.equal(drawn.length, 2, '차트가 없으면 그리지 않는다');
  assert.match(source, /function clearChart\(\) \{[\s\S]*?getElementById\('rsiTall'\)\.hidden = true;[\s\S]*?\n\}/, '차트를 지우면 같이 숨는다');
});

// NXT 에 없는 종목(DSC인베스트먼트 · ETF)은 정규장 · 전체 응답이 똑같다 — 서명이 같아 다시 그리지 않으면 버튼 글자
// (drawChart → renderChartMode)도 안 바뀌어 눌러도 안 되는 것처럼 보였다(2026-10-22). 캔들/선 · 차트만 보기처럼 서명에 넣는다.
await test('ext hours: switching redraws even when both views return the same bars, so the switch label follows', async () => {
  const { c, run } = harness(['loadChart', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const draws = [];
  const t0 = Date.parse('2026-10-22T00:00:00Z');
  const same = { ok: true, closes: [6700, 6620], times: [t0, t0 + 300000], volumes: [1, 1], opens: [6700, 6620], highs: [6700, 6620], lows: [6700, 6620] };
  Object.assign(c, {
    fetchChartCached: async () => same, err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {},
    renderCrossBadge: () => {}, curOf: () => 'KRW', drawChart: (d) => draws.push(d),
  });
  run("let lastDrawSig = null; state.timeframe = '1W'; state.indicators = cleanIndicators({}); state.extHours = true;");
  await c.loadChart();
  run('state.extHours = false;');
  await c.loadChart();
  assert.equal(draws.length, 2, '정규장으로 바꾸면 다시 그린다(버튼 글자가 따라온다)');
  await c.loadChart();
  assert.equal(draws.length, 2, '같은 보기의 30초 갱신은 그대로 둔다');
});

await test('ext hours: loadChart asks with the view the switch picked', async () => {
  const { c, run } = harness(['loadChart']);
  const asked = [];
  Object.assign(c, {
    fetchChartCached: async (_s, tf) => { asked.push(tf.extended); return { ok: false, error: 'x' }; },
    err: () => {}, clearChart: () => {},
  });
  run("state.timeframe = '1W'; state.extHours = false;");
  await c.loadChart();
  run('state.extHours = true;');
  await c.loadChart();
  assert.deepEqual(asked, [false, true]);
});

// 기간 배지는 첫 정규장 봉부터 — 1W 전체의 첫 봉은 그날 프리라 그대로 쓰면 정규장 / 전체에 따라 값이 달라진다
await test('ext hours: the period badge starts at the first regular bar, so 정규장 and 전체 show the same return', async () => {
  const { c, run } = harness(['loadChart', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const periods = [];
  const t0 = Date.parse('2026-10-14T23:00:00Z'); // 10/15 08:00 KST
  const times = [t0, t0 + 3600000, t0 + 7200000];
  Object.assign(c, {
    fetchChartCached: async () => ({ ok: true, closes: [90, 100, 110], times, volumes: [1, 1, 1],
      opens: [90, 100, 110], highs: [90, 100, 110], lows: [90, 100, 110], ext: ['pre', null, null] }),
    benchReturn: (_b, _g, since) => { periods.push(['since', since]); return null; },
    err: () => {}, quoteErrText: () => '', renderPeriod: (...a) => periods.push(a), renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW', drawChart: () => {},
  });
  run(`let lastDrawSig = null; state.timeframe = '1W'; state.indicators = cleanIndicators({});
    quotes['005930.KS'] = { price: 120, prevClose: 110, change: 10 };`);
  await c.loadChart();
  assert.deepEqual(periods.find((p) => p[0] === 'since'), ['since', times[1]], '지수 대비도 같은 봉부터');
  assert.equal(periods.find((p) => p[0] !== 'since')[0], 100, '프리 봉(90)이 아니라 첫 정규장 봉(100)부터');
});

// 네트워크가 느리면 차트 응답까지 몇 초가 걸린다. 그동안 탭 · 헤더는 새 종목 · 기간인데 차트 · 기간 배지는
// 옛 것이라 "눌러도 데이터가 안 바뀐다"로 보였다(2026-10-15). 다른 화면으로 넘어가면 옛 차트를 먼저 지우고
// 불러오는 중을 띄운다. 같은 화면의 30초 갱신은 지우지 않는다(깜빡이지 않게).
// 같은 종목 · 기간의 갱신이 한 번 실패(야후 429 · 시간 초과)하면 그리던 차트를 두고 오류만 적는다 — 지우면 다음 갱신
// (장 마감 뒤 5분)까지 빈칸이었다. 다른 화면으로 넘어간 뒤의 실패와 장 시작 직후의 빈 응답은 지운다.
await test('slow network: a failed refresh of the same chart keeps it with the error; another screen or an empty reply clears it', async () => {
  const { c, run } = harness(['loadChart']);
  let reply;
  let cleared = 0;
  const errs = [];
  const series = (closes) => ({ ok: true, closes, times: closes.map((_, i) => Date.parse(`2026-09-0${i + 1}T00:00:00Z`)),
    volumes: closes.map(() => 1), opens: closes, highs: closes, lows: closes });
  Object.assign(c, {
    fetchChartCached: async () => reply, err: (m) => errs.push(m), quoteErrText: () => '', renderPeriod: () => {},
    renderMaChips: () => {}, renderCrossBadge: () => {}, curOf: () => 'KRW', drawChart: () => {},
    clearChart: () => { cleared++; run('drawnKey = null;'); }, intradayWaitText: () => 'WAIT',
  });
  run("let lastDrawSig = null; state.timeframe = '1M';");
  reply = series([1, 2]);
  await c.loadChart();
  reply = { ok: false, error: 'HTTP 429' };
  await c.loadChart();
  assert.equal(cleared, 0, '같은 화면의 갱신 실패는 차트를 둔다');
  assert.match(errs.at(-1), /차트: HTTP 429$/, '오류는 적는다');

  run("state.timeframe = '3M';");
  await c.loadChart();
  assert.ok(cleared >= 1, '다른 기간으로 넘어간 뒤의 실패는 지운다');

  run("state.timeframe = '1D'; lastDrawSig = null;");
  reply = series([1, 2]);
  await c.loadChart();
  const before = cleared;
  reply = { ok: false, error: '빈 데이터' };
  await c.loadChart();
  assert.equal(cleared, before + 1, '빈 응답(장 시작 직후 1D)은 지운다');
  assert.equal(errs.at(-1), 'WAIT');
});

await test('slow network: switching symbol or period clears the old chart and shows loading until the new one arrives', async () => {
  const { c, run, elements } = harness(['loadChart']);
  const draws = [];
  let cleared = 0;
  let pending = null;
  const series = (closes) => ({ ok: true, closes, times: closes.map((_, i) => Date.parse(`2026-09-0${i + 1}T00:00:00Z`)),
    volumes: closes.map(() => 1), opens: closes, highs: closes, lows: closes });
  Object.assign(c, {
    fetchChartCached: () => new Promise((resolve) => { pending = resolve; }),
    err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW', drawChart: (d) => draws.push(d),
    clearChart: () => { cleared++; },
  });
  run("let lastDrawSig = null; state.timeframe = '1M';");
  const box = () => elements.get('chartBox').className;
  const settle = () => new Promise((r) => setImmediate(r));

  let load = c.loadChart();
  assert.equal(box(), 'chartbox loading', '처음 그릴 때도 불러오는 중');
  assert.equal(cleared, 0, '지울 차트가 없다');
  pending(series([1, 2]));
  await load;
  assert.equal(draws.length, 1);
  assert.equal(box(), 'chartbox');

  // 같은 화면의 갱신 — 응답을 기다리는 동안에도 차트를 그대로 둔다
  load = c.loadChart();
  await settle();
  assert.equal(cleared, 0, '같은 종목 · 기간이면 지우지 않는다');
  assert.equal(box(), 'chartbox');
  pending(series([1, 3]));
  await load;
  assert.equal(draws.length, 2);

  // 기간을 바꾸면 응답 전에 옛 차트를 지운다
  c.document.getElementById('period').hidden = false;
  run("state.timeframe = '3M';");
  load = c.loadChart();
  await settle();
  assert.equal(cleared, 1, '다른 기간으로 넘어가면 바로 지운다');
  assert.equal(elements.get('period').hidden, true, '옛 기간 배지도 숨긴다');
  assert.equal(box(), 'chartbox loading');
  pending(series([5, 6, 7]));
  await load;
  assert.equal(draws.at(-1).closes.length, 3);
  assert.equal(box(), 'chartbox', '그리면 불러오는 중을 내린다');

  // 종목을 바꿔도 같다. 응답이 늦게 와 버려지는(더 새 요청이 있는) 동안은 불러오는 중을 그대로 둔다
  run("state.selected = '000660.KS';");
  load = c.loadChart();
  await settle();
  assert.equal(cleared, 2, '다른 종목으로 넘어가면 바로 지운다');
  const first = pending;
  run("state.timeframe = '1Y';");
  const load2 = c.loadChart();
  await settle();
  first(series([9, 9]));
  await load;
  assert.equal(box(), 'chartbox loading', '버려진 응답은 불러오는 중을 내리지 않는다');
  assert.equal(draws.length, 3);
  pending({ ok: false, error: '응답 시간 초과' });
  await load2;
  assert.equal(box(), 'chartbox', '실패해도 내린다(오류 문구가 대신 뜬다)');
});

// 지수 비교선(보조 지표 '지수 대비'): 같은 기간 지수를 차트 첫 봉의 종목 가격에서 시작하게 맞춘 선. 배지의 숫자로는
// 언제 벌어졌는지 보이지 않는다. 지수 차트는 배지 때문에 이미 받는다(새 요청 없음).
await test('indicators: index comparison line starts at the stock\'s first price, follows the index by date, ends at the live index', () => {
  const { c, run } = harness(['benchLine', 'alignByDay']);
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  const times = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].map(day);
  const closes = [100, 104, 103, 110];
  // 지수에는 9/3 이 없다(휴장 차이) → 그 칸은 비운다. 9/4 는 실시간 지수 2,200 으로
  c.G = { ok: true, times: ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-04'].map(day), closes: [1900, 2000, 2100, 2150] };
  run("quotes['^KS11'] = { price: 2200 };");
  const r = run(`benchLine({ symbol: '^KS11', name: '코스피' }, G, ${JSON.stringify(times)}, ${JSON.stringify(closes)})`);
  assert.equal(r.name, '코스피');
  assert.equal(JSON.stringify(r.data), JSON.stringify([100, 105, null, 110]), '100 × 2100/2000 = 105, 마지막은 실시간 2200/2000');
  // 첫 봉에 지수가 없으면 둘 다 있는 첫 날을 기준으로
  c.G = { ok: true, times: ['2026-09-02', '2026-09-03', '2026-09-04'].map(day), closes: [2000, 2050, 2100] };
  run("delete quotes['^KS11'];");
  const late = run(`benchLine({ symbol: '^KS11', name: '코스피' }, G, ${JSON.stringify(times)}, ${JSON.stringify(closes)})`);
  assert.equal(JSON.stringify(late.data), JSON.stringify([null, 104, 106.6, 109.2]), '9/2 의 104 에서 시작');
  assert.equal(run(`benchLine(null, G, ${JSON.stringify(times)}, ${JSON.stringify(closes)})`), null, '지수 대비가 꺼져 있으면 없다');
  assert.equal(run(`benchLine({ symbol: '^KS11', name: '코스피' }, { ok: false }, ${JSON.stringify(times)}, ${JSON.stringify(closes)})`), null, '지수를 못 받았으면 없다');
});

await test('indicators: loadChart passes the comparison line with the index chart it already fetched, and redraws when only the index moves', async () => {
  const { c, run } = harness(['loadChart', 'benchLine', 'alignByDay', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange', 'benchReturn', 'benchmarkOf']);
  const draws = [];
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  const series = (closes) => ({ ok: true, closes, times: closes.map((_, i) => day(`2026-09-0${i + 1}`)),
    volumes: closes.map(() => 1), opens: closes, highs: closes, lows: closes });
  Object.assign(c, {
    fetchChartCached: async (s) => (s === '^KS11' ? series([2000, 2100]) : series([100, 110])),
    err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW', drawChart: (d) => draws.push(d),
  });
  run("let lastDrawSig = null; state.timeframe = '1M'; state.indicators = cleanIndicators({ rel: true }); quotes['005930.KS'] = { price: 110, prevClose: 100, change: 10 };");
  await c.loadChart();
  assert.equal(JSON.stringify(draws.at(-1).benchLine), JSON.stringify({ name: '코스피', data: [100, 105] }));
  run("quotes['^KS11'] = { price: 2300 };");
  await c.loadChart();
  assert.equal(draws.length, 2, '종목은 그대로여도 지수가 움직이면 다시 그린다');
  assert.equal(draws.at(-1).benchLine.data[1], 115);
  run("state.indicators = cleanIndicators({}); lastDrawSig = null;");
  await c.loadChart();
  assert.equal(draws.at(-1).benchLine, null, '끄면 없다');
  run("state.indicators = cleanIndicators({ rel: true }); state.plainChart = true; lastDrawSig = null;");
  await c.loadChart();
  assert.equal(draws.at(-1).benchLine, null, '차트만 보기면 없다');
});

// 지수 대비는 일봉(1M 이상)만 — 날짜로 짝짓기라 1W(30분봉)는 지수 기준이 첫날 마지막 봉, 종목 기준이 첫 봉이 되고
// 비교선은 그날 종가가 그날 모든 봉에 들어가 계단이 됐다(종목 · 지수 모두 +10% 인데 초과 +5.24%p).
await test('indicators: the index comparison is off on 1W — 30-minute bars cannot be matched to the index by date', async () => {
  const { c, run } = harness(['loadChart', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const asked = [];
  const draws = [];
  const periods = [];
  const t0 = Date.parse('2026-10-15T00:00:00Z');
  const series = { ok: true, closes: [100, 110], times: [t0, t0 + 1800000], volumes: [1, 1], opens: [100, 110], highs: [100, 110], lows: [100, 110] };
  Object.assign(c, {
    fetchChartCached: async (s) => { asked.push(s); return series; },
    err: () => {}, quoteErrText: () => '', renderPeriod: (...a) => periods.push(a), renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW', drawChart: (d) => draws.push(d),
  });
  run(`let lastDrawSig = null; state.timeframe = '1W'; state.indicators = cleanIndicators({ rel: true });
    quotes['005930.KS'] = { price: 110, prevClose: 100, change: 10 };`);
  await c.loadChart();
  assert.deepEqual([...asked], ['005930.KS'], '지수 차트를 받지 않는다');
  assert.equal(draws.at(-1).benchLine, null, '비교선 없음');
  assert.equal(periods.at(-1)[2], null, '초과 배지 없음');
});

await test('indicators: the comparison line is a dashed line on the price axis with its own legend entry', () => {
  const { c, run, elements } = harness(['drawChart', 'labelFor', 'renderMaLegend']);
  run(formatting);
  const configs = [];
  const items = [];
  const node = () => ({ style: {}, kids: [], append(t) { this.text = t; }, appendChild(k) { this.kids.push(k); } });
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, bindChartLeave() {}, maColor: () => '#000', hexA: (_hex, a) => `a${a}`, cssVar: (n) => n,
  });
  c.document.createElement = () => node();
  c.document.getElementById('maLegend').appendChild = (s) => items.push(s);
  run(`lastProfile = null; state.timeframe = '1M';
    var arg_ = { closes: [100, 110], times: [1, 2], up: true, cur: 'KRW', volumes: [1, 1], highs: [100, 110], lows: [100, 110],
      benchLine: { name: '코스피', data: [100, 105] } };
    drawChart(arg_);`);
  const line = configs.at(-1).data.datasets.find((d) => d.borderColor === '--bench-line');
  assert.ok(line, '지수 선');
  assert.equal(line.yAxisID, 'y');
  assert.ok(line.borderDash && line.borderDash.length === 2, '점선');
  assert.equal(line.spanGaps, true, '지수에 없는 날은 건너 잇는다');
  assert.equal(JSON.stringify(line.data), '[100,105]');
  const read = () => items.map((s) => `${s.text}=${s.kids[0].textContent}`);
  assert.equal(elements.get('maLegend').hidden, false);
  assert.deepEqual([...read()], ['코스피=105'], '마우스를 안 올리면 마지막 값');
  assert.match(items[0].title, /코스피 — 차트 첫 봉의 종목 가격에서 시작하게 맞춘 지수/);
  items.length = 0;
  run('hoverIdx = 0; renderMaLegend();');
  assert.deepEqual([...read()], ['코스피=100']);
});

// 툴팁 가격 옆 등락률의 기준. 1D 는 전일 종가(차트의 '전일' 선), 1W(30분봉)는 그 봉 날짜의 앞 거래일 종가(일봉) —
// 바로 앞 30분봉과 견주면 잡음이다. 일봉은 앞 봉 종가(그날 등락률), 첫 봉은 일봉에서 그 앞 거래일 종가. 월봉(전체)의
// 첫 봉은 기준이 없다. 빈 종가(null)는 건너뛴다.
await test('tooltip: change is measured from the previous close — 1D prev close, 1W that day\'s previous daily close, daily bars the bar before', () => {
  const { run } = harness([]);
  const day = (d, h = 0) => Date.parse(`2026-10-${d}T${String(h).padStart(2, '0')}:00:00Z`);
  run(`quotes['005930.KS'] = { prevClose: 100,
    daily: { times: [${day(12)}, ${day(13)}, ${day(14)}, ${day(15)}], closes: [90, null, 95, 99] } };`);
  const bases = (tf, times, closes) => JSON.parse(run(`state.timeframe = '${tf}';
    JSON.stringify(tipBases('005930.KS', ${JSON.stringify(times)}, ${JSON.stringify(closes)}))`));
  assert.deepEqual(bases('1D', [day(16, 1), day(16, 2)], [101, 102]), [100, 100], '1D 는 전일 종가');
  assert.deepEqual(bases('1W', [day(13, 1), day(13, 5), day(14, 1), day(15, 1), day(16, 1)], [1, 2, 3, 4, 5]), [90, 90, 90, 95, 99],
    '1W 는 그날 앞 거래일의 일봉 종가(빈 날은 건너뜀)');
  // 국내 NXT 프리(10/15 08:00 KST)는 UTC 로 전날 23시다 — 한국 날짜로 세야 10/14 종가 기준
  assert.deepEqual(bases('1W', [Date.parse('2026-10-15T08:00:00+09:00'), day(15, 1)], [1, 2]), [95, 95], '국내 1W 프리 봉');
  // 미국 겨울(EST) 애프터 19:30 ET 는 UTC 로 다음 날 — 그날(11/17)의 앞 거래일(11/16) 종가 기준
  run(`state.timeframe = '1W'; quotes.SOXL = { daily: { times: [${Date.parse('2026-11-16T14:30:00Z')}, ${Date.parse('2026-11-17T14:30:00Z')}],
    closes: [200, 210] } };`);
  assert.equal(JSON.stringify(run(`tipBases('SOXL', [${Date.parse('2026-11-17T15:00:00Z')}, ${Date.parse('2026-11-18T00:30:00Z')}], [1, 2])`)),
    '[200,200]', '미국 1W 겨울 애프터 끝 봉');
  assert.deepEqual(bases('1M', [day(14), day(15), day(16)], [95, null, 101]), [90, 95, 95], '일봉은 앞 봉, 첫 봉은 일봉에서');
  assert.deepEqual(bases('전체', [day(14), day(15)], [95, 101]), [null, 95], '월봉의 첫 봉은 기준 없음');
  run("quotes['005930.KS'] = { price: 101 };");
  assert.deepEqual(bases('1D', [day(16, 1)], [101]), [null], '전일 종가가 없으면 없음');
  assert.deepEqual(bases('1M', [day(14), day(15)], [95, 101]), [null, 95], '일봉이 없으면 첫 봉은 없음');
});

await test('tooltip: the price line carries its change in the up/down colour, with open · range · volume below it', () => {
  const { c, run } = harness(['drawChart', 'labelFor', 'plColor']);
  run(helpers());
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {}, hexA: () => 'x', cssVar: (n) => n,
  });
  run(`lastProfile = null; state.timeframe = '1M';
    var arg_ = { closes: [100, 110, 99, 99], times: [1, 2, 3, 4], up: true, cur: 'KRW', volumes: [5, 6, 7, 8],
      opens: [100, 105, 108, 99], highs: [101, 112, 109, 99], lows: [99, 104, 98, 99], tipBases: [null, 100, 110, 99] };
    drawChart(arg_);`);
  const cb = configs.at(-1).options.plugins.tooltip.callbacks;
  const item = (datasetIndex, dataIndex, y, dataset = {}) => ({ datasetIndex, dataIndex, parsed: { y }, dataset });
  assert.equal(cb.label(item(0, 1, 110)), '110 +10.00%');
  assert.equal(cb.labelTextColor(item(0, 1, 110)), run('UP'), '오르면 빨강');
  assert.equal(cb.label(item(0, 2, 99)), '99 -10.00%');
  assert.equal(cb.labelTextColor(item(0, 2, 99)), run('DOWN'), '내리면 파랑');
  assert.equal(cb.label(item(0, 3, 99)), '99 0.00%');
  assert.equal(cb.labelTextColor(item(0, 3, 99)), '--flat', '보합');
  assert.equal(cb.label(item(0, 0, 100)), '100', '기준이 없으면 가격만');
  assert.equal(cb.labelTextColor(item(0, 0, 100)), '--text');
  assert.deepEqual([...cb.label(item(2, 1, 6, { isVolume: true }))], [], '가격 말고는 본문 줄을 만들지 않는다');
  assert.equal(cb.beforeBody, undefined, '가격 줄이 맨 위 — 나머지는 그 아래(footer)');
  const tip = configs.at(-1).options.plugins.tooltip;
  assert.equal(tip.footerColor, '--text', 'footer 는 제 색 — 가격 줄의 등락 색을 물려받지 않는다');
  assert.equal(tip.footerFont.weight, 'normal', '본문처럼 굵지 않게');
  const lines = [...cb.footer([item(0, 1, 110), item(2, 1, 6, { isVolume: true })])];
  assert.deepEqual(lines.filter((l) => !l.startsWith('시 ')), ['고저 104 ~ 112', '거래량 6']);
  assert.ok(lines.every((l) => l === '시 105' || !l.startsWith('시 ')), lines.join(' / '));
  run('arg_.tipBases = undefined; drawChart(arg_);');
  assert.equal(configs.at(-1).options.plugins.tooltip.callbacks.label(item(0, 1, 110)), '110', '기준을 넘기지 않으면 가격만');
});

await test('tooltip: loadChart hands drawChart the base for every bar', async () => {
  const { c, run } = harness(['loadChart', 'bandFor', 'dailyVolAvg', 'seriesVolAvg', 'prevDayRange']);
  const draws = [];
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  Object.assign(c, {
    fetchChartCached: async () => ({ ok: true, closes: [100, 110], times: [day('2026-09-01'), day('2026-09-02')],
      volumes: [1, 1], opens: [100, 110], highs: [100, 110], lows: [100, 110] }),
    err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW', drawChart: (d) => draws.push(d),
  });
  run(`let lastDrawSig = null; state.timeframe = '1M'; state.indicators = cleanIndicators({});
    quotes['005930.KS'] = { price: 110, prevClose: 100, change: 10, daily: { times: [${day('2026-08-31')}], closes: [98] } };`);
  await c.loadChart();
  assert.equal(JSON.stringify(draws.at(-1).tipBases), '[98,100]');
});

// 매물대(보조 지표): drawChart 가 보이는 구간으로 계산해 플러그인에 넘긴다. 플러그인은 오른쪽 끝에서 왼쪽으로 그린다.
await test('indicators: volume profile is computed over the visible range and drawn from the right edge', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: () => 'x', cssVar: (n) => n,
  });
  const day = 86400000;
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  run(`state.timeframe = '3M';
    var T_ = Array.from({ length: 30 }, (_, i) => ${t0} + i * ${day});
    var C_ = Array.from({ length: 30 }, (_, i) => 100 + i);
    var arg_ = { closes: C_, times: T_, up: true, volumes: C_.map(() => 10), highs: C_.map((v) => v + 1), lows: C_.map((v) => v - 1),
      profile: true };`);
  run('drawChart(arg_);');
  let p = configs.at(-1).options.plugins.profile.profile;
  assert.equal(p.lo, 99);
  assert.equal(p.hi, 130);
  assert.equal(p.vols.length, 20);
  run('zoom = { start: T_[10], end: T_[19] }; drawChart(arg_);');
  p = configs.at(-1).options.plugins.profile.profile;
  assert.equal(p.lo, 109, '확대하면 그 구간의 매물대');
  assert.equal(p.hi, 120);
  run('zoom = null; arg_.profile = false; drawChart(arg_);');
  assert.equal(configs.at(-1).options.plugins.profile.profile, null, '끄면 넘기지 않는다');
});

await test('indicators: profile plugin bars grow leftward from the right edge, the busiest price darker', () => {
  const { c, run } = harness();
  run(source.slice(mark('const VP_MAX_WIDTH'), mark('// 교차 지점 표식')));
  const plugin = run('profilePlugin');
  const rects = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, set fillStyle(v) { this.fs = v; },
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fs: this.fs }); } };
  c.cssVar = (n) => n;
  const chartStub = { ctx, chartArea: { left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100 },
    scales: { y: { getPixelForValue: (v) => 100 - v } } };
  plugin.beforeDatasetsDraw(chartStub, {}, { profile: { lo: 0, step: 10, poc: 1, vols: [5, 10, 0, 2.5] } });
  assert.equal(rects.length, 3, '빈 칸은 그리지 않는다');
  assert.deepEqual(rects.map((r) => r.w), [30, 60, 15], '가장 긴 막대가 차트 폭의 30%');
  assert.ok(rects.every((r) => r.x + r.w === 200), '오른쪽 끝에 붙는다');
  assert.deepEqual(rects.map((r) => r.fs), ['--vp-bar', '--vp-poc', '--vp-bar']);
  assert.equal(rects[1].y, 80.5, '칸의 위쪽(가격 20)이 y 80, 1px 틈');
  assert.equal(rects[1].h, 9);
  rects.length = 0;
  plugin.beforeDatasetsDraw(chartStub, {}, { profile: null });
  assert.equal(rects.length, 0);
});

await test('candles are drawn right after the volume bars — above them, below every line', () => {
  // 막대 아래에 깔았더니 평균의 2배를 넘어 진하게 칠한 막대가 같은 색 1px 꼬리를 덮었다(2026-11-09 SK하이닉스 11/06)
  const { c, run } = harness();
  run(source.slice(mark('const candlePlugin = {'), mark('// 1D 시간외(프리 · 애프터)')));
  const plugin = run('candlePlugin');
  let drawn = 0;
  const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect() { drawn++; } };
  c.cssVar = (n) => n;
  const chartOf = (datasets) => ({ ctx, data: { datasets }, chartArea: { left: 0, top: 0, width: 100, height: 100 },
    scales: { x: { getPixelForValue: (i) => i * 10, width: 100 }, y: { getPixelForValue: (v) => 100 - v } } });
  const opts = { opens: [10, 20], highs: [30, 40], lows: [5, 15], closes: [20, 10] };
  const withVol = chartOf([{ isVolume: true }, {}]);
  plugin.beforeDatasetsDraw(withVol, {}, opts);
  assert.equal(drawn, 0, '거래량 막대가 있으면 데이터셋보다 먼저 그리지 않는다');
  plugin.afterDatasetDraw(withVol, { index: 1 }, opts);
  assert.equal(drawn, 0, '다른 데이터셋 뒤에는 그리지 않는다');
  plugin.afterDatasetDraw(withVol, { index: 0 }, opts);
  assert.equal(drawn, 2, '거래량 막대를 그린 직후 캔들 둘');
  drawn = 0;
  plugin.beforeDatasetsDraw(chartOf([{}]), {}, opts);
  assert.equal(drawn, 2, '거래량 막대가 없으면 예전처럼 맨 아래');
});

// 국내 일봉 캔들의 기준(통합 / KRX 버튼). 통합은 증권사 앱의 통합 캔들 — 2026-11-06 SK하이닉스가 증권사 앱과 같았다
// (KRX + NXT 일봉을 합친 값, 2026-11-09 사용자 확인). 캔들 모양만 바뀌고 선 · 지표가 쓰는 받은 배열은 그대로다.
await test('candle basis: 통합 puts KRX + NXT day values into the candles only, KRX keeps the received bars, today follows the live quote', async () => {
  const { c, run } = harness();
  const T = ['2026-09-08', '2026-09-09', '2026-09-10'].map((d) => Date.parse(`${d}T00:00:00Z`)); // 국내 일봉 시각(09:00 KST)
  const asked = [];
  c.api.venueDays = async (s, from) => { asked.push(`${s} ${from}`); return { ok: true, days: { 20260909: { open: 117, high: 122, low: 107, close: 118 } } }; };
  run(`quotes['000660.KS'] = { price: 116, priceSession: 'after', regularClose: 113,
    candle: { open: 115, high: 120, low: 110 }, krxCandle: { open: 111, high: 119, low: 111 } };`);
  const opens = [100, 109, 111]; const highs = [102, 122, 119]; const lows = [99, 109, 111]; const closes = [101, 113, 113];
  const bars = async (venue) => {
    run(`state.candleVenue = '${venue}';`);
    const r = await c.venueCandles('000660.KS', T, opens, highs, lows, closes, run("quotes['000660.KS']"));
    return JSON.stringify([r.opens, r.highs, r.lows, r.closes]);
  };
  assert.equal(await bars('integrated'), JSON.stringify([[100, 117, 115], [102, 122, 120], [99, 107, 110], [101, 118, 116]]),
    '9/8 은 NXT 거래가 없어 받은 값, 9/9 는 통합 일봉, 오늘(9/10)은 실시간 통합 시 · 고 · 저에 마지막 체결');
  assert.deepEqual([...asked], ['000660.KS 20260908'], '차트 첫 날부터 묻는다');
  assert.equal(JSON.stringify([opens, highs, lows, closes]), '[[100,109,111],[102,122,119],[99,109,111],[101,113,113]]',
    '받은 배열(선 · 지표)은 그대로');
  await bars('integrated');
  assert.equal(asked.length, 1, '같은 날 다시 그릴 때는 기억한 값 — 지난 날은 바뀌지 않는다');
  assert.equal(await bars('krx'), JSON.stringify([[100, 109, 111], [102, 122, 119], [99, 109, 111], [101, 113, 113]]),
    'KRX: 지난 날은 받은 값(야후 = KRX), 오늘은 KRX 시 · 고 · 저에 정규장 종가');
  assert.equal(asked.length, 1, 'KRX 는 묻지 않는다');

  // 받기에 실패하면 그동안 받은 값(KRX)으로 그리고, DAILY_RETRY 동안 다시 묻지 않는다
  run('venueCache.clear();');
  c.api.venueDays = async () => { asked.push('fail'); return { ok: false, error: 'x' }; };
  assert.equal(JSON.parse(await bars('integrated'))[0][1], 109, '실패하면 그날은 받은 값');
  await bars('integrated');
  assert.equal(asked.filter((x) => x === 'fail').length, 1, '실패 바로 뒤에는 다시 묻지 않는다');
});

await test('candle basis: drawChart draws candles, the price axis and the tooltip from the basis values, the price line from the received ones', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {}, hexA: () => 'x', cssVar: (n) => n,
  });
  run(`state.timeframe = '1M'; state.chartMode = 'candle';
    var arg_ = { closes: [101, 113], times: [1, 2], up: true, volumes: [1, 1], opens: [100, 109], highs: [102, 122], lows: [99, 109],
      candleBars: { opens: [100, 117], highs: [102, 122], lows: [99, 95], closes: [101, 118] } };`);
  run('drawChart(arg_);');
  let cfg = configs.at(-1);
  assert.equal(JSON.stringify(cfg.options.plugins.candle.lows), '[99,95]', '캔들은 기준 값');
  assert.equal(JSON.stringify(cfg.data.datasets[0].data), '[101,113]', '주가선(선 · 지표)은 받은 값');
  const lim = {};
  cfg.options.scales.y.afterDataLimits(lim);
  assert.equal(lim.min, 95, '가격 축이 통합 저가까지 — 꼬리가 잘리지 않는다');
  const cb = cfg.options.plugins.tooltip.callbacks;
  assert.equal(cb.label({ datasetIndex: 0, dataIndex: 1, parsed: { y: 113 } }), '118', '툴팁 가격은 그 캔들의 종가');
  assert.deepEqual([...cb.footer([{ datasetIndex: 0, dataIndex: 1, dataset: {} }])], ['시 117', '고저 95 ~ 122']);

  run("state.chartMode = 'line'; drawChart(arg_);");
  cfg = configs.at(-1);
  assert.equal(JSON.stringify(cfg.options.plugins.candle), '{}', '라인이면 캔들이 없다');
  assert.equal(cfg.options.plugins.tooltip.callbacks.label({ datasetIndex: 0, dataIndex: 1, parsed: { y: 113 } }), '113');
});

await test('candle basis: the 통합 / KRX switch shows only for a domestic stock drawn as daily candles, its text the basis in use', () => {
  const { c, run, elements } = harness(['renderChartMode']);
  c.MODE_ICON = { candle: 'C', line: 'L' };
  run("state.selected = '005930.KS'; state.timeframe = '1M'; state.chartMode = 'candle'; state.candleVenue = 'integrated'; renderChartMode(22, true);");
  const b = elements.get('candleVenue');
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, '통합');
  assert.equal(b.className, 'on', '통합이면 또렷하게 — 정규장/전체 버튼처럼');
  run("state.candleVenue = 'krx'; renderChartMode(22, true);");
  assert.equal(b.textContent, 'KRX');
  assert.equal(b.className, '');
  run("state.chartMode = 'line'; renderChartMode(22, true);");
  assert.equal(b.hidden, true, '라인이면 숨는다');
  run("state.chartMode = 'candle'; renderChartMode(5, false);");
  assert.equal(b.hidden, true, '분봉(1D · 1W)이면 숨는다 — 거기는 정규장 / 전체 버튼');
  run("state.selected = '^KS11'; renderChartMode(22, true);");
  assert.equal(b.hidden, true, '지수에는 없다');
});

// 가로선(평단 · 전일 · 전고 · 전저 · 프리 · 애프터): 가까운 이름표는 합치고, 범위 밖은 가장자리에 이름 · 값.
await test('horizontal lines: close labels merge instead of vanishing; out-of-range lines go to the edge with their value', () => {
  const { c, run } = harness(['hLineGroups']);
  run(formatting);
  run(source.slice(mark('const HLINE_GAP'), mark('function hLineGroups')));
  run(source.slice(mark('const hLinePlugin = {'), mark('// 마우스를 올린 시점을 세로선으로')));
  const plugin = run('hLinePlugin');
  const strokes = [];
  const texts = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, stroke() {}, setLineDash() {},
    moveTo(_x, y) { this.at = y; }, lineTo() { strokes.push({ y: this.at, color: this.strokeStyle }); },
    fillText(t, x, y) { texts.push({ t, x, y, color: this.fillStyle }); } };
  c.cssVar = (n) => n;
  // 왼쪽 위 버튼 줄(.chartctl) — 처음에는 숨겨 둔다(폭 0, 지표 화면일 때처럼). 맨 아래에서 보이게 하고 본다
  const ctl = { offsetLeft: 4, offsetTop: 4, offsetWidth: 0, offsetHeight: 18 };
  c.document.querySelector = (sel) => (sel === '.chartctl' ? ctl : null);
  // 가격 v 는 y = 200 - v (값이 클수록 위). 차트 안은 y 0~100 → 가격 100~200.
  const chartStub = { ctx, chartArea: { left: 0, right: 300, top: 0, bottom: 100 },
    scales: { y: { top: 0, bottom: 100, getPixelForValue: (v) => 200 - v } } };
  plugin.afterDatasetsDraw(chartStub, {}, { cur: 'KRW', lines: [
    { value: 150, label: '전일', varName: '--prev-line' },
    { value: 145, label: '전고', varName: '--prevhi-line' }, // 5px 아래 — 예전에는 이름표가 빠졌다
    { value: 120, label: '평단', varName: '--avg-line' },
    { value: 230, label: '전고2', varName: '--prevhi-line' }, // 범위 위
    { value: 210, label: '애프터', varName: '--over-line' }, // 범위 위, 더 가깝다
    { value: 60, label: '전저', varName: '--prevlo-line' }, // 범위 아래
  ] });
  assert.deepEqual(strokes.map((s) => s.y), [50, 55, 80], '선은 범위 안의 것만 긋는다');
  assert.deepEqual(strokes.map((s) => s.color), ['--prev-line', '--prevhi-line', '--avg-line']);
  const byText = Object.fromEntries(texts.map((t) => [t.t, t]));
  assert.ok(byText['전일·전고'], `가까운 이름표는 하나로: ${texts.map((t) => t.t).join(' | ')}`);
  assert.equal(byText['전일·전고'].y, 49, '맨 위 선 바로 위에');
  assert.ok(byText['평단']);
  assert.ok(byText['▲ 애프터 210 · 전고2 230'], '범위 위는 위 가장자리에 가까운 것부터, 값과 함께');
  assert.equal(byText['▲ 애프터 210 · 전고2 230'].color, '--over-line', '가장 가까운 선의 색');
  assert.ok(byText['▼ 전저 60'], '범위 아래는 아래 가장자리에');
  assert.equal(byText['▼ 전저 60'].y, 99);
  assert.equal(texts.length, 4, '이름표가 빠지지 않는다');

  // 이름표는 묶음의 첫 선 자리에 그리므로 그 자리에서 10px 이상 떨어진 선은 따로 쓴다(포개지지 않는다)
  assert.deepEqual([...run(`hLineGroups([{ y: 50, text: 'a' }, { y: 58, text: 'b' }, { y: 66, text: 'c' }])`)
    .map((g) => `${g.text}@${g.y}`)], ['a·b@50', 'c@66']);

  // 안쪽 맨 위 선의 이름표와 위 가장자리 표시가 포개질 자리면 그것도 합친다
  texts.length = 0;
  plugin.afterDatasetsDraw(chartStub, {}, { cur: 'KRW', lines: [
    { value: 195, label: '전일', varName: '--prev-line' }, { value: 230, label: '전고', varName: '--prevhi-line' }] });
  assert.deepEqual(texts.map((t) => t.t), ['전일·▲ 전고 230'], '범위 안의 선 이름이 앞, 가장자리 표시가 뒤');

  // 맨 위 경계에 붙은 선(삼성전자 10/15 전저 230,000)의 이름표를 선 위에 그리면 차트 밖으로 나가 잘렸다 —
  // 선 아래에 그리고, 위 가장자리 표시와 가까우면 합친다. 어떤 글자도(높이 9px) 차트 영역 밖으로 나가지 않는다.
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, tooltip: { getActiveElements: () => [{}] } }, {}, { cur: 'KRW', lines: [
    { value: 200, label: '전저', varName: '--prevlo-line' }, // y = 0, 맨 위 경계
    { value: 232, label: '전일', varName: '--prev-line' }, { value: 241, label: '전고', varName: '--prevhi-line' }] });
  assert.ok(texts.every((t) => t.y - 9 >= 0 && t.y <= 100), `글자가 차트 안에: ${texts.map((t) => `${t.t}@${t.y}`).join(' | ')}`);
  assert.deepEqual(texts.filter((t) => t.x === 2).map((t) => t.t), ['전저·▲ 전일 232 · 전고 241']);
  assert.equal(texts.find((t) => t.x === 2).color, '--prevlo-line', '색은 범위 안의 선(전저) 것');
  assert.deepEqual(texts.filter((t) => t.x === 298).map((t) => t.t), ['200'], '마우스를 올리면 그 값도 같은 줄 오른쪽에');

  // 마우스를 올린 동안(툴팁 · 십자선이 잡은 봉이 있는 동안)은 값도 — 이평선 범례처럼. 값은 오른쪽 끝
  // (y축 옆)에 따로 적는다: 왼쪽 이름표에 붙이면 커서 왼쪽에 뜨는 툴팁이 그 값을 가렸다.
  const hoverLines = [{ value: 150, label: '전일', varName: '--prev-line' }, { value: 145, label: '전고', varName: '--prevhi-line' },
    { value: 120, label: '평단', varName: '--avg-line' }, { value: 60, label: '전저', varName: '--prevlo-line' }];
  const left = () => texts.filter((t) => t.x === 2).map((t) => t.t).sort();
  const right = () => texts.filter((t) => t.x === 298).map((t) => `${t.t}@${t.y}`).sort();
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, tooltip: { getActiveElements: () => [{}] } }, {}, { cur: 'KRW', lines: hoverLines });
  assert.deepEqual(left(), ['▼ 전저 60', '전일·전고', '평단'].sort(), '이름표는 그대로 왼쪽');
  assert.deepEqual(right(), ['150 · 145@49', '120@79'].sort(), '값은 같은 높이의 오른쪽 끝에, 묶음은 묶음대로');
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, tooltip: { getActiveElements: () => [] } }, {}, { cur: 'KRW', lines: hoverLines });
  assert.deepEqual(left(), ['▼ 전저 60', '전일·전고', '평단'].sort());
  assert.deepEqual(right(), [], '마우스가 나가면 이름만');
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, tooltip: { getActiveElements: () => [{}] } }, {}, { cur: 'USD',
    lines: [{ value: 127.57, label: '전일', varName: '--prev-line' }] });
  assert.deepEqual(texts.filter((t) => t.x === 298).map((t) => t.t), ['127.57'], '값은 그 종목 통화 형식');

  // RSI 칸을 켜면 그림(chartArea)은 RSI 칸까지 내려가고 가격 칸(y)은 그 위에서 끝난다 — 가격 칸 밖의 선은
  // RSI 칸에 긋지 않고 가격 칸 아래 가장자리에 적는다
  strokes.length = 0;
  texts.length = 0;
  plugin.afterDatasetsDraw({ ...chartStub, chartArea: { ...chartStub.chartArea, bottom: 145 } }, {}, { cur: 'KRW', lines: [
    { value: 150, label: '전일', varName: '--prev-line' }, { value: 70, label: '전저', varName: '--prevlo-line' }] });
  assert.deepEqual(strokes.map((s) => s.y), [50], 'RSI 칸(y 100~145)에는 선을 긋지 않는다');
  assert.equal(texts.find((t) => t.t === '▼ 전저 70').y, 99, '가격 칸 아래 가장자리에');

  // 왼쪽 위 버튼 줄과 높이가 겹치는 이름표는 그 줄 오른쪽에 — 버튼 뒤에 가려 안 보였다(2026-11-11). 선 높이는 그대로
  ctl.offsetWidth = 60; // 줄은 y 4~22, x 4~64
  texts.length = 0;
  plugin.afterDatasetsDraw(chartStub, {}, { cur: 'KRW', lines: [
    { value: 185, label: '전일', varName: '--prev-line' }, // y 15 — 이름표 글자 5~14, 줄과 겹친다(위 가장자리 표시와 묶인다)
    { value: 165, label: '평단', varName: '--avg-line' }, // y 35 — 이름표 글자 25~34, 줄 아래
    { value: 230, label: '전고', varName: '--prevhi-line' }] }); // 범위 위 — 위 가장자리(y 9), 늘 줄 높이다
  assert.deepEqual(texts.map((t) => `${t.t}@${t.x},${t.y}`).sort(), ['전일·▲ 전고 230@67,9', '평단@2,34'].sort(),
    '겹치는 높이만 줄 오른쪽(4 + 60 + 3), 그 아래는 그대로 왼쪽');
  ctl.offsetWidth = 0; // 줄이 숨으면(지표 화면) 그대로 왼쪽
  texts.length = 0;
  plugin.afterDatasetsDraw(chartStub, {}, { cur: 'KRW', lines: [{ value: 185, label: '전일', varName: '--prev-line' }] });
  assert.deepEqual(texts.map((t) => t.x), [2]);
});

// 일봉 기억(5년치 — 실시간이 있으면 30분 기억)이 일봉 차트(5분 기억)보다 늦으면 차트의 새 봉을 잇는다. 야후는 선물의 새 날 봉을
// 한국 14:00(여름 13:00)에 열어, 그 뒤 최대 30분 이동평균 · 볼린저 · RSI 가 마지막 봉 하나 앞에서 끊겼다(2026-11-17 나스닥 선물 1M)
await test('daily cache behind the chart: the chart\'s newer bars are appended so overlays reach the last bar; the cache arrays are untouched', () => {
  const { c, run } = harness(['catchUpDaily', 'maFor']);
  run('var sma = (v, p) => v.map((_, i) => (i + 1 < p ? null : v.slice(i + 1 - p, i + 1).reduce((a, b) => a + b, 0) / p));');
  const day = (d) => Date.parse(`${d}T05:00:00Z`); // 야후 선물 일봉 시각(00:00 EST)
  const days = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'];
  const cached = { times: days.map(day), closes: [28473, 28384, 28034, 27284] };
  c.q = { daily: cached, dailyHL: { times: cached.times, highs: [1, 2, 3, 4], lows: [0, 1, 2, 3] },
    dailyVolume: { times: cached.times, volumes: [] } }; // 거래량이 빈 기억 — 열 길이가 맞지 않으면 건드리지 않는다
  c.bars = { times: [...days, '2026-11-17'].map(day), closes: [28473, 28384, 28034, 27284, 27321],
    highs: [5, 5, 5, 5, 6], lows: [0, 0, 0, 0, 1], volumes: [1, 1, 1, 1, 7] };
  run("quotes['NQ=F'] = q;");
  assert.equal(run("maFor('NQ=F', bars.times, 2)")[4], null, '고치기 전 — 마지막 봉의 이동평균이 비었다');
  run('catchUpDaily(q, bars);');
  assert.deepEqual([...run("maFor('NQ=F', bars.times, 2)")], [null, 28428.5, 28209, 27659, 27302.5], '마지막 봉까지 닿는다');
  assert.deepEqual([...run('q.dailyHL.highs')], [1, 2, 3, 4, 6], 'SAR · 스토캐스틱의 고 · 저도');
  assert.equal(run('q.dailyVolume.volumes.length'), 0, '열 길이가 맞지 않는 기억은 그대로');
  assert.ok(cached.times.length === 4 && cached.closes.length === 4, '기억해 둔 배열(dailyCache)은 건드리지 않는다');
  run('catchUpDaily(q, bars);');
  assert.equal(run('q.daily.closes.length'), 5, '두 번 불러도 한 번만 잇는다');
  // 국내 — 일봉 기억에 오늘 봉(실시간, 00:00 UTC)이 이미 있고 야후 차트에 아직 없으면 그대로
  run(`var kr = { daily: { times: [Date.parse('2026-11-16T00:00:00Z'), Date.parse('2026-11-17T00:00:00Z')], closes: [1, 2] } };
    catchUpDaily(kr, { times: [Date.parse('2026-11-16T00:00:00Z')], closes: [1] }); catchUpDaily(undefined, bars);`);
  assert.equal(run('kr.daily.closes.length'), 2);
  assert.match(realFunction('loadChart'), /const q = quotes\[item\.symbol\];\s*if \(tf\.interval === '1d'\) catchUpDaily\(q, r\);/, '일봉 기간을 그리기 전에');
});

// 야후 국내 시세는 20분 지연이라 일봉 타임프레임의 마지막 봉이 화면의 다른
// 값들보다 뒤처진다. 상세 캔들은 네이버 실시간이므로, 맞춰주지 않으면 한 화면이
// 서로 다른 순간을 가리킨다. 지나간 봉은 건드리면 안 된다.
await test('daily chart syncs the last bar to the live candle, older bars untouched', async () => {
  const { c, run } = harness(['loadChart']);
  const draws = [];
  const today = Date.parse('2026-09-10T00:00:00Z'); // 09:00 KST, NOW 와 같은 날
  const bars = { ok: true, closes: [98, 100], times: [today - 86400000, today],
    volumes: [10, 20], opens: [97, 99], highs: [99, 101], lows: [96, 97] };
  Object.assign(c, {
    fetchChartCached: async () => bars, err: () => {}, quoteErrText: () => '',
    renderPeriod: () => {}, renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW',
    drawChart: (data) => draws.push(data),
  });
  run('let lastDrawSig = null;');
  run(`state.timeframe = '3M';
    quotes['005930.KS'] = { price: 105, live: true, session: 'regular', priceSession: 'regular',
      candle: { open: 101, high: 106, low: 95 } };`);
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 105], 'last close becomes the live price');
  assert.deepEqual(draws.at(-1).highs, [99, 106], 'last high becomes the live high');
  assert.deepEqual(draws.at(-1).lows, [96, 95], 'last low becomes the live low');
  assert.deepEqual(draws.at(-1).opens, [97, 101], 'opens reach drawChart, last one synced');

  // Toggling chartMode alone must still redraw — nothing else about the
  // fetched bars or quote changed, so the signature has to notice the mode.
  const drawsBeforeToggle = draws.length;
  run("state.chartMode = 'line';");
  await c.loadChart();
  assert.equal(draws.length, drawsBeforeToggle + 1, 'chartMode toggle redraws even with an otherwise identical signature');

  // 마지막 봉이 오늘이 아니면(장 전 · 휴장) 그대로 둔다.
  bars.times = [today - 2 * 86400000, today - 86400000];
  run('lastDrawSig = null;');
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [98, 100], 'yesterday bar keeps its own close');
  assert.deepEqual(draws.at(-1).highs, [99, 101]);
  assert.deepEqual(draws.at(-1).lows, [96, 97]);

  // 분봉(1D)의 마지막 봉은 하루가 아니라 5분이라 대상이 아니다.
  bars.times = [today - 86400000, today];
  run("state.timeframe = '1D'; lastDrawSig = null;");
  await c.loadChart();
  assert.deepEqual(draws.at(-1).highs, [99, 101], '1D bars are not day candles');
});

// 직전 판정 가격(alertBase)을 prev 로 두고 한 번 판정한다.
const checkFrom = (c, run, prev) => {
  run(`for (const k in alertBase) delete alertBase[k]; Object.assign(alertBase, ${JSON.stringify(prev)});`);
  c.checkAlerts();
};

await test('alerts use per-symbol trading state; legacy price-only alerts remain compatible', () => {
  const { c, run, notifications } = harness(['checkAlerts']);
  run(formatting);
  run(`state.alerts.targets = {'005930.KS':{up:100},'000660.KS':{up:100}};
    quotes['000660.KS'] = {price:101,session:'after',isTrading:true};`);
  const prev = {'005930.KS':99,'000660.KS':99};
  for (const meta of ["session:'closed',isTrading:false", "session:'unknown',isTrading:null",
    "session:'regular',isTrading:null", "session:'closed'", "open:false"]) {
    run(`quotes['005930.KS'] = {price:101,${meta}};`);
    notifications.length = 0;
    checkFrom(c, run, prev);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /SK하이닉스/);
  }
  for (const meta of ['', ",session:'pre',open:false", ",session:'after',isTrading:true"]) {
    run(`quotes['005930.KS'] = {price:101${meta}};`);
    notifications.length = 0;
    checkFrom(c, run, prev);
    assert.equal(notifications.length, 2);
  }
  notifications.length = 0;
  run('marketOpen = false;');
  checkFrom(c, run, prev);
  assert.equal(notifications.length, 0, 'domestic stocks stay quiet while every domestic market is closed');
  run(`marketOpen = true; state.watchlist = [{symbol:'AAPL',name:'Apple'}];
    state.alerts.targets = {AAPL:{up:100}}; quotes.AAPL = {price:101,session:'unknown',isTrading:null};`);
  checkFrom(c, run, {AAPL:99});
  assert.equal(notifications.length, 1, 'domestic restrictions do not block foreign alerts');
});

await test('alert text shows the stock currency, not always 원', () => {
  const { c, run, notifications } = harness(['checkAlerts']);
  run(formatting);
  run(`state.watchlist = [{symbol:'005930.KS',name:'삼성전자'},{symbol:'AAPL',name:'Apple'}];
    state.alerts.targets = {'005930.KS':{up:300000}, AAPL:{down:180}};
    quotes['005930.KS'] = {price:301000,currency:'KRW'};
    quotes.AAPL = {price:179.5,currency:'USD'};`);
  checkFrom(c, run, {'005930.KS':299000, AAPL:182.25});
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((n) => n.body), [
    '301,000원 (목표 300,000원)',
    '179.50 USD (목표 180.00 USD)',
  ]);
});

// 갱신을 여러 번 돌리며 그때그때의 시세를 넣는다. 알림 판정은 refreshAll 안에서 일어난다.
function alertRun(watchlist, targets) {
  const h = harness(['refreshAll', 'checkAlerts']);
  h.run(formatting);
  let tick = {};
  Object.assign(h.c, {
    loadIndices: async () => [], fetchLive: async () => ({}),
    loadQuote: async (item) => {
      if (tick[item.symbol]) h.run(`quotes[${JSON.stringify(item.symbol)}] = ${JSON.stringify(tick[item.symbol])};`);
    },
    renderList() {}, renderIndices() {}, err() {}, quoteErrText: () => '', renderDetail() {},
    renderFolio: async () => {}, loadChart: async () => {}, renderUpdated() {},
  });
  h.run(`state.watchlist = ${JSON.stringify(watchlist)}; state.alerts.targets = ${JSON.stringify(targets)};`);
  return { ...h, refresh: async (quotesNow) => { tick = quotesNow; await h.c.refreshAll(); } };
}
const krLive = (price) => ({ price, currency: 'KRW', live: true, session: 'regular', isTrading: true });
const krFallback = (price) => ({ price, currency: 'KRW', live: false, session: 'unknown', isTrading: null });

// 네이버가 한 번 실패하면 야후 지연가가 화면에 뜬다. 국내 종목은 그 가격으로 알림을 판정하지
// 않는데, 직전 화면 가격을 기준으로 쓰면 다음 갱신에서 그 지연가가 "직전 가격" 이 된다.
await test('a Naver fallback price in between neither repeats nor swallows a target-price alert', async () => {
  const sam = { symbol: '005930.KS', name: '삼성전자' };
  const a = alertRun([sam], { '005930.KS': { up: 100000 } });
  await a.refresh({ '005930.KS': krLive(99900) });
  await a.refresh({ '005930.KS': krLive(100500) });
  assert.equal(a.notifications.length, 1, '99,900 → 100,500 crosses once');
  await a.refresh({ '005930.KS': krFallback(99800) }); // 야후 20분 지연가
  await a.refresh({ '005930.KS': krLive(100600) });
  assert.equal(a.notifications.length, 1, 'the delayed 99,800 is not a new starting point — no second alert');

  const b = alertRun([sam], { '005930.KS': { up: 100000 } });
  await b.refresh({ '005930.KS': krLive(99900) });
  await b.refresh({ '005930.KS': krFallback(100200) });
  await b.refresh({ '005930.KS': krLive(100300) });
  assert.equal(b.notifications.length, 1, '99,900 → 100,300 between live prices crosses — the delayed 100,200 must not hide it');
});

// 알림이 꺼져 있거나 목표가가 없던 동안에도 기준 가격은 따라간다 — 켜거나 목표가를 넣은
// 직후의 갱신이 그 전에 이미 지나간 통과를 뒤늦게 알리면 안 된다.
await test('turning alerts on, or adding a target, does not report a crossing that happened before', async () => {
  const sam = { symbol: '005930.KS', name: '삼성전자' };
  const a = alertRun([sam], { '005930.KS': { up: 100000 } });
  await a.refresh({ '005930.KS': krLive(99900) }); // 켜진 채로 기준이 생긴다
  a.run('state.alerts.enabled = false;');
  await a.refresh({ '005930.KS': krLive(100500) }); // 꺼져 있는 동안 통과
  a.run('state.alerts.enabled = true;');
  await a.refresh({ '005930.KS': krLive(100600) });
  assert.equal(a.notifications.length, 0, 'enabled after the crossing — nothing to report');

  const b = alertRun([sam], { '005930.KS': { up: 100000 } });
  await b.refresh({ '005930.KS': krLive(99900) }); // 목표가가 있는 채로 기준이 생긴다
  b.run('state.alerts.targets = {};');
  await b.refresh({ '005930.KS': krLive(100500) }); // 목표가를 지운 동안 통과
  b.run("state.alerts.targets = { '005930.KS': { up: 100000 } };");
  await b.refresh({ '005930.KS': krLive(100600) });
  assert.equal(b.notifications.length, 0, 'target added above the price it already passed — no alert');
  await b.refresh({ '005930.KS': krLive(99000) });
  await b.refresh({ '005930.KS': krLive(100100) });
  assert.equal(b.notifications.length, 1, 'a real crossing afterwards still alerts');
});

// 국내 장(정규 · 시간외 · NXT 08:00~20:00)과 미국 정규장(한국 시간 밤)은 겹치지 않는다.
// 국내 종목이 모두 닫혔다고 알림 전체를 끄면 미국 종목 알림은 거의 울릴 수 없다.
await test('US target alerts still fire while every domestic stock is closed', async () => {
  const a = alertRun([{ symbol: '005930.KS', name: '삼성전자' }, { symbol: 'AAPL', name: 'Apple' }],
    { '005930.KS': { up: 300000 }, AAPL: { up: 250 } });
  const closed = (price) => ({ price, currency: 'KRW', live: true, session: 'closed', isTrading: false });
  const us = (price) => ({ price, currency: 'USD', live: false, session: 'unknown', isTrading: null });
  a.run('marketOpen = false;'); // 국내가 모두 닫힘 — pollingIsOpen 이 내는 값
  await a.refresh({ '005930.KS': closed(299000), AAPL: us(249) });
  await a.refresh({ '005930.KS': closed(301000), AAPL: us(251) });
  assert.deepEqual(a.notifications.map((n) => n.title), ['Apple 상한 도달'], 'Apple fires; the closed domestic stock does not');
});

await test('poll timeout always rearms, including first refresh failure', async () => {
  const { c, run, timers, errors } = harness(['pollTick']);
  c.refreshAll = async () => { throw new Error('refresh failed'); };
  run('marketOpen = false;');
  await c.pollTick();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30000);
  assert.equal(errors.length, 1);
  c.refreshAll = async () => { run('marketOpen = false;'); };
  await timers[0].fn();
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, 300000);
  c.refreshAll = async () => { run('marketOpen = true;'); };
  await timers[1].fn();
  assert.equal(timers[2].delay, 30000);
});

// 첫 실행의 차트 — init 이 첫 갱신(관심종목 · 지수 시세를 하나씩 받는다)을 기다리지 않고 차트부터 받는다. 갱신 끝에서야
// 받으면 첫 실행(캐시가 빈)에 차트 자리가 한참 비어 있었다 — 불러오는 중도 안 떴다(2026-11-03).
await test('init loads the first chart without waiting for the first refresh', () => {
  const init = source.slice(source.indexOf('(async function init()'));
  assert.match(init, /\n {2}loadChart\(\)\.catch\(console\.error\);\r?\n[\s\S]*?\n {2}await pollTick\(\);\r?\n\}\)\(\);/);
});

await test('real refresh failure releases busy and pollTick schedules recovery', async () => {
  const { c, run, timers } = harness(['pollTick', 'refreshAll']);
  c.loadIndices = async () => { throw new Error('index IPC failure'); };
  run('marketOpen = false; isLive = true;');
  await c.pollTick();
  assert.equal(run('busy'), false);
  assert.equal(run('isLive'), false);
  assert.equal(run('marketOpen'), true);
  assert.equal(timers[0].delay, 30000);
});

await test('addSymbol: repeated clicks while the lookup is pending add the symbol once', async () => {
  const { c, run } = harness(['addSymbol']);
  run(source.match(/^const adding = .*$/m)[0]);
  let release;
  const gate = new Promise((r) => { release = r; });
  let fetches = 0;
  Object.assign(c, {
    hint() {}, save() {}, closeSearch() {}, renderList() {}, select: async () => {},
    fetchLive: async () => { fetches++; await gate; return {}; },
  });
  run(`var lookupFails = false;
    async function loadQuote(item) { quotes[item.symbol] = lookupFails ? { error: '없음' } : { price: 1 }; }`);
  const kakao = { symbol: '035720.KS', name: '카카오' };
  const clicks = [c.addSymbol(kakao), c.addSymbol(kakao), c.addSymbol(kakao)];
  release();
  await Promise.all(clicks);
  assert.equal(run(`state.watchlist.filter((i) => i.symbol === '035720.KS').length`), 1);
  assert.equal(fetches, 1);

  // 조회에 실패한 종목도 잠기지 않는다 — 다시 누르면 다시 조회한다
  const naver = { symbol: '035420.KS', name: 'NAVER' };
  run('lookupFails = true;');
  await c.addSymbol(naver);
  run('lookupFails = false;');
  await c.addSymbol(naver);
  assert.equal(run(`state.watchlist.filter((i) => i.symbol === '035420.KS').length`), 1);
});

await test('maFor keeps the in-progress bar when the chart was fetched a moment after the daily data', () => {
  const { c, run } = harness(['maFor']);
  const DAY = 86400000;
  const d0 = Date.parse('2026-09-21T00:00:00Z');
  // 장중 오늘 봉의 시각은 마지막 체결 시각이라 요청마다 초 단위로 다르다 (실측: 01:26:11 / 01:26:12)
  run(`quotes['005930.KS'] = { daily: { closes: [10, 20, 30, 40],
    times: [${d0}, ${d0 + DAY}, ${d0 + 2 * DAY}, ${d0 + 3 * DAY + 5171000}] } };`);
  assert.deepEqual([...c.maFor('005930.KS', [d0 + 2 * DAY, d0 + 3 * DAY + 5172000], 2)], [25, 35]);
  // 일봉에 없는 날은 여전히 비운다
  assert.equal(c.maFor('005930.KS', [d0 + 9 * DAY], 2), null);
});

await test('cleanMaStyles keeps only valid per-period color/width; maWidth falls back to defaults', () => {
  const { run } = harness();
  // 저장값은 믿지 않는다 — 모르는 기간 · 색 형식이 아닌 것 · 범위 밖 굵기 · 숫자가 아닌 굵기는 버린다
  assert.equal(run(`JSON.stringify(cleanMaStyles({
    5: { color: '#FF8800', width: 1.6 },
    20: { color: 'red', width: 9 },
    7: { color: '#123456' },
    60: { width: 0.4 },
    120: { width: '2' },
    240: null,
  }))`), JSON.stringify({ 5: { color: '#ff8800', width: 1.6 } }));
  assert.equal(run('JSON.stringify(cleanMaStyles(null))'), '{}');
  assert.equal(run('JSON.stringify(cleanMaStyles("x"))'), '{}');

  // 바꾼 굵기가 있으면 그 값, 없으면 기본(20 · 40 · 80 은 1.2px, 나머지 1px)
  run('state.maStyles = { 20: { width: 2.4 } };');
  assert.equal(run('maWidth(20)'), 2.4);
  assert.equal(run('maWidth(40)'), 1.2);
  assert.equal(run('maWidth(5)'), 1);
});

await test('zoom is remembered per timeframe and cleared for every timeframe when the symbol changes', () => {
  const { run } = harness(['setTimeframe', 'clearZooms']);
  run("state.timeframe = '3M'; zoom = { start: 1, end: 2 };");
  run("setTimeframe('1D');");
  assert.equal(run('zoom'), null, '1D has no zoom of its own');
  run("setTimeframe('1Y'); zoom = { start: 3, end: 4 };");
  run("setTimeframe('3M');");
  assert.equal(run('JSON.stringify(zoom)'), '{"start":1,"end":2}', '3M zoom comes back');
  run("setTimeframe('1Y');");
  assert.equal(run('JSON.stringify(zoom)'), '{"start":3,"end":4}', '1Y keeps its own zoom');
  run("setTimeframe('1Y');"); // 지금 기간을 다시 눌러도 그대로
  assert.equal(run('JSON.stringify(zoom)'), '{"start":3,"end":4}');

  run('clearZooms();');
  assert.equal(run('zoom'), null);
  run("setTimeframe('3M');");
  assert.equal(run('zoom'), null, 'another symbol forgets every timeframe');
});

await test('empty intraday chart says when Yahoo bars start (open + delay, KST) and how long until then', () => {
  const { c, run } = harness(['intradayEta', 'leftText', 'intradayWaitText']);
  const kst = (hhmm) => Date.parse(`2026-09-29T${hhmm}+09:00`);
  assert.deepEqual({ ...c.intradayEta(kst('09:13:00'), '0900', 20) }, { at: '09:20', minutes: 7 });
  assert.deepEqual({ ...c.intradayEta(kst('09:13:30'), '0900', 20) }, { at: '09:20', minutes: 7 });
  assert.deepEqual({ ...c.intradayEta(kst('09:13:00'), null, 20) }, { at: '09:20', minutes: 7 }); // no Naver value → 09:00
  assert.deepEqual({ ...c.intradayEta(kst('09:40:00'), '1000', 20) }, { at: '10:20', minutes: 40 }); // late-open day
  assert.equal(c.intradayEta(kst('09:25:00'), '0900', 20).minutes <= 0, true);

  assert.equal(c.leftText(7), '약 7분 뒤');
  assert.equal(c.leftText(60), '약 1시간 뒤');
  assert.equal(c.leftText(140), '약 2시간 20분 뒤');

  // the harness clock is 18:30 KST — past 09:20, so a domestic empty chart is "running late"
  run("state.timeframe = '1D';");
  assert.equal(c.intradayWaitText({ symbol: '005930.KS', name: '삼성전자' }, { openTime: '0900' }),
    '삼성전자 1D: 분봉이 늦어지고 있습니다 (보통 09:20쯤 들어옵니다 · 1M 이상은 정상)');
  assert.equal(c.intradayWaitText({ symbol: 'NVDA', name: '엔비디아' }, null),
    '엔비디아 1D: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)');
  // 야후 지수 분봉도 국내 종목처럼 20분 늦다(2026-10-02 실측) — 지수 시세에는 openTime 이 없어 09:00 기준
  assert.equal(c.intradayWaitText({ symbol: '^KS11', name: '코스피' }, {}),
    '코스피 1D: 분봉이 늦어지고 있습니다 (보통 09:20쯤 들어옵니다 · 1M 이상은 정상)');
  // 해외 지수 · 선물 · 금리 · 환율(지수 줄)은 한국 개장과 상관없다 — WTI 1D 가 비면 "09:20쯤" 이라고 했다(2026-10-27)
  for (const [symbol, name] of [['CL=F', 'WTI'], ['NQ=F', '나스닥 선물'], ['^TNX', '미국채 10년'], ['^IXIC', '나스닥'], ['KRW=X', '원/달러']]) {
    assert.equal(c.intradayWaitText({ symbol, name }, {}), `${name} 1D: 분봉이 아직 안 들어왔습니다 (1M 이상은 정상)`, symbol);
  }
});

await test('indices: selectedItem finds a watchlist row or an index; indexLive matches the stock live shape', () => {
  const { run } = harness();
  assert.equal(run('selectedItem().name'), '삼성전자');
  run("state.selected = '^KS11';");
  assert.equal(run('selectedItem().name'), '코스피');
  assert.equal(run("isIndex('^KQ11')"), true);
  assert.equal(run("isIndex('005930.KS')"), false);
  run("state.selected = 'GONE';");
  assert.equal(run('selectedItem()'), null);

  const kosdaq = `{ code: 'KOSDAQ', name: '코스닥', value: 893.29, change: -1, pct: -0.11,
    open: 893.22, high: 903.88, low: 885.65, isOpen: false, tradedAt: '2026-10-02T15:37:00+09:00' }`;
  const closed = run(`indexLive(${kosdaq})`);
  assert.equal(closed.price, 893.29);
  assert.equal(Math.round(closed.prevClose * 100) / 100, 894.29);
  assert.equal(closed.change, -1);
  assert.equal(JSON.stringify(closed.candle), '{"open":893.22,"high":903.88,"low":885.65}');
  assert.equal(closed.session, 'closed');
  assert.equal(closed.priceSession, 'closed');
  assert.equal(closed.isTrading, false);
  assert.equal(closed.open, false);
  assert.equal(closed.source, 'Naver');
  assert.equal(closed.tradedAt, '2026-10-02T15:37:00+09:00');

  const open = run(`indexLive({ ...${kosdaq}, isOpen: true })`);
  assert.equal(open.session, 'regular');
  assert.equal(open.isTrading, true);
  assert.equal(open.open, true);

  // 시가가 없으면 오늘 캔들을 그리지 않는다
  assert.equal(run(`indexLive({ ...${kosdaq}, open: null }).candle`), null);
  // 전일 대비가 없으면 실시간 값이 없는 것으로 — 야후 값(20분지연)으로 넘어간다
  assert.equal(run(`indexLive({ ...${kosdaq}, change: null })`), undefined);
  assert.equal(run('indexLive(undefined)'), undefined);
});

await test('index numbers keep two decimals like the index line; stocks keep their format', () => {
  const { run } = harness();
  run(formatting);
  assert.equal(run("curOf('^KS11')"), 'pt');
  assert.equal(run("money(7003.74, curOf('^KS11'))"), '7,003.74');
  assert.equal(run("signedMoney(-1, curOf('^KQ11'))"), '-1.00');
  run("quotes['005930.KS'] = { currency: 'KRW' };");
  assert.equal(run("money(271500, curOf('005930.KS'))"), '271,500');
  run("quotes.AAPL = { currency: 'USD' };");
  assert.equal(run("curOf('AAPL')"), 'USD');
});

// 미국채 10년(지수 줄)은 금리라 소수 셋째 자리, 등락은 bp. 선물 · 유가는 다른 지수처럼 포인트(둘째 자리).
await test('the 10-year yield keeps three decimals and moves in bp; futures and oil stay in points', () => {
  const { run } = harness();
  run(formatting);
  assert.equal(run("curOf('^TNX')"), '%');
  assert.equal(run("money(4.97, curOf('^TNX'))"), '4.970');
  assert.equal(run('fmtBp(0.0167)'), '+1.7bp');
  assert.equal(run('fmtBp(-0.06)'), '-6.0bp');
  // 헤더는 현재가 - 전일 종가로 다시 세어 소수 잡음이 낀다 — 지수 줄(네이버 값 그대로)과 같은 글자여야 한다
  assert.equal(run('fmtBp(-0.0225)'), '-2.3bp');
  assert.equal(run('fmtBp(4.965 - (4.965 + 0.0225))'), '-2.3bp');
  assert.equal(run("curOf('NQ=F')"), 'pt');
  assert.equal(run("money(29122.75, curOf('NQ=F'))"), '29,122.75');
  assert.equal(run("curOf('CL=F')"), 'pt');
});

// 지수 줄: 코스피 · 코스닥 → 나스닥 · S&P 500 → 원/달러, 한 장씩. 다섯 개는 340px 한 줄에 들어가지 않는다.
await test('index line shows one page at a time, marks the selected index, and turns pages unless hovered or viewing one', () => {
  const { c, run, elements } = harness(['renderIndices', 'indexPages', 'tickIndices', 'ixTrendTip']);
  run(formatting);
  run(source.match(/^let indexItems = .*$/m)[0]);
  run(source.match(/^let indexPage = .*$/m)[0]);
  run(source.match(/^let indexHover = .*$/m)[0]);
  run(source.match(/^let indexManualFor = .*$/m)[0]);
  run(source.match(/^let indexFlipAt = .*$/m)[0]);
  run(source.match(/^const FOLIO_MS = .*$/m)[0]);
  Object.assign(c, { cssVar: () => '#888888', esc: String });
  run(`state.selected = '005930.KS'; indexItems = [
    { code: 'KOSPI', name: '코스피', value: 7003.74, pct: 0.46 },
    { code: 'KOSDAQ', name: '코스닥', value: 893.29, pct: -0.11 },
    { code: 'NASDAQ', name: '나스닥', value: 26692.87, pct: -1.88 },
    { code: 'SPX', name: 'S&P 500', value: 6600.1, pct: -1.2 },
    { code: 'USDKRW', name: '원/달러', value: 1351.4, pct: 0.63 },
    { code: 'KPI200', name: '코스피200', value: 950, pct: 0 }, { code: 'FUT', name: '코스피200 선물', value: 952, pct: 0 }];`);
  c.renderIndices();
  const box = elements.get('indices');
  const shown = () => [...box.innerHTML.matchAll(/data-symbol="([^"]+)"/g)].map((m) => m[1]).join(' ');
  assert.equal(box.hidden, false);
  assert.equal(shown(), '^KS11 ^KQ11', '첫 장은 국내');
  assert.match(box.innerHTML, /<span class="ix" data-symbol="\^KS11" title="코스피 차트 보기">/);
  assert.match(box.innerHTML, /7,003\.74/);
  assert.doesNotMatch(box.innerHTML, /코스피200/, '지표 화면에만 있는 지수(page 없음 — 코스피200 현물 · 선물)는 보이지 않는다');
  c.tickIndices();
  assert.equal(shown(), '^IXIC ^GSPC', '다음 장은 미국');
  assert.match(box.innerHTML, /^<div class="ixpage in">/, '넘길 때는 등장 애니메이션');
  assert.match(box.innerHTML, /26,692\.87/);
  c.tickIndices();
  assert.equal(shown(), 'KRW=X', '그다음은 원/달러');
  c.tickIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '처음으로 돌아온다');
  run('indexHover = true;');
  c.tickIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '마우스를 올리면 멈춘다');
  run("indexHover = false; state.selected = '^GSPC';");
  c.renderIndices();
  assert.equal(shown(), '^IXIC ^GSPC', '보고 있는 지수의 장을 보인다');
  assert.match(box.innerHTML, /<span class="ix on" data-symbol="\^GSPC"/);
  c.tickIndices();
  assert.equal(shown(), '^IXIC ^GSPC', '보는 동안은 넘기지 않는다');
  assert.doesNotMatch(box.innerHTML, /ixpage in/, '같은 장을 4초마다 다시 등장시키지도 않는다(깜빡임)');
  run("state.selected = '005930.KS'; indexItems = indexItems.slice(0, 2);");
  c.renderIndices();
  c.tickIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '미국 지수 · 환율을 못 받으면 한 장 — 넘기지 않는다');
  run('indexItems = [];');
  c.renderIndices();
  assert.equal(box.hidden, true, 'no indices → the line hides (Naver failure)');
});

// 지수 줄 오른쪽 끝의 점 — 몇 번째 장인지 보이고, 누르면 그 장으로 바로 간다(4초씩 기다리지 않게).
await test('index line dots show the page and jump to it; the turn waits a full interval after a click; a viewed index can be paged away from until another pick', () => {
  const { c, run, elements } = harness(['renderIndices', 'indexPages', 'tickIndices', 'flipIndexPage', 'ixTrendTip']);
  run(formatting);
  for (const name of ['indexItems', 'indexPage', 'indexHover', 'indexManualFor', 'indexFlipAt']) run(source.match(new RegExp(`^let ${name} = .*$`, 'm'))[0]);
  run(source.match(/^const FOLIO_MS = .*$/m)[0]);
  Object.assign(c, { cssVar: () => '#888888', esc: String });
  run(`state.selected = '005930.KS'; indexItems = [
    { code: 'KOSPI', name: '코스피', value: 7003.74, pct: 0.46 }, { code: 'KOSDAQ', name: '코스닥', value: 893.29, pct: -0.11 },
    { code: 'NASDAQ', name: '나스닥', value: 26692.87, pct: -1.88 }, { code: 'SPX', name: 'S&P 500', value: 6600.1, pct: -1.2 },
    { code: 'USDKRW', name: '원/달러', value: 1351.4, pct: 0.63 }];`);
  const box = c.document.getElementById('indices');
  const shown = () => [...box.innerHTML.matchAll(/data-symbol="([^"]+)"/g)].map((m) => m[1]).join(' ');
  c.renderIndices();
  assert.match(box.innerHTML, /<\/div><span class="ixdots"><button class="ixdot on" data-page="0" title="코스피 · 코스닥"><\/button><button class="ixdot" data-page="1" title="나스닥 · S&P 500"><\/button><button class="ixdot" data-page="2" title="원\/달러"><\/button><\/span>$/,
    '장 수만큼 점, 지금 장이 진하다, 장의 지수 이름이 툴팁');

  c.flipIndexPage(2);
  assert.equal(shown(), 'KRW=X', '점을 누르면 그 장으로 바로');
  assert.match(box.innerHTML, /^<div class="ixpage in">/);
  assert.match(box.innerHTML, /data-page="2" title="원\/달러"/);
  assert.match(box.innerHTML, /class="ixdot on" data-page="2"/);
  c.tickIndices();
  assert.equal(shown(), 'KRW=X', '누른 뒤 한 번의 간격(4초)은 넘기지 않는다');
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => NOW + run('FOLIO_MS');
  c.tickIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '간격이 지나면 다시 넘긴다');

  // 지수를 보고 있으면 그 장에 머무는데, 점으로 다른 장을 볼 수 있다 — 30초 갱신으로 다시 그려도 그대로
  run("state.selected = '^GSPC';");
  c.renderIndices();
  assert.equal(shown(), '^IXIC ^GSPC');
  c.flipIndexPage(0);
  c.renderIndices();
  assert.equal(shown(), '^KS11 ^KQ11', '보고 있는 지수가 있어도 고른 장을 둔다');
  // 다른 것을 골랐다가 같은 지수를 다시 고르면 다시 그 지수의 장으로
  run("state.selected = '005930.KS';");
  c.renderIndices();
  run("state.selected = '^GSPC';");
  c.renderIndices();
  assert.equal(shown(), '^IXIC ^GSPC', '고르는 것이 바뀌면 원래 규칙으로');
  c.flipIndexPage(9);
  assert.equal(shown(), '^IXIC ^GSPC', '없는 장은 무시한다');

  run("state.selected = '005930.KS'; indexItems = indexItems.slice(0, 2);");
  c.renderIndices();
  assert.doesNotMatch(box.innerHTML, /ixdots/, '한 장뿐이면 점이 없다');
  c.Date.now = realNow;
  // 줄은 다시 그려지므로 점 누르기는 줄 상자에서 받는다(지수 누르기 — 그 차트 — 보다 먼저)
  assert.match(source, /const dot = e\.target\.closest\('\.ixdot'\);\s*if \(dot\) \{ flipIndexPage\(Number\(dot\.dataset\.page\)\); return; \}/);
});

// 지수 줄 80일선 추세(2026-11-25, 11-26 글자를 빼고 호버로) — 지수 칸 툴팁 맨 위에 상태 · 일수 · 시작일, 쓴 종가 · 80일선, 규칙, 한계.
// 받아 둔 일봉의 확정 봉으로 — 장이 열려 있거나 모르면 마지막 봉을 빼고, 닫힌 것이 확실하면 마지막 봉(그날 종가)까지.
await test('index line: hovering an index shows its 80-day trend above "chart", from finished daily bars only', () => {
  const { c, run, elements } = harness(['renderIndices', 'indexPages', 'tickIndices', 'ixTrendTip']);
  run(formatting);
  for (const name of ['indexItems', 'indexPage', 'indexHover', 'indexManualFor', 'indexFlipAt']) run(source.match(new RegExp(`^let ${name} = .*$`, 'm'))[0]);
  Object.assign(c, { cssVar: () => '#888888', esc: String });
  const up = Array.from({ length: 120 }, (_, i) => 100 + i); // 1/1 부터 하루씩 — 80일선이 생기고 1주 뒤(봉 84)부터 상승
  const days = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => Date.UTC(2026, 0, 1) + i * 86400000));
  run(`state.selected = '005930.KS'; indexItems = [{ code: 'KOSPI', name: '코스피', value: 7003.74, pct: 0.46 },
    { code: 'KOSDAQ', name: '코스닥', value: 893.29, pct: -0.11 }];
    dailyCache['^KS11'] = { closes: ${JSON.stringify([...up, 1])}, times: ${days(121)} };
    dailyCache['^KQ11'] = { closes: ${JSON.stringify([...up, 100, 100, 100, 5])}, times: ${days(124)} };`);
  c.renderIndices();
  const html = elements.get('indices').innerHTML;
  const rule = '\n상승: 종가가 80일선 위 · 선이 1주 전보다 높음 — 하락은 반대, 둘이 엇갈리면 전환 시도\n지금 상태일 뿐 다음 방향을 맞히는 신호가 아님';
  assert.ok(html.includes(`data-symbol="^KS11" title="80일선 추세 — 상승 추세 36일째 (3/26부터)\n4/30 종가 219.00 · 80일선 179.50 (1주 전 174.50)${rule}\n\n코스피 차트 보기"`),
    '마지막 봉(1)은 장중일 수 있어 보지 않는다 — 실시간이 없으면(모름)도 같다');
  assert.ok(html.includes('title="80일선 추세 — 하락 전환 시도 3일째 (5/1부터)\n5/3 종가 100.00 · '), '아래로 뚫었지만 선은 아직 오름 — 전환 시도');
  assert.doesNotMatch(html, /class="ixt"/, '지수 칸에 글자는 더하지 않는다');
  const ks = () => run("ixTrendTip(INDICES.find((i) => i.code === 'KOSPI'))");
  run("quotes['^KS11'] = { isTrading: true };");
  assert.match(ks(), /^80일선 추세 — 상승 추세 36일째/, '장중이면 마지막 봉을 뺀다');
  run("quotes['^KS11'] = { isTrading: false };");
  assert.match(ks(), /^80일선 추세 — 하락 전환 시도 1일째 \(5\/1부터\)\n5\/1 종가 1\.00 /, '닫힌 것이 확실하면 마지막 봉(그날 종가)까지');
  run("dailyCache['^KS11'].closes = dailyCache['^KS11'].closes.slice(0, 84);");
  assert.equal(ks(), '', '80일선 + 1주(85봉)보다 적으면 없다');
  run("delete dailyCache['^KS11'];");
  c.renderIndices();
  assert.match(elements.get('indices').innerHTML, /<span class="ix" data-symbol="\^KS11" title="코스피 차트 보기">/, '일봉을 아직 못 받았으면 툴팁은 그대로');
});

// 선물 · 유가는 셋째 장, 원/달러 · 미국채 10년은 넷째 장. 선물 · 유가는 10분 늦다는 것을 툴팁에, 금리는 등락을 bp 로.
// 지수 줄은 대표 여섯 — 코스피 · 코스닥 → 나스닥 · S&P 500 → 나스닥 선물 · 원/달러(2026-10-27). WTI · 미국채 10년 · VIX · SOX 는
// 줄에 없고 시장 지표 화면에서 고른다(고를 수 있는 항목으로는 남는다).
await test('index line: six items on three pages; WTI · 10-year · VIX · SOX stay selectable but off the line', () => {
  const { c, run } = harness(['renderIndices', 'indexPages', 'tickIndices', 'flipIndexPage', 'ixTrendTip']);
  run(formatting);
  for (const name of ['indexItems', 'indexPage', 'indexHover', 'indexManualFor', 'indexFlipAt']) run(source.match(new RegExp(`^let ${name} = .*$`, 'm'))[0]);
  run(source.match(/^const FOLIO_MS = .*$/m)[0]);
  Object.assign(c, { cssVar: () => '#888888', esc: String });
  run(`state.selected = '005930.KS'; indexItems = [
    { code: 'KOSPI', name: '코스피', value: 7003.74, change: 32.39, pct: 0.46 }, { code: 'KOSDAQ', name: '코스닥', value: 893.29, change: -1, pct: -0.11 },
    { code: 'NASDAQ', name: '나스닥', value: 26692.87, change: -511.51, pct: -1.88 }, { code: 'SPX', name: 'S&P 500', value: 6600.1, change: -80, pct: -1.2 },
    { code: 'NQ', name: '나스닥 선물', value: 29122.75, change: -19.25, pct: -0.07 }, { code: 'WTI', name: 'WTI', value: 100.36, change: 0.89, pct: 0.89 },
    { code: 'USDKRW', name: '원/달러', value: 1351.4, change: 8.5, pct: 0.63 }, { code: 'US10Y', name: '미국채 10년', value: 4.97, change: 0.0167, pct: 0.34 },
    { code: 'VIX', name: 'VIX', value: 18.39, change: -1.06, pct: -5.45 }, { code: 'SOX', name: 'SOX', value: 11083.47, change: 304, pct: 2.82 }];`);
  const box = c.document.getElementById('indices');
  const shown = () => [...box.innerHTML.matchAll(/data-symbol="([^"]+)"/g)].map((m) => m[1]).join(' ');
  c.renderIndices();
  assert.match(box.innerHTML, /<span class="ixdots"><button class="ixdot on" data-page="0" title="코스피 · 코스닥"><\/button><button class="ixdot" data-page="1" title="나스닥 · S&P 500"><\/button><button class="ixdot" data-page="2" title="나스닥 선물 · 원\/달러"><\/button><\/span>$/,
    '세 장');
  const pages = [];
  for (const p of [0, 1, 2]) { c.flipIndexPage(p); pages.push(shown()); }
  assert.deepEqual(pages, ['^KS11 ^KQ11', '^IXIC ^GSPC', 'NQ=F KRW=X']);
  assert.match(box.innerHTML, /title="나스닥 선물 \(10분 지연\) 차트 보기"><span class="ixn">나스닥 선물<\/span><span class="ixv">29,122\.75<\/span><span class="ixp" style="color:#185fa5">-0\.07%<\/span>/);
  for (const s of ['CL=F', '^TNX', '^VIX', '^SOX']) {
    assert.equal(run(`isIndex('${s}')`), true, `${s} 는 고를 수 있다`);
    assert.equal(pages.join(' ').includes(s), false, `${s} 는 줄에 없다`);
  }
});

// 시장 순위 패널의 지표 화면 — 시장 버튼 [국내] [미국] [지표]. 지표는 탭 줄 없이 묶음(국내 · 미국 · 위험 · 자금)마다 시장 항목
// 줄을 그린다. 누르면 패널을 닫고 그 항목을 고른다(지수 줄을 누를 때와 같다). 2026-10-27.
const MARKET_ITEMS = `indexItems = [
  { code: 'KOSPI', name: '코스피', value: 5626.49, change: 157.02, pct: 2.87 }, { code: 'KOSDAQ', name: '코스닥', value: 742.97, change: 15.8, pct: 2.17 },
  { code: 'NASDAQ', name: '나스닥', value: 26169.38, change: 215.3, pct: 0.83 }, { code: 'SPX', name: 'S&P 500', value: 7676.77, change: 53.4, pct: 0.7 },
  { code: 'VIX', name: 'VIX', value: 18.39, change: -1.06, pct: -5.45 }, { code: 'SOX', name: 'SOX', value: 11083.47, change: 304, pct: 2.82 },
  { code: 'NQ', name: '나스닥 선물', value: 29358.25, change: -79.5, pct: -0.27 }, { code: 'WTI', name: 'WTI', value: 101.04, change: -0.72, pct: -0.71 },
  { code: 'US10Y', name: '미국채 10년', value: 4.97, change: 0.0167, pct: 0.34 }, { code: 'USDKRW', name: '원/달러', value: 1323.23, change: -1.94, pct: -0.15 }];`;
const marketHarness = (extra = []) => {
  const h = harness(['marketRow', 'marketExtraRow', 'marketExtraError', 'marketHtml', 'marketCheckInput', 'sparkSvg', 'renderRank', 'setRankView',
    'rankClick', 'rankHtml', 'dailyVolumesOf', 'k200At', 'intradayTitle', 'ixTrendTip', ...extra]);
  if (!extra.includes('loadMarket')) h.c.loadMarket = async () => {}; // 지표 화면을 열면 market:extras 를 묻는다 — 따로 본다
  h.run(formatting);
  h.run(source.match(/^let indexItems = .*$/m)[0]);
  h.picked = [];
  h.closed = 0;
  Object.assign(h.c, { cssVar: () => '#888888', esc: String, loadRank: async () => {},
    select: async (s) => { h.picked.push(s); }, closeRank: () => { h.closed++; } });
  h.run(MARKET_ITEMS);
  return h;
};
const rowOf = (html, sym) => (html.split(`data-sym="${sym}"`)[1] || '').split('</div>')[0];

await test('market panel: 지표 lists every index item in three groups and picks one on click', async () => {
  const h = marketHarness();
  h.run("quotes['^TNX'] = { daily: { times: [1, 2, 3, 4, 5, 6], closes: [4.85, 4.9, 4.92, 4.95, 4.96, 4.97] } };");
  h.c.setRankView('mk');
  assert.match(h.elements.get('rankMarket').innerHTML, /<button data-market="kr">국내<\/button><button data-market="us">미국<\/button><button data-market="mk" class="on">시장 지표<\/button>/);
  assert.equal(h.elements.get('rankTabs').hidden, true, '지표 화면은 탭 줄이 없다');
  const html = h.elements.get('rankList').innerHTML;
  assert.deepEqual([...html.matchAll(/class="qhint rnote mgroup">([^<]+)</g)].map((m) => m[1]),
    ['국내', '코스피 장중 수급 · 현물 · 선물 억 · 30분', '미국', '심리', '금리 · 신용', '환율', '원자재']);
  const order = [...html.matchAll(/data-sym="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['^KS11', '^KQ11', '^IXIC', '^GSPC', 'NQ=F', '^SOX', '^VIX', '^TNX', 'KRW=X', 'CL=F'], '묶음 안 순서');
  assert.match(rowOf(html, '^TNX'), /4\.970/);
  assert.match(rowOf(html, '^TNX'), /\+1\.7bp/, '금리의 오늘 등락은 bp');
  assert.match(rowOf(html, '^TNX'), /\+12\.0bp/, '금리의 5일 변화도 bp');
  assert.match(rowOf(html, 'CL=F'), /10분 지연/);
  h.c.rankClick({ closest: (sel) => (sel === '[data-sym]' ? { dataset: { sym: '^VIX' } } : null) });
  assert.equal(h.closed, 1, '패널을 닫는다');
  assert.deepEqual(h.picked, ['^VIX'], '그 항목을 고른다');
  h.c.setRankView('kr');
  assert.equal(h.elements.get('rankTabs').hidden, false, '국내로 돌아오면 탭 줄이 다시 보인다');
});

// 위험 · 자금 묶음의 줄에 마우스를 올리면 그 지표의 뜻과 읽는 법(MARKET_DESC, 2026-11-02 사용자 요청 "VIX · HY OAS 등 설명").
// 누를 수 있는 줄은 그 아래에 '차트 보기'. 받은 적이 없어 — 로 남은 줄도 설명은 보인다.
await test('market panel: 위험 · 자금 rows explain what each measure is on hover', () => {
  const h = marketHarness();
  h.run(`marketExtras = { at: Date.now(), d: { ok: true, hyOas: [{ date: '20261029', value: 3.1 }, { date: '20261030', value: 3.2 }] } };`);
  const titleOf = (html, key) => (new RegExp(`data-key="${key}" title="([^"]*)"`).exec(html) || [])[1];
  let html = h.c.marketHtml();
  for (const key of ['VIX', 'US10Y', 'USDKRW', 'WTI']) {
    const t = titleOf(html, key);
    assert.ok(t && t.startsWith(`${h.run(`MARKET_DESC.${key}`)}\n\n`) && t.endsWith(' 차트 보기'), `${key}: ${t}`);
  }
  // 기준 숫자는 실제 기록에서 낸 것(2026-11-02 사용자 질문 "어디서 가져온 정보?") — VIX 는 야후 1990~ 일별 종가 9,278일.
  // 문체는 한 줄에 한 생각(2026-11-02 3단계)
  assert.match(titleOf(html, 'VIX'), /^VIX\(변동성 지수\) — 흔히 공포지수라고 부른다\n/);
  assert.match(titleOf(html, 'VIX'), /\n\n1990년부터 일별 종가\(2026-10 기준\)\n· 중앙값 17\.6 · 평균 19\.4\n· 20 아래인 날 63% · 30 넘는 날 8%\n/);
  assert.match(titleOf(html, 'VIX'), /· 위기 때: 2008-11 80\.9 · 2020-03 82\.7 · 2025-04 52\.3/);
  assert.match(titleOf(html, 'US10Y'), /\n오늘 등락 · 5일 변화는 bp\(0\.01%포인트\)/);
  assert.match(titleOf(html, 'USDKRW'), /^원\/달러 — 1달러에 원화 몇 원\n오르면 원화 약세/);
  assert.match(titleOf(html, 'WTI'), /^WTI — 서부 텍사스산 원유 선물/);
  // HY OAS 도 누르면 차트(FRED 날마다 값, 2026-11-03) — 설명 아래 '차트 보기'
  assert.equal(titleOf(html, 'HYOAS'), `${h.run('MARKET_DESC.HYOAS')}\n\n미국 HY OAS 차트 보기`);
  assert.match(titleOf(html, 'HYOAS'), /^미국 HY OAS — 투기등급\(하이일드\)[\s\S]*\nICE BofA US High Yield OAS, FRED — 1~2영업일 늦다\n\n/);
  // HY OAS 는 근거 없던 '3~4% 낙관 · 5% 경계' 를 빼고 확인한 숫자로 — FRED 최근 3년 · 20년 평균(2023) · 2008 정점
  assert.match(titleOf(html, 'HYOAS'), /· 최근 3년\(2023-11~2026-10\): 대개 2\.7~3\.5% \(중앙값 3\.0%, 가장 높을 때 2025-04 4\.6%\)\n· 20년 평균 약 5\.2% \(2023년 기준\) · 2008년 위기 때 약 20%/);
  assert.doesNotMatch(titleOf(html, 'HYOAS'), /낙관|경계/);
  assert.equal(titleOf(html, 'SPX'), 'S&P 500 차트 보기', '다른 묶음은 그대로');
  h.run('marketExtras = null; indexItems = [];');
  html = h.c.marketHtml();
  assert.equal(titleOf(html, 'VIX'), h.run('MARKET_DESC.VIX'), '값이 없는 줄(누를 수 없다)도 설명');
  assert.equal(titleOf(html, 'HYOAS'), h.run('MARKET_DESC.HYOAS'), '값이 없으면 누를 수 없다 — 설명만');
});

// 시장 지표 줄의 80일선 추세(2026-11-26 사용자 요청) — 글자로 붙이니 화면이 빽빽해 줄 툴팁 맨 위 네 줄로. 지수 줄과 같은 판정
// (ixTrendTip). 시세가 있는 줄(INDICES)만 — 베이시스 · 수급 줄은 가격이 아니라 없다. 일봉이 모자라면 툴팁은 그대로.
await test('market panel: rows with prices show the 80-day trend at the top of their tooltip, without adding a line', () => {
  const h = marketHarness();
  const titleOf = (html, key) => (new RegExp(`data-key="${key}" title="([^"]*)"`).exec(html) || [])[1];
  const up = Array.from({ length: 120 }, (_, i) => 100 + i);
  const times = JSON.stringify(Array.from({ length: 121 }, (_, i) => Date.UTC(2026, 0, 1) + i * 86400000));
  h.run(`dailyCache['^IXIC'] = { closes: ${JSON.stringify([...up, 1])}, times: ${times} };
    dailyCache['^VIX'] = { closes: ${JSON.stringify([...up, 1])}, times: ${times} };`);
  const html = h.c.marketHtml();
  const head = '80일선 추세 — 상승 추세 36일째 (3/26부터)\n4/30 종가 219.00 · 80일선 179.50 (1주 전 174.50)\n'
    + '상승: 종가가 80일선 위 · 선이 1주 전보다 높음 — 하락은 반대, 둘이 엇갈리면 전환 시도\n지금 상태일 뿐 다음 방향을 맞히는 신호가 아님';
  assert.equal(titleOf(html, 'NASDAQ'), `${head}\n\n나스닥 차트 보기`, '설명이 없는 줄은 추세 · 차트 보기');
  assert.equal(titleOf(html, 'VIX'), `${head}\n\n${h.run('MARKET_DESC.VIX')}\n\nVIX 차트 보기`, '설명이 있으면 추세 · 설명 · 차트 보기 순');
  assert.doesNotMatch(html, /class="ixt"/, '줄에 글자는 더하지 않는다');
  assert.equal(titleOf(html, 'SPX'), 'S&P 500 차트 보기', '일봉이 모자라면(받기 전) 그대로');
});

// 코스톨라니 달걀(해석) — 거래량이 있는 주가지수(코스피 · 코스닥 · 나스닥 · S&P 500)만 메모에 국면, 툴팁에 근거. 2026-10-29.
await test('market panel: stock indices note their Kostolany egg phase with the rule in a tooltip; others do not', () => {
  const h = marketHarness();
  const T = days('2026-07-01', 61);
  const C = T.map((_, i) => 5000 + i * 10);
  const V = [...Array(40).fill(100), ...Array(20).fill(130), 999]; // 마지막 봉(진행 중)은 뺀다
  const q = (vols) => `{ daily: { times: ${JSON.stringify(T)}, closes: ${JSON.stringify(C)} }, dailyVolume: { times: ${JSON.stringify(T)}, volumes: ${JSON.stringify(vols)} } }`;
  h.run(`quotes['^KS11'] = ${q(V)}; quotes['NQ=F'] = ${q(V)}; quotes['^SOX'] = ${q(T.map(() => 0))};`);
  const row = h.c.marketRow('KOSPI');
  // 쉬지 않고 올라 RSI 100 — 처음 셀 수 있는 봉부터 과열(A3), 직전 국면은 없다
  assert.equal(row.note, '달걀 A3 · 다음 B1', '처음 셀 수 있는 봉이라 직전 국면이 없다');
  assert.match(row.noteTitle, /^코스톨라니 달걀\(해석\): A3 과열\n다음은 B1\(꼭대기 뒤 하락 초기\) — 20일선이 60일선 아래로 내려가면\n\n/);
  assert.match(row.noteTitle, /\n지금: 20일선이 60일선 위\(상승\) · 거래량 20일 평균이 60일 평균의 1\.18배 · RSI 100\n/);
  assert.match(row.noteTitle, /\n순서: A1 → A2 → A3 → B1 → B2 → B3 → 다시 A1 \(한 칸씩, 되돌아가지 않는다\)\n/);
  assert.match(row.noteTitle, /과열 없이 20거래일 넘게 내리면 B1, 투매 없이 그만큼 오르면 A1/, '건너뛰는 규칙도 적는다');
  // 과거 검증 결과(일반) — 이론을 그대로 믿지 않게. 해석이라는 줄 뒤, 맨 끝
  assert.ok(row.noteTitle.endsWith(`원래 이론에는 숫자 기준이 없어 이 기준은 해석이다\n\n${h.run('EGG_EVIDENCE')}`), '과거 검증은 맨 끝');
  assert.match(h.run('EGG_EVIDENCE'), /\n· B3 \+1\.4 \(29곳 중 22곳 나음\) · B2 −1\.0 \(5곳만 나음\)\n· A3 \+0\.4 — 팔 신호가 아니었다/);
  assert.doesNotMatch(row.noteTitle, /바뀐 지/, '직전 국면이 없으면 바뀐 때도 없다');
  assert.match(rowOf(h.c.marketHtml(), '^KS11'), /<span class="mnote" title="코스톨라니 달걀\(해석\): A3[^"]*">달걀 A3 · 다음 B1<\/span>/);
  // 100봉 오르다 30봉 내린다(거래량 같음) — A3 에서 20일선이 꺾여 B1, 이어진 급락(RSI 30 아래)으로 B3.
  // 메모는 이름 칸(기본 폭 95px 남짓)에 맞게 일수 없이, 일수는 툴팁에
  const T2 = days('2026-03-01', 130);
  const C2 = [...Array.from({ length: 100 }, (_, i) => 700 + i), ...Array.from({ length: 30 }, (_, i) => 799 - (i + 1) * 3)];
  h.run(`quotes['^KQ11'] = { daily: { times: ${JSON.stringify(T2)}, closes: ${JSON.stringify(C2)} },
    dailyVolume: { times: ${JSON.stringify(T2)}, volumes: ${JSON.stringify(T2.map(() => 100))} } };`);
  const kq = h.c.marketRow('KOSDAQ');
  const e = indicators.eggPhase(C2, T2.map(() => 100));
  assert.equal(kq.note, '달걀 B1→B3 · 다음 A1');
  assert.ok(kq.noteTitle.includes(`B1(꼭대기 뒤 하락 초기)에서 B3로 바뀐 지 ${e.days}거래일째(오늘 포함)`), kq.noteTitle);
  assert.equal(h.c.marketRow('SOX').note, '', 'SOX 는 거래량이 없다(야후 0)');
  assert.equal(h.c.marketRow('NQ').note, '10분 지연', '선물은 달걀을 달지 않는다');
  assert.match(rowOf(h.c.marketHtml(), 'NQ=F'), /<span class="mnote">10분 지연<\/span>/, '툴팁 없는 메모는 그대로');
  h.run("delete quotes['^KS11'].dailyVolume;");
  assert.equal(h.c.marketRow('KOSPI').note, '', '거래량을 못 받았으면 메모 없음');
});

await test('market panel: 5-day change uses the close five bars back; fewer than six closes shows —', () => {
  const h = marketHarness();
  h.run("indexItems = [{ code: 'SOX', name: 'SOX', value: 110, change: 1, pct: 0.92 }]; quotes['^SOX'] = { daily: { closes: [100, 101, 102, 103, 104, 105] } };");
  const row = h.c.marketRow('SOX');
  assert.ok(Math.abs(row.d5 - 10) < 1e-9 && row.d5Unit === '%', JSON.stringify(row));
  assert.match(rowOf(h.c.marketHtml(), '^SOX'), /<span class="md5"[^>]*>\+10\.00%<\/span>/);
  h.run("quotes['^SOX'].daily.closes = [101, 102, 103, 104, 105];");
  assert.equal(h.c.marketRow('SOX').d5, null);
  assert.match(rowOf(h.c.marketHtml(), '^SOX'), /<span class="md5"[^>]*>—<\/span>/);
  assert.equal(h.c.marketRow('HYOAS'), null, '아직 데이터가 없는 줄은 없다(2단계)');
});

await test('market panel: same content is not rewritten (scroll stays)', () => {
  const h = marketHarness();
  let writes = 0;
  h.elements.set('rankList', { style: {}, scrollTop: 0, _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { writes++; this._h = v; } });
  h.c.setRankView('mk');
  h.c.renderRank();
  assert.equal(writes, 1, '30초 갱신으로 같은 내용을 다시 쓰지 않는다');
  h.run("indexItems[0].value = 5630;");
  h.c.renderRank();
  assert.equal(writes, 2, '값이 바뀌면 다시 쓴다');
});

// 지표 화면의 수급 · 코스피200 선물 · HY OAS 줄 — main 의 market:extras 로 그린다(2단계). 누를 수 없는 줄이다(차트가 없다).
const keyRow = (html, key) => (html.split(`data-key="${key}"`)[1] || '').split('</div>')[0];
const EXTRAS = `marketExtras = { at: Date.now(), d: { ok: true,
  spotFlows: [{ date: '20261021', foreign: -9811, final: true }, { date: '20261022', foreign: -6827, final: true },
    { date: '20261023', foreign: 2100, final: true }, { date: '20261026', foreign: 3300, final: true }, { date: '20261027', foreign: 4080, final: false }],
  futFlows: [{ date: '20261026', foreign: -1200, final: true }, { date: '20261027', foreign: 6185, final: false }],
  kospiDays: null,
  futDays: [{ date: '20261020', close: 850 }, { date: '20261021', close: 860 }, { date: '20261022', close: 857 },
    { date: '20261023', close: 863.3 }, { date: '20261026', close: 850 }, { date: '20261027', close: 883.7 }],
  k200Days: [{ date: '20261020', close: 848 }, { date: '20261021', close: 857.8 }, { date: '20261022', close: 855 },
    { date: '20261023', close: 860.3 }, { date: '20261026', close: 848.6 }, { date: '20261027', close: 881.2 }],
  hyOas: [{ date: '20261017', value: 3.1 }, { date: '20261020', value: 3.2 }, { date: '20261021', value: 3.27 },
    { date: '20261022', value: 3.4 }, { date: '20261022', value: 3.4 }, { date: '20261023', value: 3.38 }] } };`;

await test('market panel: flows show the last final day, the streak, and today\'s provisional value', () => {
  const h = marketHarness();
  h.run(EXTRAS);
  const html = h.c.marketHtml();
  const spot = keyRow(html, 'SPOT');
  assert.match(spot, /외국인 현물/);
  // 단위는 억 원(네이버 10/23 선물 +4,514 = 다음 금융 금액 4,514억, 2026-11-02 확인) — 예전에는 단위 없이 숫자만
  assert.match(spot, /<span class="mval">\+3,300억<\/span>/, '마지막 확정일 값(억 원)');
  assert.match(spot, /2일 연속 순매수/);
  assert.match(spot, /<span class="mnote">10\/26 확정\n오늘 잠정 \+4,080억<\/span>/, '이름 아래 — 오른쪽 값의 날짜, 그 아래 오늘 잠정');
  // 확정은 20:30(예전 18:00 — KRX 애프터마켓 16:00~20:00 뒤로 맞는지 몰라 늦췄다, 2026-11-02 사용자 결정)
  assert.match(html, /<div class="hit rrow mrow" role="button" tabindex="0" data-flow-key="SPOT" data-flow-kind="daily" data-key="SPOT" title="외국인 순매수\(억 원\) 10\/26 확정\n20:30 전 오늘 값은 잠정\n\n수급 차트 보기"/,
    '수급 줄은 누르면 확대 차트(openFlow, 2026-11-12)');
  assert.match(keyRow(html, 'FUTFLOW'), /1일 연속 순매도/);
  assert.doesNotMatch(html, /data-sym="[^"]*"[^>]*data-key="SPOT"/, '수급 줄은 종목 · 지수 차트가 아니다');
});

// 코스피200 현물 · 선물 줄은 누르면 차트(main.js 가 네이버 분봉 · 일봉으로 그린다) — 2026-10-30 사용자 요청. 5일 변화 · 미니 선은 다른
// 지수 줄처럼 받아 둔 일봉(quotes)에서.
await test('market panel: KOSPI 200 futures says 20분 지연 and opens its chart; HY OAS shows the date it is from', () => {
  const h = marketHarness();
  h.run("indexItems.push({ code: 'FUT', name: '코스피 200 선물', value: 883.7, change: 33.7, pct: 3.96 });");
  h.run("quotes['^KS200F'] = { daily: { times: [1, 2, 3, 4, 5, 6], closes: [850, 860, 857, 863.3, 850, 883.7] } };");
  h.run(EXTRAS);
  const html = h.c.marketHtml();
  const fut = keyRow(html, 'FUT');
  assert.match(html, /<div class="hit rrow mrow" data-sym="\^KS200F" data-key="FUT" title="코스피200 선물 차트 보기">/, '선물 줄을 누르면 차트');
  assert.match(fut, /코스피200 선물/);
  assert.match(fut, /883\.70/);
  assert.match(fut, /20분 지연/);
  assert.match(fut, /<span class="md5"[^>]*>\+3\.96%<\/span>/, '5일 변화는 선물 일봉의 6번째 앞 종가(850) 대비');
  assert.match(fut, /class="mspark"/, '미니 선도 받아 둔 일봉');
  assert.equal(h.run("curOf('^KS200F')"), 'pt');
  h.c.rankClick({ closest: (sel) => (sel === '[data-sym]' ? { dataset: { sym: '^KS200F' } } : null) });
  assert.deepEqual(h.picked, ['^KS200F'], '지수 줄처럼 고른다');
  const oas = keyRow(html, 'HYOAS');
  assert.match(oas, /<span class="mval">3\.38%<\/span>/);
  assert.match(oas, /10\/23 기준/);
  assert.match(oas, /<span class="md5"[^>]*>\+28\.0bp<\/span>/, '다섯 줄 앞(3.10) 대비 bp');
  // 국내 묶음 순서: 코스피 · 코스닥 · 코스피200 · 선물 · 베이시스 · 현물 수급 · 선물 수급
  assert.deepEqual([...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]).slice(0, 7),
    ['KOSPI', 'KOSDAQ', 'KPI200', 'FUT', 'BASIS', 'SPOT', 'FUTFLOW']);
});

// CNN 공포 · 탐욕(2026-11-03 사용자 요청) — 위험 · 자금 묶음의 VIX 바로 아래. 값은 점수, 오늘 등락은 전일 종가 대비 · 5일 변화
// 자리는 1주 전 대비(점수 차), 메모에 단계(한글), 툴팁에 뜻과 1달 · 1년 전까지. 누르면 차트(^FNG — main 이 날마다 값으로 그린다).
// 받다 실패하면 그 이유.
await test('market panel: CNN fear & greed sits under VIX with its score, the change since yesterday and a week ago, and its mood', () => {
  const h = marketHarness();
  h.run(EXTRAS);
  h.run(`marketExtras.d.fearGreed = { score: 22.7285714285714, rating: 'extreme fear', at: '2026-11-03T01:00:00+00:00',
    prevClose: 25.1, week: 32.8857142857143, month: 38.2, year: 32.6, days: [30, 25.5, 23, 22.7285714285714] };`);
  const html = h.c.marketHtml();
  const keys = [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(keys[keys.indexOf('VIX') + 1], 'FEARGREED', 'VIX 바로 아래');
  assert.match(html, /<div class="hit rrow mrow" data-sym="\^FNG" data-key="FEARGREED" title="CNN 공포 · 탐욕 지수\(0~100\)/, '누르면 차트 — 툴팁에 뜻');
  const row = keyRow(html, 'FEARGREED');
  assert.match(row, /지금 23\(극단적 공포\) · 전일 25 · 1주 전 33 · 1달 전 38 · 1년 전 33\n11\/03 10:00 기준\(한국 시각\)\n\nCNN 공포·탐욕 차트 보기"/);
  h.c.rankClick({ closest: (sel) => (sel === '[data-sym]' ? { dataset: { sym: '^FNG' } } : null) });
  assert.deepEqual(h.picked, ['^FNG'], '지수 줄처럼 고른다');
  assert.equal(h.run("curOf('^FNG')"), 'pt');
  assert.equal(h.run("curOf('^HYOAS')"), '%');
  assert.match(row, /CNN 공포·탐욕/);
  assert.match(row, /<span class="mnote">극단적 공포<\/span>/);
  assert.match(row, /<span class="mval">23<\/span>/);
  assert.match(row, /<span class="rpct"[^>]*>-2\.4<\/span>/, '전일 종가(25.1) 대비');
  assert.match(row, /<span class="md5" title="1주 전 대비\(점수 차\)">-10\.2<\/span>/);
  assert.match(row, /class="mspark"/);
  h.run("marketExtras.d.fearGreed = null; marketExtras.d.errors = { fearGreed: 'HTTP 418' };");
  const failed = h.c.marketHtml();
  assert.match(keyRow(failed, 'FEARGREED'), />실패 · HTTP 418<\/span>/);
  assert.match(failed, /<div class="rrow mrow mfix" data-key="FEARGREED"/, '값이 없으면 누를 수 없다');
});

// 장단기 금리차 · 달러 인덱스 · 원자재 묶음(2026-11-03 사용자 요청) — 금리차는 FRED 날마다 값(HY OAS 처럼 %p · bp 변화, 메모에 날짜),
// 누르면 차트(^T10Y2Y). 달러 인덱스 · 금 · 구리는 야후 일봉의 값(지수 줄 값 없음). 줄이 늘어 유가는 금 · 구리와 원자재 묶음으로.
await test('market panel: the 10y-2y spread, the dollar index and a commodities group', () => {
  const h = marketHarness();
  h.run(EXTRAS);
  h.run(`marketExtras.d.curve = [{ date: '20261027', value: 0.48 }, { date: '20261028', value: 0.5 }, { date: '20261029', value: 0.47 },
    { date: '20261030', value: 0.52 }, { date: '20261031', value: 0.55 }, { date: '20261103', value: 0.51 }];`);
  h.run("quotes['DX-Y.NYB'] = { price: 99.5, change: 0.3, pct: 0.3, daily: { times: [1, 2, 3, 4, 5, 6], closes: [98, 98.5, 99, 99.2, 99.2, 99.5] } };");
  const html = h.c.marketHtml();
  const keys = [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys.slice(keys.indexOf('VIX')), ['VIX', 'FEARGREED', 'US10Y', 'CURVE', 'HYOAS', 'USDKRW', 'JPYKRW', 'EURKRW', 'DXY', 'WTI', 'BRENT', 'GOLD', 'COPPER']);
  // 원/엔(2026-11-12 사용자 요청) — 달러 인덱스처럼 야후 값 · 차트만, 100엔당 원(main 이 곱해 준다 — tests/chart-fill.mjs)
  assert.ok(h.run("INDICES.some((i) => i.symbol === 'JPYKRW=X' && i.code === 'JPYKRW' && i.name === '원/엔(100엔)' && i.overseas && i.page === undefined)"),
    '지수 줄(page)에는 없다 — 시장 지표 화면에만');
  assert.match(h.run('MARKET_DESC.JPYKRW'), /^원\/엔 — 100엔에 원화 몇 원\n/);
  // 원/유로(2026-11-24 사용자 요청) — 같은 야후 경로, 1유로당이라 곱하지 않는다
  assert.ok(h.run("INDICES.some((i) => i.symbol === 'EURKRW=X' && i.code === 'EURKRW' && i.name === '원/유로' && i.overseas && i.page === undefined)"));
  assert.match(h.run('MARKET_DESC.EURKRW'), /^원\/유로 — 1유로에 원화 몇 원\n/);
  // 칸 이름 줄(2026-11-24 사용자 요청) — 요약 바로 아래, 첫 묶음 앞
  assert.match(html, /<\/div><div class="rrow mrow mfix mhead">.*>현재가<.*>오늘<.*>5일<.*>20일<\/span><\/div><div class="qhint rnote mgroup">국내</);
  assert.match(html, /class="qhint rnote mgroup">원자재</);
  assert.match(html, /data-sym="\^T10Y2Y" data-key="CURVE"/, '누르면 차트');
  const curve = keyRow(html, 'CURVE');
  assert.match(curve, /<span class="mval">\+0\.51%p<\/span>/);
  assert.match(curve, /11\/03 기준/);
  assert.match(curve, /<span class="md5"[^>]*>\+3\.0bp<\/span>/, '다섯 줄 앞(0.48) 대비 bp');
  assert.match(html, /data-sym="DX-Y\.NYB" data-key="DXY"/);
  assert.match(keyRow(html, 'DXY'), /99\.50/);
  h.run("marketExtras.d.curve = [{ date: '20261103', value: -0.21 }];");
  assert.match(keyRow(h.c.marketHtml(), 'CURVE'), /<span class="mval">-0\.21%p<\/span>/, '역전은 −');
});

// 코스피200 현물과 베이시스(선물 - 현물) — 현물은 지수 줄 요청에 붙여 받은 KPI200. 선물은 20분 늦어 같은 시각의 현물(오늘 1분 종가)과
// 뺀다 — 지금 현물과 빼면 그 20분 동안 움직인 만큼이 섞였다. 2026-10-29 · 30 사용자 요청.
const kst2 = (s) => Date.parse(`${s}+09:00`);
await test('market panel: KOSPI 200 spot sits beside the futures, and the basis row compares the delayed futures with the spot at the same minute', () => {
  const h = marketHarness();
  // 10/28 13:36 — 선물은 13:16 값(20분 지연), 현물은 지금 값. 현물 13:16 의 1분 종가는 886.5
  h.run(`indexItems.push({ code: 'KPI200', name: '코스피 200', value: 888, change: 6.8, pct: 0.77, tradedAt: '2026-10-28T13:36:00+09:00' },
    { code: 'FUT', name: '코스피 200 선물', value: 890, change: 6.3, pct: 0.71, tradedAt: '2026-10-28T13:16:00+09:00' });`);
  h.run("quotes['^KS200'] = { daily: { times: [1, 2, 3, 4, 5, 6], closes: [848, 857.8, 855, 860.3, 848.6, 881.2] } };");
  h.run(EXTRAS);
  h.run(`marketExtras.d.k200Min = [{ t: ${kst2('2026-10-28T13:10:00')}, close: 885 }, { t: ${kst2('2026-10-28T13:16:00')}, close: 886.5 },
    { t: ${kst2('2026-10-28T13:30:00')}, close: 887.8 }];`);
  let html = h.c.marketHtml();
  const spot = keyRow(html, 'KPI200');
  assert.match(html, /<div class="hit rrow mrow" data-sym="\^KS200" data-key="KPI200" title="코스피200 차트 보기">/, '현물 줄을 누르면 차트');
  assert.match(spot, /<span class="mname">코스피200<\/span>/);
  assert.match(spot, /888\.00/);
  assert.doesNotMatch(spot, /지연/, '현물은 늦지 않는다');
  assert.match(spot, /<span class="md5"[^>]*>\+4\.72%<\/span>/, '5일 변화는 현물 일봉의 6번째 앞 종가(848) 대비');
  const basis = keyRow(html, 'BASIS');
  assert.match(basis, /<span class="mname">베이시스<\/span><span class="mnote">13:16 기준<\/span>/, '선물 시각을 메모에');
  assert.match(basis, /<span class="mval">\+3\.50<\/span>/, '890 − 13:16 의 현물 886.5 (지금 현물 888 과 빼면 +2.00 — 20분 동안 오른 만큼 작아졌다)');
  // 날마다의 베이시스(10/20~10/27) [2, 2.2, 2, 3, 1.4, 2.5] — 오늘 등락은 어제(2.5) 대비, 5일 변화는 다섯 거래일 전(2.2) 대비
  assert.match(basis, /<span class="rpct" style="color:#e24b4a">\+1\.00<\/span>/);
  assert.match(basis, /<span class="md5"[^>]*>\+1\.30<\/span>/);
  assert.match(basis, /class="mspark"/, '날마다의 베이시스에 지금 값을 이은 미니 선');
  assert.match(html, /data-key="BASIS" title="베이시스 = 코스피200 선물 − 코스피200 현물 \(\+3\.50pt, 현물의 \+0\.39%\)\n선물이 비싸면 \+\(콘탱고\), 싸면 −\(백워데이션\)\n\n읽는 법\n/);
  assert.match(html, /\n선물 값이 20분 늦어 같은 시각\(13:16\)의 현물과 뺀다 — 장중엔 20분 전 베이시스다\n/, '툴팁에 맞춘 이유');
  // '+ 면 오를 쪽에 돈이 몰렸다' 는 단순화였다 — 견줄 것은 이론 베이시스(금리 이자 − 배당)이고 앱은 그것을 계산하지 않는다(2026-11-02 점검)
  assert.match(html, /\n· 견줄 것은 이론 베이시스 = 만기까지의 금리 이자 − 받을 배당\n· 이론값은 대개 조금 \+ 이지만, 만기 전에 큰 배당이 빠지는 기간에는 − 일 수 있다\n/);
  assert.match(html, /\n· 이론값보다 높으면 선물 매수 우위, 낮으면 매도 우위로 흔히 읽는다 \(앱은 이론값을 계산하지 않는다\)\n/);
  assert.doesNotMatch(html, /오를 쪽에 .*돈이 몰린/);

  // 분봉을 아직 못 받았으면(지표 화면을 막 열었다) 엉뚱한 현물과 빼지 않고 — 로 둔다. 날마다의 미니 선은 그대로
  h.run('marketExtras.d.k200Min = null;');
  html = h.c.marketHtml();
  assert.match(keyRow(html, 'BASIS'), /<span class="mval">—<\/span>/);
  assert.match(keyRow(html, 'BASIS'), /<span class="mnote">현물 분봉 기다리는 중<\/span>/);
  assert.match(keyRow(html, 'BASIS'), /class="mspark"/);
  // 분봉이 낡았으면(13:16 앞의 마지막이 10:00) 역시 모른다
  h.run(`marketExtras.d.k200Min = [{ t: ${kst2('2026-10-28T10:00:00')}, close: 870 }];`);
  assert.equal(h.c.marketRow('BASIS').valueText, '—');

  // 장 마감 뒤 — 선물 15:45 · 현물 15:30(그 뒤 거래 없음): 오늘 종가끼리
  h.run(`indexItems.find((i) => i.code === 'FUT').tradedAt = '2026-10-28T15:45:00+09:00';
    Object.assign(indexItems.find((i) => i.code === 'KPI200'), { value: 887.1, tradedAt: '2026-10-28T15:30:00+09:00' });`);
  assert.equal(h.c.marketRow('BASIS').valueText, '+2.90', '890 − 887.1');
  assert.equal(h.c.marketRow('BASIS').note, '15:45 기준');

  // 현물이나 선물 값이 없으면 베이시스는 —
  h.run("indexItems = indexItems.filter((i) => i.code !== 'KPI200');");
  html = h.c.marketHtml();
  assert.match(keyRow(html, 'BASIS'), /<span class="mval">—<\/span>/);
  assert.match(keyRow(html, 'KPI200'), /<span class="mval">—<\/span>/);
});

// 선물 시각의 현물 — 그 시각 앞의 마지막 1분 종가 · 지수 줄의 현물 · 장 시작 앞이면 전일 종가. 모르면 null.
await test('market panel: k200At finds the spot at the futures time, before the open falls back to the previous close', () => {
  const h = marketHarness();
  const at = (t, spot, mins) => h.c.k200At(kst2(t), spot, mins);
  const mins = [{ t: kst2('2026-10-28T09:00:00'), close: 882 }, { t: kst2('2026-10-28T09:01:00'), close: 883 }];
  const live = { value: 884, change: 2.8, tradedAt: '2026-10-28T09:25:00+09:00' }; // 전일 종가 881.2
  assert.equal(at('2026-10-28T09:01:30', live, mins).v, 883, '그 시각 앞의 마지막 1분 종가');
  assert.equal(at('2026-10-28T08:50:00', live, mins).v, 881.2, '현물 장 시작 앞(선물만 열린 08:45~09:00)이면 전일 종가');
  assert.equal(at('2026-10-28T09:20:00', live, mins), null, '1분 종가가 5분 넘게 비었는데 현물은 그 뒤에도 거래됐으면 모른다');
  assert.equal(at('2026-10-28T09:30:00', live, mins).v, 884, '현물의 마지막 거래가 그 시각 앞이면 그 값');
  const yesterday = { value: 881.2, change: 32.6, tradedAt: '2026-10-27T15:30:00+09:00' }; // 장 전 — 현물은 아직 어제 값
  assert.equal(at('2026-10-28T08:50:00', yesterday, []).v, 881.2, '장 전에는 어제 종가');
  assert.equal(h.c.k200At(NaN, live, mins), null, '선물 시각을 모르면 null');
});

await test('market panel: extras load once a minute while open, keep the last good answer on failure', async () => {
  const h = marketHarness(['loadMarket']);
  const realNow = h.c.Date.now;
  let calls = 0;
  let answer = { ok: true, spotFlows: [{ date: '20261026', foreign: 3300, final: true }], futFlows: null, kospiDays: null, futDays: null, hyOas: null };
  h.c.api.marketExtras = async () => { calls++; return answer; };
  h.c.setRankView('mk');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, '열면 받는다');
  assert.match(h.elements.get('rankList').innerHTML, /data-key="SPOT"/, '받으면 다시 그린다');
  h.c.renderRank();
  assert.equal(calls, 1, '1분 안에는 다시 묻지 않는다');
  h.c.Date.now = () => NOW + 61000;
  answer = { ok: false, error: 'HTTP 500' };
  h.c.renderRank();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, '1분이 지나면 다시 묻는다');
  assert.match(h.elements.get('rankList').innerHTML, /data-key="SPOT"/, '실패하면 있던 값을 둔다');
  h.c.Date.now = realNow;
});

// 데드캣 점검(3단계) — 맨 위 요약 줄은 개수만(결론 문구 없음), 점검 대상 줄에 판정 점(근거는 툴팁), 줄마다 20일 미니 선.
const CHECKS = (verdicts) => `marketChecks = () => ${JSON.stringify(['spot', 'futures', 'sox', 'usdkrw', 'vix', 'hyoas', 'us10y']
  .map((key, i) => ({ key, verdict: verdicts[i], detail: verdicts[i] ? `${key} 근거 숫자` : '데이터 부족' })))};`;

await test('market panel: summary counts verdicts and says how many could be judged', () => {
  const h = marketHarness();
  h.run(CHECKS(['good', 'good', 'neutral', 'risk', null, 'good', 'risk']));
  const html = h.c.marketHtml();
  assert.match(html, /^<div class="qhint msum" title="[^"]*">데드캣 점검 · 긍정 3 · 중립 1 · 위험 2 \(참고용\) · 판정 6\/7<\/div>/);
  // 툴팁에 판정마다 어느 지표인지(점검 순서대로) — 2026-10-30 사용자 요청
  assert.equal(/class="qhint msum" title="([^"]*)"/.exec(html)[1],
    '긍정: 외국인 현물 · 외국인 선물 · 미국 HY OAS\n중립: SOX\n위험: 원/달러 · 미국채 10년\n판정 불가: VIX\n'
    + `\n경험칙을 숫자로 옮긴 참고용이다 — 매매 판단을 대신하지 않는다\n\n${h.run('DEADCAT_EVIDENCE')}`);
  // 과거 검증(2026-11-02 점검 2단계) — 일곱 기준 모두 코스피 20거래일 뒤를 우연 이상으로 가르지 못했다
  assert.equal(h.run('DEADCAT_EVIDENCE'), '과거 10년 검증 — 코스피 20거래일 뒤(HY OAS 는 3년)\n'
    + '· 일곱 기준 모두 긍정 · 위험 날이 평소와 우연 이상으로 다르지 않았다\n· 지수가 60일 고점에서 10% 넘게 빠졌다 반등 중인 날만 봐도 같았다');
  assert.doesNotMatch(html, /데드캣(이다|입니다|아님|가능성)/, '결론을 내리지 않는다');
  h.run(CHECKS(['good', 'good', 'neutral', 'risk', 'good', 'good', 'risk']));
  const all = h.c.marketHtml();
  assert.match(all, /긍정 4 · 중립 1 · 위험 2 \(참고용\)<\/div>/, '모두 판정했으면 판정 수를 붙이지 않는다');
  assert.doesNotMatch(/class="qhint msum" title="([^"]*)"/.exec(all)[1], /판정 불가/, '없는 판정은 줄을 쓰지 않는다');
});

await test('market panel: each checked row has a dot with its rule detail in the tooltip; others have none', () => {
  const h = marketHarness();
  h.run(CHECKS(['good', null, 'neutral', 'good', 'risk', null, 'neutral']));
  const html = h.c.marketHtml();
  // 점 툴팁 = 그날 근거 + 그 기준의 과거 검증(CHECK_EVIDENCE, 2026-11-02)
  assert.match(rowOf(html, '^VIX'), new RegExp(`<span class="mdot risk" title="vix 근거 숫자\n${h.run('CHECK_EVIDENCE.vix').replace(/[()+.]/g, '\\$&')}"></span>`));
  assert.match(rowOf(html, '^SOX'), /<span class="mdot neutral" title="sox 근거 숫자\n과거 10년 검증[^"]*"><\/span>/);
  assert.equal(h.run('CHECK_EVIDENCE.sox'), '과거 10년 검증 — 코스피 20거래일 뒤, 평소 대비 %포인트\n· 긍정 날 +0.5 · 위험 날 −0.3 — 방향은 맞지만 우연과 구분되지 않는다');
  assert.match(h.run('CHECK_EVIDENCE.hyoas'), /^과거 3년 검증\(FRED 가 3년치만 준다\)/, 'HY OAS 는 3년');
  assert.equal(Object.keys(h.run('CHECK_EVIDENCE')).sort().join(), 'futures,hyoas,sox,spot,us10y,usdkrw,vix', '일곱 기준 모두');
  assert.match(rowOf(html, 'KRW=X'), /<span class="mdot good"/);
  assert.doesNotMatch(rowOf(html, '^KS11'), /mdot/, '점검 대상이 아니면 점이 없다');
  assert.doesNotMatch(rowOf(html, 'CL=F'), /mdot/);
});

await test('market panel: rows draw the last 20 daily values as a mini line', () => {
  const h = marketHarness();
  h.run("quotes['^SOX'] = { daily: { closes: Array.from({ length: 30 }, (_, i) => 100 + i) } };");
  const sox = rowOf(h.c.marketHtml(), '^SOX');
  const pts = (/<polyline points="([^"]+)"/.exec(sox) || [])[1];
  assert.equal(pts && pts.split(' ').length, 20, '최근 20개');
  assert.doesNotMatch(rowOf(h.c.marketHtml(), '^KS11'), /<svg/, '일봉이 없으면 선이 없다');
});

await test('sparkSvg draws values as a polyline and nothing below two', () => {
  const h = marketHarness();
  const svg = h.c.sparkSvg([1, 2, 3]);
  assert.match(svg, /^<svg class="mspark" viewBox="0 0 44 14"/);
  assert.deepEqual(/points="([^"]+)"/.exec(svg)[1].split(' '), ['1,13', '22,7', '43,1'], '왼쪽 아래에서 오른쪽 위로');
  assert.equal(h.c.sparkSvg([1]), '');
  assert.equal(h.c.sparkSvg([]), '');
  assert.match(h.c.sparkSvg([5, 5]), /points="1,7 43,7"/, '모두 같으면 가운데 평평하게');
});

// 리뷰(2026-10-27): 한 부분만 실패해도(FRED 기억이 끝난 직후 500 등) 응답 전체가 ok 라 이전 값을 버렸고, 그 줄 · 판정이 1분 넘게
// 사라졌다 — 부분마다 있던 값을 둔다.
await test('market panel: a part that fails on refresh keeps its previous value', async () => {
  const h = marketHarness(['loadMarket']);
  let answer = { ok: true, spotFlows: null, futFlows: null, kospiDays: null, futDays: null, hyOas: [{ date: '20261023', value: 3.38 }],
    k200Days: [{ date: '20261023', close: 860.3 }], intraday: { spot: [], fut: [], program: -419 } };
  h.c.api.marketExtras = async () => answer;
  h.c.setRankView('mk');
  await new Promise((r) => setImmediate(r));
  assert.match(keyRow(h.elements.get('rankList').innerHTML, 'HYOAS'), /3\.38%/);
  answer = { ok: true, spotFlows: [{ date: '20261026', foreign: 3300, final: true }], futFlows: null, kospiDays: null, futDays: null, hyOas: null,
    k200Days: null };
  const realNow = h.c.Date.now;
  h.c.Date.now = () => NOW + 61000;
  h.c.renderRank();
  await new Promise((r) => setImmediate(r));
  h.c.Date.now = realNow;
  const html = h.elements.get('rankList').innerHTML;
  assert.match(keyRow(html, 'HYOAS'), /3\.38%/, 'HY OAS 만 실패 — 있던 값을 둔다');
  assert.match(keyRow(html, 'SPOT'), /\+3,300/, '새로 온 부분은 새 값');
  assert.equal(h.run('marketExtras.d.k200Days.length'), 1, '코스피200 일봉도 실패하면 있던 값을 둔다');
  assert.equal(h.run('marketExtras.d.intraday.program'), -419, '장중 수급도 실패하면 있던 값을 둔다');
});

// 장중 수급(다음 금융, main 의 market:extras intraday) — 주체별 한 줄: 코스피 현물 누적(억) · 코스피200 선물 누적(억, 부호 색) ·
// 최근 30분 현물 변화 · 오늘 현물 흐름 미니 선. 프로그램은 현물 값 하나뿐이다. 누를 수 없다. 2026-10-30 사용자 요청(주체별 한 줄을 고름).
const kstMs = (s) => Date.parse(`${s}+09:00`);
const INTRADAY = (day) => `marketExtras = { at: Date.now(), d: { ok: true, intraday: {
  spot: [{ t: ${kstMs(`${day}T13:50`)}, individual: 8615, foreign: -11298, institution: 776, pension: 3000, corp: 1990 },
    { t: ${kstMs(`${day}T13:55`)}, individual: 8000, foreign: -12500, institution: 2500, pension: 3100, corp: 2000 },
    { t: ${kstMs(`${day}T14:25`)}, individual: 7761.4, foreign: -13737.2, institution: 3670, pension: 4853, corp: 2306 }],
  fut: [{ t: ${kstMs(`${day}T08:45`)}, individual: 5, foreign: -5, institution: 0, pension: 0, corp: 0 },
    { t: ${kstMs(`${day}T14:24`)}, individual: 434, foreign: 203, institution: -541, pension: 130, corp: -96 }],
  program: -418.8 } } };`;
await test('market panel: 장중 수급 shows spot and futures net buying per investor, the last 30 minutes and today\'s line', () => {
  const h = marketHarness();
  h.run(INTRADAY('2026-09-10')); // 하네스의 오늘(2026-09-10 18:30 KST)
  let html = h.c.marketHtml();
  assert.deepEqual([...html.matchAll(/class="qhint rnote mgroup">([^<]+)</g)].map((m) => m[1]),
    ['국내', '코스피 장중 수급 · 현물 · 선물 억 · 30분 (14:25)', '미국', '심리', '금리 · 신용', '환율', '원자재'], '국내 다음 묶음 — 제목에 단위와 마지막 현물 시각');
  const keys = [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys.slice(keys.indexOf('FUTFLOW') + 1, keys.indexOf('FUTFLOW') + 7),
    ['INTRA_FOREIGN', 'INTRA_INDIV', 'INTRA_INST', 'INTRA_PENSION', 'INTRA_CORP', 'INTRA_PROGRAM']);
  const fr = keyRow(html, 'INTRA_FOREIGN');
  assert.match(html, /<div class="hit rrow mrow" role="button" tabindex="0" data-flow-key="INTRA_FOREIGN" data-flow-kind="intraday" data-key="INTRA_FOREIGN" title="[^"]+">/,
    '누르면 장중 수급 확대 차트');
  assert.match(html, /<div class="hit rrow mrow" role="button" tabindex="0" data-flow-key="INTRA_PROGRAM" data-flow-kind="program" data-key="INTRA_PROGRAM"/,
    '프로그램은 누르면 앱이 모아 둔 날별 막대(2026-11-18 — 예전에는 시계열이 없어 누를 수 없었다)');
  assert.match(fr, /<span class="mname">외국인<\/span>/);
  assert.match(fr, /<span class="mval">-13,737<\/span>/, '현물 누적(억, 반올림)');
  assert.match(fr, /<span class="rpct" style="color:#e24b4a">\+203<\/span>/, '선물 누적(억) — 사면 빨강');
  assert.match(fr, /<span class="md5" title="최근 30분 현물 순매수 변화\(억 원\)">-1,237<\/span>/, '14:25 − 13:55');
  assert.match(fr, /class="mspark"/, '오늘 현물 흐름');
  assert.match(html, /data-key="INTRA_FOREIGN" title="외국인 장중 누적 순매수\n· 코스피 현물 -13,737억 원 \(14:25\)\n· 코스피200 선물 \+203억 원 \(14:24\)\n\n30분: /);
  assert.match(keyRow(html, 'INTRA_INST'), /<span class="rpct" style="color:#[0-9a-f]{6}">-541<\/span>/);
  assert.match(html, /data-key="INTRA_INST" title="기관 [^"]*연기금 포함/);
  assert.match(html, /data-key="INTRA_CORP" title="기타법인 [^"]*자사주/, '자사주 매입은 기타법인에 섞인다');
  // 상장사의 장내 자사주 매입은 기타법인으로 잡힌다(기사 확인). '신탁을 거치면 다른 분류' 는 출처가 없어 뺐다(2026-11-02 점검)
  assert.match(html, /기타법인은 일반 회사 · 창업투자회사 · 투자자문사 등이다\n상장사가 장내에서 자사주를 사면 여기에 잡혀/);
  assert.doesNotMatch(html, /신탁/);
  assert.match(keyRow(html, 'INTRA_PENSION'), /<span class="mval">\+4,853<\/span><span class="rpct"[^>]*>\+130<\/span>/);
  const prog = keyRow(html, 'INTRA_PROGRAM');
  assert.match(prog, /<span class="mval">-419<\/span><span class="rpct"[^>]*>—<\/span><span class="md5"[^>]*>—<\/span>/, '프로그램은 현물 값 하나');
  assert.doesNotMatch(prog, /mspark/);

  // 30분 앞 값이 없으면(장 시작 직후) —
  h.run('marketExtras.d.intraday.spot = marketExtras.d.intraday.spot.slice(2);');
  assert.match(keyRow(h.c.marketHtml(), 'INTRA_FOREIGN'), /<span class="md5"[^>]*>—<\/span>/);
  // 오늘이 아니면(장 전 · 휴장) 제목에 날짜
  h.run(INTRADAY('2026-09-09'));
  assert.match(h.c.marketHtml(), /코스피 장중 수급 · 현물 · 선물 억 · 30분 \(09\/09 14:25\)/);
  // 받은 적이 없으면 여섯 줄 모두 — 로 남는다
  h.run('marketExtras = null;');
  html = h.c.marketHtml();
  assert.match(html, /class="qhint rnote mgroup">코스피 장중 수급 · 현물 · 선물 억 · 30분</);
  for (const k of ['INTRA_FOREIGN', 'INTRA_PROGRAM']) assert.match(keyRow(html, k), /<span class="mval">—<\/span>/, k);
});

// 설계 ④: 출처가 실패했거나 아직 없으면 그 줄은 사라지지 않고 — 와 판정 불가(테두리 점)로 남는다. 예전에는 줄이 빠져
// "판정 6/7" 인데 어느 것이 빠졌는지 보이지 않았다.
await test('market panel: a row without data stays as — and a checked one gets a hollow dot', () => {
  const h = marketHarness();
  h.run("marketExtras = { at: Date.now(), d: { ok: true, spotFlows: null, futFlows: null, kospiDays: null, futDays: null, hyOas: null } };");
  const html = h.c.marketHtml();
  for (const key of ['SPOT', 'FUTFLOW', 'HYOAS']) {
    const row = keyRow(html, key);
    assert.match(row, /<span class="mdot none" title="데이터 부족\n과거 \d+년 검증[^"]*"><\/span>/, key); // 판정 불가여도 그 기준의 검증은 보인다
    assert.match(row, /<span class="mval">—<\/span>/, key);
  }
  assert.match(keyRow(html, 'HYOAS'), /미국 HY OAS/);
  assert.match(keyRow(html, 'FUT'), /코스피200 선물/, '점검 대상이 아닌 줄도 — 로 남는다');
  assert.match(html, /<div class="rrow mrow mfix" data-key="SPOT"/, '누를 수 없다');
});

// 빈 줄이 받다 실패한 것이면 이름 아래 메모에 이유, 메모 툴팁에 그 시각 — 예전에는 — 만 남아 HY OAS 가 왜 비었는지 화면으로는
// 알 수 없었다(2026-11-02, Electron 안에서 FRED 시간 초과). 2026-11-02 사용자 요청.
await test('market panel: an empty row says why it failed', () => {
  const h = marketHarness();
  h.run(`marketExtras = { at: ${kstMs('2026-09-10T16:05')}, d: { ok: true, spotFlows: [{ date: '20260909', foreign: 3300, final: true }],
    futFlows: null, kospiDays: null, futDays: null, hyOas: null, intraday: null, errors: { hyOas: '응답 시간 초과', intraday: 'HTTP 503' } } };`);
  let html = h.c.marketHtml();
  assert.match(keyRow(html, 'HYOAS'), /<span class="mval">—<\/span>/);
  assert.match(keyRow(html, 'HYOAS'), /<span class="mnote" title="16:05 에 받지 못했다: 응답 시간 초과\n지표 화면이 열려 있으면 1분마다 다시 묻는다">실패 · 응답 시간 초과<\/span>/);
  for (const k of ['INTRA_FOREIGN', 'INTRA_PROGRAM']) assert.match(keyRow(html, k), />실패 · HTTP 503<\/span>/, k);
  assert.doesNotMatch(keyRow(html, 'FUTFLOW'), /mnote/, '실패 이유가 없으면(아직 없음 등) 메모도 없다');
  assert.doesNotMatch(keyRow(html, 'SPOT'), /실패/, '받은 줄');
  // 응답 전체가 실패(있던 값도 없음) — 지표 화면에만 있는 줄 모두에 그 오류. 지수 줄(시세)과 베이시스는 market:extras 가 아니다
  h.run(`marketExtras = { at: ${kstMs('2026-09-10T16:06')}, d: { ok: false, error: '네트워크 연결 실패' } }; indexItems = [];`);
  html = h.c.marketHtml();
  for (const k of ['SPOT', 'FUTFLOW', 'HYOAS', 'INTRA_FOREIGN']) assert.match(keyRow(html, k), />실패 · 네트워크 연결 실패<\/span>/, k);
  for (const k of ['VIX', 'FUT', 'BASIS']) assert.doesNotMatch(keyRow(html, k), /실패/, k);
  // 아직 받지 않았으면 이유도 없다
  h.run('marketExtras = null;');
  assert.doesNotMatch(h.c.marketHtml(), /실패 ·/);
});

await test('choosing an index from a zoomed stock drops every zoom and re-marks the index line', async () => {
  const { c, run } = harness(['select', 'clearZooms']);
  let marks = 0;
  let charts = 0;
  Object.assign(c, {
    save() {}, renderList() {}, renderDetail() {},
    renderIndices: () => { marks++; }, loadChart: async () => { charts++; },
  });
  run("zoom = { start: 1, end: 2 }; zoomByTf['1Y'] = { start: 3, end: 4 };");
  await c.select('^KS11');
  assert.equal(run('state.selected'), '^KS11');
  assert.equal(run('zoom'), null);
  assert.equal(run("zoomByTf['1Y']"), undefined);
  assert.equal(marks, 1);
  assert.equal(charts, 1);
});

await test('refresh builds index quotes from the Naver index line; a missing index falls back to Yahoo', async () => {
  const { c, run } = harness(['refreshAll']);
  const loaded = [];
  Object.assign(c, {
    loadIndices: async () => [{ code: 'KOSPI', name: '코스피', value: 7003.74, change: 32.39, pct: 0.46,
      open: 6938.27, high: 7011.04, low: 6927.88, isOpen: true, tradedAt: '2026-10-02T15:20:00+09:00' }],
    fetchLive: async () => ({}),
    loadQuote: async (item, live) => { loaded.push([item.symbol, live]); },
    renderList() {}, renderIndices() {}, checkAlerts() {}, err() {}, quoteErrText: () => '', renderDetail() {},
    renderFolio: async () => {}, loadChart: async () => {}, renderUpdated() {},
  });
  await c.refreshAll();
  const kospi = loaded.find(([s]) => s === '^KS11');
  assert.equal(kospi[1].price, 7003.74);
  assert.equal(kospi[1].session, 'regular');
  const kosdaq = loaded.find(([s]) => s === '^KQ11');
  assert.ok(kosdaq, 'both indices are loaded every refresh');
  assert.equal(kosdaq[1], undefined, 'no Naver value → loadQuote without live (Yahoo, 20분지연)');
  assert.equal(run('busy'), false);
});

// 갱신 한 번에 목록을 종목 수만큼 다시 만들지 않는다 — 처음 받는 종목만 그때그때(첫 화면이 빨리 차게), 나머지는 끝에 한 번.
// 받는 사이 지운 종목은 시세를 남기지 않는다 — 예전에는 살아 있는 목록을 돌아 지운 종목의 시세가 되살아났다.
await test('refresh redraws the list once (plus once per first-time stock) and keeps no quote for a stock removed mid-refresh', async () => {
  const { c, run } = harness(['refreshAll']);
  let renders = 0;
  const loaded = [];
  Object.assign(c, {
    loadIndices: async () => [], fetchLive: async () => ({}),
    loadQuote: async (item) => {
      if (isIndexSym(item.symbol)) return;
      loaded.push(item.symbol);
      // B 는 받는 사이에 지워진다(지우기가 먼저 끝나고 응답이 뒤에 온다)
      if (item.symbol === 'B') run("state.watchlist = state.watchlist.filter((i) => i.symbol !== 'B'); delete quotes.B;");
      run(`quotes['${item.symbol}'] = { price: 1 };`);
      // A 를 받는 사이 C 가 지워진다 — C 는 묻지도 않는다
      if (item.symbol === 'A') run("state.watchlist = state.watchlist.filter((i) => i.symbol !== 'C');");
    },
    renderList() { renders++; }, renderIndices() {}, checkAlerts() {}, err() {}, quoteErrText: () => '', renderDetail() {},
    renderFolio: async () => {}, loadChart: async () => {}, renderUpdated() {},
  });
  const isIndexSym = (s) => c.isIndex(s); // 지수 줄 기호(^ 지수 · =X 환율 · =F 선물)
  run(`state.watchlist = [{ symbol: 'A', name: 'a' }, { symbol: 'B', name: 'b' }, { symbol: 'C', name: 'c' }, { symbol: 'D', name: 'd' }];
    quotes.A = { price: 0 }; quotes.B = { price: 0 }; quotes.C = { price: 0 }; quotes.D = { price: 0 };`);
  await c.refreshAll();
  assert.deepEqual(loaded, ['A', 'B', 'D'], '갱신 중에 지운 C 는 묻지 않는다');
  assert.equal(run('quotes.B'), undefined, '받는 사이 지운 B 의 시세는 남기지 않는다');
  assert.equal(renders, 1, '이미 있던 줄은 끝에 한 번만 다시 그린다');
  run("state.watchlist.push({ symbol: 'E', name: 'e' });");
  renders = 0;
  await c.refreshAll();
  assert.equal(renders, 2, '처음 받는 종목(E)은 받자마자 한 번 더');
});

await test('index detail: points with two decimals, no currency tag, no sector lookup', () => {
  const { c, run, elements } = harness(['renderDetail']);
  run(formatting);
  let lookups = 0;
  Object.assign(c, {
    sectors: new Map(), loadSector: () => { lookups++; return Promise.resolve(); },
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
    levelOf: () => ({ label: '—', color: '#000000' }), cssVar: () => '#000000',
  });
  run(`state.selected = '^KS11'; quotes['^KS11'] = { price: 7003.74, change: 32.39, pct: 0.46,
    live: true, session: 'closed', source: 'Naver', fetchedAt: Date.now() };`);
  c.renderDetail();
  assert.equal(elements.get('dname').textContent, '코스피');
  assert.equal(elements.get('dprice').textContent, '7,003.74');
  assert.match(elements.get('dchg').innerHTML, /\+32\.39/);
  assert.equal(lookups, 0, 'indices have no sector');
  run("state.selected = '005930.KS'; quotes['005930.KS'] = { price: 271500, currency: 'KRW' };");
  c.renderDetail();
  assert.equal(elements.get('dname').textContent, '삼성전자');
  assert.equal(elements.get('dprice').textContent, '271,500');
  assert.equal(lookups, 1, 'stocks still look up their sector');
});

// 미국채 10년을 고르면 헤더도 금리답게 — 이름 옆 단위(%), 셋째 자리, 전일 대비는 bp(등락률은 그 아래 그대로).
await test('yield detail: percent unit tag, three decimals, change in bp over the ratio', () => {
  const { c, run, elements } = harness(['renderDetail']);
  run(formatting);
  Object.assign(c, {
    sectors: new Map(), loadSector: () => Promise.resolve(),
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
    levelOf: () => ({ label: '—', color: '#000000' }), cssVar: () => '#000000',
  });
  run(`state.selected = '^TNX'; quotes['^TNX'] = { price: 4.97, change: 0.0167, pct: 0.34,
    live: true, session: 'regular', source: 'Naver', fetchedAt: Date.now() };`);
  c.renderDetail();
  assert.equal(elements.get('dname').textContent, '미국채 10년 (%)');
  assert.equal(elements.get('dprice').textContent, '4.970');
  assert.equal(elements.get('dchg').innerHTML, '+1.7bp<br>+0.34%');
  run(`state.selected = 'CL=F'; quotes['CL=F'] = { price: 100.36, change: 0.89, pct: 0.89,
    live: true, session: 'regular', source: 'Naver', fetchedAt: Date.now() };`);
  c.renderDetail();
  assert.equal(elements.get('dname').textContent, 'WTI', '유가 · 선물은 지수처럼 단위 표시 없이');
  assert.equal(elements.get('dchg').innerHTML, '+0.89<br>+0.89%');
});

// 과열도 배지의 툴팁 — 일봉 RSI 와 주봉 RSI(이번 주 진행 중). 배지 글자 · 색은 일봉 RSI 그대로다.
await test('loadQuote keeps a weekly RSI next to the daily one — the same daily closes grouped Monday to Sunday', async () => {
  const { c, run } = harness(['loadQuote']);
  const t0 = Date.parse('2026-01-05T00:00:00Z'); // 월요일, 국내 일봉 시각
  const times = [];
  const closes = [];
  for (let i = 0; i < 200; i++) {
    const t = t0 + i * 86400000;
    if ([0, 6].includes(new Date(t).getUTCDay())) continue; // 주말 없음
    times.push(t);
    closes.push(Math.round(100 + Math.sin(i / 7) * 10 + i * 0.1));
  }
  c.dailyFor = async () => ({ price: closes.at(-1), closes, times, currency: 'KRW' });
  await c.loadQuote({ symbol: '005930.KS' }, undefined);
  const q = run("quotes['005930.KS']");
  const want = run(`calcRSI(weekCloses(${JSON.stringify(times)}, ${JSON.stringify(closes)}))`);
  assert.ok(want > 0 && want < 100, String(want));
  assert.equal(q.rsiWeek, want, '주간 종가에 같은 RSI');
  assert.notEqual(q.rsiWeek, q.rsi, '일봉 RSI 와는 다른 값');
});

// 과열도는 세 단계 — 2단계 검증(2026-11-02)에서 30 미만만 20거래일 뒤가 평소와 달랐고(+1.87%p, 23/29) 30~45(주의) · 45~70(안정) ·
// 70~80(과열) · 80 이상(극과열)은 모두 평소 수준이라 45 · 80 경계를 없앴다(사용자 결정). 70 이상은 '과열' 이지만 팔 신호는 아니었다.
await test('RSI level has three steps: 과매도 under 30, 보통 30~70, 과열 from 70', () => {
  const { c, run } = harness(['levelOf']);
  c.cssVar = (n) => (n === '--flat' ? '#888888' : n);
  const lv = (x) => run(`JSON.stringify(levelOf(${x}))`);
  assert.equal(lv(29.9), JSON.stringify({ label: '과매도', color: '#185fa5' }));
  assert.equal(lv(69.9).includes('"보통"'), true);
  assert.equal(lv(92), JSON.stringify({ label: '과열', color: '#e24b4a' }), '극과열 단계는 없다');
  // 색은 30 이하 파랑(하락색) · 40~60 초록 · 70 이상 빨강(상승색), 30~40 · 60~70 은 서서히(2026-11-02 사용자 요청)
  const color = (x) => JSON.parse(lv(x)).color;
  assert.deepEqual([10, 30, 35, 40, 50, 60, 62.5, 65, 67.5, 70, 100].map(color),
    ['#185fa5', '#185fa5', '#237f80', '#2e9e5b', '#2e9e5b', '#2e9e5b', '#8b9243', '#e8862a', '#e5693a', '#e24b4a', '#e24b4a'],
    '경계에 다가가면 섞이고, 60~70 은 주황을 거친다(초록과 빨강을 바로 섞으면 가운데가 탁한 갈색)');
  assert.equal(JSON.parse(lv(30)).label, '보통', '30 은 파랑이지만 단계는 보통');
  assert.equal(lv('null'), JSON.stringify({ label: '—', color: '--dot-off' }));
  assert.match(run('RSI_EVIDENCE'), /\n· 30~70 · 70 이상: 평소와 같음 — 과열도 팔 신호는 아니었다\(그래서 과열도는 세 단계\)\n/, '배지 툴팁에 세 단계의 근거');
});

await test('RSI badge tooltip shows daily and weekly RSI; the badge itself stays on daily RSI', () => {
  const { c, run, elements } = harness(['renderDetail']);
  run(formatting);
  Object.assign(c, {
    sectors: new Map(), loadSector: () => Promise.resolve(),
    renderHolding: () => {}, renderW52: () => {}, renderTrendCheck: () => {}, candleTag: () => '',
    levelOf: () => ({ label: '중립', color: '#000000' }), cssVar: () => '#000000', hexA: () => 'x',
  });
  run("state.selected = '005930.KS'; quotes['005930.KS'] = { price: 224500, currency: 'KRW', rsi: 39.0739, rsiWeek: 43.46 };");
  c.renderDetail();
  const b = elements.get('badge');
  assert.equal(b.textContent, '중립 · RSI 39', '배지는 일봉 RSI');
  const evidence = run('RSI_EVIDENCE');
  // 한 줄에 한 생각(2026-11-02 3단계): 값 / RSI 뜻 / 단계 — 검증 — 기준
  const what = 'RSI = 최근 14거래일 오른 폭과 내린 폭의 비율(0~100)\n과열도(일봉 RSI): 30 미만 과매도 · 30~70 보통 · 70 이상 과열\n\n';
  assert.equal(b.title, `일봉 RSI 39.1 · 주봉 RSI 43.5 (이번 주 진행 중)\n${what}${evidence}\n\n기준: 15:30 정규장 종가 (오늘 · 이번 주는 지금 가격)`);
  assert.match(evidence, /^과거 10년\(대형주 25 · 지수 4\) 검증 — 20거래일 뒤, 평소 대비 %포인트\n· 30 미만: \+1\.9 \(29곳 중 22곳 나음, 2020년 폭락을 빼도 \+2\.2\)/,
    '과거 검증(2026-10-30)');
  run("quotes['005930.KS'].rsiWeek = null;");
  c.renderDetail();
  assert.equal(b.title, `일봉 RSI 39.1\n${what}${evidence}\n\n기준: 15:30 정규장 종가 (오늘은 지금 가격)`, '주봉이 모자라면(최근 상장) 일봉만');
  assert.ok(b.title.length < 1024, `Windows 툴팁 한도(1024자) 안 — ${b.title.length}자`);
  run("quotes['005930.KS'].rsi = null;");
  c.renderDetail();
  assert.equal(b.title, '', 'RSI 가 없으면 툴팁도 없다');
});

await test('loadChart draws the selected index from its Yahoo symbol in points', async () => {
  const { c, run } = harness(['loadChart']);
  run(formatting);
  const asked = [];
  const draws = [];
  Object.assign(c, {
    fetchChartCached: async (symbol) => {
      asked.push(symbol);
      return { ok: true, closes: [6900, 7000], times: [1, 2], volumes: [1, 2], highs: [6950, 7010], lows: [6890, 6990] };
    },
    err: () => {}, quoteErrText: () => '', renderPeriod: () => {}, renderMaChips: () => {},
    renderCrossBadge: () => {},
    drawChart: (data) => draws.push(data),
  });
  run(`let lastDrawSig = null; state.selected = '^KS11';
    quotes['^KS11'] = { price: 7003.74, prevClose: 6971.35, change: 32.39, live: true, open: false,
      session: 'closed', priceSession: 'closed' };`);
  await c.loadChart();
  assert.deepEqual(asked, ['^KS11']);
  assert.equal(draws.at(-1).cur, 'pt');
  assert.equal(draws.at(-1).hLines.find((l) => l.label === '전일').value, 6971.35);
});

await test('arrow keys from an index go to the first (↓) or last (↑) watchlist row', () => {
  const { c, run } = harness(['moveSelection', 'shownList', 'listGroupOf']);
  const picked = [];
  c.select = (s) => { picked.push(s); return Promise.resolve(); };
  run('document.querySelector = () => null;');
  run("state.selected = '^KS11';");
  c.moveSelection(1);
  c.moveSelection(-1);
  run("state.selected = '005930.KS';"); // 목록 안에서는 지금처럼 한 칸씩, 끝에서 돈다
  c.moveSelection(1);
  c.moveSelection(-1);
  assert.deepEqual(picked, ['005930.KS', '000660.KS', '000660.KS', '000660.KS']);
});

await test('saved selection survives restart when it is an index, even with an empty watchlist', () => {
  const { c } = harness(['validSelection']);
  const wl = [{ symbol: '005930.KS' }, { symbol: '000660.KS' }];
  assert.equal(c.validSelection('^KQ11', wl), '^KQ11');
  assert.equal(c.validSelection('^KQ11', []), '^KQ11');
  assert.equal(c.validSelection('000660.KS', wl), '000660.KS');
  assert.equal(c.validSelection('GONE', wl), '005930.KS');
  assert.equal(c.validSelection('GONE', []), null);
  assert.equal(c.validSelection(undefined, []), null);
});

// 저장된 기간이 지금 빌드에 없으면(손으로 고친 설정, 앞으로 기간 이름을 바꾸거나 뺀 빌드) loadChart 가
// TF[...] 에서 undefined 를 읽어 매 갱신 예외로 끝나고 차트가 조용히 비었다. 다른 저장값처럼 거른다.
await test('a saved timeframe this build does not know falls back to 1D', () => {
  const { c } = harness(['validTimeframe']);
  for (const tf of ['1D', '1W', '1M', '3M', '1Y', '3Y', '전체']) assert.equal(c.validTimeframe(tf), tf);
  for (const tf of ['6M', '5Y', '', undefined, null, 'toString', '__proto__']) assert.equal(c.validTimeframe(tf), '1D', String(tf));
});

await test('indexLive rejects a non-positive value or previous close, like the stock adapter', () => {
  const { run } = harness();
  const base = `{ code: 'KOSPI', name: '코스피', change: 5, pct: 0.1, open: 100, high: 101, low: 99, isOpen: true }`;
  // 빈 closePrice 는 main.js num('') 에서 0 이 된다 — 0 이 실시간 값으로 들어가면 1D 끝점이 0 이라 차트가 눌린다
  assert.equal(run(`indexLive({ ...${base}, value: 0 })`), undefined);
  assert.equal(run(`indexLive({ ...${base}, value: 5 })`), undefined, 'previous close would be 0');
  assert.equal(run(`indexLive({ ...${base}, value: 105 }).prevClose`), 100);
});

// Chart.js 는 order 가 큰 데이터셋부터 그린다(4.5.1: _sortedMetasets 를 order 오름차순으로
// 정렬한 뒤 뒤에서부터 _drawDataset). 거래량 막대가 맨 먼저(맨 아래)여야 캔들이 그 바로 위에 온다.
await test('drawChart draws the volume bars first, under every other dataset', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: () => 'rgba(0,0,0,0)', cssVar: () => '#000000',
  });
  const day = 86400000;
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  run(`state.timeframe = '3M'; state.maPeriods = [5];
    var T_ = Array.from({ length: 30 }, (_, i) => ${t0} + i * ${day});
    var C_ = Array.from({ length: 30 }, (_, i) => 100 + i);
    var arg_ = { closes: C_, times: T_, up: true, volumes: C_.map(() => 10), highs: C_, lows: C_,
      mas: [{ p: 5, data: C_ }] };`);
  run('drawChart(arg_);');
  const sets = configs.at(-1).data.datasets;
  assert.ok(sets.length >= 4, 'price, high/low band, MA and volume are there to compare against');
  const volSet = sets.find((d) => d.isVolume);
  assert.ok(sets.every((d) => d === volSet || d.order < volSet.order), '거래량 막대를 맨 먼저 그린다 — 캔들이 그 바로 위');
});

// 야후에는 3년 구간(range=3y)이 없다. 3Y 는 5년치 일봉을 받아 마지막 봉에서 달력 3년
// 전 날짜(UTC 날짜 — maFor · zoomRange 와 같은 규칙)부터 남긴다. 그날 봉은 들어간다.
await test('3Y fetches five years of daily bars and draws only the last three calendar years', async () => {
  const { c, run } = harness(['loadChart']);
  const asked = [];
  const periods = [];
  const draws = [];
  const at = (s) => Date.parse(`${s}T00:00:00Z`);
  let bars;
  Object.assign(c, {
    fetchChartCached: async (symbol, tf) => { asked.push(`${tf.range}/${tf.interval}`); return bars; },
    err: () => {}, quoteErrText: () => '', renderPeriod: (from, to) => periods.push([from, to]),
    renderMaChips: () => {}, renderCrossBadge: () => {},
    curOf: () => 'KRW', drawChart: (data) => draws.push(data),
  });
  run(`let lastDrawSig = null; state.timeframe = '3Y';
    quotes['005930.KS'] = { price: 300, live: true, session: 'closed', priceSession: 'closed' };`);
  bars = { ok: true,
    times: ['2023-09-08', '2023-09-11', '2023-09-12', '2026-09-09', '2026-09-10'].map(at),
    closes: [100, 110, 120, 280, 290], opens: [99, 109, 119, 279, 289],
    highs: [101, 111, 121, 281, 291], lows: [98, 108, 118, 278, 288], volumes: [1, 2, 3, 4, 5] };
  // 마지막 봉 2026-09-10 → 2023-09-10(일요일)부터. 금요일 09-08 은 빠지고 월요일 09-11 부터 남는다
  await c.loadChart();
  assert.deepEqual(asked, ['5y/1d']);
  const d = draws.at(-1);
  assert.deepEqual(d.times, ['2023-09-11', '2023-09-12', '2026-09-09', '2026-09-10'].map(at));
  assert.deepEqual(d.closes, [110, 120, 280, 290]);
  assert.deepEqual(d.opens, [109, 119, 279, 289]);
  assert.deepEqual(d.highs, [111, 121, 281, 291]);
  assert.deepEqual(d.lows, [108, 118, 278, 288]);
  assert.deepEqual(d.volumes, [2, 3, 4, 5]);
  assert.deepEqual(periods.at(-1), [110, 300], '3Y 수익률은 잘라 낸 첫 봉에서 잰다');
  assert.equal(bars.closes.length, 5, '캐시에 든 원본은 그대로 둔다(1Y 등과 같은 캐시 규칙)');

  // 정확히 3년 전 같은 날 봉은 들어간다
  bars = { ...bars, times: ['2023-09-08', '2023-09-10', '2023-09-11', '2026-09-09', '2026-09-10'].map(at) };
  run('lastDrawSig = null;');
  await c.loadChart();
  assert.equal(draws.at(-1).closes[0], 110, '2023-09-10 봉부터');

  // 3년이 안 된 종목은 있는 만큼 다 그린다
  bars = { ...bars, times: ['2024-05-02', '2024-05-03', '2025-01-02', '2026-09-09', '2026-09-10'].map(at) };
  run('lastDrawSig = null;');
  await c.loadChart();
  assert.deepEqual(draws.at(-1).closes, [100, 110, 120, 280, 290]);

  // 다른 기간은 받은 그대로다
  run("state.timeframe = '1Y'; lastDrawSig = null;");
  bars = { ...bars, times: ['2023-09-08', '2023-09-11', '2023-09-12', '2026-09-09', '2026-09-10'].map(at) };
  await c.loadChart();
  assert.equal(asked.at(-1), '1y/1d');
  assert.equal(draws.at(-1).closes.length, 5);
});

// 전체 — 야후에 처음부터 끝까지(range=max) 묻는다. 봉 크기는 야후가 기간에 따라 고른다(2026-10-14 실측:
// 삼성전자 · 코스피 월봉, LG에너지솔루션 주봉, AAPL 분기봉). 일 단위 이동평균 · 골든/데드는 맞지 않아 그리지 않는다.
await test('전체 asks Yahoo for the whole history and draws it without daily moving averages', async () => {
  const { c, run } = harness(['loadChart']);
  const asked = [];
  const periods = [];
  const draws = [];
  const chips = [];
  const at = (s) => Date.parse(`${s}T00:00:00Z`);
  const bars = { ok: true, times: ['2000-01-01', '2013-06-01', '2026-10-01'].map(at), closes: [6000, 30000, 237750],
    opens: [5900, 29000, 230000], highs: [6100, 31000, 240000], lows: [5800, 28000, 229000], volumes: [1, 2, 3] };
  Object.assign(c, {
    fetchChartCached: async (symbol, tf) => { asked.push(`${tf.range}/${tf.interval}`); return bars; },
    err: () => {}, quoteErrText: () => '', renderPeriod: (from, to) => periods.push([from, to]),
    renderMaChips: () => chips.push(run('chartBars')), renderCrossBadge: () => {},
    curOf: () => 'KRW', drawChart: (data) => draws.push(data),
    maFor: () => { throw new Error('일 단위 이동평균을 월봉에 그리면 안 된다'); },
  });
  run(`let lastDrawSig = null; chartBars = 1219; state.maPeriods = [5, 20, 60]; state.timeframe = '전체';
    quotes['005930.KS'] = { price: 237750, live: true, session: 'regular', priceSession: 'regular', open: true,
      candle: { open: 230000, high: 240000, low: 229000 } };`);
  await c.loadChart();
  assert.deepEqual(asked, ['max/1mo'], '일봉(1d)으로 물으면 일봉용 네이버 빈 날 채우기가 섞인다');
  const d = draws.at(-1);
  assert.deepEqual(d.closes, [6000, 30000, 237750], '받은 봉 그대로 — 끝점을 덧붙이지 않는다(1D 만)');
  // vm 안에서 만든 배열이라 펼쳐서 비교한다(프로토타입이 달라 [] 끼리도 deepEqual 이 실패한다)
  assert.deepEqual([...d.mas], [], '이동평균선 없음');
  assert.deepEqual([...d.crosses], [], '골든/데드 없음');
  assert.deepEqual(d.highs, [6100, 31000, 240000], '마지막 봉을 오늘 캔들로 덮지 않는다(일봉만)');
  assert.equal(run('chartBars'), 0, '이평선 칩은 1D · 1W 처럼 흐려진다');
  assert.deepEqual(chips, [0]);
  assert.deepEqual(periods.at(-1), [6000, 237750], '전체 수익률은 첫 봉부터');
});

// 3Y 는 1Y 처럼 축 라벨이 연/월이다 — 툴팁 제목에는 일까지, 확대하면 월/일 라벨.
await test('3Y labels read like 1Y: YY/MM axis, full date in the tooltip, MM/DD when zoomed', () => {
  const { c, run } = harness(['drawChart', 'labelFor']);
  run(formatting);
  const configs = [];
  Object.assign(c, {
    Chart: class { constructor(_el, cfg) { configs.push(cfg); } destroy() {} },
    extBandPlugin: {}, profilePlugin: {}, candlePlugin: {}, hLinePlugin: {}, crossMarkPlugin: {}, crosshairPlugin: {}, zoomBoxPlugin: {}, paneNavPlugin: {},
    renderChartMode() {}, renderMaLegend() {}, bindChartLeave() {},
    hexA: () => 'rgba(0,0,0,0)', cssVar: () => '#000000',
  });
  const day = 86400000;
  const t0 = Date.parse('2024-03-04T00:00:00Z');
  run(`state.timeframe = '3Y';
    var T_ = Array.from({ length: 30 }, (_, i) => ${t0} + i * ${day});
    var C_ = Array.from({ length: 30 }, (_, i) => 100 + i);
    var arg_ = { closes: C_, times: T_, up: true, volumes: C_.map(() => 10), highs: C_, lows: C_ };`);
  run('drawChart(arg_);');
  let cfg = configs.at(-1);
  assert.equal(cfg.data.labels[0], '24/03');
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([{ dataIndex: 2, label: cfg.data.labels[2] }]), '24/03/06');
  run('zoom = { start: T_[5], end: T_[25] }; drawChart(arg_);');
  cfg = configs.at(-1);
  assert.equal(cfg.data.labels[5], '03/09', 'zoomed 3Y shows month/day like zoomed 1Y');
  // 전체도 연/월이다 — 26년치를 월/일로 쓰면 해가 바뀌어도 같은 라벨이 된다
  run("zoom = null; state.timeframe = '전체'; drawChart(arg_);");
  cfg = configs.at(-1);
  assert.equal(cfg.data.labels[0], '24/03');
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([{ dataIndex: 2, label: cfg.data.labels[2] }]), '24/03/06');
});

// 3Y 는 봉 하나가 약 0.38px 라 5봉이 2px 남짓이다. 끈 봉 수만 보면 클릭할 때의 손떨림이
// 확대가 된다 — 마우스가 실제로 움직인 거리(6px 이상)도 넘겨야 한다.
await test('drag zoom needs 6px of real mouse travel, so a jittery click on dense 3Y does not zoom', () => {
  const { c, run } = harness(['bindZoom', 'barAt']);
  run(source.match(/^let zoomDrag = .*$/m)[0]);
  run(source.match(/^let lastChart = .*$/m)[0]);
  const on = {};
  const cv = { addEventListener: (k, fn) => { on[k] = fn; }, getBoundingClientRect: () => ({ left: 0 }) };
  c.document.getElementById = (id) => (id === 'chart' ? cv : null);
  c.window = { addEventListener: (k, fn) => { on[k] = fn; } };
  const drawn = [];
  Object.assign(c, { cv_: cv, drawChart: (d) => drawn.push(d), resetZoom: () => {} });
  run(`state.timeframe = '3Y';
    chart = { draw() {}, canvas: cv_, scales: { x: { min: 0, max: 729, getValueForPixel: (px) => px / 0.38 } } };
    lastChart = { times: Array.from({ length: 730 }, (_, i) => i * 86400000) };`);
  c.bindZoom();
  const drag = (x0, x1) => {
    on.mousedown({ button: 0, clientX: x0 });
    on.mousemove({ buttons: 1, clientX: x1 });
    on.mouseup({ clientX: x1 });
  };
  drag(100, 105); // 263 → 276봉, 14봉에 걸치지만 5px
  assert.equal(run('zoom'), null, '5px 손떨림은 확대가 아니다');
  assert.equal(drawn.length, 0);
  drag(100, 106); // 263 → 279봉
  assert.equal(run('JSON.stringify(zoom)'), JSON.stringify({ start: 263 * 86400000, end: 279 * 86400000 }));
  assert.equal(drawn.length, 1);
});

// 일봉(야후)을 실제 refreshAll · loadQuote · dailyFor 로 받는다. 시계는 테스트가 돌린다.
function dailyRun({ yahoo, live = () => ({}) }) {
  const h = harness(['refreshAll', 'loadQuote', 'dailyFor']);
  let clock = NOW;
  h.c.Date = class extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  };
  const calls = [];
  h.c.api.fetchChart = async ({ symbol, range }) => {
    calls.push(symbol);
    return yahoo(symbol, range);
  };
  Object.assign(h.c, {
    loadIndices: async () => [], fetchLive: async () => live(),
    renderList() {}, renderIndices() {}, checkAlerts() {}, err() {}, quoteErrText: () => '', renderDetail() {},
    renderFolio: async () => {}, loadChart: async () => {},
  });
  return { ...h, calls, at: (sec) => { clock = NOW + sec * 1000; }, refresh: () => h.c.refreshAll() };
}
const daily = (price) => ({ ok: true, price, closes: [price - 1000, price], times: [NOW - 86400000, NOW],
  opens: [price, price], highs: [price, price], lows: [price, price], currency: 'KRW' });

// 야후가 응답을 멈추면(8초씩 기다림) 갱신 한 번이 종목 수 × 8초가 되고, 바로 거절(429)하면
// 30초마다 전 종목 5년치를 다시 보낸다. 실패한 종목은 5분 쉬고, 한 차례에 하나가 실패하면
// 캐시가 있는 나머지는 그 차례를 건너뛴다.
await test('a failing Yahoo daily fetch is retried at most once per refresh, and each symbol rests 5 minutes', async () => {
  let up = true;
  const d = dailyRun({ yahoo: (s) => (up ? daily(100000) : { ok: false, error: 'HTTP 429' }) });
  d.run(`state.watchlist = [{symbol:'005930.KS',name:'삼성전자'},{symbol:'000660.KS',name:'SK하이닉스'},
    {symbol:'035420.KS',name:'NAVER'},{symbol:'005380.KS',name:'현대차'}];`);
  const all = 4 + d.run('INDICES.length'); // 종목 4 + 지수 줄
  await d.refresh(); // 0초 — 다 받는다
  assert.equal(d.calls.length, all);
  up = false;
  d.calls.length = 0;
  // 종목 캐시 만료(60초) 뒤 네 번 — 실시간 없는 지수는 5분 캐시라 아직 묻지 않는다
  for (const sec of [120, 150, 180, 210]) { d.at(sec); await d.refresh(); }
  assert.equal(d.calls.length, 4, `one request per refresh, not ${all} — got ${d.calls.join(',')}`);
  assert.equal(new Set(d.calls).size, 4, 'each refresh tries a different symbol — the failed ones rest');
  up = true;
  d.calls.length = 0;
  d.at(210 + 301); await d.refresh(); // 마지막 실패에서 5분 지남 — 모두 다시 받는다
  assert.equal(d.calls.length, all, 'after the rest every symbol fetches again');
  assert.ok(!d.run("quotes['005930.KS'].stale"), 'fresh again');
});

// 네트워크가 끊기면 dailyFor 는 몇 시간 전 캐시를 돌려준다. 그 값을 "20분지연 <지금 시각>" 으로
// 보여 주면 묵은 가격이 정상 지연 시세처럼 보인다 — 실제로 받은 시각과 함께 "갱신 실패" 로 보인다.
// 실시간(네이버)이 있으면 가격은 새것이라 그대로다(일봉은 RSI · 이동평균 · 52주에만 쓴다).
await test('a cached price shown because Yahoo failed says so, with the time it was actually fetched', async () => {
  let up = true;
  let naver = false;
  const d = dailyRun({
    yahoo: () => (up ? daily(250000) : { ok: false, error: 'fetch failed' }),
    live: () => (naver ? { '005930': { price: 251000, prevClose: 249000, open: true, session: 'regular',
      priceSession: 'regular', isTrading: true, source: 'Naver' } } : {}),
  });
  d.run("state.watchlist = [{symbol:'005930.KS',name:'삼성전자'}];");
  await d.refresh(); // 18:30:00 KST 에 받음
  up = false;
  d.at(3 * 3600); // 세 시간 뒤, 네트워크 끊김
  await d.refresh();
  const q = d.run("quotes['005930.KS']");
  assert.equal(q.price, 250000);
  assert.equal(q.stale, true);
  assert.equal(q.fetchedAt, NOW, 'fetchedAt is when the cache was filled, not now');
  d.c.renderUpdated();
  const header = d.elements.get('updated');
  assert.match(header.innerHTML, /갱신 실패<\/span> 18:30:00/, header.innerHTML);
  assert.match(header.title, /마지막으로 받은 값/);

  naver = true; // 네이버는 되고 야후만 안 될 때
  d.at(3 * 3600 + 30);
  await d.refresh();
  const q2 = d.run("quotes['005930.KS']");
  assert.equal(q2.price, 251000);
  assert.ok(!q2.stale, 'a live price is fresh even if the daily series is old');
  d.c.renderUpdated();
  assert.doesNotMatch(header.innerHTML, /갱신 실패/);
});

// 삭제 · 되돌리기 · 추가를 실제 함수로 돌린다. 네트워크(시세 · 차트)는 테스트가 막아 두고 푼다.
function undoRun(extra = []) {
  const h = harness(['removeSymbol', 'undoRemove', 'addSymbol', 'showUndo', 'hideUndo', 'select', ...extra]);
  h.run(source.match(/^const UNDO_MS = .*$/m)[0]);
  h.run(source.match(/^let undoSnap = .*$/m)[0]);
  h.run(source.match(/^let undoTimer = .*$/m)[0]);
  h.run(source.match(/^const adding = .*$/m)[0]);
  let gate = null;
  const charts = [];
  Object.assign(h.c, {
    save() {}, renderList() {}, renderDetail() {}, renderIndices() {}, clearZooms() {}, hint() {}, closeSearch() {},
    renderFolio: async () => {}, fetchLive: async () => ({}),
    loadQuote: async (item) => {
      if (gate) await gate.promise;
      h.run(`quotes[${JSON.stringify(item.symbol)}] = { price: 100, change: 1 };`);
    },
    loadChart: async () => { charts.push(h.run('state.selected && !!quotes[state.selected]')); },
    clearChart() {},
  });
  const hold = () => { let open; gate = { promise: new Promise((r) => { open = r; }) }; return () => { gate = null; open(); }; };
  return { ...h, charts, hold };
}
const SAM = { symbol: '005930.KS', name: '삼성전자' };
const HYNIX = { symbol: '000660.KS', name: 'SK하이닉스' };

// 지운 종목을 6초 안에 다시 추가하고 되돌리기를 누르면 같은 종목이 두 줄이 됐다 — 보유 합계가
// 두 배, 목표가 알림도 두 번. 다시 추가하면 보유는 이미 지워진 뒤라, 되돌리기는 줄은 그대로 두고
// 비어 있는 목표가 · 보유를 되살린다. 추가가 아직 조회 중일 때 되돌려도 마찬가지다.
await test('undo after re-adding the same stock restores its holding and target without a second row', async () => {
  const a = undoRun();
  a.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '000660.KS';
    state.holdings = { '005930.KS': { qty: 10, avg: 200000 } };
    state.alerts.targets = { '005930.KS': { up: 300000 } };`);
  await a.c.removeSymbol('005930.KS');
  await a.c.addSymbol(SAM);
  await a.c.undoRemove();
  assert.deepEqual(a.run("state.watchlist.map((i) => i.symbol).join()"), '000660.KS,005930.KS', 'one row each');
  assert.equal(a.run("state.holdings['005930.KS'].avg"), 200000, 'the holding comes back');
  assert.equal(a.run("state.alerts.targets['005930.KS'].up"), 300000, 'the target comes back');

  // 추가가 조회를 기다리는 사이 되돌리기 — 되돌리기가 먼저 줄을 넣고, 추가는 뒤늦게 끝난다
  const b = undoRun();
  b.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '000660.KS';`);
  await b.c.removeSymbol('005930.KS');
  const open = b.hold();
  const adding = b.c.addSymbol(SAM);
  const undoing = b.c.undoRemove();
  open();
  await Promise.all([adding, undoing]);
  assert.equal(b.run("state.watchlist.map((i) => i.symbol).join()"), '005930.KS,000660.KS', 'still one row each');
});

// 보유만 지운 것(상세의 삭제 · 설정의 ✕)도 6초 되돌리기 — 줄은 그대로 두고 보유만 되살린다(2026-11-11).
// 전에는 관심종목 ✕ 에만 있어, 취소 옆의 삭제를 잘못 누르면 손으로 넣은 평단가가 그대로 없어졌다.
await test('undo after deleting only a holding brings the holding back and leaves the row alone', async () => {
  const a = undoRun(['clearHolding', 'setHolding']);
  a.c.alertsEl = { hidden: true };
  a.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '000660.KS';
    state.holdings = { '005930.KS': { qty: 10, avg: 200000 } };`);
  a.c.clearHolding('005930.KS');
  assert.equal(a.run("state.holdings['005930.KS']"), undefined);
  assert.equal(a.elements.get('undoText').textContent, '삼성전자 보유 삭제됨');
  assert.equal(a.elements.get('undo').hidden, false);
  await a.c.undoRemove();
  assert.deepEqual({ ...a.run("state.holdings['005930.KS']") }, { qty: 10, avg: 200000 }, '보유가 돌아온다');
  assert.equal(a.run("state.watchlist.map((i) => i.symbol).join()"), '005930.KS,000660.KS', '줄은 그대로');
  assert.equal(a.elements.get('undo').hidden, true);
  a.c.clearHolding('000660.KS');
  assert.equal(a.elements.get('undo').hidden, true, '보유가 없으면 되돌릴 것도 없다');
  assert.match(realFunction('renderAlerts'), /del\.onclick = \(\) => \{ clearHolding\(item\.symbol\)/, '설정의 ✕ 도 같은 길');
});

// 선택 중이던 종목을 지웠다 되돌리면 select → loadChart 가 시세를 다시 받기 전에 돈다. 시세가 없으면
// 이동평균 · 교차 배지 · 색(늘 빨강)이 빠진 채 그려지고 다음 갱신(장 마감 후 5분)까지 남았다.
// 순위 패널에서 눌러 넣은 종목(pickRank)의 되돌리기 — 빼고, 그 종목을 보고 있으면 넣기 전에 보던 종목으로 돌아간다.
// 빼는 것은 보통 삭제라 "삭제됨 · 되돌리기" 가 다시 뜬다
await test('undo after adding from the rank panel removes the stock and goes back to what was shown', async () => {
  const a = undoRun(['validSelection']);
  a.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '000660.KS';`);
  const NV = { symbol: 'NVDA', name: '엔비디아' };
  await a.c.addSymbol(NV);
  assert.equal(a.run('state.selected'), 'NVDA', '넣으면서 연다');
  a.c.showUndo({ item: a.run("state.watchlist.find((i) => i.symbol === 'NVDA')"), added: true, prev: '000660.KS' });
  assert.equal(a.elements.get('undoText').textContent, '엔비디아 추가됨');
  await a.c.undoRemove();
  assert.equal(a.run('state.watchlist.map((i) => i.symbol).join()'), '005930.KS,000660.KS', '뺀다');
  assert.equal(a.run('state.selected'), '000660.KS', '넣기 전에 보던 종목으로');
  assert.equal(a.elements.get('undoText').textContent, '엔비디아 삭제됨', '빼는 것도 되돌릴 수 있다');
  await a.c.undoRemove();
  assert.equal(a.run('state.watchlist.map((i) => i.symbol).join()'), '005930.KS,000660.KS,NVDA');

  // 그 사이 다른 종목으로 옮겼으면 그 자리에 둔다
  const b = undoRun(['validSelection']);
  b.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '000660.KS';`);
  await b.c.addSymbol(NV);
  b.c.showUndo({ item: NV, added: true, prev: '000660.KS' });
  await b.c.select('005930.KS');
  await b.c.undoRemove();
  assert.equal(b.run('state.selected'), '005930.KS');
  assert.equal(b.run('state.watchlist.map((i) => i.symbol).join()'), '005930.KS,000660.KS');
});

await test('undoing a selected stock redraws its chart once its quote is back', async () => {
  const a = undoRun();
  a.run(`state.watchlist = ${JSON.stringify([SAM, HYNIX])}; state.selected = '005930.KS';`);
  await a.c.removeSymbol('005930.KS');
  a.charts.length = 0;
  await a.c.undoRemove();
  assert.equal(a.run('state.selected'), '005930.KS');
  assert.equal(a.charts.at(-1), true, `the last chart draw sees the quote — draws: ${JSON.stringify(a.charts)}`);
});

// 마지막 종목을 지울 때 그 종목의 차트 요청이 진행 중이면, 응답이 뒤늦게 와 지운 종목의 차트가
// 빈 헤더("—") 아래 다시 그려졌다. 차트를 지우면 그 전에 시작한 요청도 무효다.
await test('removing the last stock while its chart is loading leaves no chart behind', async () => {
  const a = undoRun(['loadChart', 'clearChart']);
  a.run(source.match(/^let lastChart = .*$/m)[0]);
  a.run(source.match(/^let hoverIdx = .*$/m)[0]);
  a.run('let lastDrawSig = null;');
  delete a.c.loadChart; delete a.c.clearChart; // 진짜 loadChart · clearChart 를 쓴다
  a.run(formatting);
  let release;
  const draws = [];
  Object.assign(a.c, {
    fetchChartCached: () => new Promise((r) => {
      release = () => r({ ok: true, closes: [1, 2, 3], times: [1, 2, 3], volumes: [1, 1, 1] });
    }),
    err() {}, quoteErrText: () => '', renderPeriod() {}, renderMaChips() {}, renderCrossBadge() {},
    renderMaLegend() {}, drawChart: (d) => draws.push(d),
  });
  a.run(`state.watchlist = ${JSON.stringify([SAM])}; state.selected = '005930.KS'; state.timeframe = '1M';`);
  const loading = a.run('loadChart()');
  await a.c.removeSymbol('005930.KS');
  release();
  await loading;
  assert.equal(a.run('state.selected'), null);
  assert.equal(draws.length, 0, 'the late response for the removed stock is dropped');
});

// 설정 패널을 Esc 로 닫으면 패널만 닫혀야 한다. 패널의 Esc 처리가 이벤트를 문서까지 올려
// 보내면, 문서 쪽 단축키는 그때 이미 패널이 닫혀 있어 Esc 를 "위젯 접기" 로 처리한다.
// 입력칸은 문서 쪽이 원래 무시하므로 버튼(다크 · 라이트)에 포커스가 있을 때 생긴다.
await test('Esc closes the settings panel only — it does not also fold the widget', () => {
  const { c, run } = harness();
  let docKey = null;
  const folds = [];
  c.document.addEventListener = (type, fn) => { if (type === 'keydown') docKey = fn; };
  Object.assign(c, {
    searchEl: { hidden: true },
    rankEl: { hidden: true }, // 순위 패널(닫힘) — 문서 쪽 키 처리가 먼저 본다
    alertsEl: { hidden: false },
    closeAlerts: () => { c.alertsEl.hidden = true; },
    setCompact: (on) => folds.push(on),
    compact: false,
  });
  const listener = source.slice(mark("document.addEventListener('keydown', (e) => {"));
  run(listener.slice(0, listener.indexOf('\n});') + 4));
  run(source.match(/^\s*alertsEl\.onkeydown = .*$/m)[0]);
  // 패널 → 문서 순서로 올라간다. 패널이 전파를 멈추면 문서까지 가지 않는다
  const press = (key, target) => {
    let stopped = false;
    const e = { key, target, preventDefault() {}, stopPropagation() { stopped = true; } };
    c.alertsEl.onkeydown(e);
    if (!stopped) docKey(e);
  };
  press('Escape', { tagName: 'BUTTON' }); // 라이트 버튼을 누른 뒤 Esc
  assert.equal(c.alertsEl.hidden, true, 'the panel closes');
  assert.deepEqual(folds, [], 'the widget does not fold as well');

  // 패널이 닫힌 뒤의 Esc 는 패널을 거치지 않고 문서로 간다 — 지금처럼 접기다
  docKey({ key: 'Escape', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.deepEqual(folds, [true]);

  // 초점이 패널 밖이면(⚙ 를 누른 뒤 · 누르면 다시 그려져 사라지는 칩) 패널이 Esc 를 못 받는다 — 문서가 닫는다(접지는 않는다)
  c.alertsEl.hidden = false;
  docKey({ key: 'Escape', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(c.alertsEl.hidden, true, '설정이 닫힌다');
  c.searchEl.hidden = false;
  c.closeSearch = () => { c.searchEl.hidden = true; };
  docKey({ key: 'Escape', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(c.searchEl.hidden, true, '검색도 닫힌다');
  assert.deepEqual(folds, [true], '패널을 닫을 때는 접지 않는다');
});

// 골든 · 데드 크로스 배지 — 툴팁에 뜻과 그 쌍(5/20 · 20/60)의 과거 검증. 색은 방향일 뿐 매매 신호가 아니었다(2026-11-03).
await test('cross badge: the tooltip says what crossed and that it did not foretell the next 20 days', () => {
  const { c, run, elements } = harness(['renderCrossBadge']);
  const el = c.document.getElementById('cross');
  el.classList = { toggle() {} };
  const t = Date.parse('2026-09-07T00:00:00Z');
  c.renderCrossBadge([{ i: 0, pair: '20/60', golden: true }], [t]);
  assert.equal(elements.get('cross').textContent, '20/60 골든 · 3일 전');
  assert.equal(el.title, `20/60 이동평균 골든 크로스 — 짧은 선이 긴 선을 위로 뚫었다\n\n${run("MA_CROSS_EVIDENCE['20/60']")}`);
  assert.match(el.title, /골든 뒤 −0\.5 \(29곳 중 10곳만 나음\)/);
  c.renderCrossBadge([{ i: 0, pair: '5/20', golden: false }], [t]);
  assert.match(el.title, /^5\/20 이동평균 데드 크로스 — 짧은 선이 긴 선을 아래로 뚫었다\n\n과거 10년/);
});

// 추세 점검 줄 — 계산은 backtest.js(tests/backtest.mjs), 여기서는 그리기 · 캐시 · 숨김만 본다.
// 결과 모양을 고정하려고 trendCheck 를 바꿔 끼운다. 마지막 묶음만 진짜 계산을 돌린다.
const TREND = () => ({
  cut: false,
  rule: { start: 59, strat: { total: 0.41, cagr: 0.074, mdd: 0.18, entries: 12, trades: 24, inShare: 0.52 },
    hold: { total: 0.63, cagr: 0.108, mdd: 0.39 }, on: true, since: Date.parse('2026-08-07T00:00:00Z'),
    from: Date.parse('2022-01-04T00:00:00Z'), to: Date.parse('2026-09-09T00:00:00Z'),
    below: 124, verdict: 'same', nullMdd: 0.21, count: 200 },
  fast: { entries: 41, trades: 82, total: 0.12 },
  regime: { cls: 'up', up: true, at: Date.parse('2026-09-09T00:00:00Z'), fallback: false, count: 1000,
    days: 214, episodes: 9, windows: 10, med: 0.021, rise: 0.61, allMed: 0.008, allRise: 0.53, diff: 0.013,
    halves: [0.01, 0.02], verdict: 'same', lo: -0.044, hi: 0.036, paths: 200 },
});
const trendDaily = (n) => ({ closes: Array.from({ length: n }, (_, i) => 100 * 1.002 ** i),
  times: Array.from({ length: n }, (_, i) => Date.parse('2024-01-01T00:00:00Z') + i * 86400000) });

await test('trend check: one line + tooltip, verdict colour, hidden without data', () => {
  const { c, run, elements } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  const el = c.document.getElementById('trendCheck');
  let result = TREND();
  c.trendCheck = () => result;

  c.renderTrendCheck(null);
  assert.equal(el.hidden, true, '선택 없음');
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, true, '일봉을 아직 못 받음');

  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  run(`dailyCache['^HYOAS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '^HYOAS', notTraded: true });
  assert.equal(el.hidden, true, '공포 · 탐욕 · HY OAS 는 사고팔 것이 아니라 숨긴다(2026-11-03)');
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, false);
  // 08-07 09:00 KST → 09-10 (하네스 시각) = 34일
  assert.equal(el.innerHTML, '정배열·20선↑ · 20선>60선 34일째 · 5년: <span>구분 안 됨</span>');
  const tip = el.title.split('\n');
  for (const line of [
    '20/60 규칙: 20일선이 60일선 위면 보유, 아래면 정리',
    '종가로 판단해 다음 날 종가에 사고판다 · 왕복 비용 0.25%',
    '기간 2022-01-04 ~ 2026-09-09',
    '지난 기간 결과 (최대 낙폭 = 가장 크게 빠진 폭)',
    '· 규칙대로: 누적 +41.0% · 해마다 +7.4% · 최대 낙폭 -18.0% · 보유한 날 52%',
    '· 그냥 보유: 누적 +63.0% · 해마다 +10.8% · 최대 낙폭 -39.0%',
    '· 날짜만 민 가짜 매매 200개 중 규칙보다 누적이 낮은 것 124개 → 구분 안 됨 (198개 이상이면 나음 · 2개 이하면 못함)',
    '· 가짜 매매의 최대 낙폭 중앙값 -21.0% (덜 빠진 건 덜 들고 있어서일 수 있다)',
    '· 진입 12회',
    '· 5/20 같은 규칙: 진입 41회 · 비용 합계 약 10% · 누적 +12.0%',
    '지금: 정배열(짧은 선이 위: 5>20>60>120일선) · 20일선 상승 — 09/09 종가 기준',
    '· 같은 상태였던 날 214일 (9구간 · 겹치지 않는 20일 묶음 10개)',
    '· 그 뒤 20거래일: 중앙값 +2.1% · 오른 비율 61% (다음 날 종가 매수, 비용 차감)',
    '· 평소: +0.8% · 53% → 차이 +1.3%포인트',
    '· 가짜 주가 200개의 차이 범위 -4.4 ~ +3.6%포인트 안 → 구분 안 됨',
  ]) assert.ok(tip.includes(line), `툴팁에 "${line}"`);
  // 우연과 예측력 — 2026-10-13 재검증: 효과 없는 규칙에서 판정이 4~5% 나오고, 앞 5년 순위로 뒤 5년 순위를 맞히지 못했다
  assert.deepEqual(tip.slice(-6), [
    '',
    '한계',
    '· 나음 · 못함은 규칙이 쓸모없어도 판정마다 20번에 1번꼴로 우연히 나온다',
    '· 지난 기간의 설명이다 — 10년치로 해 보니 앞 5년 결과로 뒤 5년을 맞히지 못했다',
    '· 배당 · 세금 · 환전 제외, 관심종목은 이미 고른 종목이라 결과가 유리하게 나오기 쉽다',
    '· 과거 통계이며 매매 권유가 아니다',
  ]);

  // 판정 색 — 나음 빨강(UP), 못함 파랑(DOWN). 새 결과를 보려면 캐시를 비운다.
  const redraw = (patch) => {
    result = TREND(); patch(result);
    run("delete trendCache['005930.KS'];");
    c.renderTrendCheck({ symbol: '005930.KS' });
    return el;
  };
  assert.match(redraw((r) => { r.rule.verdict = 'better'; r.rule.below = 199; }).innerHTML,
    /5년: <span style="color:#e24b4a">나음<\/span>$/);
  assert.match(redraw((r) => { r.rule.verdict = 'worse'; r.rule.below = 1; }).innerHTML,
    /5년: <span style="color:#185fa5">못함<\/span>$/);
  // 순위는 개수로 — "상위 99%" 가 못함에도 구분 안 됨에도 나왔다
  assert.ok(el.title.includes('· 날짜만 민 가짜 매매 200개 중 규칙보다 누적이 낮은 것 1개 → 못함 (198개 이상이면 나음 · 2개 이하면 못함)'));
  assert.ok(!el.title.includes('상위'));
  assert.ok(redraw((r) => { r.rule.verdict = 'better'; r.rule.below = 200; }).title.includes('낮은 것 200개 → 나음'));

  // 표본 부족 · 칸 넓히기 · 범위 밖인데 구분 안 됨
  redraw((r) => { r.rule.verdict = 'few'; r.rule.strat.entries = 4; r.rule.on = false; });
  assert.equal(el.innerHTML, '정배열·20선↑ · 20선<60선 34일째 · 5년: <span>표본 부족</span>');
  assert.ok(el.title.includes('· 진입 4회 — 적어서 판정하지 않음'));
  assert.ok(!el.title.includes('가짜 매매'));
  redraw((r) => { r.regime.verdict = 'few'; r.regime.fallback = true; r.regime.cls = 'mixDown'; r.regime.up = false; });
  assert.ok(el.innerHTML.startsWith('혼조·20선↓ · '));
  assert.ok(el.title.includes('지금: 혼조(20일선이 60일선 아래) · 20일선 하락 — 09/09 종가 기준'));
  assert.ok(el.title.includes('· 같은 배열 · 방향인 날이 적어 배열만으로 봄'));
  assert.ok(el.title.includes('· 같은 상태였던 날이 적어 판정하지 않음'));
  assert.ok(!el.title.includes('평소:'));
  // 판정은 빼도 표본이 얼마나 작았는지는 보인다 (스펙: 차이 · 범위 줄만 뺀다)
  assert.ok(el.title.includes('· 같은 상태였던 날 214일 (9구간 · 겹치지 않는 20일 묶음 10개)'));
  assert.ok(el.title.includes('· 그 뒤 20거래일: 중앙값 +2.1% · 오른 비율 61% (다음 날 종가 매수, 비용 차감)'));
  assert.ok(!el.title.includes('가짜 주가'));
  redraw((r) => { Object.assign(r.regime, { verdict: 'few', days: 0, episodes: 0, windows: 0, med: null, rise: null, diff: null }); });
  assert.ok(el.title.includes('· 같은 상태였던 날 0일 (0구간 · 겹치지 않는 20일 묶음 0개)'));
  assert.ok(!el.title.includes('그 뒤 20거래일'), '하루도 없으면 중앙값이 없다');
  redraw((r) => { r.regime.diff = 0.05; });
  assert.ok(el.title.includes('밖 → 구분 안 됨 (앞 · 뒤 절반의 방향이 달라)'));

  // 차이와 범위 끝이 소수 한 자리로 같게 보이면 왜 안/밖인지 안 보인다 — 그때만 둘째 자리까지.
  // 신한지주 2026-10-13: 차이 +3.18%p · 위쪽 끝 +3.21%p 가 둘 다 "+3.2%p" 로 나왔다.
  redraw((r) => { Object.assign(r.regime, { diff: 0.0318, lo: -0.0312, hi: 0.0321 }); });
  assert.ok(el.title.includes('· 평소: +0.8% · 53% → 차이 +3.18%포인트'));
  assert.ok(el.title.includes('· 가짜 주가 200개의 차이 범위 -3.12 ~ +3.21%포인트 안 → 구분 안 됨'));
  redraw((r) => { Object.assign(r.regime, { diff: -0.0438, lo: -0.0442 }); });
  assert.ok(el.title.includes('· 평소: +0.8% · 53% → 차이 -4.38%포인트'));
  assert.ok(el.title.includes('· 가짜 주가 200개의 차이 범위 -4.42 ~ +3.60%포인트 안 → 구분 안 됨'), '아래쪽 끝도');

  // Windows 의 Chromium 은 툴팁을 1024자에서 자른다(ui/views/corewm/tooltip_state_manager.cc kMaxTooltipLength).
  // 줄이 가장 길어지는 경우(이상 봉 뒤부터 · 배열만으로 봄 · 범위 밖인데 구분 안 됨 · 큰 숫자)에도 끝의 안내까지 보여야 한다.
  const longest = redraw((r) => {
    r.cut = true;
    Object.assign(r.regime, { fallback: true, diff: 0.05 });
    Object.assign(r.rule.strat, { total: 15.197, cagr: 0.251, mdd: 0.623 });
    Object.assign(r.rule.hold, { total: 17.664, cagr: 0.349, mdd: 0.541 });
  }).title;
  assert.ok(longest.length <= 1024 && longest.endsWith('매매 권유가 아니다'), `툴팁 ${longest.length}자`);

  // 줄의 기간은 실제로 쓴 기간이다 — 상장 2~5년 종목, 이상 봉 뒤부터 쓴 종목이 "5년" 으로 읽히지 않게
  assert.ok(redraw((r) => { r.rule.from = Date.parse('2024-09-09T00:00:00Z'); }).innerHTML.endsWith(' · 2년: <span>구분 안 됨</span>'));
  assert.ok(redraw((r) => { r.rule.from = Date.parse('2023-09-09T00:00:00Z'); }).innerHTML.endsWith(' · 3년: <span>구분 안 됨</span>'));
  // 문턱은 backtest.js 의 BT_JUMP(35%) — 상한가 · 하한가(±30%)는 자르지 않는다
  assert.ok(redraw((r) => { r.cut = true; }).title.includes('기간 2022-01-04 ~ 2026-09-09 (하루 35% 넘게 움직인 봉 뒤부터)'));

  // 짧은 종목은 숨기고, 이상 봉은 말한다
  assert.equal(redraw(() => {}).hidden, false);
  result = null; run("delete trendCache['005930.KS'];"); c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, true, '500봉 미만');
  result = { error: 'data' }; run("delete trendCache['005930.KS'];"); c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, '추세 점검: 데이터 확인 필요');
  assert.match(el.title, /^하루에 35% 넘게 움직인 봉이 있다\n/);
});

await test('trend check: recomputes only when the last confirmed bar changes; cost by market', () => {
  const { c, run } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  const el = c.document.getElementById('trendCheck');
  const calls = [];
  c.trendCheck = (symbol, closes, times, opts) => { calls.push({ symbol, n: closes.length, opts }); return TREND(); };
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  c.renderTrendCheck({ symbol: '005930.KS' }); // 30초 갱신
  run("dailyCache['005930.KS'].closes[599] *= 1.01;"); // 장중에는 마지막 봉만 움직인다
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(calls.length, 1, '마지막 확정 봉이 그대로면 다시 계산하지 않는다');
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(601))};`); // 다음 날 봉이 하나 늘었다
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(calls.length, 2);
  assert.deepEqual({ ...calls[0].opts }, { domestic: true, cost: 0.0025 });

  run(`dailyCache['^KS11'] = ${JSON.stringify(trendDaily(600))}; dailyCache['AAPL'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '^KS11' });
  assert.deepEqual({ ...calls.at(-1).opts }, { domestic: false, cost: 0.001 });
  assert.ok(el.title.includes('왕복 비용 0.10% (지수는 ETF 로 따라간다고 봄)'));
  c.renderTrendCheck({ symbol: 'AAPL' });
  assert.deepEqual({ ...calls.at(-1).opts }, { domestic: false, cost: 0.001 });
  assert.ok(el.title.includes('왕복 비용 0.10%') && !el.title.includes('지수는'));
});

// 추세 점검 계산이 예외를 내면 renderDetail 이 거기서 끊겨 합계 줄 · 차트까지 그 갱신에서 빠졌다.
// 줄만 숨기고 넘어가며, 같은 봉으로는 30초마다 다시 계산하지 않는다(실패도 캐시).
await test('trend check: a calculation error hides the line instead of stopping the refresh', () => {
  const { c, run, errors } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  const el = c.document.getElementById('trendCheck');
  let calls = 0;
  c.trendCheck = () => { calls++; throw new Error('boom'); };
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  assert.doesNotThrow(() => c.renderTrendCheck({ symbol: '005930.KS' }));
  assert.equal(el.hidden, true);
  assert.equal(errors.length, 1, 'console.error 로 남긴다');
  c.renderTrendCheck({ symbol: '005930.KS' }); // 30초 갱신
  assert.equal(calls, 1, '같은 확정 봉이면 다시 계산하지 않는다');
  c.trendCheck = () => TREND();
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(601))};`); // 다음 날 봉
  c.renderTrendCheck({ symbol: '005930.KS' });
  assert.equal(el.hidden, false, '새 확정 봉이 오면 다시 해 본다');
});

await test('trend check: real backtest on a steady climb says 정배열 and 표본 부족', () => {
  const { run, c } = harness(['renderTrendCheck', 'trendCheckText', 'trendCheckTip', 'verdictText', 'costOf']);
  run(`dailyCache['005930.KS'] = ${JSON.stringify(trendDaily(600))};`);
  c.renderTrendCheck({ symbol: '005930.KS' });
  const el = c.document.getElementById('trendCheck');
  // 오르기만 하면 진입이 1회라 판정하지 않는다. 일수는 60일선이 처음 생긴 봉(2024-02-29)부터 하네스 시각까지.
  // 봉을 달력 하루 간격으로 만들어 쓴 기간이 538일 — 줄에는 "1년" 으로 나온다.
  assert.equal(el.innerHTML, '정배열·20선↑ · 20선>60선 924일째 · 1년: <span>표본 부족</span>');
  assert.ok(el.title.includes('진입 1회 — 적어서 판정하지 않음'));
});

// 목표가 칸 — 쉼표를 받고, 빈 칸은 지우고, 잘못 넣으면 지우지 않는다(2026-11-11). 숫자 칸일 때는 "1,250,000" 이
// 빈 값이 되어 그 목표가가 말없이 지워졌다.
await test('alerts: a target accepts commas, a blank clears it, a bad entry keeps the old one', () => {
  const { c } = harness(['parseAmount', 'targetFrom']);
  assert.deepEqual({ ...c.targetFrom('1,250,000', 1) }, { value: 1250000 });
  assert.deepEqual({ ...c.targetFrom(' 182.5 ', null) }, { value: 182.5 }, '해외 소수');
  assert.deepEqual({ ...c.targetFrom('', 300000) }, {}, '빈 칸은 지우기');
  assert.deepEqual({ ...c.targetFrom('abc', 300000) }, { value: 300000, bad: true }, '잘못 넣으면 있던 값');
  assert.deepEqual({ ...c.targetFrom('-5', undefined) }, { value: undefined, bad: true }, '0 이하도 잘못');
  assert.match(realFunction('renderAlerts'), /cls: 'up', ph: '상한', title: '상한 — [^']+', value: [^\n]*text: true/, '글자 칸(쉼표를 보인다)');
  // 값이 들어가면 칸 이름(placeholder)이 사라져 어느 칸이 상한인지 안 보였다 — 칸마다 툴팁, 보유 평단가는 통화도
  assert.match(realFunction('renderAlerts'), /placeholder="\$\{f\.ph\}" title="\$\{f\.title \|\| f\.ph\}"/);
  assert.match(realFunction('renderAlerts'), /cls: 'avg', ph: avgPh\(item\.symbol\)/);
  // 보유 · 52주 · 추세 점검을 접어 두면 상세에 ＋ 보유 입력이 없다 — 안내가 펼치라고 한다
  assert.match(realFunction('renderAlerts'), /state\.infoOpen \? '' : ' — 지금은 접혀 있어 ▸ 보유 · 52주 · 추세 점검을 먼저 펼치세요'/);
});

// 보유 — 어떤 종목을 들고 있는지 목록에서 보이고, 상세에서 바로 넣고 고치며, 합계 줄이 무엇의 합인지 말한다.
// 이 하네스에는 진짜 DOM 이 없다. 그리는 글자와 상태만 보고, 버튼 · 키 연결은 tests/holdings.mjs(앱)가 본다.
const HOLD_FNS = ['parseAmount', 'amountText', 'holdingFrom', 'holdingPl', 'plColor', 'holdSub', 'renderHolding',
  'holdForm', 'startHoldEdit', 'saveHoldEdit', 'cancelHoldEdit', 'clearHolding', 'setHolding', 'redrawHolding', 'heldRows', 'avgPh'];
const holdHarness = (extra = []) => {
  const h = harness([...HOLD_FNS, ...extra]);
  h.run(formatting);
  const saved = [];
  Object.assign(h.c, { cssVar: () => '#888888', esc: String, save: () => saved.push(1), renderList() {},
    renderDetail: () => h.c.redrawHolding(), loadChart: async () => {} });
  if (!extra.includes('renderFolio')) h.c.renderFolio = async () => {};
  return { ...h, saved };
};

await test('holdings: amounts accept commas; both quantity and average price must be positive', () => {
  const { c } = holdHarness();
  assert.equal(c.parseAmount('206,000'), 206000);
  assert.equal(c.parseAmount(' 1,234.5 '), 1234.5);
  assert.ok(Number.isNaN(c.parseAmount('')));
  assert.ok(Number.isNaN(c.parseAmount('abc')));
  assert.deepEqual({ ...c.holdingFrom('10', '206,000') }, { qty: 10, avg: 206000 });
  assert.deepEqual({ ...c.holdingFrom('0.5', '182.35') }, { qty: 0.5, avg: 182.35 });
  for (const [q, a] of [['10', ''], ['', '100'], ['0', '100'], ['-1', '100'], ['1e400', '100'], ['10', '0']]) {
    assert.equal(c.holdingFrom(q, a), null, `${q} / ${a}`);
  }
  assert.equal(c.amountText(206000), '206,000');
  assert.equal(c.amountText(182.35), '182.35');
  assert.equal(c.amountText(0.5), '0.5');
});

await test('holdings: list row shows quantity and my return only for held stocks', () => {
  const { c, run } = holdHarness();
  run(`state.holdings = { '005930.KS': { qty: 10, avg: 200000 } }; quotes['005930.KS'] = { price: 225000 };`);
  assert.equal(c.holdSub('005930.KS'), '<span class="hsub">10주 · <b style="color:#e24b4a">손익 +12.50%</b></span>');
  assert.equal(c.holdSub('000660.KS'), '', '보유가 아니면 아무것도 붙이지 않는다');
  run(`quotes['005930.KS'] = {};`);
  assert.equal(c.holdSub('005930.KS'), '<span class="hsub">10주</span>', '현재가가 없으면 수량만');
});

// 설정 백업 · 복원 — 설정 패널 맨 아래의 내보내기 · 불러오기. 파일 창 · 확인 창은 main 이 띄운다(tests/backup.mjs).
await test('backup: export saves the latest settings first and says what it saved; import reloads on success and explains a failure', async () => {
  const { c, elements } = harness(['exportBackup', 'importBackup']);
  const log = [];
  let reply;
  Object.assign(c, {
    save: async () => { log.push('save'); },
    location: { reload: () => log.push('reload') },
  });
  c.api.backupExport = async () => { log.push('export'); return reply; };
  c.api.backupImport = async () => { log.push('import'); return reply; };
  const msg = () => elements.get('backupMsg').textContent;

  reply = { ok: true, path: 'C:\\x\\stock-widget-backup-2026-10-16.json', counts: { watchlist: 5, holdings: 2, targets: 1 } };
  await c.exportBackup();
  assert.deepEqual(log.splice(0), ['save', 'export'], '마지막 변경까지 저장한 뒤 내보낸다');
  assert.equal(msg(), '저장했습니다 — stock-widget-backup-2026-10-16.json (관심종목 5개 · 보유 2개 · 목표가 1개)');
  reply = { ok: false, canceled: true };
  await c.exportBackup();
  assert.equal(msg(), '', '창을 닫았으면 아무 말도 하지 않는다');
  reply = { ok: false, error: '권한 없음' };
  await c.exportBackup();
  assert.equal(msg(), '저장하지 못했습니다 (권한 없음)');
  log.length = 0;

  reply = { ok: true, counts: { watchlist: 3, holdings: 1, targets: 0 }, before: 'C:\\x\\before.json' };
  await c.importBackup();
  assert.deepEqual(log.splice(0), ['import', 'reload'], '바꿨으면 처음부터 다시 그린다(시작할 때 설정을 거르는 규칙을 그대로 탄다)');
  reply = { ok: false, canceled: true };
  await c.importBackup();
  assert.deepEqual(log.splice(0), ['import']);
  assert.equal(msg(), '', '취소했으면 아무 말도 하지 않는다');
  reply = { ok: false, error: '백업 파일이 아닙니다(아는 설정이 없음)' };
  await c.importBackup();
  assert.equal(msg(), '불러오지 못했습니다 (백업 파일이 아닙니다(아는 설정이 없음))');
  assert.deepEqual(log.splice(0), ['import'], '실패하면 다시 그리지 않는다');
});

// 관심종목 일정 — 실적 발표(국내) · 배당락(미국)이 14일 안이면 이름 옆에 작게 D-day. 지표 화면을 열어야만 보이던 것.
await test('events: list chip counts days by the Korean date, shows the nearest event within 14 days, and skips past ones', () => {
  const { c, run } = harness(['eventBadge', 'eventChip']);
  c.esc = (s) => String(s).replace(/</g, '&lt;');
  const at = (kst) => Date.parse(`${kst}+09:00`);
  run(`eventCache.set('005930.KS', { at: 0, events: [{ kind: 'ir', title: '2026년 3분기 경영실적 발표', date: '2026-10-29' }] });
    eventCache.set('AAPL', { at: 0, events: [{ kind: 'exdiv', title: '배당락일', date: '2026-10-16' }] });
    eventCache.set('X', { at: 0, events: [{ kind: 'ir', title: '지난 일정', date: '2026-10-01' }, { kind: 'ir', title: '<b>먼 일정</b>', date: '2026-11-30' }] });`);
  const badge = (s, kst) => run(`JSON.stringify(eventBadge('${s}', ${at(kst)}))`);
  assert.equal(badge('005930.KS', '2026-10-16T09:00:00'), JSON.stringify({ label: '실적 D-13', title: '2026년 3분기 경영실적 발표 · 10/29' }));
  assert.equal(badge('005930.KS', '2026-10-15T23:59:00'), JSON.stringify({ label: '실적 D-14', title: '2026년 3분기 경영실적 발표 · 10/29' }), '14일까지');
  assert.equal(badge('005930.KS', '2026-10-14T23:59:00'), 'null', '15일 남으면 아직 없다');
  assert.equal(badge('005930.KS', '2026-10-16T00:01:00'), JSON.stringify({ label: '실적 D-13', title: '2026년 3분기 경영실적 발표 · 10/29' }),
    '한국 날짜로 센다(00:01 KST 는 UTC 로 전날)');
  assert.equal(badge('005930.KS', '2026-10-29T15:00:00'), JSON.stringify({ label: '실적 D-day', title: '2026년 3분기 경영실적 발표 · 10/29' }));
  assert.equal(badge('005930.KS', '2026-10-30T09:00:00'), 'null', '지난 일정은 없다');
  assert.equal(badge('AAPL', '2026-10-16T10:00:00'), JSON.stringify({ label: '배당락 D-day', title: '배당락일 · 10/16' }));
  assert.equal(badge('X', '2026-10-16T10:00:00'), 'null', '지난 것과 먼 것뿐이면 없다');
  assert.equal(badge('NONE', '2026-10-16T10:00:00'), 'null', '아직 안 받았으면 없다');
  run(`eventCache.get('X').events.push({ kind: 'exdiv', title: '배당락일', date: '2026-10-25' }, { kind: 'ir', title: '<b>가까운</b>', date: '2026-10-20' });`);
  assert.equal(JSON.parse(badge('X', '2026-10-16T10:00:00')).label, '실적 D-4', '가장 가까운 것');
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  c.Date.now = () => at('2026-10-16T10:00:00');
  assert.equal(run("eventChip('X')"), '<span class="evchip" title="&lt;b>가까운&lt;/b> · 10/20">실적 D-4</span>', '제목은 이스케이프');
  assert.equal(run("eventChip('NONE')"), '');
  // 작년 잠정실적 공시일로 본 예상 일정(main 의 irEst, 2026-10-30) — '실적 예상' · 점선 칩(est)
  run(`eventCache.set('Y', { at: 0, events: [{ kind: 'irEst', title: '작년 같은 분기 잠정실적 공시일(2025-10-19) 기준 예상', date: '2026-10-19' }] });`);
  assert.equal(badge('Y', '2026-10-16T10:00:00'), JSON.stringify({ label: '실적 예상 D-3',
    title: '작년 같은 분기 잠정실적 공시일(2025-10-19) 기준 예상 · 10/19', est: true }));
  assert.equal(run("eventChip('Y')"), '<span class="evchip est" title="작년 같은 분기 잠정실적 공시일(2025-10-19) 기준 예상 · 10/19">실적 예상 D-3</span>');
  // 지난 잠정실적(main 의 irPast, 2026-11-02 사용자 요청) — 공시 다음 날부터 일주일 동안 흐린 칩 '실적 D+3'. 다가올 일정이 14일 안이면 그것이 먼저
  run(`eventCache.set('Z', { at: 0, events: [{ kind: 'irPast', title: '잠정실적 공시', date: '2026-10-30' }] });`);
  assert.equal(badge('Z', '2026-11-02T10:00:00'), JSON.stringify({ label: '실적 D+3', title: '잠정실적 공시 · 10/30', past: true }));
  assert.equal(JSON.parse(badge('Z', '2026-11-06T23:59:00')).label, '실적 D+7', '일주일까지');
  assert.equal(badge('Z', '2026-11-07T00:01:00'), 'null', '8일째부터는 없다');
  c.Date.now = () => at('2026-11-02T10:00:00');
  assert.equal(run("eventChip('Z')"), '<span class="evchip past" title="잠정실적 공시 · 10/30">실적 D+3</span>');
  run(`eventCache.get('Z').events.push({ kind: 'exdiv', title: '배당락일', date: '2026-11-10' });`);
  assert.equal(JSON.parse(badge('Z', '2026-11-02T10:00:00')).label, '배당락 D-8', '다가올 일정이 14일 안이면 그것이 먼저');
  c.Date.now = realNow;
  // 목록 줄은 이름 옆에 칩을 둔다(이름은 말줄임, 칩은 늘 보인다)
  assert.match(realFunction('renderList'), /<span class="nrow"><span class="name">\$\{esc\(item\.name\)\}<\/span>\$\{riskChip\(item\.symbol\)\}\$\{eventChip\(item\.symbol\)\}<\/span>/);
});

// 위험 상태 칩(다음 금융, 2026-11-24 사용자 요청) — 가장 심한 것 하나에 '외 n', 모두는 툴팁, 정도별 색(rk2 · rk1 · rk0). 국내 종목만, 받은 것이 없으면 없다
await test('watchlist: risk chip — worst label with a count, all labels in the tooltip, level class; none for US or without info', () => {
  const { run } = harness();
  run(helpers());
  run(`daumInfo.set('004545', { risk: [{ label: '투자경고', level: 2 }, { label: '관리종목', level: 2 }] });
    daumInfo.set('009140', { risk: [{ label: '투자주의', level: 1 }] }); daumInfo.set('347770', { risk: [{ label: '액면병합', level: 0 }] });
    daumInfo.set('005930', { risk: [] }); daumInfo.set('AAPL', { risk: [{ label: '투자경고', level: 2 }] });`);
  assert.equal(run("riskChip('004545.KS')"), '<span class="rkchip rk2" title="투자경고 · 관리종목\n거래소 지정 상태 · 다음 금융">투자경고 외 1</span>');
  assert.match(run("riskChip('009140.KS')"), /^<span class="rkchip rk1" [^>]*>투자주의<\/span>$/);
  assert.match(run("riskChip('347770.KQ')"), /^<span class="rkchip rk0" [^>]*>액면병합<\/span>$/);
  assert.equal(run("riskChip('005930.KS')"), '', '위험이 없으면 없다');
  assert.equal(run("riskChip('000660.KS')"), '', '아직 못 받았으면 없다');
  assert.equal(run("riskChip('AAPL')"), '', '국내 종목만');
  // 목록 줄은 이름 옆, 일정 칩 앞에 둔다
  assert.match(realFunction('renderList'), /<span class="nrow"><span class="name">\$\{esc\(item\.name\)\}<\/span>\$\{riskChip\(item\.symbol\)\}\$\{eventChip\(item\.symbol\)\}<\/span>/);
});

// 관심종목의 다음 금융 정보 — 국내 종목 모두를 한 번에(main 의 daum:quotes), 10분마다 · 관심종목이 바뀌면 바로. 실패하면 있던 것을 둔다
await test('watchlist: Daum info for every domestic stock in one call — every 10 minutes or when the list changes; keeps the old on failure', async () => {
  const { c, run } = harness(['loadDaumInfo']);
  run(helpers());
  const asked = [];
  let reply = { ok: true, items: { '005930': { risk: [{ label: '투자주의', level: 1 }] } } };
  c.api.daumQuotes = async (s) => { asked.push([...s]); return reply; };
  let lists = 0;
  c.renderList = () => { lists++; };
  run("state.watchlist.push({ symbol: 'AAPL', name: '애플' });");
  await run('loadDaumInfo()');
  assert.deepEqual(asked, [['005930.KS', '000660.KS']], '국내 종목만, 한 번에');
  assert.equal(lists, 1, '칩이 바뀌면 목록을 다시 그린다');
  await run('loadDaumInfo()');
  assert.equal(asked.length, 1, '10분 안에는 다시 묻지 않는다');
  run("state.watchlist.push({ symbol: '009140.KS', name: '케이아이이' });");
  reply = { ok: false, error: '막힘' };
  await run('loadDaumInfo()');
  assert.equal(asked.length, 2, '국내 종목이 바뀌면 10분을 기다리지 않는다');
  assert.match(run("riskChip('005930.KS')"), /투자주의/, '받지 못하면 있던 것을 둔다');
  assert.equal(lists, 1);
  assert.match(realFunction('refreshAll'), /loadEvents\(\)\.catch\(console\.error\);[^\n]*\n\s*loadDaumInfo\(\)\.catch\(console\.error\);/, '갱신마다 부르되 기다리지 않는다');
});

// 휴장일 · 운영시간(다음 금융, 2026-11-24) — 국내 종목은 오늘이 휴장이면 '장마감' 대신 '휴장', 사유 · 운영시간 변경 · 다음 개장은 툴팁. 하네스 시각은
// 2026-09-10(목) 18:30 KST
await test('header: domestic stock on a market holiday says 휴장; the reason, changed hours and the next open go in the tooltip', () => {
  const { c, run, elements } = harness();
  run(`marketDaysNext = Infinity; marketDays = [
    { date: '2026-09-10', holiday: true, changed: false, reason: '임시공휴일', sessions: [] },
    { date: '2026-09-11', holiday: false, changed: true, reason: '대학수학능력시험 (1시간 늦춤)', sessions: [{ session: 'REGULAR', start: '10:00', end: '16:30' }] }];
    quotes['005930.KS'] = { price: 1, live: true, session: 'closed', source: 'Naver', fetchedAt: Date.now() };`);
  c.renderUpdated();
  const el = elements.get('updated');
  assert.match(el.innerHTML, />휴장<\/span>/);
  assert.match(el.title, /\n오늘 휴장 \(임시공휴일\)\n다음 개장 09\/11\(금\) 10:00 \(운영시간 변경\)$/, el.title);
  run(`marketDays[0] = { date: '2026-09-10', holiday: false, changed: true, reason: null,
    sessions: [{ session: 'REGULAR', start: '10:00', end: '16:30' }, { session: 'AFTER_MARKET', start: '17:00', end: '20:00' }] };
    quotes['005930.KS'].session = 'after';`);
  c.renderUpdated();
  assert.match(el.innerHTML, /애프터마켓/);
  assert.match(el.title, /\n오늘 운영시간 변경 — 정규장 10:00~16:30 · 애프터마켓 17:00~20:00$/, '장이 열려 있으면 다음 개장은 적지 않는다');
  run("state.selected = 'AAPL'; quotes.AAPL = { price: 1, live: true, session: 'closed', fetchedAt: Date.now() };");
  c.renderUpdated();
  assert.doesNotMatch(el.title, /휴장|개장|운영시간/, '미국 종목에는 없다');
  assert.match(el.innerHTML, /장마감/);
});

// 52주 막대 툴팁 — 국내 종목은 다음 금융의 52주 최고 · 최저 날짜 · 50일 최고 · 최저 · 오늘 상한가 · 하한가를 붙인다(2026-11-24)
await test('detail: 52-week bar tooltip adds the Daum 52-week dates, 50-day range and price limits for domestic stocks', () => {
  const { run, elements } = harness(['renderW52', 'w52Extra']);
  run(helpers());
  run("renderW52(97800, 374500, 192400, 'KRW', { hi52: 374500, hi52Date: '2026-06-19', lo52: 97800, lo52Date: '2025-11-25', hi50: 286500, lo50: 171500, upper: 230500, lower: 124300 })");
  assert.match(elements.get('w52').title, /\n\n다음 금융\n52주 최고 374,500 \(26\/06\/19\) · 최저 97,800 \(25\/11\/25\)\n50일 최고 286,500 · 최저 171,500\n오늘 상한가 230,500 · 하한가 124,300$/,
    elements.get('w52').title);
  run("renderW52(97800, 374500, 192400, 'KRW', null)");
  assert.doesNotMatch(elements.get('w52').title, /다음 금융/, '국내가 아니거나 아직 못 받았으면 붙이지 않는다');
  assert.match(realFunction('renderDetail'), /renderW52\([^\n]*isDomestic\(item\.symbol\) \? daumInfo\.get\(item\.symbol\.split\('\.'\)\[0\]\.toUpperCase\(\)\) : null\);/);
});

// 지표 보기의 다음 금융 부분(국내, 2026-11-24 사용자 요청 — main 의 daumDetail, tests/detail.mjs 10번)
await test('metrics: Daum parts — company first with a clickable homepage, volume vs yesterday, finance rows and notices in earnings, estimate, WICS sector, news', () => {
  const { c, run } = harness(METRICS_FNS);
  run(helpers());
  run("quotes['005930.KS'] = { price: 219000, currency: 'KRW' };");
  const DM = { company: { summary: '동사는 <b>글로벌</b> 전자 기업', listed: '1975-06-11', ceo: '전영현, 노태문', est: '1969.01.13', emp: 128881, home: 'www.samsung.com' },
    sector: { name: '반도체와반도체장비', pct: 8.33, per: 20.43901, rank: 1, market: '코스피', top: [{ name: 'SK하이닉스', code: '000660', pct: -2 }] },
    estimate: { eps: 45565, per: 3.9, date: '2026-11-23' },
    finance: { '26.03': { eps: 6992.859, roe: 10.487, debt: 30.146, dps: 372 }, '26.06': { eps: 10717.849, roe: 13.718, debt: 31.101, dps: null } },
    news: [{ id: '20261124131932192', title: '5000피 <회복>', source: '이데일리', at: '2026-11-24 13:19' }],
    notices: [{ kind: 'earnings', label: '잠정실적', day: '2026-10-29', line: '2026년 3분기 · 매출 195.3조원' }], volRatio: 0.6545 };
  const html = (daum, kind = 'stock') => { c.D = { ...KR_DETAIL, kind, daum }; return run("metricsHtml({ symbol: '005930.KS', name: '삼성전자' }, D, quotes['005930.KS'])"); };
  const h = html(DM);
  assert.ok(h.indexOf('<h5>회사 개요') >= 0 && h.indexOf('<h5>회사 개요') < h.indexOf('<h5>오늘'), '회사 개요가 맨 위');
  assert.match(text(h), /대표 전영현, 노태문 · 설립 1969\.01\.13 · 상장 1975\.06\.11 · 직원 128,881명 · www\.samsung\.com/);
  assert.match(h, /<span class="mxhome" data-home="005930" title="누르면 회사 홈페이지 \(브라우저\)">www\.samsung\.com<\/span>/, '홈페이지는 종목 코드만 담는다');
  assert.ok(h.includes('&lt;b&gt;글로벌&lt;/b&gt;') && !h.includes('<b>글로벌</b>'), '소개 문장은 이스케이프');
  assert.match(h, /전일 거래량의 0\.65배/);
  // KR_DETAIL 의 실적 열은 25.12 · 26.03 · 26.06 · 26.09E · 26.12E — 마지막 넷의 같은 분기에
  assert.match(h, /<tr><td>EPS\(원\)<\/td><td>6,993<\/td><td>10,718<\/td><td>—<\/td><td>—<\/td><\/tr>/);
  assert.match(h, /<tr><td>ROE<\/td><td>10\.5%<\/td><td>13\.7%<\/td><td>—<\/td><td>—<\/td><\/tr>/);
  assert.match(h, /<tr><td>배당\(원\)<\/td><td>372<\/td><td>—<\/td>/);
  assert.match(h, /EPS · ROE · 부채비율 · 배당\(주당\)은 다음 금융/);
  assert.match(h, /<p>잠정실적 <span class="mxmute">10\/29 공시<\/span> · 2026년 3분기 · 매출 195\.3조원<\/p>/);
  assert.match(h, /추정 EPS <b>45,565원<\/b>.*추정 PER <b>3\.90배<\/b>/);
  assert.match(text(h), /반도체와반도체장비 \+8\.33% · 업종 PER 20\.4배 · 코스피 시총 1위 \(WICS\)/);
  assert.match(h, /업종 시총 상위<\/span> <span class="mxi"><span class="mxpeer" data-peer="000660"/, '업종 시총 상위도 누르면 그 종목으로');
  assert.match(h, /<h5>최근 뉴스 <span>\(다음 뉴스\)<\/span><\/h5><ul class="mxfil"><li data-news="20261124131932192"/);
  assert.ok(h.includes('5000피 &lt;회복&gt;'), '뉴스 제목은 이스케이프');
  assert.match(h, /자료: 네이버 증권 · 다음 금융\(/);
  assert.match(html({ ...DM, sector: { ...DM.sector, per: -60.7 } }), /업종 PER 적자/);
  assert.doesNotMatch(html(DM, 'etf'), /시총 1위|WICS/, 'ETF 는 업종 · 순위를 적지 않는다');
  // 다음 금융이 모두 비었으면(막힘) 단락도 출처 표기도 없다
  const empty = html({ company: null, sector: null, estimate: null, finance: null, news: null, notices: null, volRatio: null });
  assert.doesNotMatch(empty, /회사 개요|최근 뉴스|추정 EPS|전일 거래량|다음 금융\(/);
  // 누르면 main 에 기사 번호 · 종목 코드만 넘긴다
  assert.match(source, /const hp = e\.target\.closest\('\[data-home\]'\);[^\n]*\n\s*if \(hp\) \{ api\.openHome\(hp\.dataset\.home\); return; \}/);
  assert.match(source, /const n = e\.target\.closest\('\[data-news\]'\);[^\n]*\n\s*if \(n\) \{ api\.openNews\(n\.dataset\.news\); return; \}/);
});

// 관심종목 목록: 줄은 종목 · 순서가 바뀔 때만 새로 만들고, 시세 · 일정 · 선택이 바뀌면 있는 줄의 내용만 고친다. 줄을 통째로
// 새로 만들면 마우스를 올려 둔 줄의 hover(배경 · ✕)가 꺼졌다 켜지며 깜빡였다 — 시작할 때 종목 수만큼, 그 뒤로도 30초마다.
await test('watchlist: rows are rebuilt only when the stocks or their order change; quotes update the rows in place', () => {
  const { c, run, elements } = harness(['renderList', 'listRow', 'shownList', 'listGroupOf']);
  run(formatting);
  run('var sectors = new Map();'); // 업종(renderer/detail.js) — 업종별로 묶을 때 읽는다
  const node = () => {
    const parts = {};
    const cls = new Set();
    return {
      dataset: {}, style: {}, parts,
      get className() { return [...cls].join(' '); },
      set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((k) => cls.add(k)); },
      classList: { toggle: (k, on) => (on ? cls.add(k) : cls.delete(k)), add: (...k) => k.forEach((x) => cls.add(x)),
        remove: (...k) => k.forEach((x) => cls.delete(x)), contains: (k) => cls.has(k) },
      set innerHTML(v) {
        this.html = v;
        for (const k of ['dot', 'nm', 'px', 'chg', 'del']) if (v.includes(`class="${k}"`)) parts[k] = { style: {}, textContent: '', innerHTML: '' };
      },
      get innerHTML() { return this.html; },
      querySelector: (sel) => parts[sel.slice(1)],
    };
  };
  const list = { kids: [], html: '',
    set innerHTML(v) { this.kids = []; this.html = v; }, get innerHTML() { return this.html; },
    appendChild(k) { this.kids.push(k); return k; },
    querySelectorAll(sel) { return sel === '.row' ? this.kids.filter((k) => k.classList.contains('row')) : []; } };
  elements.set('list', list);
  const picked = [];
  const removed = [];
  c.document.createElement = () => node();
  Object.assign(c, { esc: String, cssVar: (n) => n, levelOf: (rsi) => ({ label: '보통', color: rsi == null ? '--dot-off' : '--dot' }),
    eventChip: () => '', holdSub: () => '', select: (s) => picked.push(s), removeSymbol: (s) => removed.push(s) });
  run(`for (const k of Object.keys(quotes)) delete quotes[k]; state.selected = '005930.KS';`);

  run('renderList()');
  const first = [...list.kids];
  assert.deepEqual(first.map((r) => r.dataset.symbol), ['005930.KS', '000660.KS']);
  assert.deepEqual(first.map((r) => r.className), ['row on', 'row'], '고른 종목은 강조');
  assert.equal(first[0].parts.px.textContent, '—', '시세 전');

  // 시세가 들어온다(시작할 때는 종목마다 한 번씩) — 같은 줄의 글자 · 색만 바뀐다
  run(`quotes['005930.KS'] = { price: 230500, change: -11500, pct: -4.75, rsi: 51 };
    quotes['000660.KS'] = { price: 1507000, change: 20000, pct: 1.34, rsi: 60 }; renderList();`);
  assert.ok(list.kids.every((r, i) => r === first[i]), '줄 요소는 그대로 — 마우스를 올려 둔 줄의 hover 가 끊기지 않는다');
  assert.deepEqual(list.kids.map((r) => [r.parts.px.textContent, r.parts.chg.textContent]),
    [['230,500', '-4.75%'], ['1,507,000', '+1.34%']]);
  assert.deepEqual(list.kids.map((r) => r.parts.px.style.color), [run('DOWN'), run('UP')]);
  assert.equal(list.kids[0].parts.dot.style.background, '--dot', '과열도 점');
  assert.equal(list.kids[0].parts.dot.title, '보통 · RSI 51', '점에도 단계 · 값 — 색만으로는 과매도 파랑과 값 없음 회색이 비슷했다');
  run(`quotes['000660.KS'] = { error: 'HTTP 429' }; renderList();`);
  assert.equal(list.kids[1].parts.dot.title, 'RSI —');
  assert.equal(list.kids[1].parts.chg.textContent, '오류');
  assert.equal(list.kids[1].parts.px.style.color, '--flat');

  // 일정 칩 · 보유 줄 · 선택이 바뀌어도 줄은 그대로. 끌기 중인 표시(dragging)는 지우지 않는다
  c.eventChip = (s) => (s === '000660.KS' ? '<chip>' : '');
  first[1].classList.add('dragging');
  run(`state.selected = '000660.KS'; renderList();`);
  assert.ok(list.kids.every((r, i) => r === first[i]));
  assert.deepEqual(list.kids.map((r) => r.className), ['row', 'row dragging on']);
  assert.equal(list.kids[1].parts.nm.innerHTML, '<span class="nrow"><span class="name">SK하이닉스</span><chip></span>');

  first[0].onclick();
  first[1].parts.del.onclick({ stopPropagation() {} });
  assert.deepEqual([picked, removed], [['005930.KS'], ['000660.KS']]);

  // 순서가 바뀌거나 종목이 늘고 줄면 새로 만든다
  run('state.watchlist.reverse(); renderList();');
  assert.deepEqual(list.kids.map((r) => r.dataset.symbol), ['000660.KS', '005930.KS']);
  assert.ok(list.kids[0] !== first[1], '순서가 바뀌면 새 줄(끌기 순번이 줄마다 묶여 있다)');
  run(`state.watchlist.push({ symbol: 'AAPL', name: '애플' }); renderList();`);
  assert.deepEqual(list.kids.map((r) => r.dataset.symbol), ['000660.KS', '005930.KS', 'AAPL']);
  run('state.watchlist = []; renderList();');
  assert.match(list.innerHTML, /관심종목이 없습니다/);
  run(`state.watchlist = [{ symbol: '005930.KS', name: '삼성전자' }]; renderList();`);
  assert.deepEqual(list.kids.map((r) => r.dataset.symbol), ['005930.KS'], '빈 안내 뒤에도 줄을 만든다');

  // 묶어 보기(설정 — 탭 없이 한 목록에서 국장 · 미장을 몰아 본다, 2026-11-13 사용자 요청): 같은 묶음끼리 모으고 묶음마다 구분선.
  // **보이는 순서만** 바꾼다 — 저장되는 순서(state.watchlist)는 그대로라 안 묶음으로 돌리면 원래대로 돌아간다. 처음에는 저장되는
  // 순서까지 바꿔, 묶기를 풀어도 섞여 있던 순서가 돌아오지 않았다(사용자 지적). 묶음 안의 순서는 그대로
  const shape = () => list.kids.map((k) => (k.classList.contains('row') ? k.dataset.symbol : `[${k.textContent}]`));
  const order = () => run("state.watchlist.map((i) => i.symbol).join()");
  run(`state.watchlist = [{ symbol: 'AAPL', name: '애플' }, { symbol: '005930.KS', name: '삼성전자' }, { symbol: 'NVDA', name: '엔비디아' },
    { symbol: '035720.KQ', name: '카카오' }]; state.listGroup = 'kr'; renderList();`);
  assert.deepEqual(shape(), ['[국내]', '005930.KS', '035720.KQ', '[미국]', 'AAPL', 'NVDA']);
  assert.equal(order(), 'AAPL,005930.KS,NVDA,035720.KQ', '저장되는 순서는 그대로');
  assert.ok(list.kids[0].classList.contains('lgroup'));
  const kept = [...list.kids];
  run('renderList();');
  assert.ok(list.kids.every((k, i) => k === kept[i]), '그대로면 다시 만들지 않는다');
  // 새로 넣은 종목은 제 묶음 끝에 보인다
  run(`state.watchlist.push({ symbol: '000660.KS', name: 'SK하이닉스' }); renderList();`);
  assert.deepEqual(shape(), ['[국내]', '005930.KS', '035720.KQ', '000660.KS', '[미국]', 'AAPL', 'NVDA']);
  run("state.listGroup = 'us'; renderList();");
  assert.deepEqual(shape(), ['[미국]', 'AAPL', 'NVDA', '[국내]', '005930.KS', '035720.KQ', '000660.KS']);
  run("state.listGroup = 'none'; renderList();");
  assert.deepEqual(shape(), ['AAPL', '005930.KS', 'NVDA', '035720.KQ', '000660.KS'], '묶기를 풀면 원래 순서로 돌아간다');
  run("state.listGroup = 'kr'; state.watchlist = [{ symbol: 'AAPL', name: '애플' }]; renderList();");
  assert.deepEqual(shape(), ['[미국]', 'AAPL'], '한쪽만 있으면 그 구분선만');

  // 업종별 — 같은 업종끼리. 묶음은 목록에 처음 나온 순서, 업종이 없으면(ETF · 아직 못 받음) 기타로 맨 뒤
  run(`sectors.set('005930.KS', '반도체'); sectors.set('000660.KS', '반도체'); sectors.set('005380.KS', '자동차'); sectors.set('069500.KS', null);
    state.watchlist = [{ symbol: '069500.KS', name: 'KODEX 200' }, { symbol: '005380.KS', name: '현대차' }, { symbol: '005930.KS', name: '삼성전자' },
      { symbol: 'NVDA', name: '엔비디아' }, { symbol: '000660.KS', name: 'SK하이닉스' }];
    state.listGroup = 'sector'; renderList();`);
  assert.deepEqual(shape(), ['[자동차]', '005380.KS', '[반도체]', '005930.KS', '000660.KS', '[기타]', '069500.KS', 'NVDA']);
  assert.equal(order(), '069500.KS,005380.KS,005930.KS,NVDA,000660.KS', '저장되는 순서는 그대로');
  // 업종을 늦게 받으면 줄 순서가 같아도 구분선을 다시 만든다
  run("state.watchlist = [{ symbol: 'NVDA', name: '엔비디아' }]; renderList();");
  assert.deepEqual(shape(), ['[기타]', 'NVDA']);
  run("sectors.set('NVDA', '반도체 및 반도체 장비'); renderList();");
  assert.deepEqual(shape(), ['[반도체 및 반도체 장비]', 'NVDA']);
});

// 끌어서 옮기기 — 자리는 보이는 순서(shownList)의 것이다. 묶어 보기면 저장된 순서와 달라, 옮긴 줄을 놓은 줄의 앞 · 뒤에 둔다
await test('watchlist: dragging puts the row next to the row it was dropped on, in the grouped view too; arrow keys follow the shown order', () => {
  const { c, run } = harness(['moveSymbol', 'moveSelection', 'shownList', 'listGroupOf']);
  const log = [];
  Object.assign(c, { save: () => log.push('save'), renderList: () => log.push('list') });
  const order = () => run("state.watchlist.map((i) => i.symbol).join(' ')");
  const shown = () => run("shownList().map((i) => i.symbol).join(' ')");
  run("state.listGroup = 'none'; state.watchlist = ['A', 'B', 'C', 'D'].map((s) => ({ symbol: s, name: s }));");
  c.moveSymbol(0, 2);
  assert.equal(order(), 'B C A D', '아래로 끌면 놓은 줄 뒤');
  c.moveSymbol(3, 1);
  assert.equal(order(), 'B D C A', '위로 끌면 놓은 줄 앞');
  assert.deepEqual(log, ['save', 'list', 'save', 'list']);
  c.moveSymbol(1, 1);
  c.moveSymbol(null, 2);
  c.moveSymbol(0, 9);
  assert.equal(order(), 'B D C A', '같은 자리 · 없는 자리면 그대로');
  // 묶어 보기: 저장된 순서 [애플 삼성전자 엔비디아 SK하이닉스], 보이는 순서 [삼성전자 SK하이닉스 | 애플 엔비디아]
  run(`state.listGroup = 'kr'; state.watchlist = [{ symbol: 'AAPL', name: 'a' }, { symbol: '005930.KS', name: 'b' }, { symbol: 'NVDA', name: 'c' },
    { symbol: '000660.KS', name: 'd' }];`);
  assert.equal(shown(), '005930.KS 000660.KS AAPL NVDA');
  c.moveSymbol(1, 0); // SK하이닉스를 삼성전자 위로
  assert.equal(shown(), '000660.KS 005930.KS AAPL NVDA');
  assert.equal(order(), 'AAPL 000660.KS 005930.KS NVDA', '저장된 순서에서도 그 줄 앞으로');
  c.moveSymbol(2, 3); // 애플을 엔비디아 아래로
  assert.equal(shown(), '000660.KS 005930.KS NVDA AAPL');
  // ↑↓ 도 보이는 순서로 — 국내 마지막 줄에서 ↓ 는 미국 첫 줄
  const picked = [];
  c.select = (s) => { picked.push(s); return Promise.resolve(); };
  run("document.querySelector = () => null; state.selected = '005930.KS';");
  c.moveSelection(1);
  c.moveSelection(-1);
  assert.deepEqual(picked, ['NVDA', '000660.KS']);
  run("state.listGroup = 'none';");
  assert.equal(shown(), order(), '안 묶음이면 저장된 순서 그대로');
});

// 업종별로 묶으려면 관심종목 모두의 업종이 있어야 한다 — 평소에는 고른 종목 것만 받는다. 없는 것만 차례로 받고 다 받으면 다시 그린다
await test('sector grouping: missing sectors are fetched one at a time and the list is redrawn once; a failed one does not stop the rest', async () => {
  const { c, run } = harness(['loadSectors']);
  run('var sectors = new Map(); var sectorsLoading = false;');
  const asked = [];
  let draws = 0;
  Object.assign(c, { renderList: () => { draws++; },
    sectorFor: async (s) => { asked.push(s); if (s === '000660.KS') throw new Error('HTTP 500'); run(`sectors.set('${s}', '업종')`); } });
  run("sectors.set('005930.KS', '반도체'); state.watchlist.push({ symbol: 'AAPL', name: '애플' });"); // 하네스 목록: 삼성전자 · SK하이닉스
  await Promise.all([c.loadSectors(), c.loadSectors()]);
  assert.deepEqual(asked, ['000660.KS', 'AAPL'], '없는 것만 — 겹쳐 불러도 한 번씩');
  assert.equal(draws, 1, '다 받은 뒤 한 번 다시 그린다');
  assert.equal(run('sectorsLoading'), false);
  // 새로 넣은 종목은 고르는 순간 업종을 받는다(loadSector) — 업종별로 보는 중이면 그 묶음으로 다시 그린다
  assert.match(realFunction('loadSector'), /const name = await sectorFor\(item\.symbol\);\s*if \(state\.listGroup === 'sector'\) renderList\(\);/);
  assert.match(source, /if \(state\.listGroup === 'sector'\) loadSectors\(\)\.catch\(console\.error\); \/\/ 업종별로 묶어 보기/, '시작할 때도');
});

// 한 번 정렬(설정의 정렬 버튼) — 누른 때의 값으로 줄을 세워 저장한다. 그 뒤로는 값이 바뀌어도 저절로 움직이지 않는다(누르려던
// 줄이 마우스 밑에서 빠지지 않게). 손으로 맞춘 순서가 사라지므로 설정에서 바로 되돌릴 수 있다(2026-11-13 사용자 요청)
await test('watchlist: one-shot sort orders the rows once — missing values last, ties keep their order, groups stay together; it can be undone', () => {
  const { c, run, elements } = harness(['sortWatchlist', 'shownList', 'listGroupOf', 'pickSort', 'undoSort', 'sortNote', 'markSeg']);
  run('var sortBefore = null;');
  const log = [];
  Object.assign(c, { save: () => log.push('save'), renderList: () => { log.push('list'); } });
  const order = () => run("state.watchlist.map((i) => i.symbol).join(' ')");
  run(`state.listGroup = 'none';
    state.watchlist = [{ symbol: 'A', name: '다' }, { symbol: 'B', name: '가', addedAt: 2 }, { symbol: 'C', name: '나' }, { symbol: 'D', name: '라', addedAt: 5 }];
    state.holdings = { C: { qty: 1, avg: 1 } };
    for (const k of Object.keys(quotes)) delete quotes[k];
    quotes.A = { pct: 1.5, rsi: 60 }; quotes.B = { pct: -2, rsi: 30 }; quotes.C = { pct: 1.5, rsi: 45 }; quotes.D = { error: 'HTTP 429' };`);
  const before = c.sortWatchlist('pctDesc');
  assert.equal(order(), 'A C B D', '높은 순 — 같은 값(A · C)은 있던 순서, 값이 없는 D 는 뒤');
  assert.deepEqual(log.splice(0), ['list', 'save'], '다시 그리고 저장');
  assert.equal(before.map((i) => i.symbol).join(' '), 'A B C D', '정렬 전 순서를 돌려준다');
  c.sortWatchlist('pctAsc');
  assert.equal(order(), 'B A C D', '낮은 순에서도 값이 없는 종목은 뒤');
  c.sortWatchlist('rsiAsc');
  assert.equal(order(), 'B C A D');
  c.sortWatchlist('held');
  assert.equal(order(), 'C B A D', '보유 먼저 — 나머지는 있던 순서');
  c.sortWatchlist('name');
  assert.equal(order(), 'B C A D', '이름순(가 · 나 · 다 · 라)');
  c.sortWatchlist('added');
  assert.equal(order(), 'D B C A', '최근 추가순 — 넣은 때(addedAt)가 늦은 것부터, 그 값이 없는 예전 종목은 뒤(있던 순서)');
  assert.match(source, /state\.watchlist\.push\(\{ symbol: item\.symbol, name: item\.name, addedAt: Date\.now\(\) \}\);/, '넣을 때 그때를 적는다(addSymbol)');

  // 묶어 보기면 보이는 순서가 국내 · 미국 묶음 안에서 정렬된 꼴이 된다 — 저장되는 순서는 정렬한 그대로
  run(`state.listGroup = 'kr';
    state.watchlist = [{ symbol: 'AAPL', name: '애플' }, { symbol: '005930.KS', name: '삼성전자' }, { symbol: 'NVDA', name: '엔비디아' },
      { symbol: '000660.KS', name: 'SK하이닉스' }];
    quotes.AAPL = { pct: 1 }; quotes['005930.KS'] = { pct: -1 }; quotes.NVDA = { pct: 5 }; quotes['000660.KS'] = { pct: 3 };`);
  c.sortWatchlist('pctDesc');
  assert.equal(order(), 'NVDA 000660.KS AAPL 005930.KS');
  assert.equal(run("shownList().map((i) => i.symbol).join(' ')"), '000660.KS 005930.KS NVDA AAPL');

  // 설정의 버튼 — 무엇으로 세웠는지 적고 되돌리기를 보인다
  run("state.listGroup = 'none';");
  log.length = 0;
  c.pickSort('name', '이름순');
  assert.equal(order(), '005930.KS AAPL NVDA 000660.KS', '삼성전자 · 애플 · 엔비디아 · SK하이닉스 — 가나다순, 로마자 이름은 한글 뒤');
  assert.equal(elements.get('sortMsg').textContent, '정렬했습니다 — 이름순');
  assert.equal(elements.get('sortUndo').hidden, false);
  const sorted = order();
  c.undoSort();
  assert.equal(order(), 'NVDA 000660.KS AAPL 005930.KS', '정렬 전 순서로');
  assert.notEqual(order(), sorted);
  assert.equal(elements.get('sortMsg').textContent, '정렬 전 순서로 되돌렸습니다');
  assert.equal(elements.get('sortUndo').hidden, true, '한 번만 되돌린다');
  assert.deepEqual(log, ['list', 'save', 'list', 'save']);
  c.undoSort();
  c.pickSort('bogus', '모르는 정렬');
  assert.equal(order(), 'NVDA 000660.KS AAPL 005930.KS', '되돌릴 것이 없거나 모르는 정렬이면 그대로');

  // 설정의 묶음 버튼(항상 위 · 관심종목 묶기) — 지금 값의 버튼만 강조
  const btn = (v) => { const b = { dataset: { v }, on: false }; b.classList = { toggle: (_k, on) => { b.on = on; } }; return b; };
  const btns = { '#groupSeg button': ['none', 'kr', 'us'].map(btn), '#pinSeg button': ['true', 'false'].map(btn) };
  c.document.querySelectorAll = (sel) => btns[sel] || [];
  c.markSeg('groupSeg', 'kr');
  c.markSeg('pinSeg', false);
  assert.deepEqual(btns['#groupSeg button'].map((b) => b.on), [false, true, false]);
  assert.deepEqual(btns['#pinSeg button'].map((b) => b.on), [false, true], '참 · 거짓 값도 글자로 견준다');
  // 누르면 값을 바꿔 저장한다 — 항상 위는 main 이 저장을 받으며 창에 적용한다(state:set → applyOnTop)
  assert.match(source, /state\.alwaysOnTop = b\.dataset\.v === 'true'; save\(\); markSeg\('pinSeg', state\.alwaysOnTop\);/);
  assert.match(source, /state\.listGroup = b\.dataset\.v;\s*renderList\(\);\s*save\(\);\s*markSeg\('groupSeg', state\.listGroup\);\s*if \(state\.listGroup === 'sector'\) loadSectors\(\)/,
    '묶기를 바꾸면 다시 그리고 저장 — 업종별이면 아직 없는 업종을 받는다');
  assert.match(source, /state\.alwaysOnTop = state\.alwaysOnTop !== false;\s*state\.listGroup = \['kr', 'us', 'sector'\]\.includes\(state\.listGroup\) \? state\.listGroup : 'none';/,
    '시작할 때 — 항상 위는 끄기로 저장된 때만 끄고, 묶기는 아는 값만');
});

// 칩은 종목마다 받는 대로 바로 그린다 — 예전에는 모든 종목을 받은 뒤 한 번만 그려, 켜고 한참 뒤에야 칩이 한꺼번에 떴다(2026-10-30 사용자
// "늦게 뜬다"). 목록은 줄의 내용만 고치므로(renderList) 자주 그려도 깜빡이지 않는다. 칩이 그대로면 다시 그리지 않는다.
await test('events: the watchlist schedule is fetched one stock at a time, kept for thirty minutes, retried after a failure, and each new chip is drawn at once', async () => {
  const { c, run } = harness(['loadEvents', 'eventChip', 'eventBadge']);
  c.esc = String;
  const asked = [];
  const fail = new Set(['000660.KS']);
  let lists = 0;
  c.api.events = async (s) => { asked.push(s); return fail.has(s) ? { ok: false, error: 'x' } : { ok: true, events: [{ kind: 'ir', title: s, date: '2026-09-15' }] }; };
  c.renderList = () => { lists++; asked.push('그림'); };
  run("state.watchlist.push({ symbol: '^KS11', name: '코스피' });");
  await c.loadEvents();
  assert.deepEqual([...asked], ['005930.KS', '그림', '000660.KS'], '목록 순서대로, 지수는 묻지 않고, 칩이 생긴 종목은 받자마자 그린다');
  assert.equal(run("eventCache.has('000660.KS')"), false, '실패는 기억하지 않는다');
  asked.length = 0;
  await c.loadEvents();
  assert.deepEqual([...asked], ['000660.KS'], '받아 둔 종목은 30분 동안 다시 묻지 않고, 실패한 종목만 다시 — 새 칩이 없으면 그리지 않는다');
  const realNow = c.Date.now; // FixedDate 는 하네스끼리 같이 쓴다 — 끝에서 되돌린다
  // 30분 — 오늘 낸 잠정실적 공시(다음 금융)를 늦지 않게. 네이버 일정은 main 이 6시간 기억한다(2026-10-30)
  c.Date.now = () => NOW + 30 * 60000;
  asked.length = 0;
  fail.clear();
  await c.loadEvents();
  assert.deepEqual([...asked], ['005930.KS', '000660.KS', '그림'], '30분이 지나면 다시 — 칩이 그대로인 종목은 다시 그리지 않는다');
  assert.equal(lists, 2);
  c.Date.now = realNow;
  // 받는 중에 또 부르면(30초 갱신이 겹치면) 그냥 돌아간다
  const pending = [];
  c.api.events = (s) => { asked.push(s); return new Promise((r) => pending.push(() => r({ ok: true, events: [] }))); };
  run('eventCache.clear();');
  asked.length = 0;
  const first = c.loadEvents();
  await c.loadEvents();
  assert.deepEqual([...asked], ['005930.KS'], '겹쳐 부르면 묻지 않는다');
  while (pending.length) { pending.shift()(); await new Promise((r) => setImmediate(r)); }
  await first;
  assert.match(realFunction('refreshAll'), /loadEvents\(\)\.catch\(console\.error\);/, '갱신마다 부르되 기다리지 않는다');
});

await test('holdings: detail adds, validates, edits, cancels and deletes; refresh keeps typed values', () => {
  const { c, run, elements, saved } = holdHarness();
  run(`quotes['005930.KS'] = { price: 225000 }; quotes['000660.KS'] = { price: 1520000 };`);
  c.renderHolding('005930.KS', 225000);
  const el = elements.get('hold');
  assert.equal(el.hidden, false);
  assert.equal(el.innerHTML, '<button type="button" class="hadd" data-act="edit">＋ 보유 입력</button>');
  c.renderHolding('^KS11', 7000);
  assert.equal(el.hidden, true, '지수는 보유할 수 없다');

  run(`state.selected = '005930.KS';`);
  c.startHoldEdit('005930.KS');
  assert.equal(el.hidden, false);
  for (const s of ['class="hq"', 'placeholder="수량" title="수량" value=""', 'class="ha"', 'placeholder="평단가" title="평단가" value=""',
    'data-act="save">저장', 'data-act="cancel">취소']) assert.ok(el.innerHTML.includes(s), s);
  assert.ok(!el.innerHTML.includes('삭제'), '새로 넣을 때는 지울 것이 없다');
  assert.equal(c.avgPh('AAPL'), '평단가($)', '미국 종목 평단가는 달러로 넣는다 — 칸 이름에 적는다');
  assert.equal(c.avgPh('005930.KS'), '평단가');

  // 30초 갱신이 칸을 다시 그리면 치던 값이 날아간다
  el.innerHTML = 'TYPED';
  c.renderHolding('005930.KS', 226000);
  assert.equal(el.innerHTML, 'TYPED');

  c.saveHoldEdit('10', '');
  assert.equal(run(`state.holdings['005930.KS']`), undefined, '평단가가 없으면 저장하지 않는다');
  assert.equal(saved.length, 0);
  assert.ok(el.innerHTML.includes('<span class="hmsg">수량과 평단가를 모두 0보다 큰 숫자로 넣어 주세요</span>'));
  assert.ok(el.innerHTML.includes('placeholder="수량" title="수량" value="10"'), '친 값은 남긴다');

  c.saveHoldEdit('10', '200,000');
  assert.deepEqual({ ...run(`state.holdings['005930.KS']`) }, { qty: 10, avg: 200000 });
  assert.equal(saved.length, 1);
  assert.equal(el.innerHTML, '<span class="hqty">10주</span><span>평단 200,000</span><span>평가 2,250,000</span>'
    + '<span class="hpl" style="color:#e24b4a">+250,000 (+12.50%)</span>'
    + '<button type="button" class="hedit" data-act="edit" title="보유 고치기">✎</button>');

  c.startHoldEdit('005930.KS');
  assert.ok(el.innerHTML.includes('placeholder="수량" title="수량" value="10"') && el.innerHTML.includes('placeholder="평단가" title="평단가" value="200,000"'));
  assert.ok(el.innerHTML.includes('data-act="del">삭제'));
  c.saveHoldEdit('0', '200,000');
  assert.deepEqual({ ...run(`state.holdings['005930.KS']`) }, { qty: 10, avg: 200000 }, '잘못 넣어도 있던 보유는 지우지 않는다');
  assert.equal(saved.length, 1);
  c.cancelHoldEdit();
  assert.ok(el.innerHTML.startsWith('<span class="hqty">10주</span>'), 'Esc · 취소는 그대로 둔다');

  // 다른 종목을 고르면 입력은 취소된다
  c.startHoldEdit('005930.KS');
  c.renderHolding('000660.KS', 1520000);
  assert.equal(el.innerHTML, '<button type="button" class="hadd" data-act="edit">＋ 보유 입력</button>');
  c.renderHolding('005930.KS', 225000);
  assert.ok(el.innerHTML.startsWith('<span class="hqty">'), '돌아와도 입력 칸이 아니다');

  const undos = [];
  c.showUndo = (s) => undos.push(s);
  c.clearHolding('005930.KS');
  assert.equal(run(`state.holdings['005930.KS']`), undefined);
  assert.equal(el.innerHTML, '<button type="button" class="hadd" data-act="edit">＋ 보유 입력</button>');
  assert.deepEqual(undos.map((s) => [s.item.symbol, { ...s.holding }, s.holdingOnly]), [['005930.KS', { qty: 10, avg: 200000 }, true]],
    '지운 보유를 되돌릴 기회를 준다 — 평단가는 위젯 밖에서 되살릴 수 없다');
});

await test('holdings: folio names its numbers and steps through total and each holding', async () => {
  const { c, run, elements } = holdHarness(['folioLines', 'renderFolio', 'showFolio', 'tickFolio']);
  c.usdKrw = () => 1380;
  run(`state.watchlist.push({ symbol: 'AAPL', name: 'AAPL' });
    state.holdings = { '005930.KS': { qty: 10, avg: 200000 }, '000660.KS': { qty: 2, avg: 1600000 }, AAPL: { qty: 5, avg: 180 } };
    quotes['005930.KS'] = { price: 225000 }; quotes['000660.KS'] = { price: 1520000 };
    quotes.AAPL = { price: 200, currency: 'USD' };`);
  await c.renderFolio();
  const box = elements.get('folio');
  const line = (cls, fn, fv, color, fp) => `<div class="${cls}"><span class="fn">${fn}</span><span class="fv">평가 ${fv}</span>`
    + `<span class="fp" style="color:${color}">손익 ${fp}</span></div>`;
  const UP = '#e24b4a', DOWN = '#185fa5';
  // 6,670,000 = 2,250,000 + 3,040,000 + $1,000 × 1,380 · 손익 228,000 / 6,442,000
  assert.equal(box.hidden, false);
  assert.equal(box.innerHTML, line('fline', '보유 3종목', '6,670,000', UP, '+228,000 (+3.54%)'));
  assert.equal(box.title, ['보유 3종목 · 평가 6,670,000 · 손익 +228,000 (+3.54%)',
    '삼성전자 10주 · 평가 2,250,000 · 손익 +250,000 (+12.50%)',
    'SK하이닉스 2주 · 평가 3,040,000 · 손익 -160,000 (-5.00%)',
    'AAPL 5주 · 평가 1,000.00 · 손익 +100.00 (+11.11%)',
    '환율 1,380원/$ (미국 주식은 이 값으로 합계에 넣음)'].join('\n'));

  c.tickFolio();
  assert.equal(box.innerHTML, line('fline in', '삼성전자 10주', '2,250,000', UP, '+250,000 (+12.50%)'));
  c.tickFolio();
  assert.equal(box.innerHTML, line('fline in', 'SK하이닉스 2주', '3,040,000', DOWN, '-160,000 (-5.00%)'));
  c.tickFolio();
  assert.equal(box.innerHTML, line('fline in', 'AAPL 5주', '1,000.00', UP, '+100.00 (+11.11%)'), '해외 종목은 달러로');
  c.tickFolio();
  assert.ok(box.innerHTML.includes('보유 3종목'), '다시 합계');

  run('folioHover = true;');
  c.tickFolio();
  assert.ok(box.innerHTML.includes('보유 3종목'), '마우스가 올라가 있으면 넘기지 않는다');
  run('folioHover = false;');
  c.tickFolio();
  await c.renderFolio(); // 30초 갱신
  assert.equal(box.innerHTML, line('fline', '삼성전자 10주', '2,250,000', UP, '+250,000 (+12.50%)'), '갱신해도 차례를 지킨다');

  // 하나뿐이면 그 종목 줄만 — "보유 1종목" 으로는 무엇을 들고 있는지 모른다
  run(`state.holdings = { '005930.KS': { qty: 10, avg: 200000 } };`);
  await c.renderFolio();
  assert.equal(box.innerHTML, line('fline', '삼성전자 10주', '2,250,000', UP, '+250,000 (+12.50%)'));
  c.tickFolio();
  assert.equal(box.innerHTML, line('fline', '삼성전자 10주', '2,250,000', UP, '+250,000 (+12.50%)'));

  run(`state.holdings = { '005930.KS': { qty: 10, avg: 200000 }, AAPL: { qty: 5, avg: 180 } };`);
  c.usdKrw = () => null;
  await c.renderFolio();
  assert.equal(box.innerHTML, '<div class="fline"><span class="fn">보유 2종목</span>'
    + '<span class="fv">환율을 받지 못해 합계를 낼 수 없습니다</span></div>', '틀린 합계를 내놓지 않는다');

  run('state.holdings = {};');
  await c.renderFolio();
  assert.equal(box.hidden, true);
});

await test('holdings: the folio rate is the index strip\'s USD/KRW, and the last one is kept when the strip fails', () => {
  // 따로 받아 30분 기억하던 때는 같은 야후 주소를 한 번 더 불렀고 지수 줄보다 묵은 환율을 썼다(2026-11-05)
  const { c, run } = harness(['usdKrw']);
  run('var fxRate = null; var indexItems = [];');
  assert.equal(c.usdKrw(), null, '지수 줄을 아직 못 받았으면 없다');
  run("indexItems = [{ code: 'KOSPI', value: 4000 }, { code: 'USDKRW', value: 1380.5 }];");
  assert.equal(c.usdKrw(), 1380.5);
  assert.equal(run('fxRate'), 1380.5, '지표 화면 비중(holdWeight)도 이 값을 쓴다');
  run('indexItems = [];');
  assert.equal(c.usdKrw(), 1380.5, '지수 줄이 실패하면 직전 값');
});

// 오늘 손익 — 보유 수량 × (현재가 - 전일 종가). 340px 줄에 이름 · 평가 · 손익 · 오늘 넷은 들어가지 않아(만 · 억으로
// 줄여도 넘쳤다) 오늘이 있으면 평가는 툴팁으로 뺀다. 전일 종가를 못 받은 종목이 섞이면 지금처럼 평가를 보인다.
await test('holdings: folio shows today\'s gain beside the total gain, moving the value into the tooltip', async () => {
  const { c, run, elements } = holdHarness(['folioLines', 'renderFolio', 'showFolio', 'tickFolio']);
  c.usdKrw = () => 1380;
  run(`state.watchlist.push({ symbol: 'AAPL', name: 'AAPL' });
    state.holdings = { '005930.KS': { qty: 10, avg: 200000 }, '000660.KS': { qty: 2, avg: 1600000 }, AAPL: { qty: 5, avg: 180 } };
    quotes['005930.KS'] = { price: 225000, prevClose: 220000 }; quotes['000660.KS'] = { price: 1520000, prevClose: 1500000 };
    quotes.AAPL = { price: 200, prevClose: 198, currency: 'USD' };`);
  await c.renderFolio();
  const box = elements.get('folio');
  const UP = '#e24b4a';
  // 오늘: 50,000 + 40,000 + $10 × 1,380 = 103,800 / 어제 평가 2,200,000 + 3,000,000 + $990 × 1,380 = 6,566,200 → +1.58%
  assert.equal(box.innerHTML, `<div class="fline"><span class="fn">보유 3종목</span><span class="fp" style="color:${UP}">손익 +228,000 (+3.54%)</span>`
    + `<span class="ft" style="color:${UP}">오늘 +103,800 (+1.58%)</span></div>`, '평가 대신 오늘');
  assert.equal(box.title, ['보유 3종목 · 평가 6,670,000 · 손익 +228,000 (+3.54%) · 오늘 +103,800 (+1.58%)',
    '삼성전자 10주 · 평가 2,250,000 · 손익 +250,000 (+12.50%) · 오늘 +50,000 (+2.27%)',
    'SK하이닉스 2주 · 평가 3,040,000 · 손익 -160,000 (-5.00%) · 오늘 +40,000 (+1.33%)',
    'AAPL 5주 · 평가 1,000.00 · 손익 +100.00 (+11.11%) · 오늘 +10.00 (+1.01%)',
    '환율 1,380원/$ (미국 주식은 이 값으로 합계에 넣음)',
    '오늘 = 전일 종가 대비 (장 시작 전에는 지난 장, 미국 프리 · 애프터마켓이면 그 가격)'].join('\n'), '평가는 툴팁에 남는다');
  c.tickFolio();
  c.tickFolio();
  assert.equal(box.innerHTML, '<div class="fline in"><span class="fn">SK하이닉스 2주</span><span class="fp" style="color:#185fa5">손익 -160,000 (-5.00%)</span>'
    + `<span class="ft" style="color:${UP}">오늘 +40,000 (+1.33%)</span></div>`, '종목 줄도 — 누적은 손실이어도 오늘은 이익일 수 있다');
  c.tickFolio();
  assert.match(box.innerHTML, /<span class="ft" style="color:#e24b4a">오늘 \+10\.00 \(\+1\.01%\)<\/span>/, '해외 종목은 달러로');

  // 전일 종가를 못 받은 종목이 있으면 합계의 오늘은 낼 수 없다 — 지금처럼 평가를 보인다. 받은 종목 줄은 오늘이 있다.
  run('delete quotes.AAPL.prevClose; folioAt = 0;');
  await c.renderFolio();
  assert.match(box.innerHTML, /<span class="fn">보유 3종목<\/span><span class="fv">평가 6,670,000<\/span>/);
  assert.doesNotMatch(box.innerHTML, /오늘/);
  assert.match(box.title, /삼성전자 10주 · 평가 2,250,000 · 손익 \+250,000 \(\+12\.50%\) · 오늘 \+50,000 \(\+2\.27%\)/);
  assert.match(box.title, /AAPL 5주 · 평가 1,000\.00 · 손익 \+100\.00 \(\+11\.11%\)$/m, '전일 종가가 없는 종목 줄은 오늘이 없다');

  // 하나뿐이면 그 종목 줄, 변동이 없으면 회색
  run("state.holdings = { '005930.KS': { qty: 10, avg: 200000 } }; quotes['005930.KS'] = { price: 220000, prevClose: 220000 };");
  await c.renderFolio();
  assert.match(box.innerHTML, /<span class="ft" style="color:#888888">오늘 0 \(0\.00%\)<\/span>/);
});

// 상세의 보유 · 52주 · 추세 점검 세 줄은 손잡이 한 줄로 접고 편다. 저장돼 다시 켜도 그대로다.
await test('info fold: the toggle folds hold · 52-week · trend lines and saves the choice', () => {
  const { c, run, elements } = harness(['applyInfoOpen', 'toggleInfo']);
  const saved = [];
  c.save = () => saved.push(run('state.infoOpen'));
  run('state.infoOpen = true;');
  c.applyInfoOpen();
  const btn = elements.get('infoToggle');
  assert.equal(btn.className, 'infotoggle');
  assert.equal(btn.ariaExpanded, 'true');
  assert.equal(btn.title, '보유 · 52주 · 추세 점검 접기');
  c.toggleInfo();
  assert.equal(run('state.infoOpen'), false);
  assert.deepEqual(saved, [false]);
  assert.equal(btn.className, 'infotoggle off', '.off 가 붙으면 CSS 가 세 줄을 숨긴다 (dom-contract)');
  assert.equal(btn.ariaExpanded, 'false');
  assert.equal(btn.title, '누르면 펼칩니다', '보이는 줄이 없으면 안내만');
  c.toggleInfo();
  assert.equal(run('state.infoOpen'), true);
  assert.deepEqual(saved, [false, true]);
  assert.equal(btn.className, 'infotoggle');
  assert.equal(btn.title, '보유 · 52주 · 추세 점검 접기');
});

// 접혀 있을 때 손잡이에 마우스를 올리면 세 줄에 보이던 내용을 툴팁으로 미리 본다.
// 52주는 52주 막대의 툴팁 글자를 그대로 쓴다 — 막대에 올렸을 때와 같은 말이다.
await test('info fold: the folded toggle\'s tooltip previews the visible lines', () => {
  const { c, run, elements } = harness(['infoTip', 'holdingPl']);
  run(formatting);
  run(`state.infoOpen = false; state.holdings = { '005930.KS': { qty: 10, avg: 200000 } };
    quotes['005930.KS'] = { price: 225000 };`);
  const w52 = c.document.getElementById('w52');
  const tc = c.document.getElementById('trendCheck');
  Object.assign(w52, { hidden: false, title: '52주 최저 201,000 · 최고 312,000\n현재 225,000 — 저점 대비 +11.94%, 고점 대비 -27.88%' });
  Object.assign(tc, { hidden: false, textContent: '혼조·20선↓ · 20선>60선 378일째 · 5년: 구분 안 됨' });
  c.infoTip();
  const btn = elements.get('infoToggle');
  assert.equal(btn.title, [
    '보유 10주 · 평단 200,000 · 평가 2,250,000 · 손익 +250,000 (+12.50%)',
    '52주 최저 201,000 · 최고 312,000',
    '현재 225,000 — 저점 대비 +11.94%, 고점 대비 -27.88%',
    '추세 점검 혼조·20선↓ · 20선>60선 378일째 · 5년: 구분 안 됨',
    '', '누르면 펼칩니다'].join('\n'));

  // 숨은 줄은 빼고, 보유가 없으면 보유 줄도 없다. "데이터 확인 필요" 는 머리말이 겹치지 않게.
  run('state.holdings = {};');
  Object.assign(w52, { hidden: true });
  Object.assign(tc, { textContent: '추세 점검: 데이터 확인 필요' });
  c.infoTip();
  assert.equal(btn.title, '추세 점검: 데이터 확인 필요\n\n누르면 펼칩니다');
  // 현재가를 아직 못 받았으면 보유는 수량 · 평단만
  run(`state.holdings = { '005930.KS': { qty: 10, avg: 200000 } }; quotes['005930.KS'] = {};`);
  Object.assign(tc, { hidden: true });
  c.infoTip();
  assert.equal(btn.title, '보유 10주 · 평단 200,000\n\n누르면 펼칩니다');
  // 지수에는 보유가 없다
  run(`state.selected = '^KS11'; state.holdings['^KS11'] = { qty: 1, avg: 1 };`);
  c.infoTip();
  assert.equal(btn.title, '누르면 펼칩니다');
  run('state.infoOpen = true;');
  c.infoTip();
  assert.equal(btn.title, '보유 · 52주 · 추세 점검 접기');
});

console.log(`PASS: ${passed} session UI test groups`);
