// LaunchScope — Token Launch Radar (model radar-2).
//
// What this page is: a static dashboard over one sealed DefiLlama snapshot. main.ts computes
// window.RADAR (in data.js, beside this folder) from the snapshot alone; this file only renders it.
// No network, no fetch: every number on the page comes from that one dataset.
//
// The model, in one paragraph: implied value = exp(a) x TVL^b x category offset x growth x maturity.
// The power law (a, b) is an OLS fit of ln(market cap) on ln(TVL) over the snapshot's live-token
// protocols - the ones that already trade, kept separate from this board and shown below as the
// calibration set. The category offset is the category's median log multiple shrunk toward the
// global median (k=8, clamped to +/-0.35 log units); growth uses the 7-day TVL change at weight
// 0.25; maturity rises from 0.85 to 1.00 over three years a protocol has run without a token.
// Every candidate model, this one included, was scored by leave-one-out on the live-token set:
// fit on the rest, predict the held-out market cap. The shipped model won that test; the table
// this page renders (renderMethod) is computed at runtime from the same dataset, so the numbers
// shown are the numbers the code produces - nothing here is a claim typed into a comment.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');

  // ---------- formatting ----------
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFullUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtMult(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(n < 0.1 ? 3 : 2) + 'x';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- the model, as the dashboard explains it ----------
  // The category's calibrated multiples from the live-token comps: {n, median, shrunk, p25, p75}.
  function calibratedMultiple(category) {
    for (var i = 0; i < DATA.categories.length; i++) {
      if (DATA.categories[i].category === category) return DATA.categories[i];
    }
    return null;
  }
  // The farm plan main.ts built for this protocol from its category, chain and size.
  function farmPlanFor(row) {
    return row.farm_steps || [];
  }
  // The multiplicative breakdown of one row's implied value, in the order the model applies it.
  function impliedValueBreakdown(row) {
    var baseValue = row.tvl_usd * row.base_multiple;
    return [
      ['TVL (snapshot)', fmtFullUsd(row.tvl_usd)],
      ['x base multiple (power law x category offset ' + fmtMult(row.cat_offset) + ')', row.base_multiple.toFixed(4)],
      ['= base value', fmtFullUsd(baseValue)],
      ['x growth (7d ' + fmtPct(row.change_7d) + ', weight 0.25)', row.growth_multiplier.toFixed(4)],
      ['x maturity (' + (row.age_days === null ? 'age unreported' : row.age_days + ' days without a token') + ')', row.maturity_multiplier.toFixed(4)],
      ['= implied value', fmtFullUsd(row.implied_value_usd)]
    ];
  }

  // ---------- state, from the URL first so a view can be linked and screenshotted ----------
  var params = new URLSearchParams(location.search);
  var state = {
    q: params.get('q') || '',
    category: params.get('category') || 'all',
    chain: params.get('chain') || 'all',
    watchlistOnly: params.get('watchlist') === '1',
    sort: params.get('sort') || 'implied',
    detail: params.get('detail') || null
  };

  function sortRows(rows) {
    var out = rows.slice();
    if (state.sort === 'tvl') out.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (state.sort === 'growth') out.sort(function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); });
    else if (state.sort === 'youngest') out.sort(function (a, b) {
      var x = a.age_days === null ? 1e12 : a.age_days, y = b.age_days === null ? 1e12 : b.age_days;
      return x - y;
    });
    else out.sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd; });
    return out;
  }

  function applyFilters() {
    var q = state.q.trim().toLowerCase();
    return sortRows(DATA.rows.filter(function (row) {
      if (state.watchlistOnly && !row.watchlist) return false;
      if (state.category !== 'all' && row.category !== state.category) return false;
      if (state.chain !== 'all' && row.chains.indexOf(state.chain) === -1) return false;
      if (q && (row.name + ' ' + row.slug + ' ' + (row.category || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    }));
  }

  // ---------- rendering ----------
  function renderHeader() {
    return '<header class="top"><div>' +
      '<div class="kicker">LaunchScope · model ' + esc(DATA.model_version) + '</div>' +
      '<h1>Token Launch Radar</h1>' +
      '<p>Every protocol in one sealed DefiLlama snapshot that records no token yet, ranked by what its launch would be worth if its record stayed as it is - with the steps to farm each one. Live-token protocols are never ranked; they are the calibration set below.</p>' +
      '</div><div class="top-meta">' +
      '<span>Snapshot as of <b>' + esc(DATA.as_of) + '</b></span>' +
      '<span>Source <b>DefiLlama protocols, sealed</b></span>' +
      '<span>Model <b>' + esc(DATA.model_version) + ' (leave-one-out winner)</b></span>' +
      '</div></header>';
  }

  function renderStats() {
    var chips = [
      [DATA.scanned_size, 'protocols scanned', false],
      [DATA.comps_size, 'live-token comps fit the model', false],
      [DATA.board_size, 'pre-token protocols ranked', false],
      [DATA.watchlist_size + '/' + DATA.watchlist_size, 'watchlist covered', true],
      [DATA.live_size, 'live tokens shown separately', false]
    ];
    return '<div class="stats">' + chips.map(function (c) {
      return '<div class="stat' + (c[2] ? ' amber' : '') + '"><b>' + c[0] + '</b><span>' + c[1] + '</span></div>';
    }).join('') + '</div>';
  }

  function optionList(values, current, allLabel) {
    var html = '<option value="all">' + allLabel + '</option>';
    values.forEach(function (v) {
      html += '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
    });
    return html;
  }

  function renderControls() {
    var cats = [], chains = [], seenC = {}, seenH = {};
    DATA.rows.forEach(function (r) {
      if (r.category && !seenC[r.category]) { seenC[r.category] = 1; cats.push(r.category); }
      r.chains.forEach(function (c) { if (!seenH[c]) { seenH[c] = 1; chains.push(c); } });
    });
    cats.sort(); chains.sort();
    return '<div class="controls">' +
      '<div class="field"><label for="f-q">Search</label><input id="f-q" type="search" placeholder="Protocol, slug, category" value="' + esc(state.q) + '"></div>' +
      '<div class="field"><label for="f-cat">Category</label><select id="f-cat">' + optionList(cats, state.category, 'All categories') + '</select></div>' +
      '<div class="field"><label for="f-chain">Chain</label><select id="f-chain">' + optionList(chains, state.chain, 'All chains') + '</select></div>' +
      '<div class="field"><label for="f-sort">Sort by</label><select id="f-sort">' +
      [['implied', 'Implied value'], ['tvl', 'TVL'], ['growth', '7d growth'], ['youngest', 'Youngest first']].map(function (o) {
        return '<option value="' + o[0] + '"' + (state.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '<label class="check"><input id="f-watch" type="checkbox"' + (state.watchlistOnly ? ' checked' : '') + '> Watchlist only</label>' +
      '<div class="count" id="result-count"></div></div>';
  }

  var SHORT_LABEL = {
    A: 'Flat TVL x 0.25', B: 'Global median multiple', C: 'Category median', D: 'Category shrunk k=4',
    E: 'D x growth', F: 'D x growth x maturity', G: 'F, growth weight tuned', R1: 'radar-1 (starter model)',
    H: 'Power law only', S: 'radar-2, as shipped'
  };

  function renderMethod() {
    var val = DATA.validation.map(function (v) {
      return '<tr class="' + (v.winner ? 'winner' : '') + '"><td>' + v.id + '</td><td>' + esc(SHORT_LABEL[v.id] || v.label) +
        (v.winner ? ' <span class="tag">shipped</span>' : '') + '</td><td class="n">' + v.mean_log10.toFixed(4) +
        '</td><td class="n">' + v.median_fold.toFixed(2) + 'x</td></tr>';
    }).join('');
    var cats = DATA.categories.slice(0, 8).map(function (c) {
      return '<tr><td>' + esc(c.category) + '</td><td class="n">' + c.n + '</td><td class="n">' + c.median.toFixed(3) +
        '</td><td class="n">' + c.shrunk.toFixed(3) + '</td></tr>';
    }).join('');
    return '<aside class="panel" id="method"><h2>Method &amp; validation</h2>' +
      '<div class="formula">implied = exp(a) x TVL<sup>b</sup> x category offset x growth x maturity<br>' +
      'a = <b>' + DATA.ols.intercept.toFixed(4) + '</b> · b = <b>' + DATA.ols.slope.toFixed(4) + '</b> · fit on <b>' + DATA.comps_size + '</b> live-token comps<br>' +
      'category offset x<b>0.71-1.42</b> (log-shrunk, k=8, clamp +/-0.35)<br>' +
      'growth x(1 + clamp(7d%, -60..120)/100 x <b>0.25</b>)<br>' +
      'maturity x<b>0.85-1.00</b> by years without a token</div>' +
      '<h3>Leave-one-out on the live comps</h3>' +
      '<table><thead><tr><th></th><th>Candidate model</th><th class="n">mean |log10 err|</th><th class="n">median fold</th></tr></thead><tbody>' + val + '</tbody></table>' +
      '<p class="note">Each candidate was fitted on 127 comps and used to predict the held-out one\'s real market cap, for all ' + DATA.comps_size + ' comps. <b>radar-2 is the lowest-error model measured</b> - the flat 0.25 multiple and every category-median model score worse, so their weights were tuned down or dropped, not kept on faith.</p>' +
      '<h3>Category multiples (context)</h3>' +
      '<table><thead><tr><th>Category</th><th class="n">comps</th><th class="n">median x</th><th class="n">shrunk x</th></tr></thead><tbody>' + cats + '</tbody></table>' +
      '<p class="note">Full table below. Categories are thin - the board\'s biggest, Risk Curators, has 1 live comp - which is why a category only moves a value through the shrunk, clamped offset, never as a raw multiple.</p>' +
      '<h3>Board rule</h3>' +
      '<p class="note">All <b>' + DATA.watchlist_size + ' watchlist</b> protocols, plus every rankable pre-token protocol below the $50M watchlist floor down to $10M TVL: <b>' + DATA.board_size + ' rows</b>. Above the floor, only the watchlist is ranked - the rest there are wrapped, staked or bridged products of tokens that already trade, or exchanges.</p>' +
      '</aside>';
  }

  function renderBoard() {
    var rows = applyFilters();
    var top = DATA.rows.length ? DATA.rows[0].implied_value_usd : 1;
    var body = rows.map(function (row) {
      var pct = Math.max(2, Math.round((row.implied_value_usd / top) * 100));
      return '<tr class="clickable" data-slug="' + esc(row.slug) + '">' +
        '<td class="n">' + row.rank + '</td>' +
        '<td class="proto"><b>' + esc(row.name) + '</b>' +
        (row.watchlist ? ' <span class="tag">watchlist</span>' : '') + '</td>' +
        '<td>' + esc(row.category || 'n/a') + '</td>' +
        '<td class="proto">' + esc((row.chains[0] || 'n/a') + (row.chains.length > 1 ? ' +' + (row.chains.length - 1) : '')) + '</td>' +
        '<td class="n">' + fmtUsd(row.tvl_usd) + '</td>' +
        '<td class="n ' + (row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(row.change_7d) + '</td>' +
        '<td class="n"><b>' + fmtUsd(row.implied_value_usd) + '</b> <span class="bar"><i style="width:' + pct + '%"></i></span></td>' +
        '<td class="n">' + fmtMult(row.eff_multiple) + '</td>' +
        '<td class="n">' + fmtUsd(row.range_lo) + '–' + fmtUsd(row.range_hi) + '</td></tr>';
    }).join('');
    if (!rows.length) body = '<tr><td colspan="9">No protocol matches these filters. Clear the search or pick another category or chain.</td></tr>';
    return '<section class="panel"><h2>The board — pre-token, ranked by implied value</h2>' +
      '<div class="boardwrap"><table class="boardtable"><thead><tr>' +
      '<th class="n">#</th><th>Protocol</th><th>Category</th><th>Chains</th><th class="n">TVL</th><th class="n">7d</th>' +
      '<th class="n">Implied value</th><th class="n">x TVL</th><th class="n">Range</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="note">Click any row for its model breakdown and farm plan. Range is the model\'s own p25-p75 error band on its live comps.</p></section>';
  }

  function renderLive() {
    var body = DATA.live.map(function (p) {
      var mult = p.mcap_usd && p.tvl_usd ? p.mcap_usd / p.tvl_usd : null;
      return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.category || 'n/a') + '</td>' +
        '<td class="n">' + fmtUsd(p.tvl_usd) + '</td><td class="n">' + fmtUsd(p.mcap_usd) + '</td>' +
        '<td class="n">' + (mult === null ? 'n/a' : mult.toFixed(3) + 'x') + '</td>' +
        '<td class="n ' + (p.change_7d === null ? '' : p.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(p.change_7d) + '</td></tr>';
    }).join('');
    return '<section class="panel wide"><h2>Calibration set — live tokens, never ranked</h2>' +
      '<p class="note" style="margin:0 0 8px">These protocols already trade. The board never ranks them; radar-2 is fitted on their real market caps (the top ' + DATA.live_size + ' of ' + DATA.comps_size + ' comps shown), and the leave-one-out table above is scored on them.</p>' +
      '<div class="boardwrap"><table><thead><tr><th>Protocol</th><th>Category</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Actual x TVL</th><th class="n">7d</th></tr></thead><tbody>' + body + '</tbody></table></div></section>';
  }

  function renderCategories() {
    var body = DATA.categories.map(function (c) {
      return '<tr><td>' + esc(c.category) + '</td><td class="n">' + c.n + '</td><td class="n">' + c.median.toFixed(4) +
        '</td><td class="n">' + c.shrunk.toFixed(4) + '</td><td class="n">' + c.p25.toFixed(4) + '</td><td class="n">' + c.p75.toFixed(4) + '</td></tr>';
    }).join('');
    return '<section class="panel wide"><h2>Category multiples — every category with a live comp</h2>' +
      '<div class="boardwrap"><table><thead><tr><th>Category</th><th class="n">Live comps</th><th class="n">Median mcap/TVL</th><th class="n">Shrunk (k=4)</th><th class="n">p25</th><th class="n">p75</th></tr></thead><tbody>' + body + '</tbody></table></div></section>';
  }

  function renderDetail(row) {
    var panel = document.getElementById('detail');
    if (!row) { panel.hidden = true; panel.innerHTML = ''; return; }
    var cat = calibratedMultiple(row.category);
    var steps = farmPlanFor(row).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var eq = impliedValueBreakdown(row).map(function (pair, i, all) {
      return '<div class="' + (i === all.length - 1 ? 'total' : '') + '"><span>' + esc(pair[0]) + '</span><span>' + esc(pair[1]) + '</span></div>';
    }).join('');
    panel.innerHTML =
      '<div class="detail-head"><div><div class="kicker" style="font-family:var(--num);font-size:11px;letter-spacing:.12em;color:var(--amberink)">' +
      esc(row.category || 'Uncategorised') + ' · rank #' + row.rank + (row.watchlist ? ' · <span class="tag">watchlist</span>' : '') + '</div>' +
      '<h2>' + esc(row.name) + '</h2><div class="sub">' + esc(row.slug) + ' · ' + esc(row.chains.join(', ') || 'no chain listed') + '</div></div>' +
      '<button class="close" id="d-close" aria-label="Close detail">Close</button></div>' +
      '<div class="kv">' +
      '<div><span>TVL</span><b class="num">' + fmtFullUsd(row.tvl_usd) + '</b></div>' +
      '<div><span>7d change</span><b class="num">' + fmtPct(row.change_7d) + '</b></div>' +
      '<div><span>Listed on DefiLlama</span><b class="num">' + esc(row.listed_at || 'unreported') + '</b></div>' +
      '<div><span>Without a token</span><b class="num">' + (row.age_days === null ? 'unreported' : row.age_days + ' days') + '</b></div>' +
      '<div><span>Implied value</span><b class="num">' + fmtFullUsd(row.implied_value_usd) + '</b></div>' +
      '<div><span>Range (p25-p75)</span><b class="num">' + fmtUsd(row.range_lo) + ' – ' + fmtUsd(row.range_hi) + '</b></div></div>' +
      '<h3 style="margin-top:16px">How radar-2 prices it</h3><div class="eq">' + eq + '</div>' +
      '<p class="note">Category context: ' + esc(row.category || 'this category') + ' has ' + row.cat_n + ' live comp' + (row.cat_n === 1 ? '' : 's') +
      (cat ? ', median multiple ' + cat.median.toFixed(3) + 'x, shrunk ' + cat.shrunk.toFixed(3) + 'x' : '') +
      '. The category moves the value only through the shrunk, clamped offset above - on purpose: raw category multiples measured worse in leave-one-out.</p>' +
      '<h3 style="margin-top:16px">Farm plan</h3><ol class="steps">' + steps + '</ol>' +
      '<div class="honest">' + esc(row.name) + ' records no token in this snapshot. The implied value is this model\'s claim from the snapshot\'s own figures - it is not a prediction that a launch will happen, or when.</div>';
    panel.hidden = false;
    document.getElementById('d-close').addEventListener('click', function () { renderDetail(null); });
  }

  function openDetail(slug) {
    for (var i = 0; i < DATA.rows.length; i++) {
      if (DATA.rows[i].slug === slug) { renderDetail(DATA.rows[i]); return; }
    }
    renderDetail(null);
  }

  // ---------- build the page ----------
  app.removeAttribute('aria-busy');
  app.innerHTML = '<div class="shell">' + renderHeader() + renderStats() + renderControls() +
    '<div class="grid">' + renderMethod() + '<div id="board-slot">' + renderBoard() + '</div></div>' +
    renderLive() + renderCategories() +
    '<footer>Implied values are this model\'s claims from one sealed DefiLlama snapshot (' + esc(DATA.as_of) + '). Not financial advice.</footer></div>' +
    '<div class="detail" id="detail" hidden></div>';

  function refreshBoard() {
    document.getElementById('board-slot').innerHTML = renderBoard();
    var rows = applyFilters();
    document.getElementById('result-count').innerHTML = 'Showing <b>' + rows.length + '</b> of ' + DATA.board_size + ' ranked protocols';
    var trs = document.querySelectorAll('#board-slot tr.clickable');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () { openDetail(this.getAttribute('data-slug')); });
    }
  }
  document.getElementById('f-q').addEventListener('input', function () { state.q = this.value; refreshBoard(); });
  document.getElementById('f-cat').addEventListener('change', function () { state.category = this.value; refreshBoard(); });
  document.getElementById('f-chain').addEventListener('change', function () { state.chain = this.value; refreshBoard(); });
  document.getElementById('f-sort').addEventListener('change', function () { state.sort = this.value; refreshBoard(); });
  document.getElementById('f-watch').addEventListener('change', function () { state.watchlistOnly = this.checked; refreshBoard(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') renderDetail(null); });
  refreshBoard();
  if (state.detail) openDetail(state.detail);
})();
