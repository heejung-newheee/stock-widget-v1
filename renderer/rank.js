// renderer/rank.js — 시장 순위 패널과 시장 지표 화면(데드캣 점검 · 코스톨라니 달걀).

// --- 시장 순위 -------------------------------------------------------------------
// 헤더의 순위 버튼이 여는 패널(검색 · 설정과 같은 덮개). 데이터는 main 의 naver:rank — 열려 있는 동안 지금 보는
// 탭만 받고 1분 쓴다(30초 갱신 때 1분이 지났으면 다시 받는다). 누르면 관심종목에 넣고 연다.

// 목록 HTML. 금액은 원(조 · 억) · 달러(T · B · M)로 줄인다. 시총 상위 탭은 시총, 나머지는 거래대금.
// 맨 위에 기준 시각과 거른 기준을 적는다 — 장이 닫혀 있으면 지난 장 순위라 열자마자 보여야 한다
// (처음에는 맨 아래에 두었는데 스크롤해야 보였다).
// 업종 · 테마 탭의 묶음 목록(d.groups)은 묶음 등락률과 오른 · 내린 종목 수다 — 등락률은 평균이라 큰 종목 한두 개에
// 끌려서 수를 같이 봐야 한다. 누르면 그 묶음 안의 종목(d.items, 급등처럼 거른 것)이다.
function rankPct(v) {
  return `<span class="rpct" style="color:${plColor(v)}">${fmtPct(v)}</span>`;
}
function rankCount(g) {
  return `<span class="rcnt"><span style="color:${UP}">↑${g.up}</span> <span style="color:${DOWN}">↓${g.down}</span></span>`;
}
function rankHtml(d, market, kind) {
  if (!d) return '<div class="qhint">순위를 불러오는 중…</div>';
  if (!d.ok) return `<div class="qhint">순위를 불러오지 못했습니다 (${esc(d.error || '알 수 없는 오류')})</div>`;
  const label = { industry: '업종', theme: '테마' }[kind];
  if (d.groups) {
    if (!d.groups.length) return `<div class="qhint">조건에 맞는 ${kind === 'theme' ? '테마가' : '업종이'} 없습니다</div>`;
    const groups = d.groups.map((g, i) => `<div class="hit rrow" data-g="${i}" title="${g.count}종목 중 오른 ${g.up} · 내린 ${g.down} — 누르면 종목">`
      + `<span class="rk">${i + 1}</span><span class="hname">${esc(g.name)}</span>${rankPct(g.pct)}${rankCount(g)}</div>`).join('');
    return `<div class="qhint rnote">네이버 ${label} 등락률 순 · 5종목 이상 · ↑오른 ↓내린 종목 수</div>${groups}`;
  }
  if (!d.items.length) return '<div class="qhint">조건에 맞는 종목이 없습니다</div>';
  const amt = (v, cur) => {
    if (v == null) return '';
    if (cur === 'KRW') return v >= 1e12 ? `${(v / 1e12).toFixed(1)}조` : `${Math.round(v / 1e8).toLocaleString()}억`;
    if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
    return v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6).toLocaleString()}M`;
  };
  const rows = d.items.map((it, i) => {
    const mine = state.watchlist.some((w) => w.symbol === it.symbol);
    return `<div class="hit rrow" data-i="${i}"><span class="rk">${i + 1}</span>`
      + `<span class="hname">${mine ? '<span class="rin" title="관심종목에 있음">✓</span>' : ''}${esc(it.name)}</span>`
      + `<span class="rpx">${money(it.price, it.currency)}</span>`
      + rankPct(it.pct)
      + `<span class="rval">${amt(kind === 'cap' ? it.cap : it.value, it.currency)}</span></div>`;
  }).join('');
  const basis = kind === 'search' ? '네이버 인기 검색 순'
    : label ? '등락률 순 · 일반 주식만(ETF · ETN · 우선주 제외) · 거래대금 10억 원 이상'
    : market === 'kr' ? '일반 주식만(ETF · ETN · 우선주 제외) · 거래대금 10억 원 이상 · 코스피 + 코스닥'
      : kind === 'cap' ? '일반 주식만 · 나스닥 + 뉴욕' : '일반 주식만 · 시총 3억 달러 이상 · 나스닥 + 뉴욕';
  const at = d.at ? Date.parse(d.at) : NaN;
  const when = Number.isFinite(at) ? `${stamp(at)} 기준 · ` : '';
  return `<div class="qhint rnote">${when}${basis}</div>${rows}`;
}

// 업종 · 테마 안에서 맨 위 줄 — 누르면 묶음 목록으로(rankClick)
function rankBackHtml(kind, g) {
  return `<div class="hit rback" data-back="1" title="${kind === 'theme' ? '테마' : '업종'} 목록으로">← <span class="hname">${esc(g.name)}</span>`
    + `${rankPct(g.pct)}${rankCount(g)}</div>`;
}

// 캐시 · 화면의 열쇠 — 업종 · 테마 안이면 묶음 번호까지('kr|industry|278')
function rankKey(v) {
  return `${v.market}|${v.kind}${v.group ? `|${v.group.no}` : ''}`;
}

// 지표 화면의 줄 하나. 고를 수 있는 시장 항목(INDICES)은 값이 지수 줄 값(없으면 받은 시세)이고, 5일 변화는 일봉의 5거래일 전
// 종가 대비다(일봉이 6개 미만이면 null). 금리는 오늘 등락 · 5일 변화를 bp 로 쓴다(d5 는 %p 차이). 데이터가 없으면 null —
// 그 줄을 그리지 않는다. 주가지수(EGG_INDEX)는 메모에 코스톨라니 달걀 국면을 달고 툴팁(noteTitle)에 근거를 적는다.
function marketRow(key) {
  const ix = INDICES.find((i) => i.code === key);
  // 지표 화면만의 줄(MARKET_EXTRA_NAMES). CNN 공포 · 탐욕 · HY OAS 는 차트도 있어(INDICES) 누르면 그 차트로
  if (!ix || key in MARKET_EXTRA_NAMES) {
    const row = marketExtraRow(key);
    return row && ix ? { ...row, symbol: ix.symbol } : row;
  }
  const it = indexItems.find((i) => i.code === key);
  const q = quotes[ix.symbol];
  const value = it ? it.value : q && q.price;
  if (!(value > 0)) return null;
  const cur = curOf(ix.symbol);
  const closes = q && q.daily && q.daily.closes;
  const base = mcBase({ closes }); // 5거래일 전 — 데드캣 점의 판정과 같은 날(market-check.js)
  const bp = cur === '%';
  const egg = EGG_INDEX.has(key) && closes ? eggPhase(closes, dailyVolumesOf(ix.symbol)) : null;
  return {
    key, name: ix.name, symbol: ix.symbol, value, cur,
    pct: it ? it.pct : q && q.pct != null ? q.pct : null,
    change: it ? it.change : q && q.change != null ? q.change : null,
    d5: base > 0 ? (bp ? value - base : (value / base - 1) * 100) : null,
    d5Unit: bp ? 'bp' : '%',
    note: ix.delayMin ? `${ix.delayMin}분 지연` : egg ? `달걀 ${eggDir(egg)}` : '',
    noteTitle: egg ? eggTip(egg) : '',
    spark: closes ? closes.slice(-20) : null,
  };
}

// 코스피200 현물의 t 시각 값 { t, v } — t 앞의 마지막 것: 오늘 1분 종가(market:extras 의 k200Min) · 지수 줄의 현물(그 거래 시각) ·
// t 가 그날 장 시작(09:00) 앞이면 전일 종가. t 앞의 1분 종가가 5분 넘게 비었는데 현물은 그 뒤에도 거래됐으면(분봉을 아직 못
// 받았거나 낡았다) 모르는 것으로 null — 엉뚱한 시각의 현물과 빼지 않는다.
function k200At(t, spot, mins) {
  if (!Number.isFinite(t) || !spot) return null;
  const spotAt = Date.parse(spot.tradedAt || '');
  const samples = (mins || []).map((m) => ({ t: m.t, v: m.close, kind: 'min' }));
  if (Number.isFinite(spotAt)) {
    samples.push({ t: spotAt, v: spot.value, kind: 'now' });
    const open = Math.floor((spotAt + 9 * 3600000) / 86400000) * 86400000; // 그날 09:00 KST(= 00:00 UTC)
    // 전일 종가는 그날 0시(KST)부터 장 시작까지의 값 — 선물만 열린 08:45~09:00 도 그 앞이다
    if (spot.change != null && t < open) samples.push({ t: open - 9 * 3600000, v: spot.value - spot.change, kind: 'prev' });
  }
  let best = null;
  for (const s of samples) if (s.t <= t && (!best || s.t >= best.t)) best = s;
  if (!best) return null;
  if (best.kind === 'min' && Number.isFinite(spotAt) && spotAt > t && t - best.t > 5 * 60000) return null;
  return { t: best.t, v: best.v };
}

// 지표 화면에만 있는 줄 — 차트가 없어 누를 수 없다(symbol null). market:extras 를 아직 못 받았거나 그 부분이 실패했으면 null.
// (코스피200 현물 · 선물은 2026-10-30 부터 누를 수 있는 INDICES 줄이다 — 위 marketRow.)
//  - BASIS 베이시스: 선물 - 현물(포인트). 선물은 네이버가 20분 늦게 줘서 지금 현물과 빼면 그 20분 동안 움직인 만큼이 섞였다(오르는
//    장에서 콘탱고가 백워데이션으로 보였다, 2026-10-30) — 선물 시각의 현물(k200At)과 뺀다. 장중엔 20분 전 베이시스이고 메모에 그 시각.
//    오늘 등락은 어제 베이시스(같은 날 종가끼리) 대비, 5일 변화 · 미니 선은 날마다의 베이시스에 지금 값을 이은 것.
//  - SPOT · FUTFLOW 외국인 현물 · 선물 수급: 마지막 확정일의 외국인 순매수(억 원 — 네이버 화면은 단위를 적지 않지만 10/23 선물
//    +4,514 가 다음 금융 금액 4,514억(계약으로는 2,177)과 같았다, 2026-11-02 확인), 5일 변화 자리에 확정일 끝에서 같은 부호가 이어진
//    날 수, 메모 첫 줄에 그 확정일, 20:30 전 오늘 값은 잠정이라 메모 둘째 줄에 따로(main FLOW_FINAL).
//  - HYOAS 미국 HY OAS: 마지막 값(%), 오늘 등락은 앞 줄 · 5일 변화는 다섯 줄 앞 대비 bp, 메모에 그 값의 날짜(1~2영업일 늦다).
//  - INTRA_* 장중 수급(다음 금융, main 의 intraday): 값 = 코스피 현물 누적 순매수(억), 오늘 등락 자리 = 코스피200 선물 누적(억 —
//    처음엔 계약이었는데 현물과 견주기 어려웠다, 부호 색), 5일 변화 자리 = 최근 30분 현물 변화(그 시각 또는 그 앞의 마지막 값 대비 — 없으면 —), 미니 선 = 오늘 현물 누적.
//    프로그램은 현물 값 하나뿐이다(선물 · 30분 · 미니 선 없음).
function marketExtraRow(key) {
  const x = marketExtras && marketExtras.d && marketExtras.d.ok ? marketExtras.d : null;
  const signed = (v) => (v > 0 ? '+' : '') + v.toLocaleString('ko-KR');
  if (key === 'BASIS') {
    const fut = indexItems.find((i) => i.code === 'FUT');
    const spot = indexItems.find((i) => i.code === 'KPI200');
    if (!fut || !spot || !(fut.value > 0) || !(spot.value > 0)) return null;
    const pt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
    const futAt = Date.parse(fut.tradedAt || '');
    const hm = Number.isFinite(futAt) ? new Date(futAt + 9 * 3600000).toISOString().slice(11, 16) : null;
    const at = k200At(futAt, spot, x && x.k200Min);
    const value = at ? fut.value - at.v : null;
    // 날마다의 베이시스(같은 날 선물 종가 - 현물 종가) — 선물 시각의 날짜 앞까지. 그날은 지금 값(맞춘 것)을 잇는다.
    const today = hm ? new Date(futAt + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '') : null;
    const spotOn = new Map(((x && x.k200Days) || []).map((d) => [d.date, d.close]));
    const hist = ((x && x.futDays) || []).filter((d) => spotOn.has(d.date) && (!today || d.date < today))
      .map((d) => d.close - spotOn.get(d.date));
    const prev = hist.length ? hist[hist.length - 1] : null;
    const change = value != null && prev != null ? value - prev : null;
    // 5거래일 전(CHECK.LOOKBACK) — hist 에는 오늘이 없어 끝에서 LOOKBACK 번째가 그날이다
    const base = hist.length >= CHECK.LOOKBACK ? hist[hist.length - CHECK.LOOKBACK] : null;
    return { key, name: MARKET_EXTRA_NAMES.BASIS, symbol: null, value, pct: null, change,
      d5: value != null && base != null ? value - base : null, d5Unit: 'pt', valueText: value == null ? '—' : pt(value),
      dayText: change == null ? '—' : pt(change), dayTone: change,
      d5Text: value != null && base != null ? pt(value - base) : '—', note: value == null ? '현물 분봉 기다리는 중' : `${hm} 기준`,
      title: `베이시스 = 코스피200 선물 − 코스피200 현물${value == null ? '' : ` (${pt(value)}pt, 현물의 ${pt((value / at.v) * 100)}%)`}\n`
        + '선물이 비싸면 +(콘탱고), 싸면 −(백워데이션)\n\n'
        + '읽는 법\n'
        + '· 견줄 것은 이론 베이시스 = 만기까지의 금리 이자 − 받을 배당\n'
        + '· 이론값은 대개 조금 + 이지만, 만기 전에 큰 배당이 빠지는 기간에는 − 일 수 있다\n'
        + '· 이론값보다 높으면 선물 매수 우위, 낮으면 매도 우위로 흔히 읽는다 (앱은 이론값을 계산하지 않는다)\n'
        + '· 만기(3 · 6 · 9 · 12월 둘째 목요일)에 가까울수록 0 에 붙는다\n\n'
        + `선물 값이 20분 늦어 같은 시각${hm ? `(${hm})` : ''}의 현물과 뺀다 — 장중엔 20분 전 베이시스다\n`
        + '오늘 등락은 어제 베이시스(종가끼리, 선물 15:45 · 현물 15:30) 대비, 5일 변화 · 미니 선은 날마다의 베이시스',
      spark: hist.length + (value != null ? 1 : 0) >= 2 ? [...hist.slice(-19), ...(value != null ? [value] : [])] : null };
  }
  if (key === 'SPOT' || key === 'FUTFLOW') {
    const flows = x && (key === 'SPOT' ? x.spotFlows : x.futFlows);
    const done = (flows || []).filter((f) => f.final);
    const last = done[done.length - 1];
    if (!last) return null;
    let n = 0;
    for (let i = done.length - 1; i >= 0 && Math.sign(done[i].foreign) === Math.sign(last.foreign) && done[i].foreign !== 0; i--) n++;
    const today = flows[flows.length - 1].final ? null : flows[flows.length - 1];
    return { key, name: MARKET_EXTRA_NAMES[key], symbol: null, value: last.foreign, pct: null, change: null,
      d5: null, d5Unit: '%', valueText: `${signed(last.foreign)}억`, dayText: '', dayTone: last.foreign,
      d5Text: n ? `${n}일 연속 순${last.foreign > 0 ? '매수' : '매도'}` : '—',
      // 이름 아래 첫 줄에 오른쪽 값의 날짜, 둘째 줄에 오늘 잠정 — 한 줄로는 기본 너비(340px)에서 잠정 숫자가 잘린다
      note: `${mmdd(last.date)} 확정${today ? `\n오늘 잠정 ${signed(today.foreign)}억` : ''}`,
      title: `외국인 순매수(억 원) ${mmdd(last.date)} 확정\n20:30 전 오늘 값은 잠정`,
      spark: done.slice(-20).map((f) => f.foreign) };
  }
  // HYOAS · CURVE(미국 장단기 금리차 10년 − 2년, %p — 2026-11-03)는 FRED 날마다 값이라 같은 모양
  if (key === 'HYOAS' || key === 'CURVE') {
    const rows = x && (key === 'HYOAS' ? x.hyOas : x.curve);
    if (!rows || !rows.length) return null;
    const last = rows[rows.length - 1];
    const prev = rows.length >= 2 ? rows[rows.length - 2].value : null;
    const base = mcRowBase(rows); // 5영업일 전 — HY OAS 점의 판정과 같은 날
    return { key, name: MARKET_EXTRA_NAMES[key], symbol: null, value: last.value, pct: null, change: prev == null ? null : last.value - prev,
      d5: base == null ? null : last.value - base, d5Unit: 'bp',
      valueText: key === 'HYOAS' ? `${last.value.toFixed(2)}%` : `${last.value > 0 ? '+' : ''}${last.value.toFixed(2)}%p`,
      note: `${mmdd(last.date)} 기준`,
      title: MARKET_DESC[key],
      spark: rows.slice(-20).map((r) => r.value) };
  }
  // CNN 공포 · 탐욕(0~100): 값은 점수(반올림), 오늘 등락은 전일 종가 대비 · 5일 변화 자리는 1주 전 대비(점수 차), 메모에 단계,
  // 툴팁에 1달 · 1년 전까지, 미니 선은 날마다의 마지막 값
  if (key === 'FEARGREED') {
    const f = x && x.fearGreed;
    if (!f) return null;
    const diff = (b) => (b == null ? null : f.score - b);
    const pt = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);
    const label = FEARGREED_LABEL[f.rating] || f.rating;
    const ago = [['전일', f.prevClose], ['1주 전', f.week], ['1달 전', f.month], ['1년 전', f.year]]
      .filter(([, v]) => v != null).map(([k, v]) => `${k} ${Math.round(v)}`).join(' · ');
    const at = Date.parse(f.at || '');
    return { key, name: MARKET_EXTRA_NAMES.FEARGREED, symbol: null, value: f.score, pct: null, change: diff(f.prevClose),
      d5: diff(f.week), d5Unit: 'pt', valueText: String(Math.round(f.score)), dayText: pt(diff(f.prevClose)), dayTone: diff(f.prevClose),
      d5Text: pt(diff(f.week)), d5Title: '1주 전 대비(점수 차)', note: label,
      title: `${MARKET_DESC.FEARGREED}\n\n지금 ${Math.round(f.score)}(${label})${ago ? ` · ${ago}` : ''}`
        + (Number.isFinite(at) ? `\n${new Date(at + 9 * 3600000).toISOString().slice(5, 16).replace('-', '/').replace('T', ' ')} 기준(한국 시각)` : ''),
      spark: f.days && f.days.length >= 2 ? f.days.slice(-20) : null };
  }
  if (key in INTRADAY_FIELD) {
    const it = x && x.intraday;
    const field = INTRADAY_FIELD[key];
    const spot = (it && it.spot) || [];
    const last = spot[spot.length - 1];
    const value = field ? last && last[field] : it && it.program;
    if (!Number.isFinite(value)) return null;
    const eok = (v) => signed(Math.round(v) || 0);
    const hm = (t) => new Date(t + 9 * 3600000).toISOString().slice(11, 16);
    const name = MARKET_EXTRA_NAMES[key];
    if (!field) {
      return { key, name, symbol: null, value, pct: null, change: null, d5: null, d5Unit: '%', valueText: eok(value), dayText: '—', d5Text: '—',
        title: `프로그램 매매 장중 누적 순매수: 코스피 현물 ${eok(value)}억 원\n`
          + '여러 종목을 바구니로 한꺼번에 사고파는 매매 (차익 · 비차익 합)\n'
          + '다음 금융이 지금 값 하나만 줘서 선물 · 30분 · 미니 선은 없다\n\n'
          + '다음 금융 — 장 마감 전은 잠정치' };
    }
    const futRow = it.fut && it.fut.length ? it.fut[it.fut.length - 1] : null;
    const fut = futRow && Number.isFinite(futRow[field]) ? futRow[field] : null;
    let ago = null; // 30분 앞 — 그 시각 또는 그 앞의 마지막 값
    for (const r of spot) if (r.t <= last.t - 30 * 60000) ago = r;
    const d30 = ago && Number.isFinite(ago[field]) ? value - ago[field] : null;
    const note = { INTRA_INST: '기관은 연기금 포함 합계다\n', INTRA_PENSION: '연기금은 기관 안의 일부다\n',
      // 상장사의 장내 자사주 매입은 기타법인으로 잡힌다(기사 확인). '신탁을 거치면 다른 분류' 는 출처가 없어 뺐다(2026-11-02 점검)
      INTRA_CORP: '기타법인은 일반 회사 · 창업투자회사 · 투자자문사 등이다\n'
        + '상장사가 장내에서 자사주를 사면 여기에 잡혀, 기타법인 순매수는 흔히 자사주 매입으로 읽히지만 전부가 그것은 아니다\n' }[key] || '';
    return { key, name, symbol: null, value, pct: null, change: null, d5: null, d5Unit: '%',
      valueText: eok(value), dayText: fut == null ? '—' : eok(fut), dayTone: fut,
      d5Text: d30 == null ? '—' : eok(d30), d5Title: '최근 30분 현물 순매수 변화(억 원)',
      title: `${name} 장중 누적 순매수\n`
        + `· 코스피 현물 ${eok(value)}억 원 (${hm(last.t)})\n`
        + `${fut == null ? '' : `· 코스피200 선물 ${eok(fut)}억 원 (${hm(futRow.t)})\n`}${note}\n`
        + '30분: 최근 30분 동안의 현물 순매수 변화 · 미니 선: 오늘 09:00 부터의 현물 누적\n'
        + '다음 금융 — 장 마감 전은 잠정치',
      spark: spot.map((r) => r[field]) };
  }
  return null;
}

// 지표 화면에만 있는 줄이 비었을 때 그 이유 — 그 부분(main 의 market:extras errors)이나 응답 전체가 실패했으면 그 문구, 아니면
// null(아직 못 받음 · 확정된 날 없음 등). 지수 줄(시세)과 베이시스는 market:extras 의 한 부분이 아니라 없다.
function marketExtraError(key) {
  const part = key in INTRADAY_FIELD ? 'intraday' : { SPOT: 'spotFlows', FUTFLOW: 'futFlows', HYOAS: 'hyOas', FEARGREED: 'fearGreed', CURVE: 'curve' }[key];
  const d = part && marketExtras && marketExtras.d;
  if (!d) return null;
  return (d.ok ? d.errors && d.errors[part] : d.error) || null;
}

// 장중 수급 묶음 제목 — 칸의 단위와 마지막 현물 값의 시각. 오늘이 아니면(장 전 · 휴장일 — 마지막 거래일 값이다) 날짜도.
function intradayTitle() {
  const it = marketExtras && marketExtras.d && marketExtras.d.ok ? marketExtras.d.intraday : null;
  const last = it && it.spot && it.spot.length ? it.spot[it.spot.length - 1] : null;
  const kst = (t) => new Date(t + 9 * 3600000).toISOString();
  const at = last ? kst(last.t) : null;
  const day = at && at.slice(0, 10) !== kst(Date.now()).slice(0, 10) ? `${at.slice(5, 7)}/${at.slice(8, 10)} ` : '';
  return `${INTRADAY_GROUP} · 현물 · 선물 억 · 30분${at ? ` (${day}${at.slice(11, 16)})` : ''}`;
}

// 데드캣 점검의 입력 — market:extras 의 다섯 부분과, SOX · 원/달러 · VIX · 미국채의 { now(지수 줄 실시간, 없으면 받은 시세),
// closes(일봉 종가), dayPct(오늘 등락률) }. 없는 것은 null(그 판정은 판정 불가).
function marketCheckInput() {
  const x = marketExtras && marketExtras.d && marketExtras.d.ok ? marketExtras.d : {};
  // 값 · 오늘 등락은 그 줄(marketRow)과 같은 것 — 따로 고르면 점의 판정과 줄의 값이 다른 "지금" 을 볼 수 있었다
  const series = (code) => {
    const r = marketRow(code);
    const q = r && quotes[r.symbol];
    return q && q.daily ? { now: r.value, closes: q.daily.closes, dayPct: r.pct } : null;
  };
  return {
    spotFlows: x.spotFlows || null, futFlows: x.futFlows || null, kospiDays: x.kospiDays || null, futDays: x.futDays || null,
    hyOas: x.hyOas || null, sox: series('SOX'), usdkrw: series('USDKRW'), vix: series('VIX'), us10y: series('US10Y'),
  };
}

// 미니 선 — 값들을 44×14 칸에 왼쪽(오래된 것)부터 오른쪽(최근)으로 잇는다. 값이 둘 미만이면 그리지 않고, 모두 같으면 가운데 평평하게.
function sparkSvg(values) {
  const v = (values || []).filter((x) => Number.isFinite(x));
  if (v.length < 2) return '';
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const r1 = (n) => Math.round(n * 10) / 10;
  const pts = v.map((x, i) => `${r1(1 + (i * 42) / (v.length - 1))},${r1(hi === lo ? 7 : 13 - ((x - lo) / (hi - lo)) * 12)}`).join(' ');
  return `<svg class="mspark" viewBox="0 0 44 14" width="44" height="14" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
}

// 지표 화면 HTML — 맨 위 데드캣 점검 요약(개수만 — 결론을 내리지 않는다), 묶음 제목 줄과 줄들(판정 점 · 이름(메모) · 값 · 오늘 등락 ·
// 5일 변화 · 20일 미니 선). 누를 수 있는 줄(고를 수 있는 항목)만 data-sym. 점검 대상이 아닌 줄은 점 자리만 비운다.
function marketHtml() {
  const checks = marketChecks(marketCheckInput());
  const checkOf = new Map(checks.map((c) => [MARKET_CHECK_ROW[c.key], c]));
  const names = new Map(); // 판정 key → 줄 이름(요약 툴팁에 판정별로 적는다)
  const out = [];
  for (const [title, keys] of MARKET_GROUPS) {
    // 데이터가 없으면(출처 실패 · 아직 못 받음) 줄을 빼지 않고 — 로 둔다(설계 ④) — 점검 대상이면 점은 테두리만(판정 불가).
    // 받다 실패한 것이면 메모에 이유, 메모 툴팁에 그 시각(2026-11-02 — HY OAS 가 — 로만 남아 왜 비었는지 알 수 없었다)
    const rows = keys.map((key) => {
      const row = marketRow(key);
      if (row) return row;
      const err = marketExtraError(key);
      const at = err ? new Date(marketExtras.at + 9 * 3600000).toISOString().slice(11, 16) : '';
      return { key, symbol: null, empty: true, valueText: '—', dayText: '—', d5Text: '—', note: err ? `실패 · ${err}` : '',
        noteTitle: err ? `${at} 에 받지 못했다: ${err}\n지표 화면이 열려 있으면 1분마다 다시 묻는다` : '',
        name: (INDICES.find((i) => i.code === key) || {}).name || MARKET_EXTRA_NAMES[key] };
    });
    out.push(`<div class="qhint rnote mgroup">${title === INTRADAY_GROUP ? intradayTitle() : title}</div>`);
    for (const r of rows) {
      const bp = r.d5Unit === 'bp';
      const day = r.dayText != null ? r.dayText : bp ? (r.change != null ? fmtBp(r.change) : '—') : (r.pct != null ? fmtPct(r.pct) : '—');
      const d5 = r.d5Text != null ? r.d5Text : r.d5 == null ? '—' : bp ? fmtBp(r.d5) : fmtPct(r.d5);
      // 위험 · 자금 줄은 툴팁에 그 지표의 뜻(MARKET_DESC) — 누를 수 있으면 그 아래에 '차트 보기', 값이 없어도 설명은 둔다
      const desc = MARKET_DESC[r.key];
      // 80일선 추세(ixTrendTip, 2026-11-26 사용자 요청)는 툴팁 맨 위 — 시세가 있는 줄(INDICES)만. 베이시스 · 수급 줄은 가격이 아니라 없다
      const trend = r.symbol && !r.empty ? ixTrendTip(INDICES.find((i) => i.symbol === r.symbol)) : '';
      const tip = [trend, r.title || desc].filter(Boolean).join('\n\n');
      // 수급 줄은 누르면 확대 차트(openFlow) — 값이 없는 줄(—)은 다른 지표 줄처럼 누를 수 없다
      const flowKind = r.empty ? null : ['SPOT', 'FUTFLOW'].includes(r.key) ? 'daily' : INTRADAY_FIELD[r.key] ? 'intraday'
        : r.key === 'INTRA_PROGRAM' ? 'program' : null; // 프로그램은 앱이 모아 둔 일별 값(flow.js programData)
      const open = r.symbol ? `<div class="hit rrow mrow" data-sym="${r.symbol}" data-key="${r.key}" title="${esc(`${tip ? `${tip}\n\n` : ''}${r.name} 차트 보기`)}">`
        : flowKind ? `<div class="hit rrow mrow" role="button" tabindex="0" data-flow-key="${r.key}" data-flow-kind="${flowKind}" data-key="${r.key}" title="${esc(`${tip ? `${tip}\n\n` : ''}수급 차트 보기`)}">`
        : `<div class="rrow mrow mfix" data-key="${r.key}"${tip ? ` title="${esc(tip)}"` : ''}>`;
      const chk = checkOf.get(r.key);
      if (chk) names.set(chk.key, r.name);
      // 점 툴팁 = 그날 근거 + 그 기준의 과거 검증(CHECK_EVIDENCE, 2026-11-02)
      const dot = chk ? `<span class="mdot ${chk.verdict || 'none'}" title="${esc(`${chk.detail}\n${CHECK_EVIDENCE[chk.key]}`)}"></span>`
        : '<span class="mdsp"></span>';
      out.push(`${open}${dot}<span class="hname"><span class="mname">${esc(r.name)}</span>${r.note ? `<span class="mnote"${r.noteTitle ? ` title="${esc(r.noteTitle)}"` : ''}>${esc(r.note)}</span>` : ''}</span>`
        + `<span class="mval">${r.valueText != null ? esc(r.valueText) : money(r.value, r.cur)}</span>`
        + `<span class="rpct" style="color:${plColor(r.dayTone != null ? r.dayTone : bp ? r.change : r.pct)}">${day}</span>`
        + `<span class="md5" title="${esc(r.d5Title || '5거래일 전 종가 대비')}">${d5}</span>${sparkSvg(r.spark)}</div>`);
    }
  }
  const count = (v) => checks.filter((c) => c.verdict === v).length;
  const judged = checks.filter((c) => c.verdict).length;
  // 툴팁에 판정마다 어느 지표인지(2026-10-30 사용자 요청) — 근거 숫자는 줄 앞 점의 툴팁
  const listOf = (v) => checks.filter((c) => c.verdict === v).map((c) => names.get(c.key)).join(' · ');
  const tip = [['긍정', 'good'], ['중립', 'neutral'], ['위험', 'risk'], ['판정 불가', null]]
    .map(([label, v]) => (listOf(v) ? `${label}: ${listOf(v)}\n` : '')).join('');
  return `<div class="qhint msum" title="${esc(`${tip}\n경험칙을 숫자로 옮긴 참고용이다 — 매매 판단을 대신하지 않는다\n\n${DEADCAT_EVIDENCE}`)}">데드캣 점검 · 긍정 ${count('good')}`
    + ` · 중립 ${count('neutral')} · 위험 ${count('risk')} (참고용)${judged < checks.length ? ` · 판정 ${judged}/${checks.length}` : ''}</div>`
    // 칸 이름 줄(2026-11-24 사용자 요청 — 값 · 등락 · 미니 선이 무엇인지 알 수 없었다). 줄과 같은 칸 클래스라 열이 맞는다
    + '<div class="rrow mrow mfix mhead"><span class="mdsp"></span><span class="hname"></span><span class="mval">현재가</span>'
    + '<span class="rpct" title="전일 종가 대비">오늘</span><span class="md5" title="5거래일 전 종가 대비">5일</span>'
    + '<span class="mspark" title="최근 20거래일 종가">20일</span></div>'
    + out.join('');
}

// 시장 · 탭 버튼과 목록을 지금 보는 것으로 그린다. 같은 목록이면 다시 쓰지 않는다(30초마다 다시 쓰면
// 내려 둔 스크롤이 맨 위로 튄다). 탭이 바뀌면 맨 위부터. 지표 화면(mk)은 탭 줄이 없다.
function renderRank() {
  if (document.getElementById('rank').hidden) return;
  const { market, kind, group } = rankView;
  const mk = market === 'mk';
  document.getElementById('rankMarket').innerHTML = [['kr', '국내'], ['us', '미국'], ['mk', '시장 지표']]
    .map(([m, label]) => `<button data-market="${m}"${m === market ? ' class="on"' : ''}>${label}</button>`).join('');
  const tabs = document.getElementById('rankTabs');
  tabs.hidden = mk;
  if (!mk) {
    tabs.innerHTML = RANK_TABS[market]
      .map(([k, label]) => `<button data-kind="${k}"${k === kind ? ' class="on"' : ''}>${label}</button>`).join('');
  }
  const key = mk ? 'mk' : rankKey(rankView);
  const hit = mk ? null : rankCache.get(key);
  const html = mk ? marketHtml() : (group ? rankBackHtml(kind, group) : '') + rankHtml(hit && hit.d, market, kind);
  const list = document.getElementById('rankList');
  rankShown = writeIfChanged(list, rankShown, key, html);
  if (!mk && (!hit || Date.now() - hit.at >= RANK_TTL)) loadRank(market, kind, group ? group.no : undefined);
  if (mk && (!marketExtras || Date.now() - marketExtras.at >= RANK_TTL)) loadMarket();
  document.getElementById('rankRefresh').disabled = mk ? marketLoading : rankLoading.has(key); // 받는 중이면 ↻ 를 끈다 — 받으면 다시 그린다
}

// 지표 화면의 market:extras — 받는 중이면 또 묻지 않고, 다시 받다 실패하면 있던 것을 둔다(loadRank 와 같다). 받으면 다시 그린다.
// 실패는 부분마다다 — 응답이 ok 라도 한 부분만 실패(null)했으면 그 부분은 있던 값을 둔다(FRED 기억이 끝난 직후 500 이면
// HY OAS 줄 · 판정이 1분 넘게 사라졌다, 리뷰 2026-10-27).
async function loadMarket() {
  if (marketLoading) return;
  marketLoading = true;
  let d;
  try {
    d = await api.marketExtras();
  } catch (e) {
    d = { ok: false, error: e.message };
  } finally {
    marketLoading = false;
  }
  const prev = marketExtras && marketExtras.d && marketExtras.d.ok ? marketExtras.d : null;
  let next = d && d.ok ? { ...d } : prev || d || { ok: false, error: '응답 없음' };
  if (d && d.ok && prev) {
    for (const k of ['spotFlows', 'futFlows', 'kospiDays', 'futDays', 'hyOas', 'k200Days', 'k200Min', 'intraday', 'fearGreed', 'curve']) if (next[k] == null && prev[k] != null) next[k] = prev[k];
  }
  marketExtras = { at: Date.now(), d: next, error: d && d.ok ? null : d && d.error || '응답 없음' };
  renderRank();
  renderFlow();
}

// 순위 하나를 받아 기억하고 다시 그린다(loadInto). no 는 업종 · 테마 안의 묶음 번호.
function loadRank(market, kind, no) {
  const key = rankKey({ market, kind, group: no === undefined ? null : { no } });
  return loadInto(rankCache, rankLoading, key, () => api.rank(no === undefined ? { market, kind } : { market, kind, no }),
    () => { renderRank(); if (key === 'kr|search') renderSearchPopular(); });
}

// 시장을 바꿔도 지금 탭이 그 시장에도 있으면 그대로(급등 → 급등), 없으면(국내 인기 검색 · 미국 시총 상위) 첫 탭.
function setRankView(market, kind) {
  if (market === 'mk') { // 지표 화면 — 탭이 없다
    rankView = { market, kind: null, group: null };
    document.getElementById('rankMsg').hidden = true;
    renderRank();
    return;
  }
  const tabs = RANK_TABS[market];
  if (!tabs) return;
  const want = kind || rankView.kind;
  rankView = { market, kind: tabs.some(([k]) => k === want) ? want : tabs[0][0], group: null };
  document.getElementById('rankMsg').hidden = true;
  renderRank();
}

function openRank() {
  openPanel(rankEl);
  document.getElementById('rankMsg').hidden = true;
  renderRank();
}

const closeRank = () => closePanel(rankEl);

// 순위 목록을 누름(목록은 다시 그려지므로 상자에 한 번 붙인다) — ← 는 묶음 목록으로, 업종 · 테마 줄은 그 안으로,
// 종목 줄은 관심종목에 넣거나 그 종목으로(pickRank).
function rankClick(target) {
  const flow = target.closest('[data-flow-key]');
  if (flow) {
    openFlow({ kind: flow.dataset.flowKind, key: flow.dataset.flowKey });
    return;
  }
  const pick = target.closest('[data-sym]'); // 지표 화면의 시장 항목 — 지수 줄을 누를 때처럼 고른다
  if (pick) {
    closeRank();
    select(pick.dataset.sym).catch(console.error);
    return;
  }
  if (target.closest('[data-back]')) {
    rankView = { ...rankView, group: null };
    renderRank();
    return;
  }
  const hit = rankCache.get(rankKey(rankView));
  const d = hit && hit.d && hit.d.ok ? hit.d : null;
  const g = target.closest('[data-g]');
  const group = g && d && d.groups && d.groups[Number(g.dataset.g)];
  if (group) {
    rankView = { ...rankView, group };
    renderRank();
    return;
  }
  const row = target.closest('[data-i]');
  const it = row && d && d.items && d.items[Number(row.dataset.i)];
  if (it) pickRank(it).catch(console.error);
}

// 누르면: 관심종목에 있으면 그 종목으로 가고, 없으면 넣고 연다(검색에서 고를 때와 같다 — addSymbol 이 넣으면서
// 연다). 넣었으면 구경하려고 누른 것일 수 있어 잠깐 되돌릴 기회를 준다(showUndo — 되돌리면 빼고 보던 종목으로).
// 못 넣으면 패널을 두고 그 이유를 적는다(addSymbol 이 돌려준다 — 시세 없음 · 연결 실패 …).
async function pickRank(it) {
  const msg = document.getElementById('rankMsg');
  if (state.watchlist.some((w) => w.symbol === it.symbol)) {
    closeRank();
    await select(it.symbol);
    return;
  }
  // 같은 줄을 또 눌렀다 — 먼저 누른 것이 넣는 중이다. addSymbol 이 바로 돌아와 아래에서 "추가하지 못했습니다"로 적었다.
  if (adding.has(it.symbol)) return;
  msg.textContent = `${it.name} 추가하는 중…`;
  msg.hidden = false;
  const prev = state.selected;
  const err = await addSymbol({ symbol: it.symbol, name: it.name });
  const added = state.watchlist.find((w) => w.symbol === it.symbol);
  if (added) {
    msg.hidden = true;
    closeRank();
    showUndo({ item: added, added: true, prev });
  } else {
    msg.textContent = `${it.name}: 추가하지 못했습니다 (${err || '조회 실패'})`;
    msg.hidden = false;
  }
}

