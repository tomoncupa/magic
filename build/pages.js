/* ============ Brewing Station PAGES (build/pages.js) ============
   Contract 3 of the build spec: the Analysis, Synergy, EDHREC, Upgrades and Compare
   pages. Each one registers itself in window.PAGES with render(el); SHELL clears `el`
   and calls render whenever the page shows, and again after every applyChange.

   Reads the open deck through ENGINE (engine.js) and the page's own globals (S, CUR,
   shelf, ...). Changes to the deck only ever go through SHELL's applyChange, each with
   a toast that offers Undo. Every card anywhere opens SHELL's card sheet.
   ES5 style like the rest of the build. Classes are brew.css (bs-) plus pages.css (pg-).
   Loads after the inline script and engine.js; nothing here runs until SHELL renders. */
(function(){
'use strict';

var PG = window.PAGES = window.PAGES || {};

/* ---------- small helpers ---------- */
function h(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]; }); }
function lc(s){ return String(s == null ? '' : s).toLowerCase(); }
function front(n){ return lc(n).split(' // ')[0]; }
function ico(id, cls){ return '<svg class="bs-ico' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="#i-' + id + '"/></svg>'; }
function pct(x){ return Math.round((x || 0) * 100) + '%'; }
function signed(x){ var v = Math.round((x || 0) * 100); return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%'; }
function dec(x){ var v = Math.round((+x || 0) * 10) / 10; return v % 1 ? v.toFixed(1) : String(v); }
function one(x){ return (Math.round((+x || 0) * 10) / 10).toFixed(1); }
function commas(n){ return Number(n || 0).toLocaleString('en-US'); }
function words(n, a, b){ return n + ' ' + (n === 1 ? a : (b || a + 's')); }
function sumQ(rows){ var s = 0; rows.forEach(function(r){ s += r.q || 1; }); return s; }
function E(){ return window.ENGINE || null; }
function live(el){ return !!el && document.documentElement.contains(el); }
function safe(f, dflt){ try{ var v = f(); return v == null ? dflt : v; }catch(e){ if(window.console) console.warn('Brewing Station pages:', e); return dflt; } }
function bk(){ var b = +S.bracket; return b >= 1 && b <= 5 ? b : 3; }
function BR(b){ return (typeof BRACKETS !== 'undefined' && BRACKETS[b]) || { name:'Bracket ' + b, gc:Infinity, desc:'', turn:8, page:'' }; }
function short(){ return S.cmd ? S.cmd.n.split(',')[0].split(' // ')[0] : 'this commander'; }
function roleName(r){ return (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[r]) || (r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Synergy'); }
function curId(){ return typeof CUR !== 'undefined' ? CUR : ''; }
function isLandC(c){ try{ return !!c && !!c.type && typeof isLand === 'function' && isLand(c); }catch(e){ return false; } }
function isBasicC(c){ try{ return !!c && !!c.type && typeof isBasic === 'function' && isBasic(c); }catch(e){ return false; } }
function isBasicName(n){ return /^(?:snow-covered )?(?:plains|island|swamp|mountain|forest)$|^wastes$/i.test(n || ''); }
function rolesC(c){ try{ return (c && (c.roles || (c.type != null && typeof rolesOf === 'function' ? rolesOf(c) : null))) || {}; }catch(e){ return {}; } }
function gcC(c){ try{ return !!c && (typeof isGC === 'function' ? isGC(c) : !!c.gc); }catch(e){ return !!(c && c.gc); } }
function pipsOf(ci){ return typeof pipHtml === 'function' ? pipHtml(ci || []) : ''; }
function titleOf(row){ return typeof deckTitle === 'function' ? deckTitle(row) : (row.name || row.cmd || 'Deck'); }
function agoOf(t){ return t && typeof ago === 'function' ? ago(t) : ''; }
// Commander Spellbook's shorthand in plain words ("Infinite creature ETB" -> "creatures entering, over and over").
function plain(s){
  return String(s == null ? '' : s)
    .replace(/\bcreature ETB\b/gi, 'creatures entering')
    .replace(/\bcreature LTB\b/gi, 'creatures leaving')
    .replace(/\bETB\b/g, 'enter')
    .replace(/\bLTB\b/g, 'leave')
    .replace(/\bstorm count\b/gi, 'spells cast (storm)')
    .replace(/\bcolorless\b/gi, 'colourless')
    .replace(/\s*—\s*/g, ': ');
}

/* ---------- money (ENGINE keeps the peso rate) ---------- */
function php(usd){ var e = E(); if(usd == null || usd === '' || isNaN(usd) || !e || !e.php) return ''; return e.php(usd); }
var RATEP = null;
function rateThen(ctx){
  var e = E();
  if(!e || !e.rate || !e.php || e.php(1) || RATEP) return;
  RATEP = e.rate().then(function(r){ RATEP = null; if(r) again(ctx); }, function(){ RATEP = null; });
}

/* ---------- cards: the pool first, then anything a page has already seen ---------- */
var SEEN = {};
function remember(c){
  if(c && c.n){
    var k = lc(c.n), f = front(c.n); if(!SEEN[k]) SEEN[k] = c; if(!SEEN[f]) SEEN[f] = c;
    // SHELL turns every name it knows into a card link, in sentences too.
    if(typeof noteCardNames === 'function') noteCardNames([c.n]);
  }
  return c;
}
// A card's name as SHELL's card link (it opens the card sheet); a plain name button as a fallback.
function link(n, label, o){
  if(typeof cardLink === 'function') return cardLink(n, label, o);
  return '<button class="pg-linkname" type="button" data-pg-card="' + h(n) + '">' + h(label == null ? n : label) + '</button>';
}
var PMAP = { p:null, len:-1, m:{} };
function pmap(){
  var p = (typeof S !== 'undefined' && S && S.pool) || [];
  if(PMAP.p === p && PMAP.len === p.length) return PMAP.m;
  var m = {};
  p.forEach(function(c){ var k = lc(c.n), f = front(c.n); if(!m[k]) m[k] = c; if(!m[f]) m[f] = c; });
  PMAP = { p:p, len:p.length, m:m };
  return m;
}
function cardFor(n){
  if(!n) return null;
  var m = pmap(), k = lc(n), f = front(n), c = m[k] || m[f] || SEEN[k] || SEEN[f];
  if(c) return c;
  var cm = [S.cmd, S.partner].filter(Boolean);
  for(var i = 0; i < cm.length; i++) if(lc(cm[i].n) === k || front(cm[i].n) === f) return cm[i];
  return null;
}
function art(c){ var i = (c && c.img) || ''; return i ? i.replace('/normal/', '/art_crop/') : ''; }

/* ---------- the deck as it is right now ---------- */
function deckSet(){
  var s = {};
  function add(n){ s[lc(n)] = 1; s[front(n)] = 1; }
  if(S.cmd) add(S.cmd.n);
  if(S.partner) add(S.partner.n);
  (S.deck || []).forEach(function(d){ add(d.n); });
  return s;
}
function isIn(set, n){ return !!(set[lc(n)] || set[front(n)]); }
function deckCount(){ return (S.deck || []).length + (S.cmd ? 1 : 0) + (S.partner ? 1 : 0); }
function full(){ return deckCount() >= 100; }

/* ---------- SHELL's toast, card sheet and change, each with a fallback ---------- */
var TEL = null, TT = 0;
function say(html, o){
  o = o || {};
  if(typeof toast === 'function'){ try{ toast(html, o); return; }catch(e){} }
  // Fallback: brew.css's toast, one at a time (SHELL normally provides this).
  if(!TEL){
    TEL = document.createElement('div'); TEL.setAttribute('role', 'status'); TEL.setAttribute('aria-live', 'polite');
    document.body.appendChild(TEL);
    TEL.addEventListener('mouseenter', function(){ clearTimeout(TT); });
    TEL.addEventListener('mouseleave', function(){ TT = setTimeout(function(){ TEL.classList.remove('on'); }, 2000); });
  }
  TEL.className = 'bs-toast' + (o.kind ? ' bs-' + o.kind : '');
  TEL.innerHTML = '<div class="bs-toast-msg">' + html + '</div>';
  if(o.undo){
    var b = document.createElement('button'); b.type = 'button'; b.className = 'bs-toast-act'; b.textContent = 'Undo';
    b.onclick = function(){ clearTimeout(TT); TEL.classList.remove('on'); o.undo(); };
    TEL.appendChild(b);
  }
  void TEL.offsetHeight;
  TEL.classList.add('on');
  clearTimeout(TT);
  TT = setTimeout(function(){ TEL.classList.remove('on'); }, o.ms || (o.undo ? 6000 : 2600));
}
function openCard(n){
  var c = cardFor(n);
  if(typeof openCardSheet === 'function'){
    try{ openCardSheet(n, c ? { card:c } : {}); return; }catch(e){ if(window.console) console.error(e); }
  }
  if(typeof zoomCard === 'function' && c && c.img) zoomCard(c.img);
  else say('The card sheet is not ready. Reload the page.');
}
function swapFlow(n){
  if(typeof openSwap === 'function'){ try{ openSwap(n); return; }catch(e){ if(window.console) console.error(e); } }
  openCard(n);
}
function snapshot(){
  return { deck:JSON.parse(JSON.stringify(S.deck || [])), boards:S.boards ? JSON.parse(JSON.stringify(S.boards)) : S.boards, side:S.side,
    und:typeof SWUNDO !== 'undefined' && SWUNDO ? SWUNDO.length : -1 };
}
function keepScroll(y){
  if(Math.abs((window.pageYOffset || 0) - y) > 2) window.scrollTo(0, y);
  setTimeout(function(){ if(Math.abs((window.pageYOffset || 0) - y) > 2) window.scrollTo(0, y); }, 40);
}
// The one way these pages change the deck. outName null = add, inCard null = cut.
function change(outName, inCard, why, done){
  if(typeof applyChange !== 'function'){ say('Changing the deck from this page needs the updated Brewing Station. Reload the page.', { kind:'bad' }); return false; }
  var y = window.pageYOffset || 0, before = snapshot(), rc = RC, r;
  try{ r = applyChange(outName || null, inCard || null, why || ''); }catch(e){ r = (e && e.message) || 'That change did not go through.'; }
  if(typeof r === 'string' || r === false){ say(h(typeof r === 'string' ? r : 'That change did not go through.'), { kind:'bad' }); return false; }
  if(RC === rc) redraw();          // SHELL normally redraws the page itself
  keepScroll(y);
  // SHELL's own words for what went where ("Swapped X out for Y. X is now in your side deck.").
  if(typeof changeToast === 'function'){ try{ var t = changeToast(); if(t) done = t; }catch(e){} }
  // The Undo is bound to this change's own entry, so it never reverses a later one.
  before.entry = typeof SWUNDO !== 'undefined' && SWUNDO && SWUNDO.length ? SWUNDO[SWUNDO.length - 1] : null;
  say(done, { undo:function(){ undoTo(before); } });
  return true;
}
function undoTo(b){
  var y = window.pageYOffset || 0;
  if(typeof undoChange === 'function'){ try{ if(undoChange(b.entry || undefined) !== false){ keepScroll(y); say('Put back.'); } return; }catch(e){} }
  S.deck = b.deck; if(b.boards !== undefined) S.boards = b.boards; S.side = b.side;
  if(b.und >= 0 && typeof SWUNDO !== 'undefined' && SWUNDO && SWUNDO.length > b.und) SWUNDO.length = b.und;
  if(S.sum) S.sum.stale = true;
  if(typeof save === 'function') save();
  if(CURP && live(CURP.el)) redraw();
  else if(typeof render === 'function') render();
  keepScroll(y);
  say('Put back.');
}
// A choice about this deck that is not a change to its cards (hidden suggestions, the summary).
function quietSave(){ if(typeof save === 'function') save({ quiet:true }); }

/* ---------- icons: SHELL ships the sprite; this is the same set, added only if missing ---------- */
var SPRITE = '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">' +
  '<symbol id="i-back" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></symbol>' +
  '<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></symbol>' +
  '<symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>' +
  '<symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/></symbol>' +
  '<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6"/></symbol>' +
  '<symbol id="i-swap" viewBox="0 0 24 24"><path d="M4 8h15l-4-4M20 16H5l4 4"/></symbol>' +
  '<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>' +
  '<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></symbol>' +
  '<symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5"/></symbol>' +
  '<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></symbol>' +
  '<symbol id="i-help" viewBox="0 0 24 24"><path d="M9.2 9.2a2.8 2.8 0 1 1 3.9 2.6c-.7.3-1.1.9-1.1 1.6v.6M12 17.2v.01"/></symbol>' +
  '<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/></symbol>' +
  '<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></symbol>' +
  '<symbol id="i-deck" viewBox="0 0 24 24"><rect x="3" y="6" width="12" height="16" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v14"/></symbol>' +
  '<symbol id="i-pencil" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></symbol>' +
  '<symbol id="i-trash" viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></symbol>' +
  '<symbol id="i-cut" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>' +
  '<symbol id="i-side" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/></symbol>' +
  '</svg>';
function sprite(){
  if(document.getElementById('i-swap')) return;
  var d = document.createElement('div'); d.innerHTML = SPRITE;
  document.body.insertBefore(d.firstChild, document.body.firstChild);
}

/* ---------- per-deck page state (tabs, filters, what is open), kept in memory ---------- */
var ST = { deck:null };
function state(){
  var id = curId();
  if(ST.deck !== id) ST = { deck:id, open:{}, more:{},
    edh:{ theme:'', bracket:0, budget:'', hide:false, allThemes:false, last:'', themes:null },
    ideas:{ tab:'up', up:0, down:0 } };
  return ST;
}

/* ---------- running a page ---------- */
var CURP = null, RC = 0;
function redraw(){ if(CURP && live(CURP.el)) run(CURP.el, CURP.id, CURP.draw, CURP.top); }
// Redraw after something async arrived, only if that page is still the one showing
// (SHELL may have drawn it again into a new element meanwhile; the data is cached).
function again(ctx, want){
  if(!CURP || CURP.id !== ctx.id || !live(CURP.el)) return;
  var y = want != null ? want : window.pageYOffset || 0;
  redraw(); keepScroll(y);
}
function reduced(){ return !!(window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches); }
function jumpTo(id){ var t = document.getElementById(id); if(t) t.scrollIntoView({ behavior:reduced() ? 'auto' : 'smooth', block:'start' }); }
function onToggle(e){
  var d = e.target, k = d && d.getAttribute && d.getAttribute('data-pg-open'); if(!k) return;
  state().open[k] = d.open;
  // A guideline row works out its swaps only when opened, so opening it draws the page again once.
  if(d.open && d.hasAttribute('data-pg-fix') && !d.querySelector('.pg-gfix, .pg-gfix-none')){ var y = window.pageYOffset || 0; redraw(); keepScroll(y); }
}
function run(el, id, draw, top){
  if(!el) return;
  RC++;
  sprite();
  CURP = { id:id, el:el, draw:draw, top:!!top };
  var ctx = { el:el, id:id, acts:[] };
  ctx.act = function(f){ ctx.acts.push(f); return ' data-pg-do="' + (ctx.acts.length - 1) + '"'; };
  el.onclick = function(e){
    var t = e.target; if(!t || !t.closest) return;
    var a = t.closest('[data-pg-do]');
    if(a && el.contains(a)){
      if(a.disabled || a.getAttribute('aria-disabled') === 'true') return;
      var f = ctx.acts[+a.getAttribute('data-pg-do')];
      if(f){ e.preventDefault(); f(a, e); }
      return;
    }
    var c = t.closest('[data-pg-card]');
    if(c && el.contains(c)){ e.preventDefault(); openCard(c.getAttribute('data-pg-card')); }
  };
  if(!el._pgToggle){ el._pgToggle = 1; el.addEventListener('toggle', onToggle, true); }
  if(!top){
    if(!E()){ el.innerHTML = wrap(empty('warn', 'The analysis did not load', 'Reload the page. If it keeps happening, engine.js is missing from the build folder.')); return; }
    if(typeof S === 'undefined' || !S || !S.cmd){
      el.innerHTML = wrap(empty('deck', 'No deck is open', 'Open a deck from your decks first, then come back to this page.', '<a class="bs-btn bs-primary" href="#decks">Go to your decks</a>'));
      return;
    }
    if(!S.pool && typeof ensurePool === 'function' && el._pgPool !== curId()){
      el._pgPool = curId();
      el.innerHTML = wrap(loadingBlock('Loading card data for ' + short()));
      ensurePool().then(function(){ if(CURP && CURP.el === el && live(el)) run(el, id, draw, top); },
        function(err){
          if(!live(el)) return;
          el.innerHTML = wrap(empty('warn', 'Card data did not load', h((err && err.message) || 'Check the connection and try again.'),
            '<button class="bs-btn bs-primary" type="button"' + ctx.act(function(){ el._pgPool = ''; run(el, id, draw, top); }) + '>Try again</button>'));
        });
      return;
    }
  }
  try{ draw(ctx, state()); }
  catch(err){
    if(window.console) console.error(err);
    el.innerHTML = wrap(empty('warn', 'This page hit a problem', h((err && err.message) || 'Unknown error') + '. Reload the page to try again.'));
  }
}

/* ---------- shared pieces of markup ---------- */
function wrap(x){ return '<div class="pg-root">' + x + '</div>'; }
function head(title, sub, right){
  return '<div class="bs-pagehead"><div><h1 class="bs-title">' + title + '</h1>' + (sub ? '<p class="bs-sub">' + sub + '</p>' : '') + '</div>' + (right || '') + '</div>';
}
function empty(icon, title, text, acts){
  return '<div class="bs-empty">' + ico(icon) + '<h3 class="bs-empty-title">' + title + '</h3>' + (text ? '<p>' + text + '</p>' : '') + (acts ? '<div class="bs-acts">' + acts + '</div>' : '') + '</div>';
}
function callout(kind, html, icon){
  return '<div class="bs-callout' + (kind && kind !== 'info' ? ' bs-' + kind : '') + '">' + ico(icon || (kind === 'warn' || kind === 'bad' ? 'warn' : kind === 'good' ? 'check' : 'info')) + '<p>' + html + '</p></div>';
}
function loadingBlock(text){ return '<div class="bs-loading bs-center"><span class="bs-spin bs-lg"></span>' + h(text) + '</div>'; }
function loadingLine(text){ return '<div class="bs-loading"><span class="bs-spin"></span>' + h(text) + '</div>'; }
function meter(v, label, cls){
  v = Math.max(0, Math.min(10, +v || 0));
  return '<span class="bs-meter' + (cls ? ' ' + cls : '') + '" style="--v:' + v + '" role="meter" aria-valuemin="0" aria-valuemax="10" aria-valuenow="' + v + '" aria-label="' + h(label) + ' ' + one(v) + ' out of 10"></span>';
}
function sectionHead(title, count, right, id){
  return '<div class="bs-section-head"><h2 class="bs-h2"' + (id ? ' id="' + id + '"' : '') + '>' + title + (count != null ? ' <span class="bs-count">' + count + '</span>' : '') + '</h2>' + (right ? '<div class="bs-acts">' + right + '</div>' : '') + '</div>';
}
function skelTiles(n, min){
  var t = '';
  for(var i = 0; i < n; i++) t += '<div class="bs-ctile" aria-hidden="true"><div class="bs-ctile-pic"><span class="bs-skel bs-skel-card"></span></div><span class="bs-skel bs-skel-line" style="--w:80%"></span><span class="bs-skel bs-skel-line" style="--w:55%"></span></div>';
  return '<div class="bs-cgrid" style="--card-min:' + (min || 150) + 'px" aria-busy="true">' + t + '</div>';
}
function skelRows(n){
  var t = '';
  for(var i = 0; i < n; i++) t += '<span class="bs-skel bs-skel-line" style="--w:' + (90 - (i % 3) * 15) + '%"></span>';
  return '<div aria-busy="true">' + t + '</div>';
}
function details(key, label, body, dflt){
  var st = state(), open = st.open[key] != null ? st.open[key] : !!dflt;
  return '<details class="bs-more" data-pg-open="' + h(key) + '"' + (open ? ' open' : '') + '><summary>' + label + '</summary><div class="bs-more-body">' + body + '</div></details>';
}
// "Show all N": remembered per deck, so a redraw after a change keeps the list open.
function moreKey(k){ return String(k).replace(/[^a-z0-9_-]+/gi, '-'); }
function isAll(k){ return !!state().more[moreKey(k)]; }
function showAll(ctx, k, total, shown, label){
  if(total <= shown || isAll(k)) return '';
  var key = moreKey(k);
  return '<button class="bs-btn bs-quiet pg-showall" type="button"' + ctx.act(function(b){
    state().more[key] = 1;
    var box = ctx.el.querySelector('[data-more="' + key + '"]'); if(box) box.classList.add('pg-all');
    b.remove();
  }) + '>' + (label || 'Show all ' + total) + '</button>';
}
// Card names as small tappable pills. items: names or {n, t (label), why}.
function nameList(ctx, items, max, k){
  if(!items || !items.length) return '';
  var all = isAll(k), key = moreKey(k), out = '';
  items.forEach(function(x, i){
    var n = typeof x === 'string' ? x : x.n, t = typeof x === 'string' ? x : (x.t || x.n), why = typeof x === 'string' ? '' : x.why;
    out += '<button class="pg-name' + (!all && i >= max ? ' pg-x' : '') + '" type="button" data-pg-card="' + h(n) + '"' + (why ? ' title="' + h(plain(why)) + '"' : '') + '>' + h(t) + '</button>';
  });
  if(!all && items.length > max) out += '<button class="pg-name pg-more" type="button"' + ctx.act(function(b){
    state().more[key] = 1; b.parentNode.classList.add('pg-all'); b.remove();
  }) + '>+' + (items.length - max) + ' more</button>';
  return '<div class="pg-names' + (all ? ' pg-all' : '') + '" data-more="' + key + '">' + out + '</div>';
}
// A card picture tile. o: { n, inDeck, badge, stats, why, acts, mini, hidden }
function tile(c, o){
  o = o || {};
  var n = (c && c.n) || o.n; remember(c);
  var img = c && (o.mini ? (c.sm || c.img) : (c.img || c.sm));
  return '<div class="bs-ctile' + (o.inDeck ? ' bs-in' : '') + (o.hidden ? ' pg-x' : '') + '">' +
    // One tab stop per card: the name below. The picture is the same card, for the mouse.
    '<button class="bs-ctile-pic" type="button"' + (typeof cardLink === 'function' ? ' tabindex="-1"' : '') + ' data-pg-card="' + h(n) + '" aria-label="' + h(n) + (o.inDeck ? ', in your deck' : '') + '">' +
      (img ? '<img src="' + h(img) + '" alt="" loading="lazy">' : '<span class="bs-ctile-noimg">' + h(n) + '</span>') +
      (o.badge ? '<span class="bs-ctile-bl">' + o.badge + '</span>' : '') +
    '</button>' +
    (typeof cardLink === 'function' ? cardLink(n, null, { cls:'bs-ctile-n', title:n }) : '<span class="bs-ctile-n" title="' + h(n) + '">' + h(n) + '</span>') +
    (o.stats ? '<span class="bs-ctile-s">' + o.stats + '</span>' : '') +
    (o.why ? '<span class="bs-ctile-why">' + h(plain(o.why)) + '</span>' : '') +
    (o.acts ? '<div class="bs-ctile-acts">' + o.acts + '</div>' : '') +
  '</div>';
}
function inDeckBadge(){ return '<span class="bs-badge bs-good">' + ico('check', 'bs-i16 pg-i12') + 'In deck</span>'; }
// Where he already keeps a card outside the 99: 'side', 'maybe' or ''.
function ownedIn(n){
  var B = (S && S.boards) || {};
  function inB(l){ return (l || []).some(function(x){ return lc(x.n) === lc(n) || front(x.n) === front(n); }); }
  return inB(B.side) ? 'side' : inB(B.maybe) ? 'maybe' : '';
}
function ownBadge(n){
  var w = ownedIn(n);
  return w ? '<span class="bs-badge bs-info">' + (w === 'side' ? 'In your side deck' : 'In Considering') + '</span>' : '';
}
// A preview card: Scryfall lists it, but it is not in shops or legal to play until its release date.
function outDate(c){
  var r = c && c.rel; if(!r || r <= new Date().toISOString().slice(0, 10)) return '';
  var d = new Date(r + 'T00:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
}
function soonBadge(c){ var d = outDate(c); return d ? '<span class="bs-badge bs-warn">Out ' + h(d) + '</span>' : ''; }
// EDHREC's numbers for a card. recent: the New Cards list, whose share is of recent decks only.
function edhStats(inc, syn, recent){
  var s = '';
  if(inc) s += '<span><b>' + pct(inc) + '</b> of ' + (recent ? 'recent ' : '') + 'decks</span>';
  if(syn != null && !isNaN(syn) && (inc || syn)) s += '<span class="' + (syn > 0.004 ? 'bs-pos' : syn < -0.004 ? 'bs-neg' : '') + '">' + signed(syn) + ' synergy</span>';
  return s;
}
// Add (deck not full) and Swap in (opens the card sheet, which picks what goes out).
function addButtons(ctx, c, why){
  if(!c) return '';
  var sw = '<button class="bs-btn bs-sm' + (full() ? ' bs-primary' : '') + '" type="button"' + ctx.act(function(){ openCard(c.n); }) + '>Swap in</button>';
  if(full()) return sw;
  return '<button class="bs-btn bs-sm bs-primary" type="button"' + ctx.act(function(){
    change(null, c, why || '', 'Added <b>' + h(c.n) + '</b> to the deck.');
  }) + '>' + ico('plus', 'bs-i16') + 'Add</button>' + sw;
}
// Columns a card grid of --card-min px fills in this page's width, for "two rows, then Show all".
function gridCols(ctx, min){
  var w = ctx.el.clientWidth || Math.min(1440, document.documentElement.clientWidth || 1200) - 48;
  if(w <= 420) return 2;
  return Math.max(2, Math.floor((w + 12) / (min + 12)));
}

/* ---------- async pieces, cached in memory so a redraw is instant ---------- */
var COMBOS = { key:'', v:null, p:null, pk:'', wait:{} };
function comboKey(){ return E().key() + '|' + bk(); }
// The deck's combos from ENGINE, or null while they load (then the page redraws once).
function combosNow(ctx){
  var key = comboKey();
  if(COMBOS.key === key && COMBOS.v) return COMBOS.v;
  if(!COMBOS.p || COMBOS.pk !== key){
    COMBOS.pk = key; COMBOS.wait = {};
    COMBOS.p = E().combos().then(function(v){ if(COMBOS.pk === key){ COMBOS.key = key; COMBOS.v = v || { inDeck:[], near:[] }; COMBOS.p = null; } return v; },
      function(){ COMBOS.p = null; return null; });
  }
  if(ctx && !COMBOS.wait[ctx.id]){
    COMBOS.wait[ctx.id] = 1;
    var w = COMBOS.wait;
    COMBOS.p.then(function(){ delete w[ctx.id]; again(ctx); });
  }
  return null;
}
// Keep this deck's summary fresh for the Decks tiles and Compare (never moves it on the shelf).
function storeSum(){
  var e = E(); if(!e || !e.summary || !S.cmd || !S.pool) return;
  var k = e.key();
  if(S.sum && S.sum.key === k && !S.sum.stale && S.sum.combos != null && S.sum.bracket === (S.bracket || null)) return;
  var s = safe(function(){ return e.summary(); }, null);
  if(!s) return;
  S.sum = s; quietSave();
}
// Opening hands and early land drops from test games (the Check step's simulation).
var SIMC = { key:'', v:null };
function testGames(cb){
  var key = E().key() + '|' + bk() + '|' + (cb ? cb.inDeck.length : '-');
  if(SIMC.key === key) return SIMC.v;
  var v = null;
  if(typeof simulate === 'function' && S.bracket && Array.isArray(S.wins)){
    v = safe(function(){
      var cards = typeof deckCards === 'function' ? deckCards() : (S.deck || []).map(function(d){ return cardFor(d.n); }).filter(Boolean);
      return simulate(cards, 2000, cb ? cb.inDeck : []);
    }, null);
  }
  SIMC = { key:key, v:v };
  return v;
}

/* ================================================================
   ANALYSIS
   ================================================================ */
var PILLARS = [
  ['consistency', 'Consistency', 'Finds the cards it needs: card draw, tutors, looking at the top of the deck, getting cards back.'],
  ['efficiency', 'Efficiency', 'Gets going quickly: cheap spells, ramp, enough lands of the right colours.'],
  ['interaction', 'Interaction', 'Deals with what opponents do: removal, board wipes, counterspells, protection.'],
  ['wincons', 'Win conditions', 'Has a way to end the game: finishers, combos, the commander, speed.']
];
var JOBS = ['lands', 'ramp', 'draw', 'tutor', 'removal', 'wipes', 'protection', 'wincon', 'synergy'];
var COLN = { W:'White', U:'Blue', B:'Black', R:'Red', G:'Green', C:'Colourless' };

function partOf(p, key){ return ((p && p.parts) || []).filter(function(x){ return x.key === key; })[0] || null; }
function haveWant(x){
  var hv = x.have, w = x.want;
  function n(v){ return typeof v === 'number' ? dec(v) : h(v == null ? 'n/a' : v); }
  switch(x.key){
    case 'avgMv': return '<b>' + (typeof hv === 'number' ? hv.toFixed(2) : n(hv)) + '</b> <small>aim ' + n(w) + ' or lower</small>';
    case 'winTurn': return hv == null ? '<small>not worked out</small>' : '<b>Turn ' + n(hv) + '</b> <small>aim ' + n(w) + ' or sooner</small>';
    case 'instantShare': return '<b>' + pct(hv) + '</b> <small>aim ' + pct(w) + '</small>';
    case 'lands': return '<b>' + n(hv) + '</b> <small>aim about ' + n(w) + '</small>';
    case 'colours': return '<b>' + n(hv) + ' of ' + n(w) + '</b> <small>colours covered</small>';
    case 'commander': return '<b>' + (hv ? 'Yes' : 'No') + '</b>';
  }
  if(!(x.weight > 0)) return '<b>' + n(hv) + '</b> <small>not scored</small>';
  return '<b>' + n(hv) + '</b> <small>' + (w ? 'of ' + n(w) + ' wanted' : 'none needed') + '</small>';
}
function partHtml(ctx, pillar, x){
  var scored = x.weight > 0;
  // The test games panel shows the land numbers from more games, so the note drops its copy.
  var note = x.key === 'lands' ? String(x.note || '').replace(/\s*In test games[^%]*%\.?\s*$/, '') : x.note;
  return '<div class="pg-part' + (scored ? '' : ' pg-off') + '">' +
    '<div class="pg-part-top"><span class="pg-part-k">' + h(x.label) + '</span><span class="pg-part-v">' + haveWant(x) + '</span></div>' +
    (scored ? meter(x.score, x.label, 'bs-sm') : '') +
    (note ? '<p class="pg-part-note">' + h(note) + '</p>' : '') +
    (x.cards && x.cards.length ? nameList(ctx, x.cards, 10, 'part-' + pillar + '-' + x.key) : '') +
  '</div>';
}
function pillarCard(ctx, def, p){
  var k = def[0], parts = (p && p.parts) || [];
  var counts = parts.length ? parts.map(function(x){ return partHtml(ctx, k, x); }).join('') : '<p class="pg-fine">Nothing to count yet.</p>';
  var raise = p && p.raise && p.raise.length ? '<ul class="pg-raise">' + p.raise.map(function(r){ return '<li>' + h(r) + '</li>'; }).join('') + '</ul>'
    : '<p class="pg-fine">Nothing obvious. This part of the deck is in good shape for bracket ' + bk() + '.</p>';
  return '<section class="bs-panel bs-pillar pg-pillar">' +
    '<div class="bs-pillar-top"><h3 class="bs-panel-title">' + def[1] + '</h3><div class="bs-score bs-sm"><b>' + one(p ? p.score : 0) + '</b><span>/10</span></div></div>' +
    meter(p ? p.score : 0, def[1]) +
    '<p class="pg-what">' + def[2] + '</p>' +
    '<p class="bs-verdict">' + h(p ? p.verdict : '') + '</p>' +
    '<div class="pg-folds">' + details('c-' + k, 'What counts', counts) + details('r-' + k, 'What would raise it', raise) + '</div>' +
  '</section>';
}
function hbarCls(v, t){
  if(t == null) return 'bs-notarget';
  if(t === 0) return v > 0 ? 'bs-over' : 'bs-met';
  if(v < t) return 'bs-short';
  if(v > t + Math.max(2, t * 0.5)) return 'bs-over';
  return 'bs-met';
}
function checkRow(label, desc, count, status, extra){
  return '<div class="pg-check"><div class="pg-check-top"><div class="pg-check-k"><b>' + label + '</b><span>' + desc + '</span></div>' +
    '<div class="pg-check-v"><span class="bs-num">' + count + '</span>' + (status ? '<span class="bs-badge ' + status[0] + '">' + status[1] + '</span>' : '') + '</div></div>' + (extra || '') + '</div>';
}

// Deckbuilding guidelines, each tagged with the video or guide it came from, checked against this deck.
// A guideline marked Fix or Watch offers swaps that move it the right way; each one is a single press.
var GUIDE_ST = { fix:['bs-bad', 'Fix'], watch:['bs-warn', 'Watch'], good:['bs-good', 'Good'], habit:['', 'Habit'] };
function guideDeltaHtml(list){
  return (list || []).map(function(d){
    return '<span class="' + (d.better ? 'bs-pos' : 'bs-neg') + '">' + h(d.label) + ' <b class="bs-num">' + d.from + ' &rarr; ' + d.to + '</b>' + (d.aim ? ' <small>(aim ' + h(d.aim) + ')</small>' : '') + '</span>';
  }).join(' &middot; ');
}
function guideFixHtml(ctx, t){
  var e = E(), res = safe(function(){ return e.guideFix(t.key); }, []);
  if(!res.length) return '<p class="pg-fine pg-gfix-none">' + h(res.note || 'No swap found for this one.') + '</p>';
  return '<p class="bs-label pg-alsohead">Swaps that fix it</p><div class="pg-gfix">' + res.map(function(p){
    var inn = p.inn;
    return '<div class="pg-gfix-row">' +
      '<div class="pg-gfix-pair">' + link(p.out) + ' <span class="pg-gfix-arr" aria-hidden="true">&rarr;</span> ' + (inn.basic ? h(inn.n) : link(inn.n)) + '</div>' +
      '<p class="pg-gfix-why">' + h(p.why) + (p.chg && p.chg.length ? '<br>' + guideDeltaHtml(p.chg) : '') + '</p>' +
      '<button class="bs-btn bs-sm bs-primary" type="button"' + ctx.act(function(){
        change(p.out, inn, 'Guideline: ' + t.title + '.', 'Swapped <b>' + h(p.out) + '</b> for <b>' + h(inn.n) + '</b>.');
      }) + ' aria-label="Swap ' + h(p.out) + ' out for ' + h(inn.n) + '">' + ico('swap', 'bs-i16') + 'Swap</button></div>';
  }).join('') + '</div>';
}
var STAPLES_ASKED = false;
function guidesHtml(ctx, st){
  var e = E();
  // Staples load once (staples.json, then Scryfall through the card cache); the page draws again when they land.
  if(e && e.loadStaples && !STAPLES_ASKED){ STAPLES_ASKED = true; e.loadStaples().then(function(){ if(e.staplesReady() && CURP && live(CURP.el)) redraw(); }); }
  var list = e && e.guides ? safe(function(){ return e.guides(); }, []) : [];
  if(!list.length) return '';
  var srcs = e.sources ? e.sources() : {};
  var checked = list.filter(function(t){ return t.status !== 'habit'; }), habits = list.filter(function(t){ return t.status === 'habit'; });
  var order = { fix:0, watch:1, good:2 };
  checked.sort(function(a, z){ return order[a.status] - order[z.status] || a.n - z.n; });
  var nf = checked.filter(function(t){ return t.status === 'fix'; }).length, nw = checked.filter(function(t){ return t.status === 'watch'; }).length;
  function row(t){
    var s = GUIDE_ST[t.status] || GUIDE_ST.habit, k = 'trap-' + t.key, open = !!st.open[k];
    var srcL = [].concat(t.src || []).map(function(id){ return srcs[id]; }).filter(Boolean);
    var mark = (t.status === 'fix' || t.status === 'watch' || t.off) ? '<button class="bs-btn bs-sm bs-quiet" type="button"' + ctx.act(function(){
        S.trapOff = S.trapOff || {};
        if(t.off) delete S.trapOff[t.key]; else S.trapOff[t.key] = 1;
        quietSave(); redraw();
      }) + '>' + (t.off ? 'Check it again' : 'Fine for this deck') + '</button>' : '';
    // The swaps are worked out only while the row is open: they read the whole pool.
    var body = '<p class="pg-part-note">' + h(t.line) + '</p>' + (t.fix ? '<p class="pg-trap-fix"><b>Fix:</b> ' + h(t.fix) + '</p>' : '') +
      (t.cards.length ? nameList(ctx, t.cards, 12, k) : '') + (open && t.canFix ? guideFixHtml(ctx, t) : '') +
      '<div class="pg-trap-acts">' + mark + srcL.map(function(x){ return '<a class="pg-gsrc" href="' + h(x.url) + '" target="_blank" rel="noopener">' + h(x.t) + '</a>'; }).join('') + '</div>';
    return '<details class="pg-trap" data-pg-open="' + k + '"' + (t.canFix ? ' data-pg-fix' : '') + (open ? ' open' : '') + '><summary>' +
      '<span class="pg-trap-n">' + t.n + '</span><span class="pg-trap-t">' + h(t.title) + '</span>' +
      '<span class="bs-badge ' + s[0] + '">' + (t.off ? 'You marked it fine' : s[1]) + '</span></summary>' + body + '</details>';
  }
  return '<section class="bs-panel pg-traps">' +
    '<div class="bs-panel-head"><h3 class="bs-panel-title">Deckbuilding guidelines</h3></div>' +
    '<p class="bs-panel-note pg-mb">' + (nf || nw ? (nf ? nf + ' to fix' : '') + (nf && nw ? ', ' : '') + (nw ? nw + ' to watch' : '') + '. ' : 'Every guideline is met. ') +
      'Open a row for the numbers, the cards and swaps that fix it. Each names its source.</p>' +
    checked.map(row).join('') +
    details('trap-habits', 'Habits a deck list cannot show (' + habits.length + ')', habits.map(row).join('')) +
  '</section>';
}

function drawAnalysis(ctx, st){
  var e = E(), el = ctx.el, b = bk(), br = BR(b);
  var cb = combosNow(ctx);
  var P = e.pillars();
  if(cb) storeSum();
  rateThen(ctx);
  var rows = safe(function(){ return e.cards(); }, []);
  var isL = function(r){ return r.role === 'lands' || isLandC(r.c); };
  var mainRows = rows.filter(function(r){ return !r.cmd; });
  var landRows = mainRows.filter(isL), spellRows = mainRows.filter(function(r){ return !isL(r); });
  var landN = sumQ(landRows), spellN = sumQ(spellRows);

  // ---- head and pillars
  var ready = P && P.ready !== false && P.consistency;
  var H = head('How strong is it?',
    'Scores out of 10 for bracket ' + b + ', ' + h(br.name) + '. These are Brewing Station\'s own estimates, worked out from the cards\' rules text, not an official rating.',
    ready ? '<div class="pg-overall"><span class="bs-label">Overall</span><div class="bs-score"><b>' + one(P.overall) + '</b><span>/10</span></div>' + meter(P.overall, 'Overall', 'bs-lg') + '<span class="pg-overall-n">Average of the four scores</span></div>' : '');
  if(!ready) H += callout('info', h((P && P.note) || 'Card data is not loaded yet, so these numbers are incomplete.'));
  else if(!cb) H += '<div class="pg-note-line">' + loadingLine('Checking Commander Spellbook for combos; the scores update when it answers') + '</div>';
  H += '<div class="pg-pillars">' + PILLARS.map(function(d){ return pillarCard(ctx, d, P && P[d[0]]); }).join('') + '</div>';

  // ---- mana curve
  var curve = [0, 0, 0, 0, 0, 0, 0, 0], mvs = 0;
  spellRows.forEach(function(r){ var m = +(r.c && r.c.mv) || 0; curve[Math.min(7, Math.floor(m))] += r.q; mvs += m * r.q; });
  var avg = spellN ? mvs / spellN : 0, cmax = Math.max.apply(null, curve) || 1;
  var curveHtml = '<section class="bs-panel">' +
    '<div class="bs-panel-head"><h3 class="bs-panel-title">Mana curve</h3></div>' +
    '<div class="pg-kv"><span><b class="bs-num">' + avg.toFixed(2) + '</b> average mana value</span><span><b class="bs-num">' + spellN + '</b> spells</span><span><b class="bs-num">' + landN + '</b> lands</span></div>' +
    '<div class="bs-curve" style="--max:' + cmax + '" role="img" aria-label="Mana curve: ' + curve.map(function(v, i){ return v + ' at ' + (i === 7 ? '7 or more' : i); }).join(', ') + '">' +
      curve.map(function(v, i){ return '<div class="bs-cbar" style="--v:' + v + '"><b>' + v + '</b><i></i><span>' + (i === 7 ? '7+' : i) + '</span></div>'; }).join('') +
    '</div>' +
    '<p class="bs-panel-note pg-mt">Each bar is how many spells cost that much mana. Lands and the commander are left out, of the average too.</p>' +
  '</section>';

  // ---- jobs against targets
  var cnt = {}, who = {}, also = {};
  var RK = { ramp:'ramp', draw:'draw', tutor:'tutor', removal:'removal', wipes:'wipe', protection:'protection', wincon:'wincon' };
  mainRows.forEach(function(r){
    var k = r.role && r.role !== 'commander' ? r.role : 'synergy';
    if(JOBS.indexOf(k) < 0) k = 'synergy';
    cnt[k] = (cnt[k] || 0) + r.q;
    (who[k] = who[k] || []).push({ n:r.n, t:(r.q > 1 ? r.q + ' ' : '') + r.n });
    // The same card doing another job on the side (a creature that also draws), shown under that job too.
    if(k === 'lands') return;
    var ro = rolesC(r.c);
    Object.keys(RK).forEach(function(j){ if(j !== k && ro[RK[j]]) (also[j] = also[j] || []).push({ n:r.n, t:r.n }); });
  });
  // Targets: a deck made in the builder uses the plan he set there; a deck brought in uses the same
  // rule-of-thumb targets as the scores above, so the page shows one set of numbers.
  var T = e.targets ? safe(function(){ return e.targets(b); }, {}) : {}, Q = !S.mox && !S.src && S.quotas ? S.quotas : null;
  var lp = partOf(P && P.efficiency, 'lands');
  function tq(k, dflt){ return Q && Q[k] != null ? Q[k] : dflt; }
  var wp = partOf(P && P.interaction, 'wipes');
  // Finishers the rules text shows (an overrun, a trampling hydra) are a second job of cards filed
  // under Synergy, so Win conditions never reads 0 while the score above counts them.
  var fp = partOf(P && P.wincons, 'finishers');
  ((fp && fp.cards) || []).forEach(function(n){
    if((who.wincon || []).some(function(x){ return x.n === n; }) || (also.wincon || []).some(function(x){ return x.n === n; })) return;
    (also.wincon = also.wincon || []).push({ n:n, t:n });
  });
  var tgt = { lands:tq('lands', lp ? lp.want : null), ramp:tq('ramp', T.ramp), draw:tq('draw', T.draw), tutor:tq('tutor', T.tutor),
    removal:tq('removal', T.removal), wipes:wp && !(wp.weight > 0) ? null : tq('wipes', T.wipes), protection:tq('protection', T.protection), wincon:tq('wincon', T.finishers), synergy:null };
  var jobsHtml = '<section class="bs-panel pg-jobs">' +
    '<div class="bs-panel-head"><h3 class="bs-panel-title">Jobs</h3><span class="bs-count pg-right">' + (Q ? 'Targets from your plan' : 'Targets: rule of thumb for bracket ' + b) + '</span></div>' +
    '<p class="bs-panel-note pg-mb">Each card counts once, under its main job, so these numbers are lower than the scores above, which count every card that does the job. The white mark is the target. Open a row to see the cards.</p>' +
    '<div class="bs-hbars">' + JOBS.map(function(k){
      var v = cnt[k] || 0, t = tgt[k], cls = hbarCls(v, t == null ? null : +t);
      var mx = t == null ? Math.max(v, spellN || 1) : Math.max(v, Math.ceil(+t * 1.25), 1);
      var open = !!st.open['job-' + k];
      return '<button class="bs-hbar ' + cls + '" type="button" aria-expanded="' + open + '" style="--v:' + v + ';--t:' + (t == null ? 0 : t) + ';--max:' + mx + '"' + ctx.act(function(btn){
          var box = btn.nextElementSibling, now = box.hidden;
          box.hidden = !now; btn.setAttribute('aria-expanded', now); state().open['job-' + k] = now;
        }) + '>' +
        '<span class="bs-hbar-k">' + h(roleName(k)) + '</span><span class="bs-hbar-track"><i></i></span>' +
        '<span class="bs-hbar-v">' + v + (t != null ? ' <small>/ ' + t + '</small>' : '') + '</span>' +
        '<span class="pg-hbar-also">' + (also[k] ? '+' + also[k].length + ' as a second job' : '') + '</span></button>' +
        '<div class="pg-jobcards"' + (open ? '' : ' hidden') + '>' + (who[k] ? nameList(ctx, who[k], 40, 'job-' + k) : '<p class="pg-fine">No card has this as its main job.</p>') +
          (also[k] ? '<p class="bs-label pg-alsohead">Also do it, as a second job <span class="bs-count">' + also[k].length + '</span></p>' + nameList(ctx, also[k], 24, 'job-also-' + k) : '') + '</div>';
    }).join('') + '</div>' +
  '</section>';

  // ---- colours: mana symbols against land sources
  var ci = (S.ci || []).slice(), colHtml = '';
  if(ci.length){
    var src = {}, pip = { W:0, U:0, B:0, R:0, G:0 }, pipAll = 0;
    landRows.forEach(function(r){
      var c = r.c || {}, prod = c.prod && c.prod.length ? c.prod : [];
      if(!prod.length && /search your library for a basic land|any color/i.test(c.o || '')) prod = ci;
      prod.forEach(function(p){ src[p] = (src[p] || 0) + r.q; });
    });
    if(typeof pips === 'function') spellRows.forEach(function(r){ if(!r.c) return; var p = safe(function(){ return pips(r.c.cost || ''); }, {}); for(var k in p){ pip[k] += p[k] * r.q; pipAll += p[k] * r.q; } });
    var need = S.sources && Object.keys(S.sources).length ? S.sources : safe(function(){ return sourceTargets(spellRows.map(function(r){ return r.c; }).filter(function(c){ return c && c.cost != null; }), landN); }, {});
    // One colour: the builder's target is simply "every land", which reads as short for a deck
    // that runs a few colourless utility lands on purpose. Show the count without a target.
    if(ci.length === 1) need = {};
    var mono = ci.length === 1 ? (src[ci[0]] || 0) : 0;
    colHtml = '<section class="bs-panel">' +
      '<div class="bs-panel-head"><h3 class="bs-panel-title">Colours</h3><span class="bs-count pg-right">lands that make each colour</span></div>' +
      '<div class="bs-hbars">' + ci.map(function(col){
        var s = src[col] || 0, t = need[col] != null ? need[col] : null, mx = t == null ? Math.max(s, landN, 1) : Math.max(s, Math.ceil(t * 1.25), 1);
        return '<div class="bs-hbar ' + (t == null ? 'bs-notarget' : s >= t - 1 ? 'bs-met' : 'bs-short') + '" style="--v:' + s + ';--t:' + (t || 0) + ';--max:' + mx + ';--fill:var(--m' + col + ')">' +
          '<span class="bs-hbar-k"><span class="bs-pips">' + pipsOf([col]) + '</span> ' + COLN[col] + '</span><span class="bs-hbar-track"><i></i></span>' +
          '<span class="bs-hbar-v">' + s + (t != null ? ' <small>/ ' + t + '</small>' : ' <small>of ' + landN + '</small>') + '</span></div>';
      }).join('') + '</div>' +
      '<p class="bs-panel-note pg-mt">' + (ci.length > 1 && pipAll
        ? 'Mana symbols in your spells: ' + ci.map(function(col){ return COLN[col] + ' ' + pct(pip[col] / pipAll); }).join(', ') + '. The white mark is how many lands should make each colour (rule of thumb).'
        : 'One colour: ' + mono + ' of your ' + landN + ' lands make ' + (COLN[ci[0]] || '').toLowerCase() + ' mana' +
          (landN > mono ? '. The other ' + (landN - mono) + ' make colourless mana or do something else.' : ', every one of them.')) + '</p>' +
    '</section>';
  }

  // ---- bracket check
  var hs = S.house || {}, lim = hs.gc != null && hs.gc !== '' ? +hs.gc : br.gc;
  var gcs = rows.filter(function(r){ return !isBasicC(r.c) && gcC(r.c); }).map(function(r){ return r.n; });
  var extra = mainRows.filter(function(r){ return rolesC(r.c).extra; }).map(function(r){ return r.n; });
  var mld = mainRows.filter(function(r){ return rolesC(r.c).mld; }).map(function(r){ return r.n; });
  // Tutors as the Consistency score counts them, so the two numbers on this page agree.
  var tp = partOf(P && P.consistency, 'tutor');
  var tut = tp && tp.cards ? tp.cards.slice() : mainRows.filter(function(r){ return r.role === 'tutor' || rolesC(r.c).tutor; }).map(function(r){ return r.n; });
  var houseGc = hs.gc != null && hs.gc !== '';
  var keep = { 1:1, 2:2, 3:4 }[b];
  var comboRow;
  if(!cb) comboRow = checkRow('Combos that win', 'Checking Commander Spellbook.', '<span class="bs-spin"></span>', null);
  else {
    var bad = cb.inDeck.filter(function(o){ return o.breaks; });
    comboRow = checkRow('Combos that win', cb.inDeck.length ? words(cb.inDeck.length, 'combo') + ' in the deck, from Commander Spellbook. The Synergy page lists them.' : 'Commander Spellbook finds none in this deck.',
      cb.inDeck.length, bad.length ? ['bs-bad', bad.length + ' too strong'] : ['bs-good', 'OK'],
      bad.length ? '<ul class="pg-badcombos">' + bad.slice(0, 4).map(function(o){ return '<li>' + h(o.cards.join(' + ')) + ': ' + h(plain(o.result)) + '</li>'; }).join('') + '</ul><p class="pg-fine">These win too early for bracket ' + b + '.</p>' : '');
  }
  var brHtml = '<section class="bs-panel">' +
    '<div class="bs-panel-head"><h3 class="bs-panel-title">Bracket check</h3><span class="bs-bracket pg-right" title="Bracket ' + b + ': ' + h(br.name) + '"><b>' + b + '</b><span>' + h(br.name) + '</span></span></div>' +
    '<div class="pg-checks">' +
      checkRow('Game Changers', houseGc ? 'Up to ' + lim + ' allowed by your house rules (bracket ' + b + ' allows ' + (br.gc === Infinity ? 'any number' : br.gc) + ').'
          : lim === Infinity ? 'No limit at this bracket.' : lim === 0 ? 'None allowed at this bracket.' : 'Up to ' + lim + ' allowed at this bracket.', gcs.length,
        gcs.length > lim ? ['bs-bad', 'Over the limit'] : ['bs-good', 'OK'], nameList(ctx, gcs, 12, 'chk-gc')) +
      comboRow +
      checkRow('Extra turns', b <= 3 ? 'One is fine; chained extra turns (one after another) are not allowed at this bracket.' : 'No limit at this bracket.', extra.length,
        (b <= 3 && extra.length > 1 && !hs.extra) ? ['bs-warn', 'Check'] : ['bs-good', 'OK'], nameList(ctx, extra, 12, 'chk-extra')) +
      checkRow('Destroys all lands', b <= 3 ? 'Not allowed at this bracket' + (hs.mld ? ', but your house rules allow it.' : '.') : 'Allowed at this bracket.', mld.length,
        (b <= 3 && mld.length && !hs.mld) ? ['bs-bad', 'Not allowed'] : ['bs-good', 'OK'], nameList(ctx, mld, 12, 'chk-mld')) +
      checkRow('Tutors', keep ? 'Rule of thumb: about ' + keep + ' or fewer at this bracket.' : 'No limit at this bracket.', tut.length,
        keep && tut.length > keep ? ['bs-warn', 'Many'] : ['bs-good', 'OK'], nameList(ctx, tut, 12, 'chk-tut')) +
    '</div>' +
    (br.desc ? '<p class="bs-panel-note pg-mt">' + h(br.desc) + '</p>' : '') +
  '</section>';

  // ---- sidebar: test games and price
  var sim = testGames(cb), wt = partOf(P && P.wincons, 'winTurn');
  var games = '<section class="bs-panel">' +
    '<div class="bs-panel-head"><h3 class="bs-panel-title">Test games</h3><span class="bs-badge pg-right">Estimate</span></div>' +
    (sim ? '<div class="bs-lines">' +
        '<div class="bs-line"><span>Opening hand with 3 or more lands</span><b>' + pct(sim.p3) + '</b></div>' +
        '<div class="bs-line"><span>Land drops or cheap ramp through turn 3</span><b>' + pct(sim.t3) + '</b></div>' +
        '<div class="bs-line"><span>Wins by turn, with nobody stopping it</span><b>' + (wt && wt.have != null ? 'Turn ' + h(wt.have) : sim.winTurn ? 'Turn ' + sim.winTurn : 'After turn 15') + '</b></div>' +
      '</div><p class="bs-panel-note pg-mt">From 2,000 shuffled test games with no opponents. The win turn comes from the 800 test games behind the scores above. All estimates: real games run longer.</p>'
      : '<p class="pg-fine">' + (S.bracket ? 'The test games could not run for this deck.' : 'Pick a bracket for this deck to run test games.') + '</p>') +
  '</section>';
  // Price is a footnote at the very end, folded away: it never decides anything here.
  var pr = e.price ? safe(function(){ return e.price(); }, null) : null, priceFoot = '';
  if(pr && pr.usd != null){
    var tot = php(pr.usd), top = (pr.top || []).slice(0, 5), unk = pr.unknown || [];
    priceFoot = '<details class="pg-pricefoot" data-pg-open="price"' + (st.open.price ? ' open' : '') + '><summary>Whole deck: about ' + (tot || '$' + commas(Math.round(pr.usd))) + ' at Scryfall prices (estimate).</summary>' +
      '<p>' + (top.length ? 'Priciest: ' + top.map(function(x){ return link(x.n) + (php(x.usd) ? ' <span class="pg-pricefoot-n">' + php(x.usd) + '</span>' : ''); }).join(', ') + '.' : '') +
        (unk.length ? ' No price yet for ' + words(unk.length, 'card') + ', so the total is a little low.' : '') + '</p></details>';
  }

  // Jobs and the bracket check are long lists; the curve, colours and test games are short
  // panels, so on a PC they stack in the right-hand column beside them.
  H += '<div class="bs-cols bs-section"><div class="bs-main">' + guidesHtml(ctx, st) + jobsHtml + brHtml + '</div>' +
    '<aside class="bs-side bs-sticky" aria-label="Mana curve, colours and test games">' + curveHtml + colHtml + games + '</aside></div>' + priceFoot;
  el.innerHTML = wrap(H);
}

/* ================================================================
   SYNERGY
   ================================================================ */
var STRENGTH = { strong:['bs-good', 'Strong'], ok:['', 'Working'], thin:['bs-warn', 'Thin'] };
function miniGrid(ctx, names, k, max){
  var all = isAll(k);
  var tiles = names.map(function(n, i){ return tile(cardFor(n) || { n:n }, { mini:true, hidden:!all && i >= max }); }).join('');
  return '<div class="bs-cgrid pg-mini' + (all ? ' pg-all' : '') + '" data-more="' + moreKey(k) + '">' + tiles + '</div>' + showAll(ctx, k, names.length, max);
}
function themePanel(ctx, st, t, i, per){
  var key = 't-' + t.key, open = st.open[key] != null ? st.open[key] : i < 3;
  var sw = STRENGTH[t.strength] || ['', t.strength];
  return '<section class="bs-panel pg-theme">' +
    '<div class="bs-panel-head"><h3 class="pg-theme-title">' + h(t.label) + '</h3><span class="bs-badge ' + sw[0] + '">' + sw[1] + '</span>' +
      '<div class="bs-acts"><span class="bs-count">' + t.enablers.length + ' feed it, ' + t.payoffs.length + ' reward it</span>' +
      '<button class="bs-btn bs-sm bs-quiet" type="button" aria-expanded="' + open + '"' + ctx.act(function(btn){
        var body = btn.closest('.pg-theme').querySelector('.pg-theme-body'), now = body.hidden;
        body.hidden = !now; btn.setAttribute('aria-expanded', now); btn.textContent = now ? 'Hide cards' : 'Show cards'; state().open[key] = now;
      }) + '>' + (open ? 'Hide cards' : 'Show cards') + '</button></div></div>' +
    '<p class="bs-panel-note">' + h(t.note) + '</p>' +
    '<div class="pg-theme-body"' + (open ? '' : ' hidden') + '>' +
      '<div class="pg-theme-cols">' +
        '<div><p class="bs-label pg-colhead">Feed it <span class="bs-count">' + t.enablers.length + '</span></p>' + (t.enablers.length ? miniGrid(ctx, t.enablers, key + '-en', per) : '<p class="pg-fine">None yet.</p>') + '</div>' +
        '<div><p class="bs-label pg-colhead">Reward it <span class="bs-count">' + t.payoffs.length + '</span></p>' + (t.payoffs.length ? miniGrid(ctx, t.payoffs, key + '-pay', per) : '<p class="pg-fine">None yet.</p>') + '</div>' +
      '</div>' +
    '</div>' +
  '</section>';
}
function smallPic(n){
  var c = cardFor(n); remember(c);
  var img = c && (c.sm || c.img);
  return '<button class="pg-pic" type="button" data-pg-card="' + h(n) + '" aria-label="' + h(n) + '">' + (img ? '<img src="' + h(img) + '" alt="" loading="lazy">' : '<span class="bs-ctile-noimg">' + h(n) + '</span>') + '</button>';
}
function spellbook(o){ return o.url ? '<a class="bs-btn bs-sm bs-quiet" href="' + h(o.url) + '" target="_blank" rel="noopener">' + ico('ext', 'bs-i16') + 'Commander Spellbook</a>' : ''; }

function drawSynergy(ctx, st){
  var e = E(), el = ctx.el, b = bk();
  var cb = combosNow(ctx);
  var th = safe(function(){ return e.themes(); }, []), L = safe(function(){ return e.links(); }, { engines:[], loners:[], byCard:{} });
  var per = innerWidth < 560 ? 6 : 12;
  var H = head('What works together', 'Read from the cards\' rules text, so it works for any deck. For each plan, the cards that feed it sit on the left and the cards that reward it on the right.');

  var top = th[0];
  H += '<div class="bs-stats pg-statrow" style="--stat-min:150px">' +
    '<div class="bs-stat"><span class="bs-stat-k">Plans found</span><span class="bs-stat-v">' + th.length + '</span><span class="bs-stat-n">' + (top ? 'Strongest: ' + h(top.label) : 'None yet') + '</span></div>' +
    '<div class="bs-stat"><span class="bs-stat-k">Engines</span><span class="bs-stat-v">' + L.engines.length + '</span><span class="bs-stat-n">cards many others work with</span></div>' +
    '<div class="bs-stat"><span class="bs-stat-k">Works with nothing</span><span class="bs-stat-v">' + L.loners.length + '</span><span class="bs-stat-n">' + (L.loners.length ? 'cut candidates' : 'every card links up') + '</span></div>' +
    '<div class="bs-stat"><span class="bs-stat-k">Combos</span><span class="bs-stat-v">' + (cb ? cb.inDeck.length : '<span class="bs-skel bs-skel-title" style="--w:40px"></span>') + '</span><span class="bs-stat-n">' + (cb ? (cb.near.length ? cb.near.length + ' more are one card away' : 'none one card away') : 'checking') + '</span></div>' +
  '</div>';

  // ---- plans (themes)
  H += '<section class="bs-section">' + sectionHead('Plans in this deck', th.length) +
    '<p class="pg-legend"><b>Strong</b>: plenty of cards on both sides. <b>Working</b>: enough to matter. <b>Thin</b>: a few cards, easy to build up or cut.</p>';
  if(th.length) H += '<div class="bs-stack">' + th.map(function(t, i){ return themePanel(ctx, st, t, i, per); }).join('') + '</div>';
  else H += empty('info', 'No plan stands out yet', h(th.note || 'No theme has both cards that feed it and cards that reward it.') + ' Adding a few cards that reward what the deck already does will show up here.');
  H += '</section>';

  // ---- engines
  H += '<section class="bs-section">' + sectionHead('Engines', L.engines.length) +
    '<p class="pg-legend">The cards the rest of the deck works with most, ranked by how many plans and combos each one ties together. Losing one of these hurts the most.</p>';
  if(L.engines.length){
    H += '<div class="bs-grid" style="--grid-min:340px">' + L.engines.slice(0, 12).map(function(g, i){
      var c = cardFor(g.n), links = L.byCard[g.n] || [];
      remember(c);
      return '<article class="bs-panel pg-engine">' +
        '<button class="pg-engine-pic" type="button" data-pg-card="' + h(g.n) + '" aria-label="' + h(g.n) + '">' + (c && c.img ? '<img src="' + h(c.img) + '" alt="" loading="lazy">' : '<span class="bs-ctile-noimg">' + h(g.n) + '</span>') + '</button>' +
        '<div class="pg-engine-body">' +
          '<div class="pg-engine-top"><span class="pg-rank bs-num">' + (i + 1) + '</span><button class="pg-linkname pg-engine-n" type="button" data-pg-card="' + h(g.n) + '">' + h(g.n) + '</button></div>' +
          '<p class="pg-engine-s">Works with <b class="bs-num">' + g.count + '</b> of your cards</p>' +
          nameList(ctx, links.map(function(x){ return { n:x.n, why:x.why }; }), 6, 'eng-' + g.n) +
        '</div></article>';
    }).join('') + '</div>';
  } else H += '<p class="pg-fine">No card links up with enough others to count as an engine yet.</p>';
  H += '</section>';

  // ---- works with nothing
  H += '<section class="bs-section">' + sectionHead('Works with nothing', L.loners.length) +
    '<p class="pg-legend">Cards that feed none of your plans, reward none of them, and are not ramp, card draw, removal, protection or a tutor. They are the easiest cuts.</p>';
  if(L.loners.length){
    H += '<div class="bs-panel bs-flush"><div class="bs-clist pg-list">' + L.loners.map(function(n){
      var c = cardFor(n), r = ((S.deck || []).filter(function(d){ return d.n === n; })[0]) || {};
      remember(c);
      return '<div class="bs-crow">' + (art(c) ? '<img class="bs-crow-thumb" src="' + h(art(c)) + '" alt="" loading="lazy">' : '<span class="bs-crow-thumb"></span>') +
        '<button class="pg-crow-open" type="button" data-pg-card="' + h(n) + '"><span class="bs-crow-n">' + h(n) + '</span><span class="bs-crow-s">' + h(roleName(r.role || 'synergy')) + (c && c.type ? ', ' + h(c.type.replace(/\s*\u2014\s*/, ': ')) : '') + '</span></button>' +
        '<span class="bs-crow-end"><button class="bs-btn bs-sm" type="button"' + ctx.act(function(){ swapFlow(n); }) + '>' + ico('swap', 'bs-i16') + 'Find a replacement</button></span></div>';
    }).join('') + '</div></div>';
  } else H += callout('good', 'Every card here feeds a plan, rewards one, or does a staple job.');
  H += '</section>';

  // ---- combos in the deck
  H += '<section class="bs-section">' + sectionHead('Combos in the deck', cb ? cb.inDeck.length : null, '<span class="bs-count">from Commander Spellbook</span>');
  if(!cb) H += '<div class="bs-grid" style="--grid-min:340px">' + [0, 1].map(function(){ return '<div class="bs-panel">' + skelRows(4) + '</div>'; }).join('') + '</div>' + loadingLine('Checking every combo Commander Spellbook knows');
  else if(!cb.inDeck.length) H += '<p class="pg-fine">' + h(cb.note || 'Commander Spellbook lists no combo made only of cards in this deck.') + ' The next section shows combos you are one card away from.</p>';
  else {
    var cmax = isAll('combos') ? cb.inDeck.length : 8;
    H += '<div class="bs-grid' + (isAll('combos') ? ' pg-all' : '') + '" style="--grid-min:340px" data-more="combos">' + cb.inDeck.map(function(o, i){
      return '<article class="bs-panel pg-combo' + (i >= cmax ? ' pg-x' : '') + '">' +
        '<div class="pg-combo-pics">' + o.cards.map(smallPic).join('') + '</div>' +
        '<p class="pg-combo-res">' + h(plain(o.result)) + '</p>' +
        '<p class="pg-combo-names">' + h(o.cards.join(' + ')) + '</p>' +
        '<div class="pg-badges">' + (o.breaks ? '<span class="bs-badge bs-bad">Too strong for bracket ' + b + '</span>' : '') +
          (o.mv ? '<span class="bs-badge"><span class="bs-num">' + o.mv + '</span>&nbsp;mana in total</span>' : '') + '<span class="pg-grow"></span>' + spellbook(o) + '</div>' +
      '</article>';
    }).join('') + '</div>' + showAll(ctx, 'combos', cb.inDeck.length, 8);
  }
  if(cb && cb.cond && cb.cond.length){
    H += details('cond', words(cb.cond.length, 'more combo needs', 'more combos need') + ' one more card of a certain kind',
      '<p class="pg-fine">Every named card is in the deck, but Commander Spellbook says each of these also needs a card of a certain kind (such as "a creature with persist"). They count only if the deck has one, so they are not counted above. Spellbook names the kind.</p>' +
      '<ul class="pg-badcombos">' + cb.cond.slice(0, 12).map(function(o){ return '<li>' + o.cards.map(function(n){ return link(n); }).join(' + ') + ': ' + h(plain(o.result)) + (o.url ? ' <a class="pg-sbl" href="' + h(o.url) + '" target="_blank" rel="noopener">Open on Spellbook</a>' : '') + '</li>'; }).join('') + '</ul>');
  }
  H += '</section>';

  // ---- one card away
  H += '<section class="bs-section">' + sectionHead('One card away', cb ? cb.near.length : null) +
    '<p class="pg-legend">You already run every piece but one. The missing card is legal and in your colours.</p>';
  if(!cb) H += skelTiles(4, 150);
  else if(!cb.near.length) H += '<p class="pg-fine">No combo is one card away for this deck.</p>';
  else {
    var set = deckSet(), near = cb.near.filter(function(o){ return !isIn(set, o.missing); }), nmax = 9;
    H += '<div class="bs-grid' + (isAll('near') ? ' pg-all' : '') + '" style="--grid-min:380px" data-more="near">' + near.map(function(o, i){
      var c = remember(o.c) || cardFor(o.missing), others = o.cards.filter(function(n){ return lc(n) !== lc(o.missing); });
      return '<article class="bs-panel pg-near' + (!isAll('near') && i >= nmax ? ' pg-x' : '') + '">' +
        '<div class="pg-near-pic">' + tile(c || { n:o.missing }, {}) + '</div>' +
        '<div class="pg-near-body">' +
          '<p class="pg-near-add"><span class="bs-label">Missing piece</span><b>' + link(o.missing) + '</b></p>' +
          '<p class="pg-combo-res">' + h(plain(o.result)) + '</p>' +
          '<p class="pg-fine">With ' + others.map(function(n){ return '<button class="pg-inline" type="button" data-pg-card="' + h(n) + '">' + h(n) + '</button>'; }).join(' and ') + ', already in the deck.</p>' +
          (o.breaks ? '<div class="pg-badges"><span class="bs-badge bs-bad">Too strong for bracket ' + b + '</span></div>' : '') +
          '<div class="bs-acts pg-mt">' + addButtons(ctx, c, 'Completes a combo: ' + o.cards.join(' + ') + ' (' + o.result + ').') + spellbook(o) + '</div>' +
        '</div></article>';
    }).join('') + '</div>' + showAll(ctx, 'near', near.length, nmax);
  }
  H += '</section>';
  el.innerHTML = wrap(H);
}

/* ================================================================
   EDHREC
   ================================================================ */
var EDHC = {}, EDHP = {};
function edhKey(s){ return curId() + '|' + (S.cmd ? S.cmd.n : '') + '|' + (S.partner ? S.partner.n : '') + '|' + (s.theme || '') + '|' + (s.bracket || 0) + '|' + (s.budget || ''); }
function fetchEdh(ctx, s, k){
  if(EDHP[k]) return;
  EDHP[k] = E().edhrec({ theme:s.theme || '', bracket:s.bracket || null, budget:s.budget || '' }).then(function(r){
    delete EDHP[k];
    EDHC[k] = r || { lists:[], themes:[], note:'EDHREC did not answer.' };
    (r && r.lists || []).forEach(function(L){ L.cards.forEach(function(x){ remember(x.c); }); });
    if(r && r.average) r.average.missing.forEach(function(x){ remember(x.c); });
    if(r && r.lists && r.lists.length) s.last = k;
    // The chips come from the unfiltered page, and with a bracket picked, from that bracket's own
    // page (its themes and counts), so he never walks into a theme the bracket has no decks for.
    if(r && !s.theme && !s.bracket && r.themes && r.themes.length) s.themes = r.themes;
    if(r && r.bracketCounts) s.bc = r.bracketCounts;
    if(r && r.budgetCounts) s.bud = r.budgetCounts;
    if(r && !s.theme && s.bracket && r.bracket === s.bracket && r.themes && r.themes.length){ s.brThemes = s.brThemes || {}; s.brThemes[s.bracket] = r.themes; }
    var y = s.y; s.y = null;
    again(ctx, y);
  }, function(err){
    delete EDHP[k];
    EDHC[k] = { lists:[], themes:[], note:'EDHREC could not be read: ' + ((err && err.message) || 'no answer') + '.', failed:true };
    var y = s.y; s.y = null;
    again(ctx, y);
  });
}
function edhControls(ctx, st, d){
  var s = st.edh, bt = s.bracket && s.brThemes && s.brThemes[s.bracket];
  var themes = (bt && bt.length ? bt : s.bracket && d && !s.theme && d.bracket === s.bracket && d.themes && d.themes.length ? d.themes : s.themes && s.themes.length ? s.themes : (d && d.themes)) || [];
  // A filter change redraws the page; stay where the controls are instead of jumping to the top.
  function go(){ var y = s.y = window.pageYOffset || 0; redraw(); keepScroll(y); }
  var chips = '<button class="bs-chip' + (!s.theme ? ' on' : '') + '" type="button" aria-pressed="' + !s.theme + '"' + ctx.act(function(){ if(s.theme){ s.theme = ''; go(); } }) + '>All</button>';
  var shown = s.allThemes ? themes : themes.slice(0, 8);
  if(s.theme && !shown.some(function(t){ return t.slug === s.theme; })){
    var mine = themes.filter(function(t){ return t.slug === s.theme; });
    shown = shown.concat(mine.length ? mine : [{ slug:s.theme, value:edhThemeName(d, s.theme, s.themes) }]);
  }
  shown.forEach(function(t){
    var on = s.theme === t.slug;
    chips += '<button class="bs-chip' + (on ? ' on' : '') + '" type="button" aria-pressed="' + on + '"' + ctx.act(function(){ s.theme = on ? '' : t.slug; go(); }) + '>' +
      h(t.value || t.slug) + (t.count ? ' <span class="bs-chip-n">' + commas(t.count) + '</span>' : '') + '</button>';
  });
  if(!s.allThemes && themes.length > 8) chips += '<button class="bs-chip pg-chipmore" type="button"' + ctx.act(function(){ s.allThemes = true; go(); }) + '>' + (themes.length - 8) + ' more themes</button>';
  else if(s.allThemes && themes.length > 8) chips += '<button class="bs-chip pg-chipmore" type="button"' + ctx.act(function(){ s.allThemes = false; go(); }) + '>Fewer themes</button>';
  var bc = s.bc || (d && d.bracketCounts) || null;
  var seg = [0, 1, 2, 3, 4, 5].map(function(v){
    var on = (s.bracket || 0) === v, n = v && bc && bc[v] != null ? +bc[v] : null;
    return '<button class="' + (on ? 'on' : '') + '" type="button" aria-pressed="' + on + '"' + (v ? ' aria-label="Bracket ' + v + ', ' + h(BR(v).name) + (n != null ? ', ' + commas(n) + ' decks' : '') + (v === bk() ? ', this deck' : '') + '" title="' + h(BR(v).name) + (n != null ? ': ' + commas(n) + ' decks' : '') + '"' : '') +
      ctx.act(function(){ if((s.bracket || 0) !== v){ s.bracket = v; go(); } }) + '>' + (v ? v + (v === bk() ? '<span class="pg-yours" aria-hidden="true"></span>' : '') + (n != null ? '<span class="pg-segn" aria-hidden="true">' + (n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : n) + '</span>' : '') : 'Any') + '</button>';
  }).join('');
  var bud = s.bud || (d && d.budgetCounts) || null;
  var price = [['', 'Any'], ['budget', 'Budget'], ['expensive', 'Expensive']].map(function(x){
    var on = (s.budget || '') === x[0], n = x[0] && bud && bud[x[0]] != null ? +bud[x[0]] : null;
    return '<button class="' + (on ? 'on' : '') + '" type="button" aria-pressed="' + on + '"' + (n != null ? ' title="' + commas(n) + ' decks" aria-label="' + x[1] + ', ' + commas(n) + ' decks"' : '') + ctx.act(function(){ if((s.budget || '') !== x[0]){ s.budget = x[0]; go(); } }) + '>' + x[1] + '</button>';
  }).join('');
  return '<div class="pg-controls">' +
    '<div class="pg-ctl pg-ctl-grow"><span class="bs-label">Theme</span><div class="bs-chips" role="group" aria-label="Theme">' + (themes.length || !d ? chips : '<span class="pg-fine">EDHREC lists no themes for this commander.</span>') + '</div></div>' +
    '<div class="pg-ctl"><span class="bs-label">Bracket <span class="pg-dotnote">(dot = this deck; small number = decks)</span></span><div class="bs-seg" role="group" aria-label="Bracket">' + seg + '</div></div>' +
    '<div class="pg-ctl"><span class="bs-label">Price</span><div class="bs-seg" role="group" aria-label="Price">' + price + '</div></div>' +
    '<div class="pg-ctl"><span class="bs-label">Show</span><label class="bs-toggle"><button class="bs-switch" type="button" role="switch" aria-label="Hide cards I already run" aria-checked="' + !!s.hide + '"' +
      ctx.act(function(btn){ s.hide = !s.hide; btn.setAttribute('aria-checked', s.hide); again(ctx); }) + '></button>Hide cards I already run</label></div>' +
  '</div>';
}
function edhSkeleton(ctx, st, last){
  var H = '<div class="bs-stats pg-statrow" style="--stat-min:150px">' + [1, 2, 3, 4].map(function(){ return '<div class="bs-stat"><span class="bs-skel bs-skel-line" style="--w:50%"></span><span class="bs-skel bs-skel-title" style="--w:70%"></span></div>'; }).join('') + '</div>';
  H += last ? edhControls(ctx, st, last) : '<div class="pg-controls"><span class="bs-skel bs-skel-line" style="--w:60%"></span></div>';
  H += loadingLine('Reading EDHREC\'s page for ' + short() + (st.edh.theme ? ', ' + edhThemeName(last, st.edh.theme, st.edh.themes) + ' theme' : '') + (st.edh.bracket ? ', bracket ' + st.edh.bracket : ''));
  H += '<section class="bs-section"><span class="bs-skel bs-skel-title" style="--w:220px"></span>' + skelTiles(gridCols(ctx, 150), 150) + '</section>';
  H += '<section class="bs-section"><span class="bs-skel bs-skel-title" style="--w:180px"></span>' + skelTiles(gridCols(ctx, 150), 150) + '</section>';
  return H;
}
function drawEdhrec(ctx, st){
  var e = E(), el = ctx.el, s = st.edh, k = edhKey(s), d = EDHC[k], set = deckSet();
  var sub = h(short()) + ' decks on EDHREC' + (s.theme ? ', ' + h(edhThemeName(d || EDHC[s.last], s.theme, s.themes)) + ' theme' : '') + (s.bracket ? ', bracket ' + s.bracket : '') + (s.budget ? ', ' + s.budget : '') + '. Cards you already run are marked green.';
  var outLink = d && d.url ? '<div class="bs-acts"><a class="bs-btn bs-quiet" href="' + h(d.url) + '" target="_blank" rel="noopener">' + ico('ext', 'bs-i16') + 'Open on EDHREC</a></div>' : '';
  var H = head('What EDHREC shows', sub, outLink);
  if(!d){
    H += edhSkeleton(ctx, st, EDHC[s.last]);
    el.innerHTML = wrap(H);
    fetchEdh(ctx, s, k);
    return;
  }
  rateThen(ctx);
  if(!d.lists || !d.lists.length){
    H += empty('warn', d.failed ? 'EDHREC did not answer' : 'Nothing on EDHREC for this', h(d.note || 'EDHREC has no page for this commander.'),
      '<button class="bs-btn bs-primary" type="button"' + ctx.act(function(){ delete EDHC[k]; redraw(); }) + '>' + ico('refresh', 'bs-i16') + 'Try again</button>' +
      (s.theme || s.bracket || s.budget ? '<button class="bs-btn" type="button"' + ctx.act(function(){ s.theme = ''; s.bracket = 0; s.budget = ''; redraw(); }) + '>Show all decks</button>' : ''));
    el.innerHTML = wrap(H);
    return;
  }
  // "You match": the share of the average deck's nonbasic cards you also run.
  var A = d.average, match = null, missing = [], extra = [];
  if(A){
    missing = A.missing.filter(function(x){ return !isIn(set, x.n); });
    extra = A.extra.filter(function(n){ return isIn(set, n); });
    var mine = safe(function(){ return e.cards(); }, []).filter(function(r){ return !r.cmd && !isBasicC(r.c) && !isBasicName(r.n); }).length;
    var shared = Math.max(0, mine - extra.length);
    match = shared + missing.length ? shared / (shared + missing.length) : null;
  }
  H += '<div class="bs-stats pg-statrow" style="--stat-min:150px">' +
    '<div class="bs-stat"><span class="bs-stat-k">Decks on EDHREC</span><span class="bs-stat-v">' + commas(d.decks) + '</span><span class="bs-stat-n">' + (s.theme || s.bracket || s.budget ? 'with this filter' : 'for ' + h(short())) + '</span></div>' +
    (d.rank != null ? '<div class="bs-stat"><span class="bs-stat-k">EDHREC rank</span><span class="bs-stat-v">#' + commas(d.rank) + '</span><span class="bs-stat-n">popularity on EDHREC, lower is more popular</span></div>' : '') +
    (d.salt != null ? '<div class="bs-stat"><span class="bs-stat-k">Salt score</span><span class="bs-stat-v">' + (+d.salt).toFixed(2) + '<small>/ 4</small></span><span class="bs-stat-n">how much players dislike facing it</span></div>' : '') +
    (match != null ? '<div class="bs-stat bs-hl"><span class="bs-stat-k">You match</span><span class="bs-stat-v">' + Math.round(match * 100) + '<small>%</small></span><span class="bs-stat-n">of the average deck\'s cards</span></div>' : '') +
  '</div>';
  if(d.note) H += callout('info', h(d.note));
  H += edhControls(ctx, st, d);
  var who = edhWho(s, d);
  H += '<p class="pg-legend"><b>64%</b> of decks: how many ' + who + ' on EDHREC run the card. <span class="pg-pos">+58% synergy</span>: that share, minus the share of other decks of the same colours that run it (58 points more). New Cards count recent decks only.</p>';

  // ---- every list, in EDHREC's order
  var cols = gridCols(ctx, 150), per = cols * 2, why = function(x){ return 'EDHREC: in ' + pct(x.inc) + ' of ' + short() + ' decks' + (x.syn ? ', synergy ' + signed(x.syn) : '') + '.'; };
  var nav = '<nav class="pg-jump" aria-label="EDHREC lists">' + d.lists.map(function(L, i){ return '<button class="bs-chip" type="button"' + ctx.act(function(){ jumpTo('pg-edh-' + i); }) + '>' + h(L.title) + ' <span class="bs-chip-n">' + L.cards.length + '</span></button>'; }).join('') + (A ? '<button class="bs-chip" type="button"' + ctx.act(function(){ jumpTo('pg-edh-avg'); }) + '>Average deck</button>' : '') + '</nav>';
  H += nav;
  d.lists.forEach(function(L, i){
    var cards = L.cards.map(function(x){ return { x:x, inDeck:isIn(set, x.n) }; });
    var have = cards.filter(function(y){ return y.inDeck; }).length;
    var vis = s.hide ? cards.filter(function(y){ return !y.inDeck; }) : cards;
    var lk = 'edh-' + s.theme + '-' + s.bracket + '-' + i, all = isAll(lk);
    H += '<section class="bs-section">' + sectionHead(h(L.title), L.cards.length, '<span class="bs-count">' + (have ? have + ' in your deck' : 'none in your deck') + '</span>', 'pg-edh-' + i);
    if(!vis.length) H += '<p class="pg-fine">You already run all ' + L.cards.length + '.</p>';
    else {
      H += '<div class="bs-cgrid' + (all ? ' pg-all' : '') + '" data-more="' + moreKey(lk) + '">' + vis.map(function(y, j){
        var x = y.x, c = x.c || cardFor(x.n);
        return tile(c || { n:x.n }, { inDeck:y.inDeck, hidden:!all && j >= per, badge:y.inDeck ? inDeckBadge() : (ownBadge(x.n) || soonBadge(c)),
          stats:edhStats(x.inc, x.syn, L.title === 'New Cards'), acts:y.inDeck ? '' : addButtons(ctx, c, why(x)) });
      }).join('') + '</div>' + showAll(ctx, lk, vis.length, per);
    }
    H += '</section>';
  });

  // ---- the average deck against yours
  H += '<section class="bs-section">' + sectionHead('Average deck against yours', null, A ? '<a class="bs-btn bs-sm bs-quiet" href="' + h(A.url) + '" target="_blank" rel="noopener">' + ico('ext', 'bs-i16') + 'Average deck on EDHREC</a>' : '', 'pg-edh-avg');
  if(!A) H += callout('warn', 'EDHREC\'s average deck did not load, so there is nothing to compare with. Try again later.');
  else {
    var mk = 'avg-miss-' + s.theme + '-' + s.bracket, xk = 'avg-extra-' + s.theme + '-' + s.bracket;
    H += '<p class="pg-legend">EDHREC\'s average deck is built from the cards most ' + edhWho(s, d) + ' run.' +
      (A.basics ? ' Basic lands: the average deck runs <b class="bs-num">' + A.basics.avg + '</b>, you run <b class="bs-num">' + A.basics.you + '</b>.' : '') + '</p>';
    H += '<div class="bs-grid bs-fit" style="--grid-min:340px">' +
      '<section class="bs-panel bs-flush"><div class="bs-panel-head"><h3 class="bs-panel-title">It runs, you do not</h3><span class="bs-count pg-right">' + missing.length + '</span></div>' +
        (missing.length ? '<div class="bs-clist pg-list' + (isAll(mk) ? ' pg-all' : '') + '" data-more="' + moreKey(mk) + '">' + missing.map(function(x, i){
          var c = x.c || cardFor(x.n); remember(c);
          return '<div class="bs-crow' + (!isAll(mk) && i >= 12 ? ' pg-x' : '') + '">' + (art(c) ? '<img class="bs-crow-thumb" src="' + h(art(c)) + '" alt="" loading="lazy">' : '<span class="bs-crow-thumb"></span>') +
            '<button class="pg-crow-open" type="button" data-pg-card="' + h(x.n) + '"><span class="bs-crow-n">' + h(x.n) + '</span><span class="bs-crow-s">' + (x.inc ? 'in ' + pct(x.inc) + ' of decks' : 'in the average deck') + (ownedIn(x.n) ? ', ' + (ownedIn(x.n) === 'side' ? 'in your side deck' : 'in Considering') : '') + '</span></button>' +
            '<span class="bs-crow-end">' + (c ? (full() ? '<button class="bs-btn bs-sm" type="button"' + ctx.act(function(){ openCard(x.n); }) + '>Swap in</button>'
              : '<button class="bs-btn bs-sm bs-primary" type="button"' + ctx.act(function(){ change(null, c, 'In EDHREC\'s average deck for ' + short() + (x.inc ? ' (' + pct(x.inc) + ' of decks)' : '') + '.', 'Added <b>' + h(x.n) + '</b> to the deck.'); }) + '>Add</button>') : '') + '</span></div>';
        }).join('') + '</div>' + '<div class="pg-pad">' + showAll(ctx, mk, missing.length, 12) + '</div>' : '<p class="pg-fine pg-pad">You run every card in the average deck.</p>') +
      '</section>' +
      '<section class="bs-panel bs-flush"><div class="bs-panel-head"><h3 class="bs-panel-title">You run, it does not</h3><span class="bs-count pg-right">' + extra.length + '</span></div>' +
        (extra.length ? '<div class="bs-clist pg-list' + (isAll(xk) ? ' pg-all' : '') + '" data-more="' + moreKey(xk) + '">' + extra.map(function(n, i){
          var c = cardFor(n), r = ((S.deck || []).filter(function(dd){ return dd.n === n; })[0]) || {};
          return '<button class="bs-crow' + (!isAll(xk) && i >= 12 ? ' pg-x' : '') + '" type="button" data-pg-card="' + h(n) + '">' + (art(c) ? '<img class="bs-crow-thumb" src="' + h(art(c)) + '" alt="" loading="lazy">' : '<span class="bs-crow-thumb"></span>') +
            '<span class="bs-crow-main"><span class="bs-crow-n">' + h(n) + '</span><span class="bs-crow-s">' + h(roleName(r.role || (c && isLandC(c) ? 'lands' : 'synergy'))) + '</span></span><span class="bs-crow-end"></span></button>';
        }).join('') + '</div>' + '<div class="pg-pad">' + showAll(ctx, xk, extra.length, 12) + '</div>' : '<p class="pg-fine pg-pad">Every card you run is in the average deck too.</p>') +
      '</section>' +
    '</div>';
  }
  // EDHREC's own combo list for this commander, and the commanders it calls similar.
  var ec = (d.combos || []).filter(function(x){ return !/^see more/i.test(x.v); }), more = (d.combos || []).filter(function(x){ return /^see more/i.test(x.v); })[0];
  if(ec.length || (d.similar || []).length){
    H += '<div class="bs-grid bs-section" style="--grid-min:340px">';
    if(ec.length) H += '<section class="bs-panel"><div class="bs-panel-head"><h3 class="bs-panel-title">Combos EDHREC lists</h3>' +
      (more ? '<a class="bs-btn bs-sm bs-quiet pg-right" href="https://edhrec.com' + h(more.href) + '" target="_blank" rel="noopener">' + ico('ext', 'bs-i16') + 'See more on EDHREC</a>' : '') + '</div><ul class="pg-edhcombos">' +
      ec.map(function(x){
        var names = x.v.split(' + '), all = names.every(function(n){ return isIn(set, n); });
        return '<li>' + names.map(function(n){ return link(n); }).join(' + ') + (all ? ' <span class="bs-badge bs-good">In your deck</span>' : '') +
          ' <a class="pg-sbl" href="https://edhrec.com' + h(x.href) + '" target="_blank" rel="noopener" aria-label="Open ' + h(x.v) + ' on EDHREC">Open</a></li>';
      }).join('') + '</ul></section>';
    if((d.similar || []).length) H += '<section class="bs-panel"><div class="bs-panel-head"><h3 class="bs-panel-title">Similar commanders on EDHREC</h3></div><div class="bs-chips">' +
      d.similar.map(function(n){ var sl = typeof slugify === 'function' ? slugify(n) : ''; return sl ? '<a class="bs-chip" href="https://edhrec.com/commanders/' + h(sl) + '" target="_blank" rel="noopener">' + h(n) + '</a>' : ''; }).join('') + '</div></section>';
    H += '</div>';
  }
  el.innerHTML = wrap(H);
}
// "Krenko decks", or with filters on, "Goblins Krenko decks at bracket 3".
function edhWho(s, d){
  return (s.budget === 'budget' ? 'budget ' : s.budget === 'expensive' ? 'expensive ' : '') + (s.theme ? h(edhThemeName(d, s.theme, s.themes)) + ' ' : '') + h(short()) + ' decks' + (s.bracket ? ' at bracket ' + s.bracket : '');
}
function edhThemeName(d, slug, more){
  var t = ((d && d.themes) || []).concat(more || []).filter(function(x){ return x.slug === slug; })[0];
  return t ? t.value : String(slug).replace(/-/g, ' ').replace(/\b\w/g, function(ch){ return ch.toUpperCase(); });
}

/* ================================================================
   UPGRADES (id "ideas"): upgrades, downgrades, interesting cards
   ================================================================ */
var INT = {};
function interestingNow(ctx){
  var id = curId(), c = INT[id];
  if(c && c.list) return c;
  if(!c){
    INT[id] = { p:E().interesting().then(function(list){ INT[id] = { list:list || [], note:(list && list.note) || '' }; again(ctx); },
      function(err){ INT[id] = { list:[], note:'Could not look for interesting cards: ' + ((err && err.message) || 'no answer') + '.' }; again(ctx); }) };
  }
  return null;
}
var KINDS = [
  ['combo', 'Completes a combo', 'You already run the other pieces.'],
  ['synergy', 'High synergy on EDHREC', 'Cards ' + '{c}' + ' decks run far more often than other decks do.'],
  ['gem', 'Hidden gems', 'Few decks play them, but almost only with this commander.'],
  ['new', 'New cards', 'Recent cards EDHREC is seeing in these decks.'],
  ['theme', 'Fits your strongest plan', 'Read from the rules text: works with what the deck already does.']
];
// ENGINE's reason for a swap, minus what the badges already say, with "against" spelled out.
function swapWhy(t){
  var s = plain(t), o = s;
  s = s.replace(/^[^.]*?,? the same job as the card it replaces\.\s*/i, '')
    .replace(/(in \d+% of [^.;]*? decks), against (\d+%)\./g, '$1 (the card it replaces: $2).')
    .replace(/Works with (\d+) of your cards, against (\d+)\./g, 'Works with $1 of your cards (the card it replaces: $2).');
  return s || o;
}
function gainWord(g){ return g >= 0.6 ? 'Big upgrade' : g >= 0.3 ? 'Clear upgrade' : 'Small upgrade'; }
function swapPic(c, n, out){
  remember(c);
  var img = c && (c.img || c.sm);
  return '<button class="bs-swap-card' + (out ? ' bs-out' : '') + '" type="button" data-pg-card="' + h(n) + '" aria-label="' + h(n) + (out ? ', goes out' : ', comes in') + '">' +
    (img ? '<img src="' + h(img) + '" alt="" loading="lazy">' : '<span class="bs-ctile-noimg">' + h(n) + '</span>') +
    '<span class="bs-badge ' + (out ? 'bs-bad">Out' : 'bs-good">In') + '</span></button>';
}
function swapCard(ctx, p, kind, target){
  var oc = p.outCard || cardFor(p.out), ic = p.inn;
  var badge = kind === 'up' ? '<span class="bs-badge bs-gold">' + gainWord(p.gain) + '</span>'
    : (p.pri > 0 ? '<span class="bs-badge bs-warn">Needed for bracket ' + target + '</span>' : '<span class="bs-badge">Weaker card</span>');
  var why = (kind === 'up' ? 'Upgrade' : 'Power down to bracket ' + target) + ': ' + p.why;
  return '<article class="bs-swap">' +
    '<div class="bs-swap-cards">' + swapPic(oc, p.out, true) + ico('arrow', 'bs-swap-arrow') + swapPic(ic, ic.n, false) + '</div>' +
    '<div class="bs-swap-info">' +
      '<div class="pg-swapnames"><p><span class="bs-label">Out</span><span class="bs-o">' + link(p.out) + '</span></p><p><span class="bs-label">In</span><span class="bs-i">' + link(ic.n) + '</span></p></div>' +
      '<div class="pg-badges"><span class="bs-badge">' + h(roleName(p.role)) + '</span>' + badge + (gcC(ic) ? '<span class="bs-badge bs-warn">Game Changer</span>' : '') + ownBadge(ic.n) + '</div>' +
      '<p class="bs-swap-why">' + h(swapWhy(p.why)) + '</p>' +
    '</div>' +
    '<div class="bs-swap-side">' +
      '<div class="pg-swap-btns">' +
        '<button class="bs-btn bs-sm bs-quiet" type="button" title="Stop suggesting ' + h(ic.n) + ' for this deck"' + ctx.act(function(){ hideIdea(p.out, ic.n); }) + '>Not for me</button>' +
        '<button class="bs-btn bs-primary" type="button"' + ctx.act(function(){ change(p.out, ic, why, 'Swapped <b>' + h(p.out) + '</b> for <b>' + h(ic.n) + '</b>.'); }) + '>' + ico('swap', 'bs-i16') + 'Swap</button>' +
      '</div>' +
    '</div>' +
  '</article>';
}
// "Not for me": the builder's reject list (S.rejects) keeps the card from being suggested again.
function hideIdea(out, inn){
  S.rejects = S.rejects || [];
  S.rejects.push({ out:out, inn:inn });
  quietSave(); redraw();
  say('<b>' + h(inn) + '</b> will not be suggested for this deck again.', { undo:function(){
    S.rejects = (S.rejects || []).filter(function(x){ return !(x.inn === inn && x.out === out); });
    quietSave(); redraw(); say('Suggestions are back.');
  } });
}
function drawIdeas(ctx, st){
  var e = E(), el = ctx.el, s = st.ideas, cur = bk();
  // Combos first: a card that would complete one is never offered as a plain upgrade, and the
  // page redraws once Commander Spellbook has answered.
  combosNow(ctx);
  if(!(s.up >= cur && s.up <= Math.min(5, cur + 1))) s.up = cur;
  if(!(s.down >= 1 && s.down < cur)) s.down = Math.max(1, cur - 1);
  var ups = safe(function(){ return e.upgrades({ bracket:s.up }); }, []);
  var downs = cur > 1 ? safe(function(){ return e.downgrades({ bracket:s.down }); }, []) : [];
  var intr = interestingNow(ctx), set = deckSet();
  var ilist = intr ? intr.list.filter(function(x){ return !isIn(set, x.n); }) : null;
  rateThen(ctx);

  var H = head('Upgrades and downgrades', 'Each pair takes a card out and puts one in that does the same job. Open any card to see it; every swap can be undone.');
  var tabs = [['up', 'Upgrades', ups.length], ['down', 'Downgrades', cur > 1 ? downs.length : 0], ['int', 'Interesting<span class="bs-nosm"> cards</span>', ilist ? ilist.length : null]];
  H += '<div class="pg-tabsrow"><div class="bs-seg bs-block pg-seg3" role="group" aria-label="Show">' + tabs.map(function(t){
    var on = s.tab === t[0];
    return '<button class="' + (on ? 'on' : '') + '" type="button" aria-pressed="' + on + '"' + ctx.act(function(){ if(s.tab !== t[0]){ s.tab = t[0]; redraw(); } }) + '><span>' + t[1] + '</span>' +
      ' <span class="bs-seg-n">' + (t[2] == null ? '<span class="bs-spin pg-spin-sm"></span>' : t[2]) + '</span></button>';
  }).join('') + '</div></div>';

  if(s.tab === 'up'){
    H += '<div class="pg-controls">' + (cur < 5
      ? '<div class="pg-ctl"><span class="bs-label">Aim for</span><div class="bs-seg" role="group" aria-label="Aim for">' +
          [cur, cur + 1].map(function(v){ var on = s.up === v; return '<button class="' + (on ? 'on' : '') + '" type="button" aria-pressed="' + on + '"' + ctx.act(function(){ if(s.up !== v){ s.up = v; redraw(); } }) + '>' + (v === cur ? 'Stay at ' + v : 'Push to ' + v) + '</button>'; }).join('') +
        '</div></div><p class="pg-legend pg-ctl-grow">' + (s.up > cur ? 'Pushing to bracket ' + s.up + ' (' + h(BR(s.up).name) + ') also allows ' + (BR(s.up).gc === Infinity ? 'any number of Game Changers' : BR(s.up).gc + ' Game Changers') + ', fast mana and tutors that find anything.' : 'Better cards for the same jobs, within bracket ' + cur + ' rules.') + '</p>'
      : '<p class="pg-legend">Bracket 5 is the top bracket: these are the strongest swaps for the same jobs.</p>') + '</div>';
    if(ups.note) H += callout('info', h(ups.note));
    // Pushing up: Game Changer swaps only go through once the deck itself is set to the higher bracket.
    if(s.up > cur){
      var gcIn = ups.filter(function(p){ return gcC(p.inn) && !gcC(p.outCard || cardFor(p.out)); }).length;
      var gcNow = (S.deck || []).filter(function(d){ return d.gc; }).length;
      var lim = safe(function(){ return typeof gcLimit === 'function' ? gcLimit() : BR(cur).gc; }, BR(cur).gc);
      if(gcIn && gcNow + gcIn > lim){
        H += '<div class="bs-callout bs-gold pg-callout-act">' + ico('info') + '<p><b>' + words(gcIn, 'swap adds', 'swaps add') + ' a Game Changer.</b> The deck is set to bracket ' + cur + ', which allows ' + (lim === Infinity ? 'any number' : lim) + ' and it has ' + gcNow + '. Those swaps go through once the deck is set to bracket ' + s.up + '.</p>' +
          (typeof setBracket === 'function' ? '<button class="bs-btn bs-sm" type="button"' + ctx.act(function(){ setBracket(s.up); }) + '>Set the deck to bracket ' + s.up + '</button>' : '') + '</div>';
      }
    }
    if(ups.length) H += '<div class="bs-swaps">' + ups.map(function(p){ return swapCard(ctx, p, 'up', s.up); }).join('') + '</div>';
    else H += empty('check', 'No clear upgrades', 'Every card is already about as good as the options for its job' + (s.up === cur && cur < 5 ? ', or try Push to ' + (cur + 1) + '.' : '.'),
      '<button class="bs-btn bs-primary" type="button"' + ctx.act(function(){ s.tab = 'int'; redraw(); }) + '>See interesting cards</button>');
  }
  else if(s.tab === 'down'){
    if(cur <= 1){
      H += empty('info', 'Already at the lowest bracket', 'Bracket 1 is the lowest, so there is nothing to power down.');
    } else {
      var opts = []; for(var v = cur - 1; v >= 1; v--) opts.push(v);
      H += '<div class="pg-controls"><div class="pg-ctl"><span class="bs-label">Power down to</span><div class="bs-seg" role="group" aria-label="Power down to">' + opts.map(function(v){
        var on = s.down === v; return '<button class="' + (on ? 'on' : '') + '" type="button" aria-pressed="' + on + '"' + ctx.act(function(){ if(s.down !== v){ s.down = v; redraw(); } }) + '><span>Bracket ' + v + '<span class="bs-nosm">: ' + h(BR(v).name) + '</span></span></button>';
      }).join('') + '</div></div><p class="pg-legend pg-ctl-grow">For a table that plays at bracket ' + s.down + ': Game Changers over the limit, strong tutors, early combos and fast mana go first, then the strongest cards.</p></div>';
      if(downs.note) H += callout('warn', h(downs.note));
      if(downs.length) H += '<div class="bs-swaps">' + downs.map(function(p){ return swapCard(ctx, p, 'down', s.down); }).join('') + '</div>';
      else H += empty('check', 'Nothing to power down', 'The deck already fits bracket ' + s.down + ', and no weaker card does the same jobs.');
    }
  }
  else {
    H += '<div class="pg-controls"><p class="pg-legend pg-ctl-grow">Cards that are not in the deck, are legal and in your colours, and have a reason to be here. Add one when the deck is short, or Swap in to pick what it replaces.</p>' +
      (intr ? '<button class="bs-btn bs-sm bs-quiet" type="button"' + ctx.act(function(){ delete INT[curId()]; redraw(); }) + ' title="Look through EDHREC, Commander Spellbook and your plans again">' + ico('refresh', 'bs-i16') + 'Find new ideas</button>' : '') + '</div>';
    if(!intr){
      H += loadingLine('Looking through EDHREC, Commander Spellbook and your plans');
      H += '<section class="bs-section"><span class="bs-skel bs-skel-title" style="--w:200px"></span>' + skelTiles(gridCols(ctx, 170), 170) + '</section>';
    } else if(!ilist.length){
      H += empty('info', 'Nothing new turned up', h(intr.note || 'The card pool for this commander has nothing the deck is missing.'));
    } else {
      var per = gridCols(ctx, 170) * 2;
      KINDS.forEach(function(K){
        var list = ilist.filter(function(x){ return x.kind === K[0]; }); if(!list.length) return;
        var k = 'int-' + K[0], all = isAll(k);
        H += '<section class="bs-section">' + sectionHead(K[1], list.length) + '<p class="pg-legend">' + h(K[2].replace('{c}', short())) + '</p>' +
          '<div class="bs-cgrid' + (all ? ' pg-all' : '') + '" style="--card-min:170px" data-more="' + moreKey(k) + '">' + list.map(function(x, i){
            var c = remember(x.c) || cardFor(x.n);
            // The reason line only when it says more than the numbers already on the tile.
            var repeat = (x.kind === 'synergy' || x.kind === 'gem') && x.inc;
            return tile(c || { n:x.n }, { hidden:!all && i >= per, badge:ownBadge(x.n), why:repeat ? '' : x.why, stats:edhStats(x.inc, x.syn, x.kind === 'new'), acts:addButtons(ctx, c, x.why) });
          }).join('') + '</div>' + showAll(ctx, k, list.length, per) + '</section>';
      });
    }
  }
  el.innerHTML = wrap(H);
}

/* ================================================================
   COMPARE (top level)
   ================================================================ */
var ANALYSING = false, PROG = { t:'Starting', v:0 }, FEEDWAIT = false;
function shelfDecks(){
  var list = safe(function(){ return typeof shelf === 'function' ? shelf() : []; }, []);
  return list.filter(function(r){ return r && r.cmd; }).map(function(r){
    var sum = r.sum || null;
    // The open deck's own copy may be newer than its shelf row.
    if(r.id === curId() && S && S.sum && (!sum || (S.sum.at || 0) >= (sum.at || 0))) sum = S.sum;
    var stale = !!(sum && (sum.stale || (r.id === curId() && E() && S.cmd && sum.key && sum.key !== safe(function(){ return E().key(); }, sum.key))));
    return { id:r.id, row:r, name:titleOf(r), art:(sum && sum.art) || r.art || '', ci:(sum && sum.ci) || r.ci || [], sum:sum, stale:stale, bracket:(sum && sum.bracket) || r.bracket };
  });
}
// Which decks the Compare table shows: every deck, unless he turned one off (remembered on this device only).
var CMP_OFF = 'forge.cmpOff';
function cmpOff(){ try{ var o = JSON.parse(localStorage.getItem(CMP_OFF) || '{}'); return o && typeof o === 'object' ? o : {}; }catch(e){ return {}; } }
function setCmpOff(o){ try{ if(Object.keys(o).length) localStorage.setItem(CMP_OFF, JSON.stringify(o)); else localStorage.removeItem(CMP_OFF); }catch(e){} }
// Two decks with the same name (a Moxfield deck and a draft of it) get where they came from after the name.
function cmpNames(decks){
  var cnt = {}, seen = {};
  decks.forEach(function(d){ cnt[d.name] = (cnt[d.name] || 0) + 1; });
  decks.forEach(function(d){
    if(cnt[d.name] < 2) return;
    var r = d.row || {}, src = r.mox ? 'Moxfield' : r.src ? 'Imported' : 'Draft', k = d.name + '|' + src;
    seen[k] = (seen[k] || 0) + 1;
    d.name = d.name + ' (' + src + (seen[k] > 1 ? ' ' + seen[k] : '') + ')';
  });
  return decks;
}
function abbr(decks){
  var used = {};
  return decks.map(function(d){
    var base = d.name.replace(/^\s*\d+\.\s*/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'DCK', a = base, i = 2;
    while(used[a]) a = base.slice(0, 2) + (i++);
    used[a] = 1; return a;
  });
}
var CMP_ROWS = [
  ['Power'],
  ['Consistency', function(s){ return s.pillars && s.pillars.c; }, 'bar', 'hi'],
  ['Efficiency', function(s){ return s.pillars && s.pillars.e; }, 'bar', 'hi'],
  ['Interaction', function(s){ return s.pillars && s.pillars.i; }, 'bar', 'hi'],
  ['Win conditions', function(s){ return s.pillars && s.pillars.w; }, 'bar', 'hi'],
  ['Overall', function(s){ return s.pillars && s.pillars.o; }, 'one', 'hi', 'average of the four'],
  ['Speed'],
  ['Average mana value', function(s){ return s.avgMv; }, 'two', 'lo', 'spells only, lower is faster'],
  ['Mana curve', function(s){ return s.curve; }, 'curve'],
  ['Ramp', function(s){ return s.roles && s.roles.ramp; }, 'int', 'hi'],
  ['Wins by turn', function(s){ return s.winTurn; }, 'turn', 'lo', 'estimate, no opponents'],
  ['Jobs'],
  ['Lands', function(s){ return s.roles && s.roles.lands; }, 'int', null, 'cards whose main job is a land'],
  ['Card draw', function(s){ return s.roles && s.roles.draw; }, 'int', 'hi'],
  ['Tutors', function(s){ return s.roles && s.roles.tutor; }, 'int', 'hi'],
  ['Targeted removal', function(s){ return s.roles && s.roles.removal; }, 'int', 'hi'],
  ['Board wipes', function(s){ return s.roles && s.roles.wipes; }, 'int', 'hi'],
  ['Protection', function(s){ return s.roles && s.roles.protection; }, 'int', 'hi'],
  ['Win conditions', function(s){ return s.roles && s.roles.wincon; }, 'int', 'hi', 'cards whose main job is winning'],
  ['Bracket'],
  ['Bracket', function(s){ return s.bracket; }, 'bracket'],
  ['Game Changers', function(s){ return s.gcs; }, 'int'],
  ['Combos', function(s){ return s.combos; }, 'int', null, 'from Commander Spellbook'],
  ['Themes'],
  ['Top plans', function(s){ return s.themes; }, 'list'],
  // Price last, and never "best": cheaper is not better, it is only a footnote.
  ['Money'],
  ['Price', function(s){ return s.usd; }, 'money', null, 'estimate, Scryfall prices']
];
function cmpCell(kind, v, best){
  var sr = best ? '<span class="bs-sr"> best</span>' : '', cls = best ? ' bs-best' : '';
  if(v == null || (kind === 'list' && !v.length) || (kind === 'curve' && !v.length))
    return '<td class="bs-muted' + cls + '">' + ({ turn:'No estimate', bracket:'Not set', money:'No price', list:'None found', curve:'None' }[kind] || 'Not checked') + sr + '</td>';
  switch(kind){
    case 'bar': return '<td class="' + cls.trim() + '"><span class="bs-mbar" style="--v:' + v + '"><i></i><span class="bs-num">' + one(v) + '</span></span>' + sr + '</td>';
    case 'one': return '<td class="bs-n' + cls + '">' + one(v) + sr + '</td>';
    case 'two': return '<td class="bs-n' + cls + '">' + (+v).toFixed(2) + sr + '</td>';
    case 'turn': return '<td class="bs-n' + cls + '">Turn ' + v + sr + '</td>';
    case 'money': return '<td class="bs-n' + cls + '">' + (php(v) || '$' + (+v).toFixed(0)) + sr + '</td>';
    case 'bracket': return '<td><span class="bs-bracket" title="' + h(BR(v).name) + '"><b>' + v + '</b><span>' + h(BR(v).name) + '</span></span></td>';
    case 'curve':
      var mx = Math.max.apply(null, v) || 1;
      return '<td><div class="bs-curve bs-mini" style="--max:' + mx + '" role="img" aria-label="Curve: ' + v.join(', ') + '">' + v.map(function(n){ return '<div class="bs-cbar" style="--v:' + n + '"><i></i></div>'; }).join('') + '</div></td>';
    case 'list': return '<td class="pg-wrapcell">' + v.map(h).join('<br>') + '</td>';
  }
  return '<td class="bs-n' + cls + '">' + v + sr + '</td>';
}
function drawCompare(ctx, st){
  var el = ctx.el, all = cmpNames(shelfDecks()), off = cmpOff();
  var decks = all.filter(function(d){ return !off[d.id]; });
  if(!decks.length) decks = all;
  var done = decks.filter(function(d){ return d.sum; }), todo = decks.length - done.length;
  var canAll = typeof analyseAll === 'function';
  var H = head('Compare decks', 'Every deck side by side. The best value in each row is gold. Scores are Brewing Station\'s own estimates.',
    decks.length ? '<div class="bs-acts"><button class="bs-btn bs-fill" type="button" id="pgAnalyseAll"' + (ANALYSING ? ' disabled' : '') + ctx.act(function(btn){ analyseEvery(ctx, btn); }) + '>' +
      (ANALYSING ? '<span class="bs-spin"></span>Analysing' : ico('refresh', 'bs-i16') + (todo ? 'Analyse every deck' : 'Analyse again')) + '</button></div>' : '');
  H += '<div class="bs-panel pg-prog" id="pgProg"' + (ANALYSING ? '' : ' hidden') + '><div class="bs-progress-row"><span id="pgProgT">' + PROG.t + '</span><span class="bs-num" id="pgProgP">' + Math.round(PROG.v * 100) + '%</span></div>' +
    '<div class="bs-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(PROG.v * 100) + '" aria-label="Analysing decks" style="--v:' + PROG.v + '"><i></i></div></div>';
  if(!decks.length){
    H += empty('deck', 'No decks to compare yet', 'Bring your decks in from Moxfield on the Decks page, then come back here.', '<a class="bs-btn bs-primary" href="#decks">Go to your decks</a>');
    el.innerHTML = wrap(H); return;
  }
  if(!done.length) H += callout('gold', '<b>No deck is analysed yet.</b> Analyse every deck works out the scores for each one in turn' + (canAll ? '.' : '; it needs the updated Brewing Station, so reload the page first.'));
  else if(todo) H += callout('info', words(todo, 'deck is', 'decks are') + ' not analysed yet. Analyse every deck fills in the gaps, or open one and look at its Analysis page.');
  // Moxfield decks he has not opened here yet are not in the table: say so, with the way to add them.
  var onShelf = {}; decks.forEach(function(d){ if(d.row.mox && d.row.mox.id) onShelf[d.row.mox.id] = 1; });
  var feedOk = safe(function(){ return typeof FEED !== 'undefined' && !!FEED.data; }, false);
  var notIn = feedOk ? safe(function(){ return FEED.data.decks.filter(function(f){ return !onShelf[f.id]; }); }, []) : [];
  if(!feedOk && !FEEDWAIT && typeof feed === 'function'){ FEEDWAIT = true; safe(function(){ feed().then(function(){ again(ctx); }, function(){}); }); }
  if(decks.length === 1 || notIn.length){
    H += '<div class="bs-callout pg-callout-act">' + ico('info') + '<p>' +
      (notIn.length ? words(notIn.length, 'Moxfield deck is', 'Moxfield decks are') + ' not brought in yet, so ' + (notIn.length === 1 ? 'it is' : 'they are') + ' not in this table: <span data-nolink>' + notIn.map(function(f){ return h(f.name); }).join(', ') + '</span>. Open ' + (notIn.length === 1 ? 'it' : 'them') + ' from your decks to add ' + (notIn.length === 1 ? 'it' : 'them') + '.'
        : 'Only one deck in Brewing Station. Bring in another to see them side by side.') +
      '</p><a class="bs-btn bs-sm" href="#decks">Go to your decks</a></div>';
  }

  // ---- which decks: one chip per deck, tap to leave it out of the table and the shared cards
  if(all.length > 2){
    H += '<div class="pg-cmp-pick"><p class="bs-label" id="pgCmpPickL">Decks in the table <span class="bs-count">' + decks.length + ' of ' + all.length + '</span></p>' +
      '<div class="bs-chips" role="group" aria-labelledby="pgCmpPickL">' + all.map(function(d){
        var on = decks.indexOf(d) >= 0;
        return '<button class="bs-chip' + (on ? ' on' : '') + '" type="button" aria-pressed="' + on + '"' + ctx.act(function(){
          var o = {}, cur = cmpOff();
          all.forEach(function(x){ if(cur[x.id]) o[x.id] = 1; });
          if(o[d.id]) delete o[d.id]; else o[d.id] = 1;
          if(all.every(function(x){ return o[x.id]; })){ say('Keep at least one deck in the table.'); return; }
          setCmpOff(o); again(ctx);
        }) + '><span data-nolink>' + h(d.name) + '</span></button>';
      }).join('') + '</div></div>';
  }

  // ---- the table
  // Columns share the page width (between 170 and 300 px each). When every column fits, the page
  // itself scrolls and the deck row sticks under the header (no second scroll bar); otherwise
  // the table scrolls sideways inside its own box.
  var roomW = (ctx.el.clientWidth || document.documentElement.clientWidth) - 2;
  var colw = Math.max(170, Math.min(300, Math.floor((roomW - 180) / Math.max(1, decks.length))));
  var fits = 180 + decks.length * colw <= roomW;
  var th = '<th scope="col"><span class="bs-label">Deck</span></th>' + decks.map(function(d){
    return '<th scope="col"><div class="bs-th-deck">' +
      '<a class="pg-th-link" href="#d=' + encodeURIComponent(d.id) + '&amp;p=analysis" title="Open ' + h(d.name) + '">' + (d.art ? '<img src="' + h(d.art) + '" alt="" loading="lazy">' : '<span class="pg-th-noart"></span>') + '<b data-nolink>' + h(d.name) + '</b></a>' +
      '<span class="pg-th-meta"><span class="bs-pips">' + pipsOf(d.ci) + '</span>' +
      (d.sum ? '<span class="pg-th-sub">' + (d.stale ? '<span class="bs-badge bs-warn">Changed since</span>' : 'Analysed ' + h(agoOf(d.sum.at))) + '</span>'
        : '<a class="bs-btn bs-sm" href="#d=' + encodeURIComponent(d.id) + '&amp;p=analysis">Analyse</a>') + '</span>' +
    '</div></th>';
  }).join('');
  var body = '';
  CMP_ROWS.forEach(function(R){
    if(R.length === 1){ body += '<tr class="bs-tgroup"><th colspan="' + (decks.length + 1) + '" scope="rowgroup"><span>' + R[0] + '</span></th></tr>'; return; }
    var vals = decks.map(function(d){ return d.sum ? safe(function(){ return R[1](d.sum); }, null) : undefined; });
    var best = null;
    if(R[3]){
      var nums = vals.map(function(v){ return R[2] === 'turn' && v === null ? 16 : v; }).filter(function(v){ return typeof v === 'number' && !isNaN(v); });
      if(nums.length >= 2){ var b = R[3] === 'hi' ? Math.max.apply(null, nums) : Math.min.apply(null, nums); if(nums.some(function(v){ return v !== b; })) best = b; }
    }
    body += '<tr><th scope="row">' + R[0] + (R[4] ? '<small>' + R[4] + '</small>' : '') + '</th>' + vals.map(function(v, i){
      if(v === undefined) return '<td class="bs-muted">Not analysed</td>';
      var cmpv = R[2] === 'turn' && v === null ? 16 : v;
      return cmpCell(R[2], v, best != null && cmpv === best);
    }).join('') + '</tr>';
  });
  H += '<div class="bs-table-wrap bs-tall pg-cmp' + (fits ? ' pg-fits' : '') + '"><table class="bs-table" style="--colw:' + colw + 'px;--firstw:180px;--colw-sm:140px;--firstw-sm:112px"><thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table></div>';

  // ---- cards shared between decks
  var named = done.filter(function(d){ return d.sum.names && d.sum.names.length; }), map = {};
  named.forEach(function(d){
    var seen = {};
    d.sum.names.forEach(function(n){ var k = lc(n); if(isBasicName(n) || seen[k]) return; seen[k] = 1; (map[k] = map[k] || { n:n, decks:[] }).decks.push(d.name); });
  });
  var shared = Object.keys(map).map(function(k){ return map[k]; }).filter(function(x){ return x.decks.length > 1; })
    .sort(function(a, b){ return b.decks.length - a.decks.length || (a.n < b.n ? -1 : 1); });
  var copies = 0; shared.forEach(function(x){ copies += x.decks.length; });
  var sk = 'shared', smax = 25;
  var sharedHtml = '<section>' + sectionHead('Cards you share between decks', shared.length) +
    (named.length < 2 ? '<p class="pg-fine">Analyse at least two decks to see which cards they share.</p>'
      : !shared.length ? '<p class="pg-fine">These decks share no cards besides basic lands.</p>'
      : '<p class="pg-legend">Every card that sits in two or more decks. To play them all without moving cards around you need <b class="bs-num">' + copies + '</b> physical copies of these <b class="bs-num">' + shared.length + '</b> cards.</p>' +
        '<div class="bs-panel bs-flush"><div class="bs-clist pg-list' + (isAll(sk) ? ' pg-all' : '') + '" data-more="' + sk + '">' + shared.map(function(x, i){
          var c = cardFor(x.n);
          return '<button class="bs-crow' + (!isAll(sk) && i >= smax ? ' pg-x' : '') + '" type="button" data-pg-card="' + h(x.n) + '">' +
            '<img class="bs-crow-thumb" alt="" loading="lazy" data-pg-art="' + h(lc(x.n)) + '"' + (art(c) ? ' src="' + h(art(c)) + '"' : '') + '>' +
            '<span class="bs-crow-main"><span class="bs-crow-n">' + h(x.n) + '</span><span class="bs-crow-s">' + h(x.decks.join(', ')) + '</span></span>' +
            '<span class="bs-crow-end"><span class="bs-badge' + (x.decks.length >= 3 ? ' bs-gold' : '') + '"><span class="bs-num">' + x.decks.length + '</span>&nbsp;copies</span></span></button>';
        }).join('') + '</div><div class="pg-pad">' + showAll(ctx, sk, shared.length, smax) + '</div></div>') + '</section>';

  // ---- overlap grid
  var ov = '';
  if(named.length >= 2){
    var ab = abbr(named), sets = named.map(function(d){ var s = {}; d.sum.names.forEach(function(n){ if(!isBasicName(n)) s[lc(n)] = 1; }); return s; });
    ov = '<section class="bs-panel"><div class="bs-panel-head"><h3 class="bs-panel-title">Cards in common</h3></div>' +
      '<p class="bs-panel-note pg-mb">Share of the smaller deck\'s cards that the other deck also runs, basic lands left out.</p>' +
      '<div class="bs-table-wrap"><table class="bs-table pg-heat" style="--colw:60px;--firstw:110px;--colw-sm:56px;--firstw-sm:90px"><thead><tr><th scope="col"><span class="bs-sr">Deck</span></th>' +
        ab.map(function(a, i){ return '<th scope="col" title="' + h(named[i].name) + '">' + h(a) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        named.map(function(d, i){
          return '<tr><th scope="row" title="' + h(d.name) + '"><span class="pg-ab bs-num">' + h(ab[i]) + '</span> <span data-nolink>' + h(d.name.replace(/^\s*\d+\.\s*/, '')) + '</span></th>' + named.map(function(o, j){
            if(i === j) return '<td class="pg-diag"><span class="bs-sr">same deck</span></td>';
            var a = sets[i], b2 = sets[j], n = 0, na = Object.keys(a).length, nb = Object.keys(b2).length;
            Object.keys(a).forEach(function(k){ if(b2[k]) n++; });
            var v = Math.min(na, nb) ? n / Math.min(na, nb) : 0;
            return '<td class="bs-heat" style="--v:' + v.toFixed(2) + '" title="' + n + ' cards in common with ' + h(o.name) + '"><span>' + Math.round(v * 100) + '%</span></td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table></div></section>';
  }
  H += '<div class="bs-cols bs-section"><div class="bs-main">' + sharedHtml + '</div><aside class="bs-side">' + ov + '</aside></div>';
  el.innerHTML = wrap(H);
  fillArt(ctx, shared.slice(0, 150).filter(function(x){ return !art(cardFor(x.n)); }).map(function(x){ return x.n; }));
}
// Pictures for shared cards that are not in the open deck's pool (Scryfall, cached).
function fillArt(ctx, names){
  if(!names.length || typeof sfCollection !== 'function') return;
  Promise.resolve().then(function(){ return sfCollection(names.map(function(n){ return { n:n }; })); }).then(function(res){
    if(!live(ctx.el)) return;
    var got = (res && res.cards) || {};
    Object.keys(got).forEach(function(k){ remember(got[k]); });
    Array.prototype.forEach.call(ctx.el.querySelectorAll('img[data-pg-art]'), function(im){
      if(im.getAttribute('src')) return;
      var c = got[im.getAttribute('data-pg-art')] || SEEN[im.getAttribute('data-pg-art')];
      if(c && art(c)) im.src = art(c);
    });
  }, function(){});
}
function analyseEvery(ctx, btn){
  if(ANALYSING) return;
  if(typeof analyseAll !== 'function'){ say('Analyse every deck needs the updated Brewing Station. Reload the page.', { kind:'bad' }); return; }
  ANALYSING = true; PROG = { t:'Starting', v:0 };
  btn.disabled = true; btn.innerHTML = '<span class="bs-spin"></span>Analysing';
  var box = document.getElementById('pgProg'); if(box) box.hidden = false;
  // SHELL may redraw the page while it switches decks, so this looks the bar up each time.
  function prog(i, n, name){
    var v = n ? Math.min(1, i / n) : 0;
    PROG = { t:i < n ? 'Analysing <b>' + (i + 1) + '</b> of <b>' + n + '</b>: ' + h(name || '') : 'All ' + n + ' decks analysed.', v:v };
    var b2 = document.getElementById('pgProg'); if(!b2) return;
    b2.hidden = false;
    b2.querySelector('#pgProgT').innerHTML = PROG.t;
    b2.querySelector('#pgProgP').textContent = Math.round(v * 100) + '%';
    var bar = b2.querySelector('.bs-progress'); bar.style.setProperty('--v', v); bar.setAttribute('aria-valuenow', Math.round(v * 100));
  }
  var p;
  try{ p = Promise.resolve(analyseAll(prog)); }catch(e){ p = Promise.reject(e); }
  p.then(function(res){
    ANALYSING = false;
    if(CURP && CURP.id === 'compare' && live(CURP.el)) redraw();
    var errs = (res && res.errors) || [];
    if(res && res.done < res.total) say('Analysing stopped after ' + res.done + ' of ' + res.total + ' decks, because a deck was opened. Press Analyse every deck to finish the rest.');
    else if(errs.length) say('Analysed ' + (res.done - errs.length) + ' of ' + res.total + ' decks. Could not analyse: ' + h(errs.join('; ')) + '.', { kind:'bad', ms:9000 });
    else say('Every deck is analysed.', { kind:'good' });
  }, function(err){
    ANALYSING = false;
    if(CURP && CURP.id === 'compare' && live(CURP.el)) redraw();
    say('Analysing stopped: ' + h((err && err.message) || 'something went wrong') + '.', { kind:'bad' });
  });
}

/* ---------- registration ---------- */
PG.analysis = { label:'Analysis', needsPool:true, render:function(el){ run(el, 'analysis', drawAnalysis); } };
PG.synergy = { label:'Synergy', needsPool:true, render:function(el){ run(el, 'synergy', drawSynergy); } };
PG.edhrec = { label:'EDHREC', needsPool:true, render:function(el){ run(el, 'edhrec', drawEdhrec); } };
PG.ideas = { label:'Upgrades', needsPool:true, render:function(el){ run(el, 'ideas', drawIdeas); } };
PG.compare = { label:'Compare', top:true, needsPool:false, render:function(el){ run(el, 'compare', drawCompare, true); } };
// SHELL's card sheet asks this for cards the pages fetched that are not in the deck's pool.
PG.cardFor = cardFor;
})();
