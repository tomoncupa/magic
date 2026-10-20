/* Brewing Station: "My deck now" and "Ask Claude" (mine.js)

   My deck now (Deck tab, Moxfield panel): Tom pastes his deck as it really is, the whole list or
   only + and - lines. The page works out what changed, makes every change through changeDeck (so
   a card that leaves the 99 goes to the side deck, and a card that comes back from the side deck
   leaves it), with one Undo for the lot, then hands him the Main Deck and Sideboard texts for
   Moxfield's Bulk Edit.

   Ask Claude (its own deck tab): questions about the open deck. Each question sends one compact
   page about the deck (names by type, side deck, rules text only for cards newer than Claude may
   know) plus the last 3 questions and answers, never the whole conversation. The thread lives on
   the deck (S.ask). Claude may end with SWAP / ADD / CUT lines; each becomes a button.

   Loads after index.html's script and pages.js, and uses their globals. */
(function(){
'use strict';

/* ================= My deck now ================= */
window.nowBtnHtml = function(){
  return '<button class="bs-btn bs-block" type="button" data-now>' + ico('import', 'bs-i16') + 'Paste my deck as it is now</button>';
};

function loadingLine(t){ return '<div class="bs-loading"><span class="bs-spin"></span>' + esc(t) + '</div>'; }
var SIGN = /^\s*([+\-−–])\s*(.+)$/;
function key(n){ return String(n || '').toLowerCase().split(' // ')[0].trim(); }
function isCmdName(n){ return (S.cmd && sameName(S.cmd.n, n)) || (S.cmd && key(S.cmd.n) === key(n)) || (S.partner && key(S.partner.n) === key(n)); }

// -> { mode:'list'|'changes', outs:[{n,q}], ins:[{n,q}], side:null|[{n,q}], total, empty }
function nowParse(text){
  var lines = String(text || '').split(/\r?\n/).map(function(t){ return t.trim(); }).filter(Boolean);
  var R = { mode:'list', outs:[], ins:[], side:null, total:0, empty:!lines.length };
  if(!lines.length) return R;
  if(lines.every(function(l){ return SIGN.test(l); })){
    R.mode = 'changes';
    lines.forEach(function(l){
      var m = SIGN.exec(l), row = parseDeckText(m[2]).rows[0]; if(!row) return;
      (m[1] === '+' ? R.ins : R.outs).push({ n:row.n, q:row.q });
    });
    // "- X" for a card not in the deck is dropped here, with a note.
    R.notIn = R.outs.filter(function(o){ return !S.deck.some(function(d){ return key(d.n) === key(o.n); }); });
    R.outs = R.outs.filter(function(o){ return R.notIn.indexOf(o) < 0; }).map(function(o){
      var d = S.deck.filter(function(x){ return key(x.n) === key(o.n); })[0]; return { n:d.n, q:o.q };
    });
    return R;
  }
  var P = parseDeckText(text), want = {}, side = [];
  P.rows.forEach(function(r){
    if(r.board === 'cmd' || r.board === 'comp' || r.board === 'maybe') return;
    if(isCmdName(r.n)) return;   // the commander, wherever the export put it
    if(r.board === 'side' && !r.loose){ side.push({ n:r.n, q:r.q }); return; }
    if(r.board === 'side' && r.loose) return;   // a lone card at the end that is not the commander: leave it out
    var k = key(r.n); if(!want[k]) want[k] = { n:r.n, q:0 }; want[k].q += r.q; R.total += r.q;
  });
  if(side.length) R.side = side;
  var have = {};
  S.deck.forEach(function(d){ var k = key(d.n); if(!have[k]) have[k] = { n:d.n, q:0 }; have[k].q++; });
  Object.keys(have).forEach(function(k){ var d = have[k].q - (want[k] ? want[k].q : 0); if(d > 0) R.outs.push({ n:have[k].n, q:d }); });
  Object.keys(want).forEach(function(k){ var d = want[k].q - (have[k] ? have[k].q : 0); if(d > 0) R.ins.push({ n:want[k].n, q:d }); });
  return R;
}

// Card data for every card coming in. -> { cards:{ key:card }, missing:[name] }
async function nowLookup(ins){
  var out = {}, need = [];
  ins.forEach(function(x){
    if(isBasicName(x.n)){ out[key(x.n)] = { n:x.n.replace(/\b\w/g, function(c){ return c.toUpperCase(); }) }; return; }
    var c = poolCard(x.n); if(c) out[key(x.n)] = c; else need.push(x);
  });
  var missing = [];
  if(need.length){
    var r = await sfCollection(need.map(function(x){ return { n:x.n }; }));
    for(var i = 0; i < need.length; i++){
      var x = need[i], c = r.cards[x.n.toLowerCase()];
      if(!c){ var raw = await sf('/cards/named?fuzzy=' + encodeURIComponent(x.n)); if(raw) c = slim(raw); }
      if(c){ c = Object.assign({}, c); c.stats = c.stats || {}; c.roles = c.roles || rolesOf(c); out[key(x.n)] = c; }
      else missing.push(x.n);
    }
  }
  return { cards:out, missing:missing };
}
function whyNot(c){
  if(!c || isBasicName(c.n)) return '';
  if(isCmdName(c.n)) return 'it is your commander';
  if(unreleased(c)) return 'it is not out yet';
  if(c.legal !== 'legal') return 'it is not legal in Commander';
  if(!withinCI(c)) return 'it is outside the deck\'s colours';
  return '';
}

var NOW = null;
window.openNowSheet = function(){
  if(!S.cmd || !S.pool){ toast('Open a deck first.'); return; }
  var me = NOW = { R:null, L:null, seq:0, t:0, busy:false };
  me.h = bsSheet({ title:'My deck as it is now', body:function(b){
      b.innerHTML = '<div class="sh-imp">' +
        '<div class="sh-imp-sec"><label class="bs-label" for="nowText">Your deck</label>' +
        '<textarea id="nowText" class="sh-imp-ta" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="The whole list, any format:&#10;1 Sol Ring&#10;1 Llanowar Elves&#10;...&#10;&#10;Or only what changed:&#10;- Grenzo, Dungeon Warden&#10;+ Llanowar Elves"></textarea>' +
        '<p class="sh-sub">Paste the whole list and Brewing Station works out what changed. Or type only the changes, one per line, starting with + or -. Cards that leave the deck go to your side deck. Cards that come in from the side deck leave it.</p></div>' +
        '<div id="nowPrev" aria-live="polite"></div></div>';
      b.querySelector('#nowText').addEventListener('input', function(e){ me.text = e.target.value; clearTimeout(me.t); me.t = setTimeout(nowPreview, 450); });
    },
    actions:[{ label:'Cancel', kind:'quiet' }, { label:'Make these changes', kind:'primary', fn:function(){ nowApply(); return false; } }],
    onClose:function(){ me.closed = true; clearTimeout(me.t); } });
  me.go = me.h.el.querySelector('.bs-sheet-foot .bs-primary'); me.go.disabled = true;
  setTimeout(function(){ var t = me.h.el.querySelector('#nowText'); if(t) t.focus(); }, 60);
};

async function nowPreview(){
  var me = NOW; if(!me || me.closed) return;
  var box = me.h.el.querySelector('#nowPrev'), seq = ++me.seq;
  me.R = nowParse(me.text); me.L = null; me.go.disabled = true;
  var R = me.R;
  if(R.empty){ box.innerHTML = ''; return; }
  if(R.mode === 'list' && R.total < 50){
    box.innerHTML = '<div class="bs-callout bs-warn">' + ico('warn') + '<p>That list has only ' + R.total + ' card' + (R.total === 1 ? '' : 's') + ' besides the commander. If you meant only the changes, start each line with + or -.</p></div>';
    return;
  }
  if(!R.outs.length && !R.ins.length && !R.side){
    box.innerHTML = '<div class="bs-callout">' + ico('check') + '<p>That is the deck you have here already. Nothing to change.</p></div>';
    return;
  }
  box.innerHTML = loadingLine('Looking up the cards');
  var L;
  try{ L = await nowLookup(R.ins); }catch(e){ if(seq === me.seq) box.innerHTML = '<div class="bs-callout bs-bad">' + ico('warn') + '<p>Could not look the cards up: ' + esc(e.message) + '</p></div>'; return; }
  if(seq !== me.seq || me.closed) return;
  me.L = L;
  var bad = [];
  R.ins.forEach(function(x){ var c = L.cards[key(x.n)], w = c ? whyNot(c) : ''; if(w) bad.push(c.n + ': ' + w); });
  var nOut = R.outs.reduce(function(s, x){ return s + x.q; }, 0), nIn = R.ins.reduce(function(s, x){ return s + x.q; }, 0);
  var rows = function(list, cls){ return list.map(function(x){ var c = cls === 'bs-add' ? L.cards[key(x.n)] : null;
    return '<li class="' + cls + '"><span>' + esc(c ? c.n : x.n) + (cls === 'bs-rm' && !isBasicName(x.n) ? ' <small class="mn-dim">to side deck</small>' : '') + '</span><small>' + (x.q > 1 ? x.q : '') + '</small></li>'; }).join(''); };
  var h = '<p class="sh-sub"><b>' + nOut + ' out, ' + nIn + ' in.</b>' + (nOut !== nIn ? ' The deck goes from ' + (S.deck.length + (S.partner ? 2 : 1)) + ' to ' + (S.deck.length + (S.partner ? 2 : 1) - nOut + nIn) + ' cards.' : '') + '</p>';
  if(R.ins.length) h += '<div class="sh-diffhead">Coming in</div><ul class="bs-diff">' + rows(R.ins, 'bs-add') + '</ul>';
  if(R.outs.length) h += '<div class="sh-diffhead">Going out</div><ul class="bs-diff">' + rows(R.outs, 'bs-rm') + '</ul>';
  if(R.side) h += '<p class="sh-sub">Your list has a side deck section, so your side deck becomes exactly that (' + R.side.reduce(function(s, x){ return s + x.q; }, 0) + ' cards).</p>';
  if(R.notIn && R.notIn.length) h += '<p class="sh-sub">Not in the deck, so nothing to take out: ' + R.notIn.map(function(x){ return esc(x.n); }).join(', ') + '.</p>';
  if(L.missing.length) h += '<div class="bs-callout bs-warn">' + ico('warn') + '<p>Scryfall has no card called ' + L.missing.map(function(n){ return '<b>' + esc(n) + '</b>'; }).join(', ') + '. Fix the spelling, or those stay out.</p></div>';
  if(bad.length) h += '<div class="bs-callout bs-warn">' + ico('warn') + '<p>These cannot go in: ' + bad.map(esc).join('; ') + '.</p></div>';
  box.innerHTML = h;
  me.go.disabled = false;
}

function landish(n, c){ if(isBasicName(n)) return true; var x = c || poolCard(n); return !!(x && x.type && isLand(x)); }
async function nowApply(){
  var me = NOW; if(!me || me.busy) return;
  if(!me.L){ await nowPreview(); if(!me.L) return; }
  me.busy = true; me.go.disabled = true;
  var R = me.R, L = me.L, errs = [], done = 0;
  // One Undo for the whole update.
  pushUndo('your deck now'); var u = SWUNDO[SWUNDO.length - 1];
  var outs = [], ins = [];
  R.outs.forEach(function(x){ for(var k = 0; k < x.q; k++) outs.push(x.n); });
  R.ins.forEach(function(x){ var c = L.cards[key(x.n)]; if(!c) return; for(var k = 0; k < x.q; k++) ins.push(c); });
  // Lands swap with lands where they can, so each card takes a slot of its own kind.
  var pairs = [];
  [true, false].forEach(function(land){
    ins.filter(function(c){ return !c._p && landish(c.n, c) === land; }).forEach(function(c){
      var i = outs.findIndex(function(o){ return o && landish(o) === land; }); if(i < 0) return;
      pairs.push([outs[i], c]); outs[i] = null; c._p = 1;
    });
  });
  ins.filter(function(c){ return !c._p; }).forEach(function(c){ var i = outs.findIndex(function(o){ return !!o; }); if(i >= 0){ pairs.push([outs[i], c]); outs[i] = null; c._p = 1; } });
  pairs.forEach(function(p){
    var inn = isBasicName(p[1].n) ? p[1].n : p[1];
    var r = changeDeck(p[0], inn, 'In your deck now.', false, { trust:true });
    if(r === true){ done++; return; }
    errs.push(r);
    if(changeDeck(p[0], null, '', false, {}) === true) done++;   // it left his deck either way
  });
  outs.filter(Boolean).forEach(function(n){ var r = changeDeck(n, null, '', false, {}); if(r === true) done++; else errs.push(r); });
  ins.filter(function(c){ return !c._p; }).forEach(function(c){
    var r = changeDeck(null, isBasicName(c.n) ? c.n : c, 'In your deck now.', false, { trust:true, over:true });
    if(r === true) done++; else errs.push(r);
  });
  ins.forEach(function(c){ delete c._p; });
  if(R.side){ S.boards = S.boards || { side:[], maybe:[] }; S.boards.side = R.side.map(function(x){ return { n:(poolCard(x.n) || { n:x.n }).n, q:x.q }; }).sort(function(a, b){ return a.n.localeCompare(b.n); }); done++; }
  if(!done){ SWUNDO.pop(); me.busy = false; me.go.disabled = false; toast('Nothing changed. ' + errs.map(esc).join(' '), { kind:'bad', ms:9000 }); return; }
  S.side = null; save(); afterEdit();
  me.h.close();
  nowDone(u, R, errs);
}

function nowDone(u, R, errs){
  var B = S.boards || {}, side = (B.side || []).length, linked = !!S.mox;
  var h = bsSheet({ title:'Your deck is updated', body:function(b){
    b.innerHTML = '<div class="sh-imp">' +
      (errs.length ? '<div class="bs-callout bs-warn">' + ico('warn') + '<p>Left out: ' + errs.map(esc).join(' ') + '</p></div>' : '') +
      '<p class="sh-sub">' + (S.deck.length + (S.partner ? 2 : 1)) + ' cards in the deck, ' + (B.side || []).reduce(function(s, x){ return s + x.q; }, 0) + ' in the side deck.</p>' +
      (linked
        ? '<p class="sh-sub"><b>Now Moxfield.</b> Open the deck, press Bulk Edit. On the Main Deck tab, select all the text and paste the Main Deck over it. On the Sideboard tab, do the same with the Sideboard. Then Save.</p>' +
          '<div class="bs-acts" style="gap:var(--s3)"><button class="bs-btn bs-primary" type="button" data-mn="deck">' + ico('copy', 'bs-i16') + 'Copy the Main Deck</button>' +
          (side ? '<button class="bs-btn bs-primary" type="button" data-mn="side">' + ico('copy', 'bs-i16') + 'Copy the Sideboard</button>' : '') +
          '<button class="bs-btn bs-quiet" type="button" data-mn="open">' + ico('ext', 'bs-i16') + 'Open on Moxfield</button></div>' +
          (!side ? '<p class="sh-sub">Your side deck is empty: on Moxfield, clear the Sideboard tab\'s box.</p>' : '')
        : '<p class="sh-sub">This deck is not linked to a Moxfield deck of yours. Copy the whole deck, side deck included, and paste it into a new Moxfield deck.</p>' +
          '<div class="bs-acts"><button class="bs-btn bs-primary" type="button" data-mn="all">' + ico('copy', 'bs-i16') + 'Copy the whole deck</button></div>') +
      '</div>';
    b.onclick = function(e){
      var x = e.target.closest('[data-mn]'); if(!x) return;
      var k = x.getAttribute('data-mn');
      if(k === 'open'){ openOut(S.mox.url); return; }
      copy(moxPaste(k), { deck:'Copied the 99 for the Main Deck tab.', side:'Copied the side deck for the Sideboard tab.', all:'Copied the whole deck with its headings.' }[k]);
      x.classList.remove('bs-primary'); x.innerHTML = ico('check', 'bs-i16') + 'Copied';
    };
  }, actions:[{ label:'Undo all of it', kind:'quiet', fn:function(){ undoChange(u); } }, { label:'Done', kind:'primary' }] });
}
// Outside links go to Chrome on the PC (where he is signed in to Moxfield), a new tab elsewhere.
function openOut(url){
  if(LOCAL) fetch('/api/open', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ url:url }) }).catch(function(){ window.open(url, '_blank', 'noopener'); });
  else window.open(url, '_blank', 'noopener');
}

/* ================= Ask Claude ================= */
// B: how a top player reads and builds a Commander deck (Tom, 2026-10-21: "a lot smarter, like a super pro player").
// Every Claude prompt in Brewing Station carries it (window.PRO_DOCTRINE).
var DOCTRINE = [
  'HOW YOU THINK (a top Commander player):',
  '1. Plan first. Before judging any card, say in one line how this deck wins, what the commander does in that plan (engine, value, finisher, combo piece) and which turns matter. Judge every card by what it does for that plan, not by how strong it is in general. A card that looks weak alone can hold the deck up, and a strong card can do nothing here.',
  '2. Mana is the first thing that loses games. Check land count against the curve and the card draw, ramp that comes down on turns 1 to 3, colour sources against the pips, and how many cards cost 6 or more. Count; do not estimate.',
  '3. Efficiency. Cost against impact: what does the card do the turn it lands and the turn after. Favour cheap, flexible, instant-speed cards. A slow card must win the game or bury the table in value.',
  '4. Interaction. Count answers by threat type (creature, artifact, enchantment, planeswalker, graveyard, stack, a whole board). Prefer cheap and flexible answers. The deck must protect its engine or commander, and its board wipes must suit its own plan.',
  '5. Card flow. Repeatable draw and engines beat one-shot draw. Tutors are only as good as their targets: name them.',
  '6. Winning. Count real ways to close the game and how they survive one removal spell or counterspell. Combos: name every piece, what must be in play first and how fragile they are. Fit the bracket: its expected game length, the Game Changer list and count given below, and the combo rules.',
  '7. The table. It is a four-player game: threat assessment, not becoming the archenemy too early, what the table will answer, what to play around.',
  '8. Swaps. Each one names the job, the card out and why it is the right cut in this deck, the card in and what it really does (read its rules text below), and the cost: curve, colours, synergy lost. Never cut combo pieces, engine pieces or cards he marked Keep unless he asks. Prefer cards from his side deck. Weigh each swap against the whole deck, never on its own.',
  '9. Truth. Read the rules text given; never go from memory for card text, rulings, Game Changers or legality. Use the app\'s numbers. If you are not sure, say so in a few words rather than guess.',
  '10. One-colour decks need no colour fixing: never suggest Commander\'s Sphere, Command Tower, Chromatic Lantern, any-colour lands or other fixing in a deck of one colour.'
].join('\n');
window.PRO_DOCTRINE = DOCTRINE;
var ASK = { busy:'', err:'', draft:'', paste:'', stage:'' };
// Memory (Tom, 2026-10-21: "increase the memory of brewing station"): the last 10 questions and answers in full
// (up to 4000 characters each), every older question of the conversation as one line, 100 kept per deck.
var KEEP = 10, ANSWER_CAP = 4000, NEW_SINCE = '2025-09-01';

function thread(){ S.ask = S.ask || { msgs:[] }; return S.ask.msgs; }
function deckSheet(){
  var L = [], b = +S.bracket || 3, BR = (typeof BRACKETS !== 'undefined' && BRACKETS[b]) || { name:'' };
  L.push('Commander: ' + S.cmd.n + (S.partner ? ' and ' + S.partner.n : '') + ' (colours: ' + ((S.ci || []).join('') || 'colourless') + ')');
  L.push('Bracket: ' + b + (BR.name ? ' (' + BR.name + ')' : '') + '. Game Changer limit: ' + (gcLimit() === Infinity ? 'none' : gcLimit()) + '.');
  var th = typeof themeLabel === 'function' ? themeLabel() : ''; if(th && th !== 'No theme') L.push('Theme: ' + th);
  L.push('Cards: ' + (S.deck.length + (S.partner ? 2 : 1)));
  // The Game Changers as Wizards lists them now (Scryfall, read live), not as Claude remembers them: its memory
  // still had Urza, Lord High Artificer and Mana Drain on Jin-Gitaxias (Tom, 2026-10-20: "how is it mistaking a card for a game changer??").
  var gcIn = [S.cmd, S.partner].filter(Boolean).concat(S.deck).filter(function(d, i, a){ return !d.basic && a.findIndex(function(x){ return x.n === d.n; }) === i; })
    .filter(function(d){ var c = poolCard(d.n) || d; return typeof isGC === 'function' ? isGC(c) : !!c.gc; }).map(function(d){ return d.n; });
  L.push('Game Changers in this deck: ' + (gcIn.length ? gcIn.join('; ') : 'none') + ' (' + gcIn.length + ' of ' + (gcLimit() === Infinity ? 'no limit' : gcLimit()) + '). This is the complete count, checked against the current official list; do not count any other card as a Game Changer.');
  if((S.gcNames || []).length) L.push('The current official Game Changer list (cards not on it are not Game Changers, even if they used to be): ' + S.gcNames.join('; '));
  var by = {};
  S.deck.forEach(function(d){ var g = typeGroup(d); (by[g] = by[g] || {}); by[g][d.n] = (by[g][d.n] || 0) + 1; });
  TYPE_GROUPS.forEach(function(g){
    var m = by[g]; if(!m) return;
    var names = Object.keys(m).sort(), n = names.reduce(function(s, k){ return s + m[k]; }, 0);
    L.push(g + (g === 'Sorcery' ? ' cards' : 's') + ' (' + n + '): ' + names.map(function(k){ return (m[k] > 1 ? m[k] + ' ' : '') + k; }).join('; '));
  });
  var B = S.boards || {};
  if((B.side || []).length) L.push('Side deck (cards he owns for this deck, not in it now): ' + B.side.map(function(x){ return (x.q > 1 ? x.q + ' ' : '') + x.n; }).join('; '));
  if((B.maybe || []).length) L.push('Considering: ' + B.maybe.map(function(x){ return x.n; }).join('; '));
  if((S.rejects || []).length) L.push('He turned these down before, do not suggest them: ' + S.rejects.map(function(x){ return x.inn; }).join('; '));
  // Every card's rules text, so Claude reads what the cards do instead of remembering (Tom picked E, 2026-10-20);
  // side deck cards only when newer than Claude may know.
  var seen = {}, rows = [];
  [S.cmd, S.partner].filter(Boolean).concat(S.deck).forEach(function(d){ if(d.basic || seen[d.n]) return; seen[d.n] = 1; var c = poolCard(d.n) || (d.o ? d : null); if(c) rows.push(c); });
  (B.side || []).forEach(function(x){ var c = poolCard(x.n); if(c && !seen[c.n] && c.rel && c.rel >= NEW_SINCE){ seen[c.n] = 1; rows.push(c); } });
  if(rows.length){
    L.push('', 'Rules text of every card above (read these, do not go from memory):');
    rows.forEach(function(c){ L.push('- ' + c.n + ' ' + (c.cost || '') + ' | ' + c.type + ' | ' + String(c.o || '').replace(/\n/g, ' / ')); });
  }
  return L.join('\n');
}
// The deck's combos from Commander Spellbook with their steps, so Claude explains real ones (Tom,
// 2026-10-19: "detail the combos it tells me about"). Kept in ASK.cmb for the copy-the-question path.
async function comboLines(){
  try{
    var r = await ENGINE.combos(), l = ((r && r.inDeck) || []).slice(0, 8);
    var st = await Promise.all(l.map(function(o){ return comboSteps(o.id).catch(function(){ return null; }); }));
    ASK.near = ((r && r.near) || []).slice(0, 10).map(function(o){ return o.cards.join(' + ') + ' (missing ' + o.missing + '): ' + (o.result || o.res || ''); });
    ASK.cmb = l.map(function(o, i){ var s = st[i];
      return '- ' + o.cards.join(' + ') + ': ' + o.result + '.' + (s && (s[1] || []).length ? ' Before: ' + s[1].join(' ') : '') +
        (s && (s[0] || []).length ? ' Steps: ' + s[0].map(function(x, j){ return (j + 1) + ') ' + x; }).join(' ') : ''); });
  }catch(e){ ASK.cmb = ASK.cmb || []; }
  return ASK.cmb;
}
// His own categories (Tom, 2026-10-20: "Let brewing station see my personal categories"): each with its
// cards, then the ones that also count there.
function catLines(){
  if(typeof cats !== 'function' || !cats().list.length) return [];
  var home = {}, also = {}, none = [];
  S.deck.forEach(function(d){
    if(d.basic) return;
    var h = catOf(d.n); if(h) (home[h] = home[h] || []).push(d.n); else if(none.indexOf(d.n) < 0) none.push(d.n);
    catAlso(d.n).forEach(function(t){ (also[t] = also[t] || []).push(d.n); });
  });
  var L = cats().list.map(function(t){
    return t + ': ' + ((home[t] || []).join('; ') || 'nothing yet') + ((also[t] || []).length ? '. Also counts here: ' + also[t].join('; ') : '');
  });
  if(none.length) L.push('No category yet: ' + none.join('; '));
  return L;
}
// What the app itself measured (Tom picked A, 2026-10-20), so Claude works from the same numbers as the
// Analysis tab instead of guessing them. Every part is optional: a part that fails is left out.
function analysisLines(){
  var E = window.ENGINE, L = [], t = function(f){ try{ return f(); }catch(e){ return null; } };
  if(!E) return L;
  var sc = t(function(){ return E.score(); });
  if(sc) L.push('Deck score ' + sc.score + ' of 10: ' + sc.parts.map(function(p){ return p.label + ' ' + p.score; }).join(', ') + '.');
  var P = t(function(){ return E.pillars(); });
  if(P && P.consistency) [['consistency', 'Consistency'], ['efficiency', 'Efficiency'], ['interaction', 'Interaction'], ['wincons', 'Win conditions']].forEach(function(d){
    var p = P[d[0]]; if(!p) return;
    var gaps = (p.parts || []).filter(function(x){ return x.weight > 0 && x.value < 0.8; }).map(function(x){ return x.label + ' ' + x.have + (typeof x.want === 'number' ? ' of ' + x.want : ''); });
    L.push(d[1] + ' ' + p.score + ' of 10. ' + (p.verdict || '') + (gaps.length ? ' Short: ' + gaps.join('; ') + '.' : ''));
  });
  var G = t(function(){ return E.guides(); }) || [];
  var gf = G.filter(function(g){ return g.status === 'fix' || g.status === 'watch'; });
  if(gf.length) L.push('Guidelines not met: ' + gf.map(function(g){ return (g.status === 'fix' ? 'FIX ' : 'watch ') + g.title + (g.line ? ' (' + g.line + ')' : ''); }).join('; '));
  var A = t(function(){ return E.answers(); });
  if(A && A.rows) L.push('Answers by kind of threat: ' + A.rows.map(function(r){ return r.label + ' ' + r.n + (r.instant != null ? ' (' + r.instant + ' instant)' : ''); }).join(', ') + '.');
  var K = t(function(){ return E.links(); });
  if(K && K.engines && K.engines.length) L.push('Most linked cards (the engine): ' + K.engines.slice(0, 8).map(function(e){ return e.n + ' (' + e.count + ' links)'; }).join('; '));
  if(K && K.loners && K.loners.length) L.push('Cards linked to nothing else: ' + K.loners.slice(0, 12).join('; '));
  return L;
}
// C: the numbers a strong player checks on EDHREC, from the pool the app already loaded: each card's share of
// this commander's decks and its synergy, then the most played cards this deck does not run.
function edhOf(c){ var s = (c && c.stats) || {}; return s.base || s.theme || s.bracket || s.exp || null; }
function pc(x){ return Math.round(x * 100) + '%'; }
function edhLines(){
  var L = [], pool = S.pool ? (Array.isArray(S.pool) ? S.pool : Object.keys(S.pool).map(function(k){ return S.pool[k]; })) : [];
  var inDeck = {}; S.deck.forEach(function(d){ inDeck[d.n.toLowerCase()] = 1; });
  var mine = [], seen = {};
  S.deck.forEach(function(d){ if(d.basic || seen[d.n]) return; seen[d.n] = 1; var e = edhOf(poolCard(d.n)); mine.push(e && e.pd ? d.n + ' ' + pc(e.inc) + (e.syn != null ? ', synergy ' + (e.syn >= 0 ? '+' : '') + pc(e.syn) : '') : d.n + ' not on EDHREC\'s page'); });
  if(mine.length) L.push('Each card in the deck, share of ' + shortName(S.cmd.n) + ' decks on EDHREC and synergy: ' + mine.join('; '));
  var side = {}; ((S.boards || {}).side || []).forEach(function(x){ side[x.n.toLowerCase()] = 1; });
  var miss = pool.filter(function(c){ var e = edhOf(c); return c && c.n && !inDeck[c.n.toLowerCase()] && e && e.pd && !(typeof isBasicName === 'function' && isBasicName(c.n)) && (typeof withinCI !== 'function' || withinCI(c)) && c.legal === 'legal'; })
    .sort(function(a, b){ return edhOf(b).inc - edhOf(a).inc; }).slice(0, 30);
  if(miss.length) L.push('Most played cards for this commander that the deck does not run: ' + miss.map(function(c){ var e = edhOf(c); return c.n + ' ' + pc(e.inc) + (e.syn != null ? ', synergy ' + (e.syn >= 0 ? '+' : '') + pc(e.syn) : '') + (side[c.n.toLowerCase()] ? ', in his side deck' : '') + (typeof isGC === 'function' && isGC(c) ? ', Game Changer' : ''); }).join('; '));
  if((ASK.near || []).length) L.push('Combos one card away (Commander Spellbook): ' + ASK.near.join('; '));
  var E = window.ENGINE;
  if(E && E.saltOf){ var sl = []; S.deck.forEach(function(d){ var v = E.saltOf(d.n); if(v >= 1 && sl.indexOf(d.n + ' ' + v) < 0) sl.push(d.n + ' ' + v); }); if(sl.length) L.push('EDHREC salt (0 to 4, how unhappy the card makes opponents), cards at 1 or more: ' + sl.join('; ')); }
  return L;
}
// The 99 as names, one per copy, kept on each question so the next one can say what changed in between.
function deckNames(){ return S.deck.map(function(d){ return d.n; }).sort(); }
function deckDiff(was){
  var c = {}; was.forEach(function(n){ c[n] = (c[n] || 0) - 1; }); deckNames().forEach(function(n){ c[n] = (c[n] || 0) + 1; });
  var ins = [], outs = [];
  Object.keys(c).forEach(function(n){ for(var i = 0; i < Math.abs(c[n]); i++) (c[n] > 0 ? ins : outs).push(n); });
  return { ins:ins, outs:outs };
}
function askPrompt(q){
  var L = [];
  L.push('You are a Magic: The Gathering Commander deckbuilding expert. Tom is asking about one of his decks in his deck app, Brewing Station.');
  L.push('Answer his question about the deck below. Plain English, direct, under 250 words unless he asks for more. No em dashes. No tables. Use exact English card names.');
  L.push(DOCTRINE, '');
  L.push('Write every card name in double square brackets, like [[Sol Ring]], so his app can show the card.');
  if(canDirect()) L.push('You can search the web (WebSearch, WebFetch) for rulings, current EDHREC pages and recent tournament or high-power lists when that would change your answer. Do not search for what is already given below.');
  L.push('Game Changers and bracket rules: use only the Game Changer list and count given below. Your memory of the list is out of date.');
  L.push('If you recommend changing cards, end the answer with one line per change in exactly this form, and nothing after them:');
  L.push('SWAP: <card in the deck> -> <card to put in>', 'CUT: <card in the deck>', 'ADD: <card>');
  L.push('A card going in must be legal in Commander and inside the colour identity. Prefer cards from his side deck when they do the job, since he owns them.');
  L.push('When you mention a combo, detail it: the pieces, what must be in play first, each step as a numbered list, and what it gets you. For a combo listed below, follow its Commander Spellbook steps.');
  L.push('Tom changes the deck between questions. THE DECK below is the deck as it is right now; earlier answers were about the deck as it was then. Never apologise for or correct an earlier answer because the deck changed, and never say a card count was wrong. When a change matters to the question, say it in one plain line ("Since then you added X").');
  L.push('', '=== THE DECK ===', deckSheet());
  var an = analysisLines();
  if(an.length){ L.push('', '=== WHAT THE APP MEASURED (its own numbers; use them, and say so when you disagree) ==='); an.forEach(function(x){ L.push(x); }); }
  var ed = edhLines();
  if(ed.length){ L.push('', '=== EDHREC AND COMMANDER SPELLBOOK ==='); ed.forEach(function(x){ L.push(x); }); }
  var kp = Object.keys(S.keep || {}).map(function(k){ var d = S.deck.filter(function(x){ return x.n.toLowerCase() === k; })[0]; return d ? d.n : ''; }).filter(Boolean);
  if(kp.length) L.push('', 'Cards he marked Keep, never suggest cutting them: ' + kp.join('; '));
  var tl = typeof tasteLines === 'function' ? tasteLines() : [];
  if(tl.length){ L.push('', '=== HIS PAST CHOICES ACROSS HIS DECKS (learn his taste from these; do not suggest what he keeps turning down) ==='); tl.forEach(function(x){ L.push(x); }); }
  var cl = catLines();
  if(cl.length) L.push('', '=== HIS OWN CATEGORIES (how he groups the deck; use his names when you talk about a group) ==='); cl.forEach(function(x){ L.push(x); });
  if((ASK.cmb || []).length) L.push('', '=== COMBOS IN THE DECK (Commander Spellbook) ===', ASK.cmb.join('\n'));
  var all = thread().filter(function(m){ return m.a; }), t = all.slice(-KEEP), older = all.slice(0, Math.max(0, all.length - KEEP));
  if(older.length){ L.push('', '=== EARLIER QUESTIONS IN THIS CONVERSATION (' + older.length + ', questions only) ==='); older.forEach(function(m){ L.push('- ' + String(m.q).replace(/\s+/g, ' ').slice(0, 200)); }); }
  var last = t.length ? t[t.length - 1] : null;
  if(last && last.deck){
    var df = deckDiff(last.deck);
    L.push('', '=== CHANGED SINCE YOUR LAST ANSWER ===', df.ins.length || df.outs.length
      ? (df.ins.length ? 'In: ' + df.ins.join('; ') + '. ' : '') + (df.outs.length ? 'Out: ' + df.outs.join('; ') + '.' : '')
      : 'Nothing in the 99.');
  }
  if(t.length){
    L.push('', '=== EARLIER IN THIS CONVERSATION (last ' + t.length + ') ===');
    t.forEach(function(m){ L.push('Tom: ' + m.q, 'You: ' + (m.a.length > ANSWER_CAP ? m.a.slice(0, ANSWER_CAP) + ' [...]' : m.a), ''); });
  }
  L.push('', '=== TOM ASKS ===', q);
  return L.join('\n');
}
// Claude's answer -> { text, moves:[{kind:'swap'|'cut'|'add', out, inn}] }
function readAnswer(a){
  var moves = [], keep = [];
  String(a || '').split(/\r?\n/).forEach(function(line){
    var m = /^\s*[-*]?\s*(SWAP|CUT|ADD)\s*:\s*(.+?)\s*$/i.exec(line);
    if(!m){ keep.push(line); return; }
    var k = m[1].toLowerCase(), v = m[2].replace(/\*\*|\[\[|\]\]/g, '');
    if(k === 'swap'){ var p = v.split(/\s*(?:->|→|=>)\s*/); if(p.length === 2) moves.push({ kind:k, out:p[0].trim(), inn:p[1].trim() }); }
    else if(k === 'cut') moves.push({ kind:k, out:v.trim() });
    else moves.push({ kind:k, inn:v.trim() });
  });
  return { text:keep.join('\n').trim(), moves:moves };
}
function md(t){
  var out = [], list = null;
  // [[Card Name]] (asked for in the prompt) becomes a card name with its hover and card sheet.
  function inline(s){ return esc(s).replace(/\[\[([^\[\]]{2,90}?)\]\]/g, function(x, n){ return cardSpan(n); }).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>'); }
  function endList(){ if(list){ out.push('</' + list + '>'); list = null; } }
  String(t || '').split(/\r?\n/).forEach(function(line){
    var s = line.trim();
    if(!s){ endList(); return; }
    var hd = /^#{1,4}\s+(.+)$/.exec(s), ul = /^[-*•]\s+(.+)$/.exec(s), ol = /^\d+[.)]\s+(.+)$/.exec(s);
    if(hd){ endList(); out.push('<p class="mn-h">' + inline(hd[1]) + '</p>'); return; }
    if(ul || ol){ var tag = ul ? 'ul' : 'ol'; if(list !== tag){ endList(); out.push('<' + tag + '>'); list = tag; } out.push('<li>' + inline((ul || ol)[1]) + '</li>'); return; }
    endList(); out.push('<p>' + inline(s) + '</p>');
  });
  endList();
  return out.join('');
}
function canDirect(){ return LOCAL && CL.status && CL.status.available && CL.status.signed_in; }
function claudeOk(){
  if(!LOCAL) return;
  if(!CL.status && !ASK.checking){ ASK.checking = true; fetch('/api/claude/status').then(function(r){ return r.ok ? r.json() : { available:false }; }, function(){ return { available:false }; })
    .then(function(j){ CL.status = j; ASK.checking = false; if(APP.view === 'deck' && (S.page === 'ask' || S.page === 'analysis')) render(); }); }
}
// The same deck page Ask Claude gets, for Claude's check of the engine's swaps on Analysis (pages.js, Tom picked D).
window.askDeckPage = function(){
  var L = [DOCTRINE, '', '=== THE DECK ===', deckSheet()], an = analysisLines(), cl = catLines(), tl = typeof tasteLines === 'function' ? tasteLines() : [], ed = edhLines();
  if(an.length){ L.push('', '=== WHAT THE APP MEASURED ==='); an.forEach(function(x){ L.push(x); }); }
  if(ed.length){ L.push('', '=== EDHREC AND COMMANDER SPELLBOOK ==='); ed.forEach(function(x){ L.push(x); }); }
  if(cl.length){ L.push('', '=== HIS OWN CATEGORIES ==='); cl.forEach(function(x){ L.push(x); }); }
  if(tl.length){ L.push('', '=== HIS PAST CHOICES ==='); tl.forEach(function(x){ L.push(x); }); }
  return L.join(String.fromCharCode(10));
};
window.askCanDirect = function(){ claudeOk(); return canDirect(); };
function askRedraw(){ if(APP.view === 'deck' && S.page === 'ask') render(); }

// Done is read off the deck, so an Undo from anywhere puts the button back.
function inDeck(n){ return S.deck.some(function(d){ return sameName(d.n, n) || sameName(n, d.n); }); }
// A basic land is in every deck already: adding one is done once the deck is back at 100.
function moveDone(m){ if(m.kind === 'add' && m.inn && isBasicName(m.inn)) return S.deck.length + (S.partner ? 2 : 1) >= 100; return (!m.inn || inDeck(m.inn)) && (!m.out || !inDeck(m.out)); }
// A name in the text, already escaped: a span, so it wraps with the words around it.
function cardSpan(n){ return '<span class="bs-cardlink" role="button" tabindex="0" data-card="' + n + '">' + n + '</span>'; }
// What each change Claude suggests does to the deck score, the same number the Fix rows show (Tom picked B,
// 2026-10-20). A card not in the pool is looked up once on Scryfall and the page drawn again.
var MVC = {}, MVS = {}, MVQ = {};
function moveCard(n){
  var c = poolCard(n) || MVC[n.toLowerCase()]; if(c) return c;
  var k = n.toLowerCase(); if(MVQ[k]) return null; MVQ[k] = 1;
  sfCollection([{ n:n }]).then(function(r){ var x = r.cards[k]; if(x){ x = Object.assign({}, x); x.stats = x.stats || {}; x.roles = x.roles || rolesOf(x); MVC[k] = x; askRedraw(); } }, function(){});
  return null;
}
function moveScore(m){
  var E = window.ENGINE; if(!E || !E.scoreWith || !E.score) return null;
  var inn = m.inn ? moveCard(m.inn) : null; if(m.inn && !inn) return { wait:true };
  var outD = m.out ? S.deck.filter(function(d){ return sameName(d.n, m.out) || sameName(m.out, d.n); })[0] : null;
  if(m.out && !outD) return null;
  var key = (E.key ? E.key() : S.deck.length) + '|' + (outD ? outD.n : '') + '>' + (inn ? inn.n : '');
  if(MVS[key]) return MVS[key];
  var a = E.score(), b = E.scoreWith([{ out:outD ? outD.n : null, inn:inn }]);
  if(!a || !b) return null;
  return (MVS[key] = { from:a.raw, to:b.raw, d:b.raw - a.raw, kept:!!(outD && S.keep && S.keep[outD.n.toLowerCase()]), out:outD ? outD.n : '' });
}
function moveScoreHtml(m, done){
  if(done) return '';
  var r = moveScore(m); if(!r) return '';
  if(r.wait) return '<span class="mn-move-s pg-fine">Working out the deck score…</span>';
  var E = window.ENGINE, cls = r.d >= 0.03 ? 'bs-pos' : r.d <= -0.03 ? 'bs-neg' : 'pg-fine';
  return '<span class="mn-move-s ' + cls + '">Deck score <b class="bs-num">' + E.scorePair(r.from, r.to) + '</b>' + (r.d <= -0.03 ? ', lowers it' : '') + '</span>' +
    (r.kept ? '<span class="mn-move-s bs-neg">You marked ' + esc(r.out) + ' Keep</span>' : '');
}
// Each change Claude suggests: its cards as names with their hover, and its own button beside them.
function moveHtml(m, i, done){
  var o = cardSpan(esc(m.out || '')), n = cardSpan(esc(m.inn || ''));
  var label = m.kind === 'swap' ? 'Swap ' + o + ' for ' + n : m.kind === 'cut' ? 'Move ' + o + ' to the side deck' : 'Add ' + n;
  var verb = m.kind === 'swap' ? 'Swap' : m.kind === 'cut' ? 'Move' : 'Add';
  return '<div class="mn-move"><span class="mn-move-t">' + label + moveScoreHtml(m, done) + '</span>' + (done ? '<span class="bs-badge bs-good">' + ico('check', 'bs-i16 pg-i12') + '<span>Done</span></span>'
    : '<button class="bs-btn bs-sm" type="button" data-mv="' + i + '">' + ico(m.kind === 'swap' ? 'swap' : m.kind === 'cut' ? 'side' : 'plus', 'bs-i16') + verb + '</button>') + '</div>';
}
function drawAsk(el){
  claudeOk();
  var T = thread(), direct = canDirect(), busy = ASK.busy === CUR;
  var h = '<div class="pg-root mn-ask">';
  h += '<div class="mn-head"><div><h2 class="mn-title">Ask Claude about this deck</h2>' +
    '<p class="pg-fine">Each question sends Claude one page about this deck and your last ' + KEEP + ' questions, never the whole conversation. Start a new conversation to change subject.</p></div>' +
    (T.length ? '<button class="bs-btn bs-sm bs-quiet" type="button" id="askNew">' + ico('refresh', 'bs-i16') + 'New conversation</button>' : '') + '</div>';
  if(!T.length){
    h += '<div class="mn-starts">' + ['What is this deck weakest at?', 'Which 5 cards should I cut first, and for what?', 'How does this deck actually win?', 'Which side deck cards deserve a slot back?'].map(function(q){
      return '<button class="bs-chip" type="button" data-start="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') + '</div>';
  }
  h += '<div class="mn-thread">';
  T.forEach(function(m, k){
    h += '<div class="mn-q">' + esc(m.q) + '</div>';
    if(m.a){
      var A = readAnswer(m.a);
      // Answers from before the [[ ]] marks: the cards it suggests still turn into names in its text.
      noteCardNames(A.moves.reduce(function(L, mv){ return L.concat(mv.out || [], mv.inn || []); }, []));
      h += '<div class="mn-a">' + md(A.text) +
        (A.moves.length ? '<div class="mn-moves">' + A.moves.map(function(mv, i){ return moveHtml(mv, k + ':' + i, moveDone(mv)); }).join('') + '</div>' : '') + '</div>';
    } else if(busy && k === T.length - 1){
      h += '<div class="mn-a">' + loadingLine(ASK.stage || 'Claude is answering') + '</div>';
    } else if(k === T.length - 1 && !direct){
      h += '<div class="mn-a mn-paste"><p class="pg-fine">Off the PC: copy the question, paste it into Claude, then paste Claude\'s whole answer here.</p>' +
        '<button class="bs-btn bs-sm" type="button" id="askCopy">' + ico('copy', 'bs-i16') + 'Copy the question for Claude</button>' +
        '<textarea id="askPaste" class="mn-ta" rows="5" placeholder="Paste Claude\'s answer">' + esc(ASK.paste) + '</textarea>' +
        '<button class="bs-btn bs-sm bs-primary" type="button" id="askPasteGo">Add the answer</button></div>';
    } else {
      h += '<div class="mn-a"><p class="pg-fine">No answer came back.</p><button class="bs-btn bs-sm" type="button" id="askRetry">' + ico('refresh', 'bs-i16') + 'Ask again</button></div>';
    }
  });
  h += '</div>';
  if(ASK.err) h += '<div class="bs-callout bs-bad">' + ico('warn') + '<p>' + esc(ASK.err) + '</p></div>';
  if(LOCAL && CL.status && CL.status.available && !CL.status.signed_in)
    h += '<div class="bs-callout bs-warn">' + ico('warn') + '<div class="sh-err"><p>Claude needs signing in once on this PC.</p><button class="bs-btn bs-sm" type="button" id="askLogin">Sign in to Claude</button></div></div>';
  h += '<div class="mn-form"><label class="bs-sr" for="askQ">Your question</label>' +
    '<textarea id="askQ" class="mn-ta" rows="3" placeholder="Ask anything about this deck. Ctrl+Enter sends."' + (busy ? ' disabled' : '') + '>' + esc(ASK.draft) + '</textarea>' +
    '<button class="bs-btn bs-primary" type="button" id="askGo"' + (busy ? ' disabled' : '') + '>' + 'Ask' + '</button></div>';
  h += '</div>';
  el.innerHTML = h;
  var th = el.querySelector('.mn-thread'); if(th && T.length) setTimeout(function(){ var last = el.querySelector('.mn-thread > :last-child'); if(last && last.scrollIntoView) last.scrollIntoView({ block:'nearest' }); }, 0);
  el.oninput = function(e){ if(e.target.id === 'askQ') ASK.draft = e.target.value; if(e.target.id === 'askPaste') ASK.paste = e.target.value; };
  el.onkeydown = function(e){ if(e.target.id === 'askQ' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); askSend(ASK.draft); } };
  el.onclick = function(e){
    var t = e.target, s = t.closest('[data-start]'); if(s){ askSend(s.getAttribute('data-start')); return; }
    var mv = t.closest('[data-mv]'); if(mv){ doMove(mv.getAttribute('data-mv')); return; }
    if(t.closest('#askGo')){ askSend(ASK.draft); return; }
    if(t.closest('#askNew')){ var old = S.ask; S.ask = { msgs:[] }; save({ quiet:true }); render(); toast('New conversation.', { undo:function(){ S.ask = old; save({ quiet:true }); render(); return true; } }); return; }
    if(t.closest('#askRetry')){ var q = thread().pop().q; save({ quiet:true }); askSend(q); return; }
    if(t.closest('#askCopy')){ var T2 = thread(), last = T2[T2.length - 1]; T2.pop(); var p = askPrompt(last.q); T2.push(last); copy(p, 'Copied. Paste it into Claude.'); return; }
    if(t.closest('#askPasteGo')){ var T3 = thread(), l3 = T3[T3.length - 1]; if(!ASK.paste.trim()) return; l3.a = ASK.paste.trim(); l3.at = Date.now(); ASK.paste = ''; save({ quiet:true }); render(); return; }
    if(t.closest('#askLogin')){ fetch('/api/claude/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' }); CL.status = null; toast('A window opens to sign in. Come back here after.'); return; }
  };
}
async function askSend(q){
  q = String(q || '').trim(); if(!q || ASK.busy) return;
  var T = thread(); T.push({ q:q, a:'', at:Date.now(), deck:deckNames() }); if(T.length > 100) T.splice(0, T.length - 100);
  ASK.draft = ''; ASK.err = '';
  save({ quiet:true });
  if(!canDirect()){ comboLines(); render(); return; }   // the copy / paste box shows under the question
  var mine = CUR, D = S, msg = T[T.length - 1];
  // The prompt leaves out the question being asked, so it is not counted twice.
  ASK.busy = mine; render();
  await comboLines();
  try{ if(window.ENGINE && ENGINE.loadSalt) await ENGINE.loadSalt(); }catch(e){}
  if(CUR !== mine || S !== D){ ASK.busy = ''; askRedraw(); return; }
  T.pop(); var prompt = askPrompt(q); T.push(msg);
  try{
    ASK.stage = 'Claude is answering'; askRedraw();
    var r = await fetch('/api/claude/ask', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ prompt:prompt, web:true }) });
    var j = await r.json();
    if(j.error) throw new Error(j.error);
    var draft = String(j.text || '').trim();
    // E: a second read of its own answer against the same page before he sees it.
    if(draft && CUR === mine && S === D){
      ASK.stage = 'Claude is checking its answer'; askRedraw();
      try{
        var r2 = await fetch('/api/claude/ask', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ prompt:checkPrompt(prompt, draft) }) });
        var j2 = await r2.json();
        if(!j2.error && String(j2.text || '').trim().length > 40) draft = String(j2.text).trim();
      }catch(e2){}   // the draft stands when the check fails
    }
    msg.a = draft; msg.at = Date.now();
    if(CUR === mine && S === D) save({ quiet:true });
    else toast('Claude\'s answer came back after you left that deck, so it was dropped. Ask again there.', { kind:'bad', ms:9000 });
  }catch(e){ ASK.err = 'Claude could not answer: ' + e.message; }
  ASK.busy = ''; ASK.stage = '';
  askRedraw();
}
// E: the answer read again by a strict checker, with the whole page it was written from.
function checkPrompt(prompt, draft){
  return [prompt, '', '=== YOUR DRAFT ANSWER ===', draft, '', '=== NOW CHECK IT ===',
    'You wrote the draft above. Check every claim in it against the page: card rules text, counts, which cards are in the deck or the side deck, legality, colour identity, Game Changers, bracket rules, combos and their pieces, and the app\'s numbers. Check each swap against the whole deck (rule 8). Fix every mistake, cut anything you cannot back, keep what is right.',
    'Reply with only the final answer for Tom, in the same format (card names in [[ ]], SWAP / CUT / ADD lines last). Do not mention the checking.'].join('\n');
}
async function doMove(id){
  var p = id.split(':'), m = thread()[+p[0]]; if(!m) return;
  var mv = readAnswer(m.a).moves[+p[1]]; if(!mv) return;
  var inCard = null;
  if(mv.inn){
    if(isBasicName(mv.inn)) inCard = mv.inn;
    else {
      inCard = poolCard(mv.inn);
      if(!inCard){
        var raw = await sf('/cards/named?exact=' + encodeURIComponent(mv.inn)) || await sf('/cards/named?fuzzy=' + encodeURIComponent(mv.inn));
        if(!raw){ toast('Scryfall has no card called ' + esc(mv.inn) + '.', { kind:'bad' }); return; }
        inCard = slim(raw); inCard.stats = {}; inCard.roles = rolesOf(inCard);
      }
    }
  }
  var r = applyChange(mv.kind === 'add' ? null : mv.out, mv.kind === 'cut' ? null : inCard, 'Claude, asked in Ask Claude.', mv.kind === 'cut' ? { to:'side' } : mv.kind === 'add' ? { over:true } : undefined);
  if(r !== true){ toast(esc(r), { kind:'bad' }); return; }
  askRedraw();
  toast(changeToast(), { undo:undoTop(askRedraw) });
}

window.PAGES = window.PAGES || {};
window.PAGES.ask = { label:'Ask Claude', needsPool:true, render:drawAsk };
})();
