/* ============ Brewing Station ENGINE (build/engine.js) ============
   Contract 2 of the build spec. Pure analysis of the OPEN deck (global S) with its
   pool loaded. It never saves and never changes the deck. (The one touch on S: the
   test games add 'cmdr' to S.wins for a moment when the commander is a threat, and
   take it out again in the same call.) It loads after the page's inline script, so
   the page's globals (S, poolCard, score, rolesOf, isGC, ...) are in scope.

   Everything that judges shows its working: every score lists the cards it counted.
   Everything that reads cards reads the rules text (the card's own name, and "this
   creature" style self references, become ~), never a list of card names, so it works
   on any deck. The commander counts three times wherever the deck's plan is read.

   Sync calls are cached per deck (the cache key changes whenever a card, a job,
   the bracket or the pool changes). Network calls return Promises and cache through
   cacheGet/cachePut (always awaited, so an async cache works too).
   Nothing here throws for missing data: lists come back empty with a `note`. */
(function(){
'use strict';

var E = {};
var DAY_MS = 864e5;

/* ---------- small helpers ---------- */
function lc(s){ return String(s == null ? '' : s).toLowerCase(); }
function front(n){ return lc(n).split(' // ')[0]; }
function r1(x){ return Math.round(x * 10) / 10; }
function r2(x){ return Math.round(x * 100) / 100; }
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function pc(x){ return Math.round((x || 0) * 100) + '%'; }
function words(n, one, many){ return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function uniq(a){ var s = {}, o = []; a.forEach(function(x){ if(!s[x]){ s[x] = 1; o.push(x); } }); return o; }
function withNote(v, note){ if(note) v.note = note; return v; }
function rxEsc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function bk(){ var b = +S.bracket; return b >= 1 && b <= 5 ? b : 3; }
function short(){ return S.cmd ? S.cmd.n.split(',')[0].split(' // ')[0] : 'this commander'; }
function has(){ return typeof S !== 'undefined' && S && S.cmd; }
function fixOf(n){ var f = S.roleFix || {}; if(f[n]) return f[n]; for(var k in f) if(sameName(n, k) || sameName(k, n)) return f[k]; return ''; }
function winsOk(){ return Array.isArray(S.wins); }
function safeScore(c){
  if(!c || !c.stats) return 0.05;
  try{ return winsOk() ? score(c) : bestInc(c); }catch(e){ return 0.05; }
}
function isGc(c){ try{ return !!c && isGC(c); }catch(e){ return !!(c && c.gc); } }
// Not out yet: Scryfall already lists preview cards as legal, so the release date decides.
function notOutYet(c){ return !!(c && c.rel) && c.rel > new Date().toISOString().slice(0, 10); }
function noUnreleased(c){ try{ return !unreleased(c) && !notOutYet(c); }catch(e){ return true; } }
function okAdd(c){
  if(!c || c.legal !== 'legal') return false;
  try{ if(!withinCI(c)) return false; }catch(e){ return false; }
  if(!noUnreleased(c)) return false;
  if(!c.roles) c = Object.assign({}, c, { roles:rolesFor(c) });
  try{ return allowed(c); }catch(e){ return true; }
}

/* ---------- fast name lookups (poolCard is a linear search) ---------- */
var PIX = { pool:null, len:-1, map:{} };
function pix(){
  var p = (S && S.pool) || [];
  if(PIX.pool === p && PIX.len === p.length) return PIX.map;
  var m = {};
  p.forEach(function(c){ var k = lc(c.n), f = front(c.n); if(!m[k]) m[k] = c; if(!m[f]) m[f] = c; });
  PIX = { pool:p, len:p.length, map:m };
  return m;
}
function pcard(n){ if(!n) return null; var m = pix(); return m[lc(n)] || m[front(n)] || null; }
function cmdCards(){
  return [S.cmd, S.partner].filter(Boolean).map(function(c){ return pcard(c.n) || c; });
}
var ROLES = {};
function rolesFor(c){
  if(c.roles) return c.roles;
  var k = c.n + '|' + (c.o || '').length;
  return ROLES[k] || (ROLES[k] = (function(){ try{ return rolesOf(c); }catch(e){ return {}; } })());
}

/* ---------- rules text: lower case, no reminder text, self references become ~ ---------- */
var TXT = {};
var SELF_RX = /\bthis (?:creature|artifact|enchantment|equipment|land|permanent|vehicle|aura|planeswalker|card|spell|token|battle|saga|class|case|room|siege|kindred)\b/g;
function tx(c){
  var key = c.n + '|' + (c.o || '').length;
  if(TXT[key] != null) return TXT[key];
  var o = noUlt(lc(c.o).replace(/\([^)]*\)/g, ''));
  var names = [lc(c.n)].concat(lc(c.n).split(' // '));
  names.slice().forEach(function(n){ var s = n.split(', ')[0]; if(s !== n && s.length >= 4) names.push(s); });
  uniq(names).sort(function(a, b){ return b.length - a.length; }).forEach(function(n){ if(n) o = o.split(n).join('~'); });
  o = o.replace(SELF_RX, '~');
  return (TXT[key] = o);
}
// A planeswalker's ultimate (a loyalty cost of 6 or more) and emblems are not what the card does in a
// normal game, so they never count toward its jobs or plans (Garruk's -7 is not a tutor).
function noUlt(o){
  return o.replace(/(?:^|\n)[\u2212-](?:[6-9]|\d\d+): [^\n]*/g, '\n').replace(/you get an emblem with "[^"]*"\.?/g, '').replace(/^\n+/, '');
}
// Damage amplifiers (Torbran, Fiery Emancipation): every token, attacker and ping hits harder.
var DMG_AMP = /deals? that much damage plus \d|deals? (?:double|triple|twice|three times) that (?:much )?damage|if a (?:[a-z]+ )?source you control would deal damage|\bred sources you control\b/;
// The text with "create ... tokens" clauses taken out, so a card that only makes
// Goblin tokens is not read as a card that rewards Goblins.
function rest(o){ return o.replace(/\bcreates? [^.]*?\btokens?\b/g, ' '); }

/* ---------- themes, read off rules text ----------
   en(c, o, rest, R) -> weight when the card feeds the theme (enabler).
   pay(c, o, rest, R) -> true when the card rewards the theme (payoff).
   full = enablers for a full load in 99 cards; pf = payoffs for a full load.
   enN/payN are plural phrases for notes, enW/payW singular ones for links. */
// Keywords whose only mention of tokens is in the reminder text (stripped) are listed by name.
var TOKEN_MAKER = /\bcreates? [^.]*?(?:\bcreature tokens?\b|\d+\/\d+[^.]*?\btokens?\b|token that's a copy|tokens? that are copies)|\bpopulate\b|\bamass\b|\bincubate\b|\bfabricate \d|\bmyriad\b|\bmobilize\b|\bafterlife \d|\boffspring\b|\bsquad\b|for mirrodin!|\bembalm\b|\beternalize\b|\bencore\b/;
function rx(re){ return function(c, o){ return re.test(o); }; }
function rxW(re){ return function(c, o){ return re.test(o) ? 1 : 0; }; }
var TH = [
  { k:'tokens', label:'Tokens', full:10, pf:4,
    enN:'make creature tokens', payN:'reward a wide board', enW:'makes creature tokens', payW:'rewards a wide board',
    en:function(c, o){ return TOKEN_MAKER.test(o) ? 1 : 0; },
    // Tested on the text without its own "create ... tokens" clauses (r), except the
    // triggers on creating tokens, which name tokens by nature (tested on o).
    pay:function(c, o, r){ return /if (?:one or more )?tokens? would be created|whenever you create [^.]*?\btokens?\b|whenever you (?:create or )?sacrifice (?:a|one or more) tokens?/.test(o) ||
      /\btokens? you control\b|\bcreature tokens?\b|whenever (?:one or more |a |an |another )?(?:other )?(?:nontoken )?creatures? (?:you control )?enters?\b|creatures you control get \+|for each (?:other )?creature you control|number of creatures you control/.test(r) || DMG_AMP.test(o); } },
  { k:'sacrifice', label:'Sacrifice and death', full:8, pf:3,
    enN:'give you bodies to sacrifice', payN:'turn deaths into value', enW:'gives it bodies to sacrifice', payW:'turns deaths into value',
    en:function(c, o){ return /\bwhen ~ dies\b/.test(o) || TOKEN_MAKER.test(o) ? 1 : 0; },
    pay:rx(/\bsacrifice (?:a|an|another|one or more|x|two|three|any number of) (?:other )?(?:[a-z-]+ )?[a-z]+\b[^.:"]*?:|additional cost[^.]*?sacrifice (?:a|an|another)|whenever [^.]*?\b(?:a|an|another|one or more)(?: other)?(?: nontoken)? [^.]*?\bdies\b|is put into (?:a|your) graveyard from the battlefield|creatures? (?:that )?died this turn|whenever you sacrifice|equipped creature dies|deals? that much damage plus \d|deals? (?:double|triple|twice|three times) that (?:much )?damage|if a (?:[a-z]+ )?source you control would deal damage/) },
  { k:'counters', label:'+1/+1 counters', full:10, pf:3,
    enN:'put +1/+1 counters out', payN:'reward counters', enW:'puts +1/+1 counters out', payW:'rewards +1/+1 counters',
    en:rxW(/\bputs? (?:a|an|one|two|three|four|x|that many|\w+) (?:additional )?\+1\/\+1 counters? on|enters(?: the battlefield)? with [^.]*?\+1\/\+1 counters?|\bdistribute [^.]*?\+1\/\+1|\bproliferate\b|\bbolster \d|\bsupport \d|\badapt \d|\boutlast\b|\bmentor\b|\btraining\b|\briot\b|\bevolve\b|\bmodular\b|\bgraft\b|\bmonstrosity\b|\bbackup \d/),
    pay:rx(/with (?:a|one or more) \+1\/\+1 counters? on (?:it|them)|for each \+1\/\+1 counter|if it had counters on it|whenever you put (?:a|one or more) [^.]*?counters? on|move (?:all|a|one or more|any number of) counters?|\+1\/\+1 counters? (?:would be )?(?:put|placed) on|whenever (?:one or more )?\+1\/\+1 counters? (?:are|is) put|number of \+1\/\+1 counters|twice that many [^.]*?counters|that many plus one|double the number of [^.]*?counters|creatures? you control with (?:counters|\+1\/\+1)|\bproliferate\b/) },
  { k:'graveyard', label:'Graveyard and recursion', full:8, pf:3,
    enN:'fill your graveyard', payN:'use your graveyard', enW:'fills your graveyard', payW:'uses your graveyard',
    en:rxW(/(?:^|[\n.:;,] ?)(?:then )?(?:you )?mills? (?:a|an|one|two|three|four|five|six|seven|x|\w+) cards?|\bsurveil \d|\bdredge\b|\bdiscards? (?:a|one|two|three|x|that many|your hand|their hand|\w+ cards?)|put (?:the top [^.]*?|that card|those cards) into your graveyard|each player discards|\bconniv/),
    pay:rx(/(?:return|put|cast|play) [^.]*?from (?:your|a|any) graveyards?|from your graveyard (?:to|onto)|cards? in your graveyard|creature card in a graveyard|return enchanted creature card|\bflashback\b|\bunearth\b|\bescape\b|\bembalm\b|\beternalize\b|\bdisturb\b|\bjump-start\b|\bretrace\b|\bdelve\b|\bthreshold\b|\bdelirium\b|\bencore\b|\bscavenge\b|\bundergrowth\b/) },
  { k:'spells', label:'Instants and sorceries', full:15, pf:3,
    enN:'are instants or sorceries', payN:'reward casting them', enW:'is an instant or sorcery', payW:'rewards casting instants and sorceries',
    en:function(c){ return /\b(?:Instant|Sorcery)\b/.test(c.type) ? 1 : 0; },
    pay:function(c, o){ var s = o.replace(/counter target [^.]*?spell/g, ''); return /whenever you cast (?:an?|your first|your second)? ?(?:instant|sorcery|noncreature)|instant (?:or|and) sorcery spells?|instant or sorcery cards?|noncreature spells?|\bprowess\b|\bmagecraft\b|copy target (?:instant|sorcery)|whenever you cast or copy|\bstorm\b/.test(s); } },
  { k:'artifacts', label:'Artifacts', full:15, pf:3,
    enN:'are or make artifacts', payN:'reward artifacts', enW:'is or makes an artifact', payW:'rewards artifacts',
    en:function(c, o){ return /\bArtifact\b/.test(c.type) || /\bcreates? [^.]*?\b(?:treasure|clue|food|blood|powerstone|map|gold|junk|incubator|thopter|servo|construct|artifact)\b[^.]*?\btokens?\b/.test(o) ? 1 : 0; },
    pay:rx(/\bartifacts? you control\b|whenever (?:an?|one or more|another) (?:nontoken )?artifacts? (?:you control )?(?:enters?|is put into)|for each artifact|number of artifacts|sacrifice (?:an?|another) artifact|\bimprovise\b|\baffinity for artifacts\b|\bmetalcraft\b|artifact spells?|whenever you cast an artifact|artifact creatures? you control/) },
  { k:'enchantments', label:'Enchantments', full:12, pf:3,
    enN:'are enchantments', payN:'reward enchantments', enW:'is an enchantment', payW:'rewards enchantments',
    en:function(c){ return /\bEnchantment\b/.test(c.type) ? 1 : 0; },
    pay:rx(/\benchantments? you control\b|whenever (?:an?|another|one or more) (?:nontoken )?enchantments? (?:you control )?enters?|whenever you cast an? (?:enchantment|aura)|for each enchantment|number of enchantments|\bconstellation\b|enchantment spells?/) },
  { k:'lifegain', label:'Life gain', full:8, pf:3,
    enN:'gain life', payN:'reward gaining life', enW:'gains life', payW:'rewards gaining life',
    en:rxW(/\blifelink\b|\byou gain (?:\d+|x|that much|an amount of|\w+) life|\bgains? (?:\d+|x) life|gain life equal/),
    pay:rx(/whenever you gain life|if you would gain life|life you(?:'ve)? gained|you gained life this turn|gained (?:\d+|x) or more life|amount of life you gained|whenever you gain \d+ or more life/) },
  { k:'landfall', label:'Landfall and extra lands', full:6, pf:3,
    enN:'put extra lands out', payN:'reward lands entering', enW:'puts extra lands out', payW:'rewards lands entering',
    en:rxW(/you may play (?:an? )?additional lands?|play an additional land|put (?:a|an|up to \w+|two|x|that many|those|it) [^.]*?lands? cards?[^.]*? onto the battlefield|search your library for [^.]*?lands? cards?[^.]*?(?:put|onto) [^.]*?battlefield|return [^.]*?lands? cards? from your graveyard to the battlefield|play lands from your graveyard|\bexplores?\b/),
    pay:rx(/\blandfall\b|whenever (?:a|an|one or more|another) (?:nontoken )?(?:lands?|mountains?|forests?|islands?|swamps?|plains) (?:you control )?enters?|whenever you play a land|for each land you control|number of lands you control/) },
  { k:'combat', label:'Attacking', full:8, pf:3,
    enN:'help your creatures attack', payN:'reward attacking', enW:'helps your creatures attack', payW:'rewards attacking',
    en:function(c, o){
      // Only cards that help the whole team (or any creature) attack; a creature's own haste does not count.
      return /creatures you control (?:get \+|(?:gain|have) [^.]*?\b(?:haste|trample|menace|flying|double strike|first strike)\b)|creatures (?:you control )?can't be blocked|untap all creatures you control|(?:target|equipped|enchanted) creature (?:gains?|has|gets \+\d+\/\+\d+ and (?:gains?|has)) [^.]*?\b(?:haste|trample|menace|flying|double strike)/.test(o) ? 1 : 0; },
    pay:function(c, o){ return /whenever [^.]*?\battacks?\b|whenever [^.]*?deals combat damage|attacking creatures?|creature attacking causes|combat damage to (?:a player|an opponent|one or more)|whenever you attack|additional combat|extra combat|\bbattle cry\b|\bmyriad\b|\bmelee\b|\bexalted\b|\bdethrone\b|\braid\b/.test(o) || DMG_AMP.test(o); } },
  { k:'etb', label:'Enter abilities and blink', full:8, pf:2,
    enN:'have an enter ability', payN:'repeat enter abilities', enW:'has an enter ability to repeat', payW:'repeats enter abilities',
    en:function(c, o){ return /\bCreature\b/.test(c.type) && /\bwhen ~ enters\b/.test(o) ? 1 : 0; },
    pay:rx(/exile (?:target|another target|up to (?:one|two|\w+) (?:other )?target|each|two target)[^.]*?(?:creatures?|permanents?|artifacts?)[^.]*?(?:,|\.)? (?:then )?return (?:it|them|that card|those cards)|return (?:it|that card|those cards|them) to the battlefield under (?:its|their) owner's control|\bblink\b|\bflicker\b|triggers an additional time|token that's a copy of (?:target|another)|tokens? that (?:are|is) (?:a )?cop(?:y|ies) of/) },
  { k:'drawpay', label:'Card draw payoffs', full:8, pf:2,
    enN:'draw extra cards', payN:'reward drawing', enW:'draws extra cards', payW:'rewards drawing cards',
    en:function(c, o, r, R){ return R.draw ? 1 : 0; },
    pay:rx(/whenever you draw (?:a|your second|one or more|your first)? ?cards?|for each card you(?:'ve)? drawn|cards? (?:you've )?drawn this turn|whenever (?:a player|an opponent|each opponent|one or more (?:players|opponents)) draws?|second card each turn/) },
  { k:'discard', label:'Discard', full:5, pf:2,
    enN:'discard cards', payN:'reward discarding', enW:'discards cards', payW:'rewards discarding',
    en:rxW(/\bdiscards? (?:a|one|two|three|x|that many|your hand|their hand|\w+ cards?)|\bdiscard your hand|each player discards|\bcycling\b|\bconniv|\bchannel\b|\bblood tokens?\b/),
    pay:rx(/whenever you discard|whenever (?:a player|an opponent|one or more (?:players|opponents)) discards?|\bmadness\b|whenever you cycle|cards? discarded this way/) },
  { k:'mill', label:'Mill', full:5, pf:2,
    enN:'mill opponents', payN:'reward full graveyards', enW:'mills opponents', payW:'rewards milling',
    en:rxW(/(?:target (?:player|opponent)|each (?:player|opponent)|that player|defending player|each other player) mills?\b/),
    pay:rx(/cards? in (?:an opponent's|each opponent's|target opponent's|target player's|opponents') graveyards?|for each card in (?:target|each|that) (?:player's|opponent's) graveyard|whenever (?:a card|one or more cards) (?:is|are) put into an opponent's graveyard|no cards in (?:their|his or her) library|opponents'? graveyards?/) },
  { k:'voltron', label:'Equipment and auras', full:6, pf:2,
    enN:'are Equipment or Auras', payN:'reward suiting up', enW:'is Equipment or an Aura', payW:'rewards Equipment and Auras',
    en:function(c, o){ return /\bEquipment\b/.test(c.type) || (/\bAura\b/.test(c.type) && /enchant creature|enchanted creature/.test(o)) ? 1 : 0; },
    pay:rx(/for each (?:equipment|aura)|(?:equipment|auras?) (?:you control|attached to)|whenever (?:an? |one or more )?(?:equipment|auras?) (?:you control )?(?:enters|becomes? attached)|equip abilities|equipped or enchanted|is equipped|becomes? equipped|enchanted by|\battach(?:es)? (?:target|an?|up to)|equipped creatures? you control|whenever ~ becomes the target of an aura/) },
  { k:'bigmana', label:'Big mana', full:12, pf:4,
    enN:'make extra mana', payN:'use big mana', enW:'makes extra mana', payW:'turns big mana into value',
    en:function(c, o, r, R){
      if(/add (?:one|an) additional|twice as much (?:mana|of)|twice that much mana|untap all lands|adds? (?:an )?additional (?:\{|mana)|add an amount of|add (?:\{[a-z0-9]\})+ for each|add x mana/.test(o)) return 1.5;
      if(/\b(?:Instant|Sorcery)\b/.test(c.type) && /\badd \{/.test(o)) return 1;
      return R.ramp ? 0.5 : 0; },
    pay:function(c, o){ return (!isLand(c) && (/\{X\}/.test(c.cost || '') || c.mv >= 7)) || /\{x\}[^.:\n]*:/.test(o) || /(?:^|\n)\{\d+\}(?:\{[a-z]\})*: (?!add)/.test(o); } },
  { k:'exile', label:'Cast from exile or the top', full:5, pf:2,
    enN:'let you cast from exile or the top', payN:'reward casting from exile', enW:'lets you cast from exile or the top', payW:'rewards casting from exile',
    en:rxW(/exile the top [^.]*?(?:you may (?:play|cast)|until)|you may (?:play|cast) [^.]*?(?:from the top of your library|from exile|exiled with)|look at the top card of your library (?:at )?any time|\bforetell\b|\bplot\b|\bsuspend\b|\bcascade\b|\bdiscover \d|\badventure\b/),
    pay:rx(/whenever you cast a spell from (?:exile|anywhere other than your hand)|cast from exile|spells? you cast from (?:exile|anywhere)|cards? you own in exile|from anywhere other than your hand/) },
  { k:'walkers', label:'Planeswalkers', full:5, pf:2,
    enN:'are planeswalkers', payN:'reward planeswalkers', enW:'is a planeswalker', payW:'rewards planeswalkers',
    en:function(c){ return /\bPlaneswalker\b/.test(c.type) ? 1 : 0; },
    // Loyalty, planeswalkers, proliferate, or counters of every kind ("one or more counters", as on
    // Doubling Season). A +1/+1 counter doubler does nothing for a planeswalker, and a planeswalker
    // putting loyalty on itself rewards nothing.
    pay:function(c, o){ var s = o.replace(/loyalty counters? on ~/g, ''); return /\bplaneswalkers? you control\b|loyalty abilit|loyalty counters?|whenever you activate a loyalty ability|planeswalker spells?|\bproliferate\b|twice that many (?:of (?:those|each of those kinds of) )?counters|one or more counters\b|counters? (?:would be )?put on (?:a|each) planeswalker/.test(s); } },
  { k:'edicts', label:'Opponents sacrifice and discard', full:5, pf:2,
    enN:'make opponents sacrifice or discard', payN:'reward it', enW:'makes opponents sacrifice or discard', payW:'rewards opponents sacrificing or discarding',
    en:rxW(/(?:each opponent|target (?:player|opponent)|each player|defending player|that player|each other player|controller) (?:sacrifices|discards)|(?:opponent|player) (?:sacrifices|discards) [^.]*?unless/),
    pay:rx(/whenever (?:an opponent|a player|one or more (?:opponents|players)) (?:sacrifices|discards)|whenever an opponent sacrifices [^.]*? or discards|(?:onto|to) the battlefield under your control from (?:their|a|an opponent's) graveyard/) },
  { k:'untap', label:'Tap abilities and untapping', full:3, pf:3,
    enN:'have tap abilities worth repeating', payN:'untap them or give haste', enW:'has a tap ability worth repeating', payW:'untaps it or gives it haste',
    en:function(c, o){ return /\bCreature\b/.test(c.type) && /(?:^|\n)[^:\n"]*\{t\}[^:\n"]*:/.test(o) && !/(?:^|\n)\{t\}: add /.test(o) ? 1 : 0; },
    pay:rx(/untap (?:another )?target (?:creature|permanent|legendary creature)|untap (?:equipped|enchanted) creature|untap all creatures|as though (?:it|they|those creatures) had haste|(?:equipped|enchanted|target) creature (?:gains?|has) [^.]*?\bhaste\b|\b[a-z]+s you control [^.]*?\b(?:have|gain) [^.]*?\bhaste\b|copy (?:that|target) (?:activated )?ability|has all activated abilities of (?:all )?creatures you control|whenever an ability of (?:equipped|enchanted) creature is activated|whenever you activate an ability/) }
];
var THK = {}; TH.forEach(function(t){ THK[t.k] = t; });

/* Tribal themes are built per deck: the commander's creature types, plus any type
   that 8 or more of the deck's creatures share. */
var PLURAL = { hero:'Heroes', mouse:'Mice', ox:'Oxen', fungus:'Fungi', djinn:'Djinn', sheep:'Sheep', fish:'Fish', homunculus:'Homunculi', cyclops:'Cyclopes', mongoose:'Mongooses', octopus:'Octopuses' };
function pluralT(t){
  var l = t.toLowerCase();
  if(PLURAL[l]) return PLURAL[l];
  if(/[^aeiou]y$/.test(l)) return t.slice(0, -1) + 'ies';
  if(/(?:elf|dwarf|wolf)$/.test(l)) return t.slice(0, -1) + 'ves';
  if(/(?:s|x|ch|sh)$/.test(l)) return t + 'es';
  return t + 's';
}
var TRX = {};
function tribeRx(t){ return TRX[t] || (TRX[t] = new RegExp('\\b(?:' + rxEsc(t.toLowerCase()) + '|' + rxEsc(pluralT(t).toLowerCase()) + ')\\b')); }
function creatureTypes(c){ return /\b(?:Creature|Kindred|Tribal)\b/.test(c.type || '') ? subtypes(c).filter(function(s){ return !/^(?:Equipment|Aura|Vehicle|Saga|Food|Treasure|Clue)$/.test(s); }) : []; }
function tribeTheme(t, main){
  var R = tribeRx(t), p = pluralT(t);
  return { k:'tribe:' + t, tribe:t, main:!!main, label:p, full:15, pf:4,
    enN:'are ' + p + ' or make them', payN:'reward ' + p, enW:'is or makes a ' + t, payW:'rewards ' + p,
    en:function(c, o){
      if(creatureTypes(c).indexOf(t) >= 0 || (c.kw || []).indexOf('Changeling') >= 0) return 1;
      var m = o.match(/\bcreates? [^.]*?\btokens?\b/g);
      return m && m.some(function(s){ return R.test(s); }) ? 1 : 0; },
    pay:function(c, o, r){ return R.test(r) || (main && /creature type|chosen type|shares? a creature type/.test(o)); } };
}

/* ---------- what one card does (deck independent, cached by name) ---------- */
var FEAT = {};
function feats(c){
  var key = c.n + '|' + (c.o || '').length + '|' + (c.type || '');
  if(FEAT[key]) return FEAT[key];
  var o = tx(c), rs = rest(o), R = rolesFor(c), t = c.type || '', f = { en:{}, pay:{}, R:R };
  var land = isLand(c), spell = /\b(?:Instant|Sorcery)\b/.test(t), perm = !spell;
  f.land = land; f.spell = spell;
  TH.forEach(function(th){
    var w = th.en(c, o, rs, R); if(w) f.en[th.k] = w;
    if(th.pay(c, o, rs, R)) f.pay[th.k] = 1;
  });
  // Recursion: getting cards back from the graveyard. Only itself counts half. Lands too (Buried Ruin).
  var recOther = /return [^.]*?cards? [^.]*?from (?:your|a) graveyard to (?:your hand|the battlefield)|(?:cast|play) [^.]*?(?:cards?|spells?) from your graveyard|put [^.]*?cards? [^.]*?from (?:your|a) graveyard (?:onto the battlefield|into your hand)/.test(o);
  var recSelf = /\bflashback\b|\bretrace\b|\bunearth\b|\bescape\b|\bdisturb\b|\bembalm\b|\beternalize\b|\bjump-start\b|\bencore\b|return ~ from your graveyard/.test(o);
  f.rec = recOther ? 1 : recSelf ? 0.5 : 0;
  if(land){ FEAT[key] = f; return f; }
  var lines = o.split('\n');
  // An activated ability. Loyalty abilities ("+1:", "-2:") and "activate only as a sorcery" are
  // sorcery speed, so they never make a card instant-speed interaction.
  function act(L){ return /^[^:"]{0,70}: /.test(L) && !/^[+\u2212-]?(?:\d+|x): /.test(L) && !/activate only as a sorcery/.test(L); }
  // Card draw. Repeatable draw weighs 1.5, a one-shot of two or more cards 1, a single card 0.5.
  var drawLine = /\bdraws? (?:a|an|one|two|three|four|five|six|seven|x|that many|\w+) cards?|draw cards equal|exile the top [^.]*you may (?:play|cast)|look at the top [^.]* put [^.]* into your hand/;
  // Impulse draw across two sentences ("Exile the top two cards. Until the end of your
  // next turn, you may play those cards.") is card draw too; rolesOf misses it.
  var impulse = /exile the top [^.]*?cards?[^.]*?\.\s*(?:until [^.]*?,\s*)?(?:you may (?:play|cast)|during your next turn)/.test(o) ||
    /reveal the top card of your library[^.]*?(?:and )?put (?:that card|it) into your hand/.test(o);
  if(impulse && !R.draw){ f.rep = perm && /\bwhenever\b|\bat the beginning of\b/.test(o); f.drawW = f.rep ? 1.5 : 0.75; f.impulse = true; }
  else if(R.draw){
    var rep = false, big = false, loot = /draws? [^.]*?, then discards?|discard [^.]*?\. if you do, draw|\bconniv/.test(o);
    lines.forEach(function(L){
      if(!drawLine.test(L)) return;
      if(perm && (/\bwhenever\b|\bat the beginning of\b/.test(L) || act(L)) && !/^when ~ enters/.test(L)) rep = true;
      if(/draws? (?:two|three|four|five|six|seven|x|that many)|draw cards equal|draws? cards equal/.test(L)) big = true;
    });
    if(/each player discards (?:their|his or her) hand/.test(o)) big = rep || big;
    f.rep = rep;
    f.drawW = rep ? 1.5 : (big && !loot) ? 1 : 0.5;
    // Draw N then discard N (Faithless Looting), or discard then draw the same number: no cards gained.
    var noLoot = o.replace(/draws? (a|one|two|three|four|x) cards?, then discards? \1 cards?|discards? (a|one|two|three) cards?[^.]*?\. if you do, draws? \2 cards?/g, ' ');
    if(noLoot !== o && !drawLine.test(noLoot)){ f.drawW = 0; f.loot = true; }
  } else f.drawW = 0;
  // Card selection: scry, surveil, look at the top, impulse draw, loot and rummage.
  f.sel = impulse || /\bscry \d|\bsurveil \d|look at the top|reveal the top|exile the top [^.]*you may (?:play|cast)|, then discard|discard [^.]*?\. if you do, draw|additional cost[^.]*?discard|\bconniv|\bexplores?\b|you may (?:play|cast) [^.]*?from the top of your library/.test(o);
  f.counter = /\bcounter target\b|\bcounter (?:that|it|all)\b/.test(o) && !/counter target activated/.test(o);
  f.removal = !!R.removal || f.counter || /(?:owner of )?target (?:nonland )?(?:permanent|creature|artifact|enchantment)[^.]*?(?:shuffles it into|on (?:the )?(?:top|bottom) of) (?:its|their) (?:owner's )?library/.test(o);
  f.mana = /\badd \{|\badd one mana|\badd (?:two|three|x) mana|\badds? an additional \{|\bsearch your library for [^.]*?\blands? cards?/.test(o);
  // Removal quality: pings (1 or 2 damage), hits only on players or planeswalkers,
  // and colour-hosers ("if it's blue") count half.
  if(f.removal){
    var hard = /\b(?:destroy|exile) (?:up to (?:one|two|x) )?(?:another )?target|return (?:up to one )?target [^.]*? to (?:its|their) owner'?s? hand|counter target|target creature (?:an opponent controls )?gets -\d|fights? (?:target|another|up to)|target (?:player|opponent) sacrifices|deals? (?:[3-9]|\d\d|x|that much) damage|damage equal to/.test(o);
    var narrow = /if (?:it's|it is) (?:blue|black|red|green|white)|target (?:blue|black|red|green|white) /.test(o);
    f.remW = hard && !narrow ? 1 : 0.5;
  } else f.remW = 0;
  f.wipe = !!R.wipe || /then sacrifices the rest|sacrifices all (?:other )?(?:creatures|nonland permanents)/.test(o);
  f.protection = !!R.protection || /spells you control can't be countered|opponents can't cast spells (?:or activate [^.]*?)?during your turn|during your turn, your opponents can't cast|creatures you control have [^.]*?\bward\b|choose new targets for target spell|(?:you control|target creature|target permanent|your commander|equipped creature|enchanted creature|creatures|permanents)[^.]*?\b(?:gains?|have|has) [^.]*?\b(?:hexproof|indestructible|shroud|protection)|phases? out/.test(o);
  var interact = f.removal || f.wipe || f.protection;
  var flash = (c.kw || []).indexOf('Flash') >= 0;
  f.instant = interact && (/\bInstant\b/.test(t) || flash || (perm && lines.some(function(L){ return act(L) && /destroy|exile|damage|counter target|return target|-\d+\/-\d+|hexproof|indestructible|shroud|protection|phases? out|new targets|sacrifices/.test(L); })));
  // Tutors: any search for a nonland card. Unrestricted ones ("a card") are the strongest.
  var tm = o.match(/search your library (?:and\/or graveyard |or graveyard )?for (?:a|an|any number of|up to \w+|two|three|x) ([^.]*?)cards?\b/);
  f.tutor = !!R.tutor || !!(tm && !/^(?:basic )?(?:snow )?(?:land|forest|plains|island|swamp|mountain|basic)/.test(tm[1].trim()));
  f.tutorAny = !!tm && tm[1].trim() === '' ;
  // Cost reducers ("spells you cast cost {1} less") do ramp's job.
  f.reducer = /spells (?:you cast )?cost \{\d\} less/.test(o);
  // "Spend mana as though it were mana of any color" reads as ramp to rolesOf; it is not.
  f.ramp = (!!R.ramp && !(/as though it were mana of any (?:color|type)/.test(o) && !/\badd \{|\badd one mana|\bcreate (?:a|two|three|x) treasure/.test(o))) || f.reducer;
  f.cheap = f.ramp && c.mv <= 2;
  // Fast mana: free or 1-mana rocks that make 2 or more, and rituals.
  f.ritual = spell && /\badd (?:\{|x |one mana|two mana|three mana|an amount)/.test(o);
  f.fast = (f.ramp && (c.mv === 0 || (c.mv <= 1 && /add \{[^}]+\}\{[^}]+\}|add (?:two|three) mana/.test(o)))) || f.ritual;
  // Finishers: the rules' win-condition text plus scaling damage and sacrifice outlets that hit players.
  f.fin = !!R.wincon || /deals? damage equal to the number of|deals? damage to (?:any target|target (?:player|opponent)|each opponent)[^.]*?equal to the number of|deals? (?:\d+|x) damage to (?:each opponent|target (?:player|opponent)|any target)[^.]*?for each|(?:each opponent|target (?:player|opponent)|defending player) loses (?:\d+|x) life[^.]*?for each|sacrifice (?:a|another) [a-z]+[^:]*?: [^.]*?(?:damage to any target|each opponent loses|damage to (?:target|each) (?:player|opponent))|gets? \+\d+\/\+\d+ (?:until end of turn )?for each|attacking creatures? (?:you control )?get \+|put [^.]*?\+1\/\+1 counters? on each (?:other )?creature you control|can't block creatures you control|creatures you control can't be blocked/.test(o);
  // A damage amplifier (Torbran, Fiery Emancipation) is a finisher when the deck pings or goes wide;
  // ctx() decides that per deck.
  f.amp = DMG_AMP.test(o);
  // Big threats: creatures costing 5 or more with evasion, and X creatures with trample.
  // They end games through combat; the finishers part counts them half.
  var kw = (c.kw || []).join(' ');
  // Trampling creatures that keep growing (hydras) at any mana value count too.
  var grows = /put (?:a|an|one|two|x|that many|\w+) \+1\/\+1 counters? on ~|double the number of \+1\/\+1 counters on ~|~ enters with [^.]*?\+1\/\+1 counters?/.test(o);
  f.threat = !f.fin && /\bCreature\b/.test(t) && ((c.mv >= 5 && /Trample|Flying|Double strike|Menace|Shadow/.test(kw)) || (/\{X\}/.test(c.cost || '') && /Trample/.test(kw)) || (c.mv >= 4 && /~ can't be blocked/.test(o)) ||
    (grows && (/Trample/.test(kw) || /~ has trample|~ gains trample/.test(o))));
  f.extra = !!R.extra; f.mld = !!R.mld;
  // An extra turn that comes back (buyback, returns to hand, copies): chained extra turns.
  f.extraRep = f.extra && /\bbuyback\b|return ~ to (?:its owner's|your) hand|shuffle ~ into|copy (?:it|~|that spell)|~ from your graveyard/.test(o);
  FEAT[key] = f;
  return f;
}
// Jobs that keep a card off the "works with nothing" list. The spec names the first six;
// finishers are added so a deck's win condition is never offered as a cut.
var STAPLE = { ramp:1, draw:1, removal:1, wipes:1, protection:1, tutor:1, wincon:1 };
// A card's jobs. His own correction (S.roleFix) wins outright; otherwise the deck
// entry's job plus every job the rules text shows.
function jobsOf(r){
  var fix = fixOf(r.n), j = {};
  if(fix){ j[fix] = 1; return j; }
  if(r.role && r.role !== 'commander') j[r.role] = 1;
  var f = r.f;
  if(f.land){ j.lands = 1; return j; }
  if(f.ramp) j.ramp = 1;
  if(f.tutor) j.tutor = 1;
  if(f.drawW) j.draw = 1;
  if(f.removal) j.removal = 1;
  if(f.wipe) j.wipes = 1; if(f.protection) j.protection = 1; if(f.fin) j.wincon = 1;
  return j;
}

/* ---------- the per-deck picture, cached until the deck changes ---------- */
function sig(){
  var d = S.deck || [], parts = [];
  for(var i = 0; i < d.length; i++) parts.push(d[i].n + ':' + (d[i].role || ''));
  var p = S.pool || [];
  return [S.cmd ? S.cmd.n : '', S.partner ? S.partner.n : '', S.bracket, p.length, p.length ? p[0].n : '',
    JSON.stringify(S.roleFix || {}), JSON.stringify(S.house || {}), lc(S.refuseText).length, parts.join('|')].join('#');
}
function basicStub(d){ return { n:d.n, prod:d.prod || [basicColour(d.n)], type:'Basic Land', o:'', cost:'', mv:0, ci:[], kw:[] }; }
var CTX = { key:'', v:null };
function ctx(){
  if(!has()) return { ok:false, why:'No deck is open.', rows:[], themes:[], by:{} };
  var key = sig();
  if(CTX.key === key && CTX.v) return CTX.v;
  var rows = [], by = {};
  cmdCards().forEach(function(c){
    var r = { n:c.n, q:1, c:c, role:'commander', cmd:true, basic:false, must:true, d:null };
    rows.push(r); by[lc(c.n)] = r;
  });
  (S.deck || []).forEach(function(d){
    var k = lc(d.n); if(by[k]){ by[k].q++; return; }
    var c = pcard(d.n), miss = false;
    if(!c && d.basic) c = basicStub(d);
    if(!c){ c = { n:d.n, mv:d.mv || 0, cost:'', type:'', o:'', ci:[], prod:[], kw:[], stats:{}, legal:'legal', missing:true }; miss = true; }
    var r = { n:d.n, q:1, c:c, role:d.role || 'synergy', cmd:false, basic:!!d.basic || isBasic(c), must:!!d.must, d:d, missing:miss };
    rows.push(r); by[k] = r;
  });
  rows.forEach(function(r){ r.f = feats(r.c); r.jobs = jobsOf(r); r.gc = !r.basic && !r.missing ? isGc(r.c) : !!(r.d && r.d.gc); });
  var X = { ok:!!S.pool, why:S.pool ? '' : 'Card data is not loaded yet, so these numbers are incomplete.', key:key, rows:rows, by:by };
  X.names = {}; rows.forEach(function(r){ X.names[lc(r.n)] = 1; X.names[front(r.n)] = 1; });
  X.gcs = rows.filter(function(r){ return r.gc; }).map(function(r){ return r.n; });
  X.themes = buildThemes(X);
  // A damage amplifier (Torbran, Fiery Emancipation) ends games in a deck that pings or goes wide.
  var wide = X.themes.some(function(h){ return h.active && h.v >= 0.35 && (h.t.k === 'tokens' || h.t.k === 'combat' || h.t.k === 'sacrifice' || h.t.tribe); });
  var pings = rows.some(function(r){ return !r.basic && !r.missing && !r.f.land && /deals? (?:1|2|x|that much) damage to (?:any target|each opponent|target (?:player|opponent)|each player|any other target)/.test(tx(r.c)); });
  if(wide || pings) rows.forEach(function(r){ if(r.f.amp && !fixOf(r.n)) r.jobs.wincon = 1; });
  // A deck that wins with a wide board of creatures does not want board wipes of its own.
  var gw = X.themes.filter(function(h){ return h.active && h.v >= 0.7 && (h.t.k === 'tokens' || h.t.k === 'counters' || h.t.tribe); })[0];
  X.goWide = gw ? gw.t.label : '';
  CTX = { key:key, v:X };
  return X;
}
// Pass the deck picture in loops: ctx() rebuilds its fingerprint on every call.
function inX(X, n){ return !!(X.names && (X.names[lc(n)] || X.names[front(n)])); }
// The page's house() and gcLimit() create S.house when it is missing; these only read.
function hs(){ return S.house || {}; }
function gcLim(){ var h = hs(); return h.gc != null && h.gc !== '' ? +h.gc : (BRACKETS[S.bracket] || BRACKETS[3]).gc; }
function earlyLim(){ var v = +hs().early; return v > 0 ? v : 6; }
function rowOf(n){ var X = ctx(); return X.by[lc(n)] || X.rows.filter(function(r){ return sameName(r.n, n) || sameName(n, r.n); })[0] || null; }

function deckTribes(rows){
  var cmdT = [], count = {};
  rows.forEach(function(r){
    if(r.basic || r.missing) return;
    var ts = creatureTypes(r.c);
    if(r.cmd) ts.forEach(function(t){ if(cmdT.indexOf(t) < 0) cmdT.push(t); });
    else ts.forEach(function(t){ count[t] = (count[t] || 0) + r.q; });
  });
  var main = cmdT.slice().sort(function(a, b){ return (count[b] || 0) - (count[a] || 0); })[0];
  var list = cmdT.slice();
  Object.keys(count).forEach(function(t){ if(count[t] >= 8 && list.indexOf(t) < 0) list.push(t); });
  if(!main) main = list.slice().sort(function(a, b){ return (count[b] || 0) - (count[a] || 0); })[0];
  return list.map(function(t){ return tribeTheme(t, t === main); });
}
// en/pay of any theme for any card (static themes come from the cached feats).
var TRIB = {};
function tribeRead(t, c){
  var k = t.k + (t.main ? '*' : '') + '|' + c.n + '|' + (c.o || '').length;
  if(TRIB[k]) return TRIB[k];
  var o = tx(c);
  return (TRIB[k] = { en:t.en(c, o, rest(o), rolesFor(c)) || 0, pay:!!t.pay(c, o, rest(o), rolesFor(c)) });
}
function enOf(t, c){ return t.tribe ? tribeRead(t, c).en : feats(c).en[t.k] || 0; }
function payOf(t, c){ return t.tribe ? tribeRead(t, c).pay : !!feats(c).pay[t.k]; }
function buildThemes(X){
  var list = TH.concat(deckTribes(X.rows)), out = [];
  list.forEach(function(t){
    var en = [], pay = [], Ew = 0, Pw = 0, cm = '';
    X.rows.forEach(function(r){
      if(r.basic || r.missing) return;
      var w = enOf(t, r.c), p = payOf(t, r.c), m = r.cmd ? 3 : 1;
      if(w){ en.push(r); Ew += w * m; if(r.cmd) cm = 'enabler'; }
      if(p){ pay.push(r); Pw += m; if(r.cmd) cm = cm ? 'both' : 'payoff'; }
    });
    var sE = Math.min(1, Ew / t.full), sP = Math.min(1, Pw / t.pf), v = sE * sP;
    var active = pay.length > 0 && en.length > 0 && !(pay.length === 1 && en.length === 1 && pay[0] === en[0]);
    out.push({ t:t, enRows:en, payRows:pay, E:Ew, P:Pw, v:v, cmd:cm, active:active,
      rank:v + (cm ? 0.15 : 0) + Math.min(0.1, (Ew + Pw) / 400) });
  });
  out.sort(function(a, b){ return b.rank - a.rank; });
  return out;
}
function byStrength(rows){
  return rows.slice().sort(function(a, b){ return (b.cmd - a.cmd) || (safeScore(b.c) - safeScore(a.c)); }).map(function(r){ return r.n; });
}

/* ============ ENGINE.cards ============ */
E.cards = function(){
  try{
    return ctx().rows.map(function(r){
      var role = fixOf(r.n) || (r.cmd ? (r.f.land ? 'lands' : primaryRole(Object.assign({}, r.c, { roles:rolesFor(r.c) }))) : r.role);
      return { n:r.n, q:r.q, c:r.c, role:role, cmd:r.cmd };
    });
  }catch(e){ return withNote([], 'Could not read the deck: ' + e.message); }
};

/* ============ ENGINE.themes ============ */
E.themes = function(){
  try{
    var X = ctx();
    var out = X.themes.filter(function(h){ return h.active; }).map(function(h){
      var t = h.t, strength = h.v >= 0.7 ? 'strong' : h.v >= 0.35 ? 'ok' : 'thin';
      var ne = h.enRows.length, np = h.payRows.length;
      var note = (ne === 1 ? '1 card ' + t.enW : ne + ' cards ' + t.enN) + ' and ' + (np === 1 ? '1 card ' + t.payW : np + ' cards ' + t.payN) + '.';
      if(h.cmd) note += ' Your commander ' + (h.cmd === 'both' ? t.enW + ' and ' + t.payW : h.cmd === 'enabler' ? t.enW : t.payW) + '.';
      return { key:t.k, label:t.label, enablers:byStrength(h.enRows), payoffs:byStrength(h.payRows), strength:strength, note:note,
        score:r2(h.v), cmd:h.cmd || null };
    });
    return withNote(out, X.ok ? (out.length ? '' : 'No theme has both cards that feed it and cards that reward it.') : X.why);
  }catch(e){ return withNote([], 'Could not read the themes: ' + e.message); }
};

/* ============ combos (Commander Spellbook, combos.json) ============ */
var CB = { key:'', res:null, p:null };
function namesSig(){ return (S.cmd ? S.cmd.n : '') + '|' + (S.partner ? S.partner.n : '') + '|' + (S.deck || []).map(function(d){ return d.n; }).sort().join('|') + '|' + S.bracket + '|' + (S.pool ? S.pool.length : 0); }
function cardForName(n){ if(S.cmd && sameName(S.cmd.n, n)) return S.cmd; if(S.partner && sameName(S.partner.n, n)) return S.partner; return pcard(n); }
// Does a combo break the rules of bracket tb? Same rule as the Check step's
// comboBreaksBracket, with the target bracket as a parameter. House rules apply
// only at his own bracket.
function breaksAt(o, tb){
  var mode = tb === bk() ? (hs().combo || '') : '', two = o.cards.length <= 2 && o.inf;
  function early(){
    var mv = o.cards.reduce(function(s, n){ var c = cardForName(n); return s + (c ? c.mv : 3); }, 0);
    return mv + (o.mvNeeded || 0) <= earlyLim();
  }
  // Combos whose result wipes out lands count as mass land destruction.
  if(tb <= 3 && /land (?:denial|destruction)/i.test(o.result || '') && !(tb === bk() && hs().mld)) return true;
  if(mode === 'any') return false;
  if(mode === 'none') return two;
  if(mode === 'late') return two && early();
  if(tb >= 4) return false;
  if(tb === 1) return !!o.inf;
  if(tb === 2) return two;
  return two && early();
}
function comboList(){
  if(CB.res && CB.key === namesSig()) return CB.res.inDeck;
  var lc2 = S.lastCheck && S.lastCheck.combos;
  if(lc2 && lc2.length){ var X = ctx(); return lc2.filter(function(o){ return !o.req && o.cards.every(function(n){ return inX(X, n); }); }).map(function(o){
    return { cards:o.cards, result:o.res, bracketTag:o.tag, tag:tagName(o.tag), inf:o.inf, mvNeeded:o.mvNeeded, pop:o.pop, id:o.id, req:o.req };
  }); }
  return [];
}
function nearList(){
  if(CB.res && CB.key === namesSig()) return CB.res.near;
  return ((S.lastCheck && S.lastCheck.near) || []).filter(function(o){ return !o.req; }).map(function(o){ return { cards:o.cards, missing:o.missing, result:o.res, inf:o.inf, mvNeeded:o.mvNeeded }; });
}
// Every combo this deck is one named card away from (not only the 30 the page lists), for the
// suggestion lists: a card that would complete one never comes in as a plain upgrade.
function nearAllList(){ return CB.res && CB.key === namesSig() ? (CB.res.nearAll || CB.res.near) : nearList(); }
E.combos = function(){
  if(!has()) return Promise.resolve({ inDeck:[], near:[], note:'No deck is open.' });
  var key = namesSig();
  if(CB.res && CB.key === key) return Promise.resolve(CB.res);
  if(CB.p && CB.pkey === key) return CB.p;
  CB.pkey = key;
  CB.p = (async function(){
    var res = { inDeck:[], near:[], note:'' };
    var data;
    try{ data = await loadCombos(); }catch(e){ res.note = 'The combo list did not load (' + e.message + '), so combos were not checked.'; return res; }
    var have = {};
    [S.cmd, S.partner].filter(Boolean).map(function(c){ return c.n; }).concat((S.deck || []).map(function(d){ return d.n; }))
      .forEach(function(n){ have[lc(n)] = 1; have[front(n)] = 1; });
    var names = data.names, inIdx = new Array(names.length);
    for(var i = 0; i < names.length; i++) inIdx[i] = !!(have[lc(names[i])] || have[front(names[i])]);
    // req: how many more cards "of a kind" Spellbook's combo also needs (such as "a creature with
    // persist"). The deck may not have one, so those are kept apart (cond) and never count as a combo
    // in the deck, or as one card away.
    var inDeck = [], near = [], cond = [];
    data.v.forEach(function(v){
      var pcs = v[0], miss = -1, nm = 0;
      for(var j = 0; j < pcs.length; j++){ if(!inIdx[pcs[j]]){ nm++; if(nm > 1) return; miss = pcs[j]; } }
      if(nm && pcs.length < 2) return;   // a one-card "combo" is not one card away from anything
      var o = { cards:pcs.map(function(x){ return names[x]; }), result:v[4], bracketTag:v[1], tag:tagName(v[1]), mvNeeded:v[2], inf:!!v[3],
        id:v[5], req:v[6] || 0, pop:v[7] || 0, url:'https://commanderspellbook.com/combo/' + v[5] + '/' };
      if(o.req){ if(!nm) cond.push(o); return; }
      if(!nm) inDeck.push(o); else { o.missing = names[miss]; near.push(o); }
    });
    cond.sort(function(a, b){ return b.pop - a.pop; });
    res.cond = cond;
    inDeck.sort(function(a, b){ return b.pop - a.pop; });
    inDeck.forEach(function(o){
      o.mv = o.cards.reduce(function(s, n){ var c = cardForName(n); return s + (c ? c.mv : 3); }, 0) + (o.mvNeeded || 0);
      o.breaks = breaksAt(o, bk());
    });
    near.sort(function(a, b){ return b.pop - a.pop; });
    // The missing piece must be legal, in colours, out already and not refused.
    var want = uniq(near.slice(0, 400).map(function(o){ return o.missing; })).slice(0, 160);
    var got = {}, ask = [];
    want.forEach(function(n){ var c = pcard(n); if(c) got[lc(n)] = c; else ask.push({ n:n }); });
    if(ask.length){
      try{ var sc = await sfCollection(ask); Object.keys(sc.cards).forEach(function(k){ got[k] = sc.cards[k]; }); }
      catch(e){ res.note = 'Scryfall did not answer, so some near combos could not be checked.'; }
    }
    var per = {}, keep = [];
    near.forEach(function(o){
      if(keep.length >= 30) return;
      var c = got[lc(o.missing)];
      if(!c || !okAdd(c)) return;
      if((per[o.missing] = (per[o.missing] || 0) + 1) > 3) return;
      o.c = c; o.breaks = breaksAt(o, bk()); keep.push(o);
    });
    res.inDeck = inDeck; res.near = keep;
    res.nearAll = near.map(function(o){ return { cards:o.cards, missing:o.missing, result:o.result, inf:o.inf, mvNeeded:o.mvNeeded }; });
    if(!inDeck.length && !res.note) res.note = 'Commander Spellbook lists no combo made only of cards in this deck.';
    CB.res = res; CB.key = key;
    return res;
  })();
  CB.p.then(function(){ CB.p = null; }, function(){ CB.p = null; });
  return CB.p;
};

/* ============ ENGINE.links and cardLinks ============ */
function buildLinks(X){
  // Rebuilt when the full combo list arrives after the first call.
  var ck = comboList().length + (CB.res && CB.key === namesSig() ? 'c' : 'l');
  if(X.links && X.linksCk === ck) return X.links;
  X.linksCk = ck;
  var by = {}, per = {};
  function add(a, b, why, w){
    var m = by[a] || (by[a] = {}), e = m[b] || (m[b] = { n:b, why:[], w:0 });
    if(e.why.indexOf(why) < 0) e.why.push(why);
    e.w = Math.max(e.w, w);
  }
  // Engine weight: each theme a card sits in adds the square root of its partners
  // there (tribal counts 0.6, it links almost everything); each combo adds 2.5 (up to 4).
  function eng(n, k, v){ var m = per[n] || (per[n] = {}); m[k] = (m[k] || 0) + v; }
  X.themes.forEach(function(h){
    if(!h.active) return;
    h.enRows.forEach(function(e){
      h.payRows.forEach(function(p){
        if(e === p) return;
        add(e.n, p.n, h.t.payW, 1);
        add(p.n, e.n, h.t.enW, 1);
        eng(e.n, h.t.k, 1); eng(p.n, h.t.k, 1);
      });
    });
  });
  var cw = {};
  comboList().forEach(function(o){
    var pcs = o.cards.map(rowOf).filter(Boolean);
    pcs.forEach(function(a){ cw[a.n] = (cw[a.n] || 0) + 1; pcs.forEach(function(b){ if(a !== b) add(a.n, b.n, 'combo: ' + o.result, 3); }); });
  });
  var byCard = {}, engines = [], loners = [];
  X.rows.forEach(function(r){
    if(r.basic) return;
    var m = by[r.n] || {};
    var list = Object.keys(m).map(function(k){ return m[k]; }).sort(function(a, b){ return b.w - a.w || (a.n < b.n ? -1 : 1); })
      .map(function(e){ return { n:e.n, why:e.why.slice(0, 2).join('; ') }; });
    byCard[r.n] = list;
    if(list.length){
      if(!r.f.land){
        var pm = per[r.n] || {}, s = 2.5 * Math.min(4, cw[r.n] || 0);
        Object.keys(pm).forEach(function(k){ s += Math.sqrt(pm[k]) * (k.indexOf('tribe:') === 0 ? 0.6 : 1); });
        if(r.cmd) s *= 1.5;   // the commander is always on hand, so it is the centre of the deck
        engines.push({ n:r.n, count:list.length, score:r1(s), themes:Object.keys(pm).length });
      }
    }
    else if(!r.cmd && !r.f.land && !r.missing && !Object.keys(r.jobs).some(function(j){ return STAPLE[j]; })) loners.push(r.n);
  });
  engines.sort(function(a, b){ return b.score - a.score || b.count - a.count; });
  X.links = { byCard:byCard, engines:engines.slice(0, 12), loners:loners };
  return X.links;
}
E.links = function(){
  try{
    var X = ctx(), L = buildLinks(X);
    return { byCard:L.byCard, engines:L.engines, loners:L.loners, note:X.ok ? '' : X.why };
  }catch(e){ return { byCard:{}, engines:[], loners:[], note:'Could not read the links: ' + e.message }; }
};
E.cardLinks = function(name, card){
  try{
    var L = buildLinks(ctx());
    if(L.byCard[name]) return L.byCard[name];
    var k = Object.keys(L.byCard).filter(function(x){ return sameName(x, name) || sameName(name, x); })[0];
    if(k) return L.byCard[k];
    // A card not in the deck: what it would work with. A card fetched from Scryfall for the card
    // sheet (a combo piece, a searched card) is not in the pool, so the caller may pass it.
    var c = pcard(name) || (card && card.n && card.type ? card : null); if(!c) return [];
    var X = ctx(), out = [], seen = {};
    X.themes.forEach(function(h){
      if(!h.active) return;
      var e = enOf(h.t, c), p = payOf(h.t, c);
      if(e) h.payRows.forEach(function(r){ if(!seen[r.n]){ seen[r.n] = 1; out.push({ n:r.n, why:h.t.payW }); } });
      if(p) h.enRows.forEach(function(r){ if(!seen[r.n]){ seen[r.n] = 1; out.push({ n:r.n, why:h.t.enW }); } });
    });
    return out;
  }catch(e){ return []; }
};

// Why the commander is a threat on its own, or '' when it is not.
function cmdThreat(X){
  var cl = comboList(), top = X.themes.filter(function(h){ return h.active; })[0], why = '';
  X.rows.filter(function(r){ return r.cmd; }).forEach(function(r){
    if(why) return;
    if(r.f.fin || r.f.threat) why = r.n + ' ends games on its own text.';
    else if(cl.some(function(o){ return o.cards.some(function(n){ return sameName(n, r.n) || sameName(r.n, n); }); })) why = r.n + ' is part of a combo in the deck.';
    else if(top && top.cmd && top.v >= 0.3) why = r.n + ' drives the strongest theme (' + top.t.label + ').';
    else if(payOf(THK.voltron, r.c)) why = r.n + ' wins by suiting up.';
  });
  return why;
}

/* ============ goldfish simulation (the Check step's simulate, run small and cached) ============ */
var SIM = { key:'', v:null };
function sim(X){
  var key = X.key + '|' + comboList().length;
  if(SIM.key === key) return SIM.v;
  var v = null, added = false;
  try{
    if(winsOk() && BRACKETS[S.bracket] && S.pool){
      // A commander that is a threat counts as one of the two win cards, the way the
      // Check step counts a commander he marked as a win condition. Undone below.
      if(cmdThreat(X) && S.wins.indexOf('cmdr') < 0){ S.wins.push('cmdr'); added = true; }
      // The Check step's simulation, with this engine's reading of what wins: its
      // finishers and big threats count as win cards, and his job corrections apply.
      var cards = (S.deck || []).map(function(d){
        var r = X.by[lc(d.n)]; if(!r || r.missing) return null;
        var roles = Object.assign({}, rolesFor(r.c));
        if(r.jobs.wincon || r.f.threat) roles.wincon = 1; else delete roles.wincon;
        if(r.jobs.ramp) roles.ramp = 1; else delete roles.ramp;
        return Object.assign({}, r.c, { roles:roles });
      }).filter(Boolean);
      v = simulate(cards, 800, comboList());
    }
  }catch(e){ v = null; }
  finally{ if(added){ var i = S.wins.indexOf('cmdr'); if(i >= 0) S.wins.splice(i, 1); } }
  SIM = { key:key, v:v };
  return v;
}

/* ============ ENGINE.pillars ============
   Brewing Station's own estimate, not an official rating. Each pillar is built from
   parts; each part compares what the deck has with a target for its bracket.
   A part scores with diminishing returns: 1 - e^(-1.9 x have/want), so meeting the
   target gives 85% of the part, half the target 61%, double the target 98%.
   "Lower is better" parts (average mana value, goldfish turn) use (want/have)^power
   as the ratio; "close to" parts (land count) fall off either side of the target.
   The pillar is the weighted average of its parts, times 10.

   Targets per bracket (rules of thumb, tuned to 99-card decks):
                        B1    B2    B3    B4    B5     what it counts                                   */
var TARGET = {
  draw:              [6,    8,    10,   11,   12],  // card draw, weighted: repeatable 1.5, 2+ cards 1, one card 0.5
  tutor:             [0,    0,    3,    5,    8],   // tutors for nonland cards (not scored at 1 and 2)
  selection:         [2,    3,    4,    5,    6],   // scry, surveil, look at the top, impulse, loot
  recursion:         [1,    1,    2,    2,    2],   // getting cards back from the graveyard (self-only counts half)
  avgMv:             [3.5,  3.3,  3.1,  2.8,  2.2], // average mana value of the spells (lower is better)
  ramp:              [8,    9,    10,   12,   14],  // ramp pieces
  cheapRamp:         [3,    4,    6,    8,    11],  // ramp that costs 2 mana or less
  fastMana:          [0,    0,    1,    3,    6],   // free or 1-mana rocks that make 2+, rituals
  removal:           [5,    6,    8,    10,   12],  // targeted removal (counterspells count too)
  wipes:             [1,    2,    2,    2,    1],   // board wipes
  counterspells:     [0,    1,    2,    3,    6],   // only scored when blue is in the deck
  protection:        [2,    2,    3,    4,    4],   // hexproof, indestructible, redirects, ward
  instantShare:      [0.3,  0.4,  0.5,  0.6,  0.75],// share of the interaction that works at instant speed
  finishers:         [2,    3,    3,    3,    2],   // cards that end games (drain, overrun, scaling damage)
  combos:            [0,    0,    1,    2,    2],   // combos fully in the deck (Commander Spellbook)
  winTurn:           [10,   9,    8,    6,    4]    // goldfish win turn aimed for (lower is better)
};
var WEIGHT = {
  draw:1, tutor:0.6, selection:0.5, recursion:0.35,
  avgMv:0.8, ramp:1, cheapRamp:0.6, lands:0.8, colours:0.5, fastMana:0.4,
  removal:1, wipes:0.6, counterspells:0.5, protection:0.7, instantShare:0.5,
  finishers:1, combos:0.7, commander:0.6, winTurn:0.9
};
function tgt(k){ return TARGET[k][bk() - 1]; }
function fUp(have, want){ return want > 0 ? 1 - Math.exp(-1.9 * have / want) : 1; }
function fDown(have, want, pow){ if(!(have > 0)) return 1; return 1 - Math.exp(-1.9 * Math.pow(want / have, pow)); }
function fNear(have, want, spread){ var d = (have - want) / spread; return 0.95 * Math.exp(-0.7 * d * d); }
function part(key, label, have, want, value, cards, note, weight){
  return { key:key, label:label, have:have, want:want, cards:cards || [], note:note || '',
    weight:weight == null ? (WEIGHT[key] || 0.5) : weight, value:r2(clamp(value, 0, 1)), score:r1(clamp(value, 0, 1) * 10) };
}
function pillarOf(name, parts, raiseFn){
  var sw = 0, s = 0;
  parts.forEach(function(p){ if(p.weight > 0){ sw += p.weight; s += p.weight * p.value; } });
  var score = sw ? r1(10 * s / sw) : 0;
  var scored = parts.filter(function(p){ return p.weight > 0; });
  var gap = scored.slice().sort(function(a, b){ return (b.weight * (1 - b.value)) - (a.weight * (1 - a.value)); })[0];
  var head = score >= 8.5 ? 'Excellent' : score >= 7 ? 'Solid' : score >= 5 ? 'Workable' : score >= 3 ? 'Thin' : 'Weak';
  var verdict = head + ' for bracket ' + bk() + (gap && gap.value < 0.7 ? '. ' + gap.label + ' is the gap.' : '.');
  var raise = scored.filter(function(p){ return p.value < 0.8; })
    .sort(function(a, b){ return (b.weight * (1 - b.value)) - (a.weight * (1 - a.value)); })
    .map(raiseFn).filter(Boolean).slice(0, 4);
  return { score:score, verdict:verdict, parts:parts, raise:raise };
}
function namesWhere(X, fn){ return X.rows.filter(function(r){ return !r.basic && !r.missing && fn(r); }).map(function(r){ return r.n; }); }
function landCount(X){ return X.rows.reduce(function(s, r){ return s + ((!r.cmd && (r.jobs.lands || r.f.land)) ? r.q : 0); }, 0); }
function spellsOf(X){ return X.rows.filter(function(r){ return !r.cmd && !r.f.land && !r.jobs.lands && !r.missing; }); }
function sourcesOf(X){
  var out = {};
  X.rows.forEach(function(r){
    if(r.cmd || !(r.jobs.lands || r.f.land)) return;
    var prod = r.c.prod && r.c.prod.length ? r.c.prod : [];
    if(!prod.length && /search your library for a basic land|any color/.test(tx(r.c))) prod = S.ci || [];
    prod.forEach(function(p){ out[p] = (out[p] || 0) + r.q; });
  });
  return out;
}
var PIL = { key:'', v:null };
E.pillars = function(){
  try{
    var X = ctx(), key = X.key + '|' + comboList().length;
    if(PIL.key === key) return PIL.v;
    if(!X.ok){
      var wait = function(){ return { score:0, verdict:X.why || 'Card data is not loaded yet.', parts:[], raise:[] }; };
      return { consistency:wait(), efficiency:wait(), interaction:wait(), wincons:wait(), overall:0, ready:false, note:X.why || 'Card data is not loaded yet.' };
    }
    var b = bk(), ci = S.ci || [];
    // ---- consistency
    var drawRows = X.rows.filter(function(r){ return !r.basic && !r.missing && r.jobs.draw; });
    var drawHave = r1(drawRows.reduce(function(s, r){ return s + (r.f.drawW || 0.5); }, 0));
    var tutors = namesWhere(X, function(r){ return r.jobs.tutor; });
    var sel = namesWhere(X, function(r){ return r.f.sel; });
    var recRows = X.rows.filter(function(r){ return !r.basic && !r.missing && r.f.rec; });
    var recHave = r1(recRows.reduce(function(s, r){ return s + r.f.rec; }, 0));
    var cons = [
      part('draw', 'Card draw', drawHave, tgt('draw'), fUp(drawHave, tgt('draw')), drawRows.map(function(r){ return r.n; }),
        drawRows.filter(function(r){ return r.f.rep; }).length + ' repeatable (count 1.5), the rest count 1 for two or more cards and 0.5 for one.'),
      part('tutor', 'Tutors', tutors.length, tgt('tutor'), fUp(tutors.length, tgt('tutor')), tutors,
        tgt('tutor') ? 'Cards that search the library for a nonland card.' : 'Not needed at bracket ' + b + ', so not scored.', tgt('tutor') ? null : 0),
      part('selection', 'Card selection', sel.length, tgt('selection'), fUp(sel.length, tgt('selection')), sel, 'Scry, surveil, look at the top, cast from the top, loot.'),
      part('recursion', 'Recursion', recHave, tgt('recursion'), fUp(recHave, tgt('recursion')), recRows.map(function(r){ return r.n; }), 'Getting cards back from the graveyard. A card that only brings itself back counts half.')
    ];
    // ---- efficiency
    var spells = spellsOf(X), mvSum = 0, mvN = 0;
    spells.forEach(function(r){ mvSum += (r.c.mv || 0) * r.q; mvN += r.q; });
    var avg = mvN ? mvSum / mvN : 0;
    var ramp = namesWhere(X, function(r){ return !r.cmd && r.jobs.ramp; });
    var cheap = namesWhere(X, function(r){ return !r.cmd && r.jobs.ramp && r.c.mv <= 2; });
    var fast = namesWhere(X, function(r){ return !r.cmd && r.f.fast; });
    var lands = landCount(X);
    // Land target, a rule of thumb: 33 + 1.5 per point of average mana value, minus 1
    // for every 3 cheap ramp pieces past 4; cEDH lists run about 3 fewer.
    var landWant = Math.round(clamp(33 + 1.5 * avg - (cheap.length - 4) / 3 - (b === 5 ? 3 : 0), 28, 42));
    var sm = sim(X);
    var effParts = [
      part('avgMv', 'Average mana value', r2(avg), tgt('avgMv'), fDown(avg, tgt('avgMv'), 3), [], 'Of the ' + mvN + ' spells, lands and commander left out. Lower is faster.'),
      part('ramp', 'Ramp', ramp.length, tgt('ramp'), fUp(ramp.length, tgt('ramp')), ramp),
      part('cheapRamp', 'Ramp at 2 mana or less', cheap.length, tgt('cheapRamp'), fUp(cheap.length, tgt('cheapRamp')), cheap),
      part('lands', 'Lands', lands, landWant, fNear(lands, landWant, 5), namesWhere(X, function(r){ return !r.cmd && !r.basic && (r.jobs.lands || r.f.land); }),
        'Target from the curve and cheap ramp (rule of thumb).' + (sm ? ' In test games, land drops or cheap ramp through turn 3: ' + pc(sm.t3) + '.' : ''))
    ];
    if(ci.length > 1){
      var src = sourcesOf(X), targets = S.sources || {};
      if(!Object.keys(targets).length){ try{ targets = sourceTargets(spells.map(function(r){ return r.c; }), lands); }catch(e){ targets = {}; } }
      var okCols = ci.filter(function(col){ return (src[col] || 0) >= (targets[col] || 0) - 1; });
      effParts.push(part('colours', 'Coloured sources', okCols.length, ci.length, okCols.length / ci.length * 0.95, [],
        ci.map(function(col){ return col + ': ' + (src[col] || 0) + ' of ' + (targets[col] || 0); }).join(', ') + ' lands.'));
    } else effParts.push(part('colours', 'Coloured sources', ci.length, ci.length, 1, [], ci.length ? 'One colour: every coloured land makes it.' : 'Colourless.', 0));
    effParts.push(part('fastMana', 'Fast mana', fast.length, tgt('fastMana'), fUp(fast.length, tgt('fastMana')), fast,
      tgt('fastMana') ? 'Free or 1-mana rocks that make 2 or more, and rituals.' : 'Not expected at bracket ' + b + ', so not scored.', tgt('fastMana') ? null : 0));
    // ---- interaction
    var removal = namesWhere(X, function(r){ return r.jobs.removal; });
    var remHave = r1(X.rows.reduce(function(s, r){ return s + (!r.basic && !r.missing && r.jobs.removal ? (r.f.remW || 1) : 0); }, 0));
    var wipes = namesWhere(X, function(r){ return r.jobs.wipes; });
    var counters = namesWhere(X, function(r){ return r.f.counter; });
    var prot = namesWhere(X, function(r){ return r.jobs.protection; });
    var interRows = X.rows.filter(function(r){ return !r.basic && !r.missing && !r.f.land && (r.jobs.removal || r.jobs.wipes || r.jobs.protection || r.f.counter); });
    var inst = interRows.filter(function(r){ return r.f.instant; }).map(function(r){ return r.n; });
    var share = interRows.length ? inst.length / interRows.length : 0;
    var blue = ci.indexOf('U') >= 0;
    var inter = [
      part('removal', 'Targeted removal', remHave, tgt('removal'), fUp(remHave, tgt('removal')), removal,
        'Pings of 1 or 2 damage, answers to players only and colour-hosers count half.'),
      X.goWide ? part('wipes', 'Board wipes', wipes.length, 0, 1, wipes, 'This deck wins with a wide board (' + X.goWide + '), so board wipes of its own are not scored. One that spares your creatures can still help.', 0)
        : part('wipes', 'Board wipes', wipes.length, tgt('wipes'), fUp(wipes.length, tgt('wipes')), wipes),
      part('counterspells', 'Counterspells', counters.length, tgt('counterspells'), fUp(counters.length, tgt('counterspells')), counters,
        blue ? '' : 'Blue has most counterspells and this deck is not blue, so not scored.', blue && tgt('counterspells') ? null : 0),
      part('protection', 'Protection', prot.length, tgt('protection'), fUp(prot.length, tgt('protection')), prot),
      part('instantShare', 'Instant speed', Math.round(share * 100) / 100, tgt('instantShare'), fUp(share, tgt('instantShare')), inst,
        inst.length + ' of ' + interRows.length + ' interaction cards work at instant speed.')
    ];
    // ---- win conditions
    var fin = namesWhere(X, function(r){ return r.jobs.wincon; });
    var threats = namesWhere(X, function(r){ return !r.cmd && !r.jobs.wincon && r.f.threat; });
    var finHave = fin.length + threats.length / 2;
    var cl = comboList();
    var comboCards = uniq([].concat.apply([], cl.map(function(o){ return o.cards; })));
    var cmdR = X.rows.filter(function(r){ return r.cmd; });
    var cmdWhy = cmdThreat(X);
    var wt = sm ? sm.winTurn : null, wantT = tgt('winTurn');
    var wins = [
      part('finishers', 'Finishers', finHave, tgt('finishers'), fUp(finHave, tgt('finishers')), fin.concat(threats),
        'Drain, overruns, scaling damage, extra combats, alternate wins.' + (threats.length ? ' Big evasive or trampling creatures count half: ' + threats.length + '.' : '')),
      part('combos', 'Combos in the deck', cl.length, tgt('combos'), fUp(cl.length, tgt('combos')), comboCards,
        tgt('combos') ? (cl.length ? cl.slice(0, 3).map(function(o){ return o.cards.join(' + '); }).join('; ') : 'Commander Spellbook finds none.') : 'Not expected at bracket ' + b + ', so not scored.', tgt('combos') ? null : 0),
      part('commander', 'Commander as a threat', cmdWhy ? 1 : 0, 1, cmdWhy ? 0.95 : 0.35, cmdWhy ? cmdR.map(function(r){ return r.n; }) : [], cmdWhy || 'The commander does not win games by itself here.'),
      part('winTurn', 'Goldfish win turn', wt || (sm ? '15+' : null), wantT, sm ? (wt ? fDown(wt, wantT, 2) : 0.15) : 0.5, [],
        sm ? 'Median turn a test game with no opponents wins, from 800 shuffles (estimate).' : 'The test games could not run for this deck.', sm ? null : 0)
    ];
    var P = {
      consistency:pillarOf('consistency', cons, raiseTip),
      efficiency:pillarOf('efficiency', effParts, raiseTip),
      interaction:pillarOf('interaction', inter, raiseTip),
      wincons:pillarOf('wincons', wins, raiseTip)
    };
    P.overall = r1((P.consistency.score + P.efficiency.score + P.interaction.score + P.wincons.score) / 4);
    P.ready = true;
    P.bracket = b;
    P.winTurn = wt;
    P.note = 'Brewing Station\'s own estimate from the cards\' rules text, scored against bracket ' + b + ' targets. Not an official rating.' + (X.ok ? '' : ' ' + X.why);
    PIL = { key:key, v:P };
    return P;
  }catch(e){
    var z = function(){ return { score:0, verdict:'Could not work this out.', parts:[], raise:[] }; };
    return { consistency:z(), efficiency:z(), interaction:z(), wincons:z(), overall:0, note:'Could not score the deck: ' + e.message };
  }
};
function raiseTip(p){
  var n = Math.max(1, Math.ceil((typeof p.want === 'number' ? p.want : 0) - (typeof p.have === 'number' ? p.have : 0)));
  switch(p.key){
    case 'draw': return 'Add about ' + n + ' more card draw; cards that draw every turn count most.';
    case 'tutor': return 'Add ' + words(n, 'tutor') + ' to find your best cards.';
    case 'selection': return 'Add ' + words(n, 'card') + ' that scry, loot or look at the top of the deck.';
    case 'recursion': return 'Add a way to get cards back from the graveyard.';
    case 'avgMv': return 'Swap expensive spells for cheaper ones to bring the average mana value toward ' + p.want + ' (now ' + p.have + ').';
    case 'ramp': return 'Add ' + words(n, 'more ramp piece') + '.';
    case 'cheapRamp': return 'Swap slow ramp for ramp that costs 2 mana or less.';
    case 'lands': return 'Play about ' + p.want + ' lands (now ' + p.have + ').';
    case 'colours': return 'Add lands that make the colours you are short on: ' + p.note;
    case 'fastMana': return 'Fast mana (free or 1-mana rocks) would speed the deck up.';
    case 'removal': return 'Add ' + words(n, 'more removal spell') + ', cheap and instant speed if you can.';
    case 'wipes': return 'Add ' + words(n, 'board wipe') + '.';
    case 'counterspells': return 'Add ' + words(n, 'counterspell') + '.';
    case 'protection': return 'Add ' + n + ' more protection for your key creature (hexproof, indestructible, redirects).';
    case 'instantShare': return 'Swap sorcery-speed answers for instants or abilities you can use on any turn.';
    case 'finishers': return 'Add ' + words(n, 'card') + ' that ends the game once your board is set.';
    case 'combos': return 'A combo would give the deck a sudden win; see One card away on the Synergy page.';
    case 'commander': return 'Pick cards that turn the commander into a threat.';
    case 'winTurn': return 'Faster threats or more cheap ramp would win sooner.';
  }
  return '';
}

/* ============ values used by upgrades and downgrades ============ */
// How many of the deck's cards a card works with, read off the deck's live themes.
// A card in the deck is not counted against itself. Each theme adds at most 12.
function potential(c, X, inside){
  var n = 0;
  X.themes.forEach(function(h){
    if(!h.active) return;
    var e = enOf(h.t, c), p = payOf(h.t, c), k = 0;
    if(e) k += h.payRows.length - (inside && p ? 1 : 0);
    if(p) k += h.enRows.length - (inside && e ? 1 : 0);
    n += Math.min(12, Math.max(0, k));
  });
  return n;
}
function synB(n){ return 0.4 * (1 - Math.exp(-n / 8)); }
function comboNameSet(){ var s = {}; comboList().forEach(function(o){ o.cards.forEach(function(n){ s[lc(n)] = 1; s[front(n)] = 1; }); }); return s; }
// EDHREC's page for this commander lists the card (any of its numbers).
function listedOn(c){ var s = (c && c.stats) || {}; return !!((s.base && s.base.pd) || s.theme || s.bracket || s.exp); }
// The middle score of the deck's nonland cards that EDHREC does list.
var MID = { key:'', v:0.3 };
function midScore(X){
  if(MID.key === X.key) return MID.v;
  var v = X.rows.filter(function(r){ return !r.cmd && !r.basic && !r.missing && r.c && !isLand(r.c) && listedOn(r.c); })
    .map(function(r){ return safeScore(r.c); }).sort(function(a, b){ return a - b; });
  MID = { key:X.key, v:v.length ? v[Math.floor(v.length / 2)] : 0.3 };
  return MID.v;
}
function valueOf(c, X, inside, cset){
  var links = potential(c, X, inside), base = safeScore(c);
  // A card in the deck that EDHREC's page does not list (Torbran in Krenko) is unknown, not weak:
  // it is valued like the deck's middle card, so it is not the first one offered as a cut.
  if(inside && !listedOn(c)) base = Math.max(base, midScore(X));
  var v = base + synB(links) + (inside && cset && (cset[lc(c.n)] || cset[front(c.n)]) ? 0.3 : 0) + cmdEngineBonus(c, X);
  return { v:v, links:links };
}
// A card that repeats the commander's own tap ability (copies it, untaps the commander, gives it
// haste: Rings of Brighthearth, Illusionist's Bracers, Patriar's Seal in Krenko) is there for the
// commander, whatever else it links to, so it is worth more than its link count says.
function cmdEngineBonus(c, X){
  var h = X.themes.filter(function(x){ return x.active && x.t.k === 'untap'; })[0];
  if(!h || !h.enRows.some(function(r){ return r.cmd; })) return 0;
  return payOf(h.t, c) ? 0.25 : 0;
}
function limFor(tb){
  var cur = bk();
  if(tb === cur) return gcLim();
  if(tb > cur) return Math.max(gcLim(), BRACKETS[tb].gc);
  return BRACKETS[tb].gc;
}
// Does card c (with features f) do job `role`?
function doesJob(role, c, f){
  if(role === 'lands') return isLand(c) && !isBasic(c);
  if(isLand(c)) return false;
  switch(role){
    case 'ramp': return f.ramp;
    case 'tutor': return f.tutor;
    case 'draw': return !!f.R.draw || !!f.impulse;
    case 'removal': return f.removal;
    case 'wipes': return f.wipe;
    case 'protection': return f.protection;
    case 'wincon': return f.fin;
    case 'synergy': return synergyLike(c, f);
  }
  return true;
}
// The job a swap must keep. A noncreature card filed under Synergy whose text plainly
// does a staple job (Ruby Medallion is ramp) keeps that job, unless he set the job
// himself. Creatures stay Synergy: a Goblin lord that also cuts costs is there as a Goblin.
var STAPLE_ORDER = ['ramp', 'draw', 'removal', 'wipes', 'protection', 'tutor', 'wincon'];
function jobFor(r){
  if(r.role !== 'synergy' || fixOf(r.n) || /\bCreature\b/.test(r.c.type || '')) return r.role;
  for(var i = 0; i < STAPLE_ORDER.length; i++) if(r.jobs[STAPLE_ORDER[i]]) return STAPLE_ORDER[i];
  return 'synergy';
}
// Quality inside a job: repeatable draw beats a cantrip, hard removal beats a ping.
function qual(job, f){
  if(job === 'draw') return 0.15 * ((f.drawW || 0.5) - 0.5);
  if(job === 'removal') return 0.15 * ((f.remW || 0.5) - 0.5);
  return 0;
}
// Swapping a mana rock or land fetcher keeps a real mana ability.
function keepsMana(outF, inF, job){ return job !== 'ramp' || !outF.mana || inF.mana; }
function edhBit(c){
  var s = (c && c.stats) || {}, b = s.base && s.base.pd ? s.base : s.theme && s.theme.pd ? s.theme : s.exp && s.exp.pd ? s.exp : null;
  return b ? b.inc : null;
}
function rejected(n){ return (S.rejects || []).some(function(x){ return sameName(x.inn, n) || sameName(n, x.inn); }); }
function nearBreaks(n, tb){
  return nearList().some(function(o){ return o.missing && (sameName(o.missing, n) || sameName(n, o.missing)) && breaksAt(o, tb); });
}
// The missing piece of a combo that is infinite or breaks bracket tb (every near combo, not only the listed ones).
function nearBad(n, tb){
  return nearAllList().some(function(o){ return o.missing && (sameName(o.missing, n) || sameName(n, o.missing)) && (o.inf || breaksAt(o, tb)); });
}
// Where he already keeps a card: 'side' (his side deck), 'maybe' (Considering) or ''.
function ownedIn(n){
  var B = S.boards || {};
  function inB(l){ return (l || []).some(function(x){ return sameName(x.n, n) || sameName(n, x.n); }); }
  return inB(B.side) ? 'side' : inB(B.maybe) ? 'maybe' : '';
}
// How card c works with the commander in a live plan: 2 through a plan of its own (Patriar's Seal
// untaps Krenko, Rings of Brighthearth copies his ability), 1 only by sharing a creature type, 0 not.
function cmdLinked(c, X, self){
  var k = 0;
  X.themes.forEach(function(h){
    if(!h.active || k === 2) return;
    var e = enOf(h.t, c), p = payOf(h.t, c);
    if((e && h.payRows.some(function(r){ return r.cmd && r.n !== self; })) || (p && h.enRows.some(function(r){ return r.cmd && r.n !== self; }))) k = Math.max(k, h.t.tribe ? 1 : 2);
  });
  return k;
}
// A card that only makes mana once (a spell, or "sacrifice ~: add") does not replace a permanent mana source.
function oneShotMana(c, f){ return f.spell || /sacrifice ~[^:]*: add/.test(tx(c)); }
// A synergy card is replaced only by another synergy card: a creature (unless it is a tutor or a
// plain mana creature), or a noncreature card with no staple job of its own.
function synergyLike(c, f){
  if(isLand(c) || f.tutor) return false;
  if(/\bCreature\b/.test(c.type || '')) return !(f.ramp && f.mana && !f.fin);
  return !(f.ramp || f.drawW >= 1 || f.removal || f.wipe || f.protection);
}
var TUTOR_KEEP = { 1:1, 2:2, 3:4, 4:99, 5:99 };
function candidatePool(X){
  return (S.pool || []).filter(function(c){ return !inX(X, c.n) && okAdd(c) && !rejected(c.n); });
}

/* ============ ENGINE.upgrades ============ */
E.upgrades = function(opts){
  try{
    var X = ctx(); if(!X.ok) return withNote([], X.why);
    var cur = bk(), tb = clamp(+((opts && opts.bracket) || cur) || cur, 1, 5), lim = limFor(tb);
    var gcNow = X.gcs.length, room = Math.max(0, lim - gcNow), cset = comboNameSet();
    var push = tb > cur;
    // A piece of a combo the deck already runs (Zealous Conscripts with Kiki-Jiki) is a way to win,
    // so an upgrade never takes it out; only a combo the target bracket forbids is fair game (Downgrades).
    var keep = {};
    comboList().forEach(function(o){ if(breaksAt(o, tb)) return; o.cards.forEach(function(n){ keep[lc(n)] = 1; keep[front(n)] = 1; }); });
    var outs = X.rows.filter(function(r){ return !r.cmd && !r.basic && !r.must && !r.missing && !keep[lc(r.n)] && !keep[front(r.n)]; })
      .map(function(r){ var vv = valueOf(r.c, X, true, cset); return { r:r, v:vv.v, links:vv.links, job:jobFor(r) }; })
      .sort(function(a, b){ return a.v - b.v; });
    var ins = candidatePool(X).filter(function(c){
      var f = feats(c);
      if(tb <= 3 && (f.mld || (c.roles && c.roles.mld)) && !(tb === cur && hs().mld)) return false;
      // Below bracket 4, never the missing piece of an infinite combo or one the bracket forbids.
      if(tb <= 3 && nearBad(c.n, tb)) return false;
      return true;
    }).map(function(c){
      var f = feats(c), vv = valueOf(c, X, false), own = ownedIn(c.n);
      var bonus = push ? (isGc(c) ? 0.25 : 0) + (f.fast ? 0.15 : 0) + (f.tutorAny ? 0.15 : 0) : 0;
      // A card he already owns (side deck, Considering) goes first when it is about as good.
      if(own) bonus += 0.05;
      return { c:c, f:f, v:vv.v + bonus, links:vv.links, gc:isGc(c), own:own };
    });
    var extrasIn = X.rows.filter(function(r){ return r.f.extra; }).length;
    var tutorsIn = X.rows.filter(function(r){ return !r.cmd && r.jobs.tutor; }).length, tutorKeep = TUTOR_KEEP[tb];
    var cand = [];
    outs.forEach(function(o){
      var list = [], oCmd = cmdLinked(o.r.c, X, o.r.n);
      ins.forEach(function(i){
        if(!doesJob(o.job, i.c, i.f) || !keepsMana(o.r.f, i.f, o.job)) return;
        if(!isLand(i.c) && i.c.mv > (o.r.c.mv || 0) + 1) return;
        // Chained extra turns are out below bracket 4: at most one extra-turn card.
        if(tb <= 3 && i.f.extra && (extrasIn >= 1 || i.f.extraRep)) return;
        // A card that works with the commander is not replaced by one that works with it less: a card
        // in one of the commander's own plans (Patriar's Seal untaps Krenko) only by another such card.
        if(oCmd && cmdLinked(i.c, X) < oCmd) return;
        // A mana rock that stays is not replaced by mana that comes once (Lotus Petal), unless pushing up for fast mana.
        if(o.job === 'ramp' && o.r.f.mana && !oneShotMana(o.r.c, o.r.f) && oneShotMana(i.c, i.f) && !(push && i.f.fast)) return;
        var g = (i.v + qual(o.job, i.f)) - (o.v + qual(o.job, o.r.f)); if(g < 0.1) return;
        list.push({ o:o, i:i, g:g });
      });
      list.sort(function(a, b){ return b.g - a.g; });
      cand = cand.concat(list.slice(0, 6));
    });
    cand.sort(function(a, b){ return b.g - a.g; });
    var usedO = {}, usedI = {}, added = 0, tutAdded = 0, out = [];
    cand.forEach(function(p){
      if(out.length >= 20 || usedO[p.o.r.n] || usedI[p.i.c.n]) return;
      // Only additions are counted against the limit, so any subset of these swaps stays legal.
      if(p.i.gc && !p.o.r.gc){ if(added >= room) return; added++; }
      // Tutors coming in count against the bracket's rule of thumb for tutors.
      if(p.i.f.tutor && !p.o.r.jobs.tutor){ if(tutorsIn + tutAdded >= tutorKeep) return; tutAdded++; }
      usedO[p.o.r.n] = 1; usedI[p.i.c.n] = 1;
      out.push({ out:p.o.r.n, inn:p.i.c, role:p.o.job, gain:r2(p.g), why:upWhy(p, lim, gcNow + added, tb, cur), outCard:p.o.r.c, own:p.i.own || '' });
    });
    var note = out.length ? '' : 'No card in the pool is clearly better at the same job. The pool is EDHREC\'s cards for ' + short() + '.';
    if(lim !== Infinity && gcNow > lim) note += (note ? ' ' : '') + 'The deck already has ' + gcNow + ' Game Changers, over the limit of ' + lim + ', so none are added.';
    return withNote(out, note);
  }catch(e){ return withNote([], 'Could not find upgrades: ' + e.message); }
};
function upWhy(p, lim, gcAfter, tb, cur){
  var o = p.o, i = p.i, bits = [];
  bits.push((ROLE_NAMES[o.job] || 'Same job') + ', the same job as the card it replaces.');
  var a = edhBit(i.c), b = edhBit(o.r.c);
  if(a != null && b != null) bits.push('EDHREC: in ' + pc(a) + ' of ' + short() + ' decks, against ' + pc(b) + '.');
  else if(a != null) bits.push('EDHREC: in ' + pc(a) + ' of ' + short() + ' decks; the card it replaces is not on that page.');
  if(i.links > o.links) bits.push('Works with ' + i.links + ' of your cards, against ' + o.links + '.');
  if(i.gc) bits.push(o.r.gc ? 'Game Changer for Game Changer.' : 'Game Changer: ' + gcAfter + ' of ' + (lim === Infinity ? 'no limit' : lim) + ' at bracket ' + tb + '.');
  if(tb > cur && (i.f.fast || i.f.tutorAny)) bits.push(i.f.fast ? 'Fast mana for bracket ' + tb + '.' : 'Finds any card, for bracket ' + tb + '.');
  if(i.c.mv < (o.r.c.mv || 0)) bits.push('Costs ' + ((o.r.c.mv || 0) - i.c.mv) + ' less.');
  return bits.join(' ');
}

/* ============ ENGINE.downgrades ============ */
E.downgrades = function(opts){
  try{
    var X = ctx(); if(!X.ok) return withNote([], X.why);
    var cur = bk(), tb = +((opts && opts.bracket) || cur - 1);
    if(!(tb >= 1)) return withNote([], 'There is no bracket below 1.');
    if(tb >= cur) return withNote([], 'Pick a bracket lower than ' + cur + ' to power the deck down.');
    var lim = BRACKETS[tb].gc, cset = comboNameSet();
    // Tutors each target bracket keeps (rule of thumb: low brackets play them lightly).
    var tutorKeep = { 1:1, 2:2, 3:4, 4:99, 5:99 }[tb];
    var all = X.rows.filter(function(r){ return !r.cmd && !r.basic && !r.must && !r.missing; });
    var rows = all.filter(function(r){ return !r.f.land; });
    var val = {}; all.forEach(function(r){ val[r.n] = valueOf(r.c, X, true, cset); });
    var outs = [], taken = {};
    function mark(r, pri, why){ if(taken[r.n]) return; taken[r.n] = 1; outs.push({ r:r, pri:pri, why:why, v:val[r.n].v }); }
    // 1. Game Changers over the target limit, strongest first (lands such as Gaea's Cradle too).
    var gcs = all.filter(function(r){ return r.gc; }).sort(function(a, b){ return val[b.n].v - val[a.n].v; });
    var gcCount = X.gcs.length;
    gcs.forEach(function(r){ if(gcCount > lim){ mark(r, 5, 'Game Changer: bracket ' + tb + ' allows ' + (lim === 0 ? 'none' : lim) + '.'); gcCount--; } });
    // 2. Tutors past what the bracket keeps; the ones that find any card go first.
    var tut = rows.filter(function(r){ return r.jobs.tutor; }).sort(function(a, b){ return (b.f.tutorAny - a.f.tutorAny) || (val[b.n].v - val[a.n].v); });
    tut.slice(0, Math.max(0, tut.length - tutorKeep)).forEach(function(r){ mark(r, 4, 'Tutor: bracket ' + tb + ' decks keep tutors rare (this keeps ' + tutorKeep + ').'); });
    // 3. Combos that break the target bracket: cut the weakest piece that is not the commander.
    comboList().forEach(function(o){
      if(!breaksAt(o, tb)) return;
      var pcs = o.cards.map(rowOf).filter(function(r){ return r && !r.cmd && !r.must && !r.basic; });
      if(pcs.some(function(r){ return taken[r.n]; })) return;
      pcs.sort(function(a, b){ return (val[a.n] ? val[a.n].v : 0) - (val[b.n] ? val[b.n].v : 0); });
      if(pcs[0] && val[pcs[0].n]) mark(pcs[0], 3, 'Breaks a combo not allowed at bracket ' + tb + ': ' + o.cards.join(' + ') + ' (' + o.result + ').');
    });
    // 4. Fast mana, extra turns and land destruction.
    rows.forEach(function(r){
      if(tb <= 2 && r.f.fast && !/^sol ring$/i.test(r.n)) mark(r, 3, 'Fast mana: bracket ' + tb + ' decks ramp fairly.');
      if(r.f.mld && tb <= 3) mark(r, 3, 'Mass land destruction: not allowed at bracket ' + tb + '.');
    });
    // Chained extra turns are out at brackets 1 to 3; a single extra turn is fine. One that comes back
    // goes, and when there are several, all but the weakest.
    var ext = rows.filter(function(r){ return r.f.extra; }).sort(function(a, b){ return val[a.n].v - val[b.n].v; });
    if(tb <= 3) ext.forEach(function(r, k){
      if(r.f.extraRep) mark(r, 3, 'Extra turns that come back again: bracket ' + tb + ' allows no chained extra turns.');
      else if(k > 0) mark(r, 3, 'More than one extra-turn card: bracket ' + tb + ' allows no chained extra turns.');
    });
    // 5. Then the strongest cards, at most 6, each for a clearly weaker card.
    rows.filter(function(r){ return !taken[r.n]; }).sort(function(a, b){ return val[b.n].v - val[a.n].v; }).slice(0, 12)
      .forEach(function(r){ outs.push({ r:r, pri:0, why:'One of the strongest cards in the deck.', v:val[r.n].v }); });
    var pool = candidatePool(X).filter(function(c){
      var f = feats(c);
      if(isGc(c) || f.tutorAny || f.mld || f.extra || (c.roles && (c.roles.mld || c.roles.extra))) return false;
      if(tb <= 2 && f.fast) return false;
      // Never the missing piece of an infinite combo, or of one the target bracket forbids.
      if(nearBad(c.n, tb)) return false;
      return true;
    }).map(function(c){ var own = ownedIn(c.n); return { c:c, f:feats(c), v:valueOf(c, X, false).v, own:own }; });
    var usedI = {}, list = [], stuck = [], zero = 0;
    outs.sort(function(a, b){ return b.pri - a.pri || b.v - a.v; });
    outs.forEach(function(o){
      if(list.length >= 20) return;
      if(o.pri === 0 && zero >= 6) return;
      var role = jobFor(o.r), mv = o.r.c.mv || 0;
      // A tutor leaving is replaced by card draw, which finds cards more slowly.
      var job = role === 'tutor' ? 'draw' : role;
      var best = null, bestV = 0, bestRank = 0;
      pool.forEach(function(i){
        if(usedI[i.c.n]) return;
        if(!doesJob(job, i.c, i.f) || !keepsMana(o.r.f, i.f, job)) return;
        if(role === 'tutor' && i.f.tutor) return;
        if(job === 'ramp' && o.r.f.fast){ if(i.c.mv < 2 || i.c.mv > 3) return; }
        else if(Math.abs(i.c.mv - mv) > 1) return;
        var iv = i.v + qual(job, i.f);
        if(o.pri === 0 && iv > o.v + qual(job, o.r.f) - 0.1) return;
        // A card he already owns (side deck, Considering) is picked first when it fits.
        var rank = iv + (i.own ? 0.05 : 0);
        if(!best || rank > bestRank){ best = i; bestV = iv; bestRank = rank; }
      });
      if(!best && job === 'lands' && o.pri > 0){
        // No fair nonbasic land: a basic land of the deck's main colour does the job.
        var col = (S.ci || [])[0], bn = col ? BASICS[col] : 'Wastes';
        best = { c:{ n:bn, type:'Basic Land — ' + bn, o:'', cost:'', mv:0, ci:[], prod:[col || 'C'], legal:'legal', kw:[], basic:true, stats:{} }, f:{}, v:0.05 };
        bestV = best.v;
      }
      if(!best){ if(o.pri > 0) stuck.push(o.r.n); return; }
      if(!best.c.basic) usedI[best.c.n] = 1;
      if(o.pri === 0) zero++;
      list.push({ out:o.r.n, inn:best.c, role:role, gain:r2(o.v + qual(job, o.r.f) - bestV), pri:o.pri, own:best.own || '',
        why:o.why + ' ' + best.c.n + (job === role ? ' does the same job (' + (ROLE_NAMES[job] || job) + ').' : ' draws cards instead.'), outCard:o.r.c });
    });
    var gcLeft = X.gcs.length - list.filter(function(p){ var r = rowOf(p.out); return r && r.gc; }).length;
    var note = [];
    if(stuck.length) note.push('No fair card for the same job in the pool for: ' + stuck.join(', ') + '. Cut these by hand.');
    if(gcLeft > lim) note.push('After these swaps the deck still has ' + gcLeft + ' Game Changers; bracket ' + tb + ' allows ' + lim + '.');
    return withNote(list, note.join(' '));
  }catch(e){ return withNote([], 'Could not find downgrades: ' + e.message); }
};

/* ============ ENGINE.interesting ============ */
E.interesting = async function(){
  try{
    if(!has()) return withNote([], 'No deck is open.');
    var X = ctx(); if(!X.ok) return withNote([], X.why);
    var out = [], seen = {}, count = {};
    // The tile's numbers come from EDHREC's main page for this commander only. A card that is only on
    // a theme or no-budget page shows no share, instead of that page's share read as all decks.
    function stat(c){ var b = (c.stats && c.stats.base) || {}; return { inc:b.pd ? b.nd / b.pd : 0, syn:b.pd ? b.syn || 0 : 0 }; }
    function push(c, kind, why, cap){
      if(!c || seen[lc(c.n)] || inX(X, c.n) || (count[kind] || 0) >= cap) return;
      if(!okAdd(c)) return;
      seen[lc(c.n)] = 1; count[kind] = (count[kind] || 0) + 1;
      var s = stat(c);
      out.push({ n:c.n, c:c, kind:kind, why:why, inc:r2(s.inc), syn:r2(s.syn), own:ownedIn(c.n) });
    }
    // One card from a combo.
    var cb = await E.combos().catch(function(){ return null; });
    ((cb && cb.near) || []).forEach(function(o){
      var others = o.cards.filter(function(n){ return !(sameName(n, o.missing) || sameName(o.missing, n)); });
      push(o.c, 'combo', 'Completes a combo with ' + others.join(' and ') + ': ' + o.result + '.' + (o.breaks ? ' Too strong for bracket ' + bk() + '.' : ''), 6);
    });
    var base = S.base && S.base.cards ? S.base.cards : [];
    // EDHREC's High Synergy list first, then the pool by synergy.
    var synList = base.filter(function(x){ return x.list === 'High Synergy Cards'; }).map(function(x){ return pcard(x.n); })
      .concat((S.pool || []).filter(function(c){ return c.stats && c.stats.base && c.stats.base.syn >= 0.3; })
        .sort(function(a, b){ return b.stats.base.syn - a.stats.base.syn; }));
    synList.forEach(function(c){ if(!c) return; var s = stat(c); push(c, 'synergy', s.inc ? 'EDHREC: synergy +' + pc(s.syn) + ' with ' + short() + ', in ' + pc(s.inc) + ' of its decks.' : 'On EDHREC\'s High Synergy list for ' + short() + '.', 10); });
    // Hidden gems: few decks play them, but most of that play comes from this commander.
    // (EDHREC synergy is this commander's share minus other decks' share, so it can
    // never beat the inclusion: a gem keeps synergy at 60% or more of its inclusion.)
    (S.pool || []).filter(function(c){ var b = c.stats && c.stats.base; if(!b || !b.pd) return false; var inc = b.nd / b.pd; return inc <= 0.3 && b.syn >= 0.1 && b.syn >= 0.6 * inc; })
      .sort(function(a, b){ return b.stats.base.syn - a.stats.base.syn; })
      .forEach(function(c){ var s = stat(c); push(c, 'gem', 'Only ' + pc(s.inc) + ' of ' + short() + ' decks play it, but other decks almost never do (synergy +' + pc(s.syn) + ').', 8); });
    // EDHREC's New Cards list.
    var fresh = base.filter(function(x){ return x.list === 'New Cards'; });
    var need = fresh.filter(function(x){ return !pcard(x.n); }).map(function(x){ return { id:x.id, n:x.n }; });
    var got = {};
    if(need.length){ try{ got = (await sfCollection(need)).cards; }catch(e){} }
    fresh.forEach(function(x){
      var c = pcard(x.n) || got[x.id] || got[lc(x.n)];
      push(c, 'new', 'New card on EDHREC: in ' + pc(x.pd ? x.nd / x.pd : 0) + ' of recent ' + short() + ' decks.', 8);
    });
    // Fits the strongest theme by rules text.
    var top = X.themes.filter(function(h){ return h.active; })[0];
    if(top){
      (S.pool || []).filter(function(c){ return !isLand(c) && (enOf(top.t, c) || payOf(top.t, c)); })
        .map(function(c){ return { c:c, v:valueOf(c, X, false).v, p:payOf(top.t, c) }; })
        .sort(function(a, b){ return b.v - a.v; })
        .forEach(function(x){
          push(x.c, 'theme', x.p ? 'Rewards your ' + top.t.label.toLowerCase() + ': ' + words(top.enRows.length, 'card') + ' in the deck feed it.'
            : 'Feeds your ' + top.t.label.toLowerCase() + ': ' + words(top.payRows.length, 'card') + ' in the deck reward it.', 10);
        });
    }
    // Cards he already owns (side deck, Considering) first within each kind: they cost nothing.
    out.forEach(function(x, i){ x.i = i; });
    out.sort(function(a, b){ return a.kind === b.kind ? ((b.own ? 1 : 0) - (a.own ? 1 : 0)) || a.i - b.i : a.i - b.i; });
    out.forEach(function(x){ delete x.i; });
    return withNote(out, out.length ? '' : 'Nothing new turned up in the pool for this deck.');
  }catch(e){ return withNote([], 'Could not look for interesting cards: ' + e.message); }
};

/* ============ ENGINE.edhrec ============
   What EDHREC's commander page shows, in its own list order and titles.
   Paths (checked live 29 Sep 2026): /commanders/<slug>, /commanders/<slug>/<theme>,
   /commanders/<slug>/<bracket page>, /commanders/<slug>/<bracket page>/<theme>
   (theme after bracket; the other order is 403), and the same under /average-decks/.
   The average deck JSON carries deck.cards = {Type:[[name, count]]}. */
// EDHREC answers some filters (a theme at a bracket with no decks) with an empty page: that is no page.
async function edhPage(path){ try{ var p = await edh(path); return p && p.cards && p.cards.length ? p : null; }catch(e){ return null; } }
async function avgDeck(path){
  var key = 'avg:' + path, hit = null;
  try{ hit = await cacheGet(key); }catch(e){ hit = null; }
  if(hit) return hit;
  try{
    var r = await fetch((typeof EDH === 'string' ? EDH : 'https://json.edhrec.com/pages') + path + '.json', { headers:{ 'Accept':'application/json' } });
    if(!r.ok) return null;
    var j = await r.json();
    if(!j || j.redirect || !j.deck || !j.deck.cards) return null;
    var cards = [];
    Object.keys(j.deck.cards).forEach(function(t){ (j.deck.cards[t] || []).forEach(function(x){ cards.push([x[0], x[1] || 1]); }); });
    var v = { header:j.header || '', cards:cards };
    try{ await cachePut(key, v); }catch(e){}
    return v;
  }catch(e){ return null; }
}
function isBasicName(n){ return /^(?:snow-covered )?(?:plains|island|swamp|mountain|forest)$|^wastes$/i.test(n); }
E.edhrec = async function(opts){
  opts = opts || {};
  var out = { url:'', header:'', decks:0, rank:null, salt:null, themes:[], lists:[], average:null, note:'', theme:opts.theme || '', bracket:opts.bracket || null, budget:opts.budget || '',
    bracketCounts:null, budgetCounts:null, combos:[], similar:[] };
  try{
    if(!has()){ out.note = 'No deck is open.'; return out; }
    var slugs = S.slug ? [S.slug] : edhSlugs(), slug = slugs[0], base = null, notes = [];
    for(var i = 0; i < slugs.length && !base; i++){ base = await edhPage('/commanders/' + slugs[i]); if(base) slug = slugs[i]; }
    if(!base && S.base) base = S.base;
    if(!base){ out.note = 'EDHREC has no page for ' + S.cmd.n + (S.partner ? ' and ' + S.partner.n : '') + '.'; return out; }
    var th = opts.theme || '', br = opts.bracket && BRACKETS[opts.bracket] ? BRACKETS[opts.bracket] : null;
    // Budget: EDHREC's cheaper and pricier decks for this commander, after the bracket and theme.
    var bud = opts.budget === 'budget' || opts.budget === 'expensive' ? opts.budget : '';
    var root = '/commanders/' + slug, path = root + (br ? '/' + br.page : '') + (th ? '/' + th : '') + (bud ? '/' + bud : '');
    var page = path === root ? base : await edhPage(path);
    if(!page && bud){ notes.push('EDHREC has no ' + bud + ' page for this filter, so this shows decks at every price.'); bud = ''; path = root + (br ? '/' + br.page : '') + (th ? '/' + th : ''); page = path === root ? base : await edhPage(path); }
    if(!page && br && th){ notes.push('EDHREC has no ' + th + ' page for bracket ' + opts.bracket + ', so this shows every ' + th + ' deck.'); path = root + '/' + th; page = await edhPage(path); br = null; }
    if(!page && th){ notes.push('EDHREC has no ' + th + ' page for ' + short() + ', so this shows all its decks.'); path = root + (br ? '/' + br.page : ''); page = path === root ? base : await edhPage(path); th = ''; }
    if(!page && br){ notes.push('EDHREC has no bracket ' + opts.bracket + ' page for ' + short() + ', so this shows all its decks.'); path = root; page = base; br = null; }
    out.url = 'https://edhrec.com' + path;
    out.bracketCounts = base.bc || null; out.budgetCounts = base.bud || null;
    out.combos = (base.combos || []).slice(0, 12); out.similar = (base.similar || []).slice(0, 8);
    out.header = page.header || base.header || '';
    out.decks = page.decks || 0; out.rank = base.rank != null ? base.rank : null; out.salt = base.salt != null ? r2(base.salt) : null;
    out.themes = ((page.tags && page.tags.length ? page.tags : base.tags) || []).map(function(t){ return { slug:t.slug, value:t.value, count:t.count }; });
    // Lists in EDHREC's order, cards in its order.
    var lists = [], byTitle = {}, DX = ctx();
    (page.cards || []).forEach(function(x){
      var L = byTitle[x.list]; if(!L){ L = byTitle[x.list] = { title:x.list, cards:[] }; lists.push(L); }
      L.cards.push({ n:x.n, id:x.id, inc:r2(x.pd ? x.nd / x.pd : 0), syn:r2(x.syn || 0), inDeck:inX(DX, x.n) });
    });
    // Average deck.
    var apath = '/average-decks/' + slug + (br ? '/' + br.page : '') + (th ? '/' + th : '') + (bud ? '/' + bud : '');
    var avg = await avgDeck(apath);
    var average = null;
    if(avg){
      var incOf = {}; (page.cards || []).forEach(function(x){ incOf[lc(x.n)] = x.pd ? x.nd / x.pd : 0; });
      var avgNames = {}, avgBasics = 0, missing = [];
      avg.cards.forEach(function(x){
        if(isBasicName(x[0])){ avgBasics += x[1]; return; }
        avgNames[lc(x[0])] = 1; avgNames[front(x[0])] = 1;
        if(!inX(DX, x[0])){ var pcx = pcard(x[0]); missing.push({ n:x[0], inc:r2(incOf[lc(x[0])] != null ? incOf[lc(x[0])] : edhBit(pcx) || 0) }); }
      });
      missing.sort(function(a, b){ return b.inc - a.inc; });
      var X = ctx(), extra = [], myBasics = 0;
      X.rows.forEach(function(r){
        if(r.cmd) return;
        if(r.basic){ myBasics += r.q; return; }
        if(!avgNames[lc(r.n)] && !avgNames[front(r.n)]) extra.push(r.n);
      });
      average = { url:'https://edhrec.com' + apath, header:avg.header, missing:missing, extra:extra, basics:{ avg:avgBasics, you:myBasics } };
    } else notes.push('EDHREC\'s average deck did not load.');
    // Card objects so every tile has a picture: the pool first, then Scryfall.
    var want = [];
    lists.forEach(function(L){ L.cards.forEach(function(x){ if(!pcard(x.n)) want.push({ id:x.id, n:x.n }); }); });
    if(average) average.missing.forEach(function(x){ if(!pcard(x.n)) want.push({ n:x.n }); });
    var got = {};
    if(want.length){
      var seenW = {}; want = want.filter(function(x){ var k = lc(x.n); if(seenW[k]) return false; seenW[k] = 1; return true; });
      try{ got = (await sfCollection(want)).cards; }catch(e){ notes.push('Scryfall did not answer, so some cards have no picture.'); }
    }
    function cardFor(x){ return pcard(x.n) || (x.id && got[x.id]) || got[lc(x.n)] || null; }
    lists.forEach(function(L){ L.cards.forEach(function(x){ x.c = cardFor(x); delete x.id; }); });
    if(average) average.missing.forEach(function(x){ x.c = cardFor(x); });
    out.lists = lists; out.average = average;
    out.theme = th; out.bracket = br ? +opts.bracket : null; out.budget = bud;
    out.note = notes.join(' ');
    return out;
  }catch(e){ out.note = 'EDHREC could not be read: ' + e.message; return out; }
};

/* ============ money ============ */
var FXR = null;
try{ FXR = JSON.parse(localStorage.getItem('forge.fx') || 'null'); }catch(e){ FXR = null; }
var FXP = null;
// Pesos per US dollar, cached 3 days (the Card Scanner's two sources, same sanity check).
E.rate = function(){
  if(FXR && FXR.rate && Date.now() - FXR.at < 3 * DAY_MS) return Promise.resolve(FXR.rate);
  if(FXP) return FXP;
  FXP = (async function(){
    var sources = [
      ['https://open.er-api.com/v6/latest/USD', function(j){ return j.rates && j.rates.PHP; }],
      ['https://api.frankfurter.app/latest?from=USD&to=PHP', function(j){ return j.rates && j.rates.PHP; }]
    ];
    for(var i = 0; i < sources.length; i++){
      try{
        var r = await fetch(sources[i][0]);
        if(!r.ok) continue;
        var v = +sources[i][1](await r.json());
        if(v > 20 && v < 200){
          FXR = { rate:v, at:Date.now() };
          try{ localStorage.setItem('forge.fx', JSON.stringify(FXR)); }catch(e){}
          return v;
        }
      }catch(e){}
    }
    return FXR ? FXR.rate : null;
  })();
  FXP.then(function(){ FXP = null; }, function(){ FXP = null; });
  return FXP;
};
// "₱1,240", or "" when the price or the rate is unknown. Uses the last known rate.
E.php = function(usd){
  if(usd == null || usd === '' || isNaN(usd)) return '';
  var r = FXR && FXR.rate;
  if(!r){ E.rate(); return ''; }
  var p = usd * r;
  if(!p) return '₱0';
  if(p < 10) return '₱' + p.toFixed(p < 1 ? 2 : 1);
  return '₱' + Math.round(p).toLocaleString('en-US');
};
function usdOf(c){ return c && typeof c.usd === 'number' && !isNaN(c.usd) ? c.usd : null; }
// Deck price: every copy of every nonbasic card, commander included.
E.price = function(){
  try{
    var X = ctx(), sum = 0, known = 0, unknown = [], each = [];
    X.rows.forEach(function(r){
      if(r.basic) return;
      var u = usdOf(r.c);
      if(u == null && r.cmd) u = usdOf(S.cmd && sameName(S.cmd.n, r.n) ? S.cmd : S.partner);
      if(u == null){ unknown.push(r.n); return; }
      sum += u * r.q; known++; each.push({ n:r.n, usd:u });
    });
    each.sort(function(a, b){ return b.usd - a.usd; });
    return { usd:known ? r2(sum) : null, php:known ? E.php(sum) : '', known:known, unknown:unknown, top:each.slice(0, 5),
      note:unknown.length ? words(unknown.length, 'card') + ' have no price yet.' : '' };
  }catch(e){ return { usd:null, php:'', known:0, unknown:[], top:[], note:'Could not price the deck: ' + e.message }; }
};

// A short fingerprint of the 100 (commander and every card, copies counted). A shelf
// row's sum is out of date when row.sum.key !== ENGINE.key() for that deck.
E.key = function(){
  if(!has()) return '';
  var s = [S.cmd.n, S.partner ? S.partner.n : ''].concat((S.deck || []).map(function(d){ return d.n; }).sort()).join('|');
  var h = 0x811c9dc5;
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + '.' + (S.deck || []).length;
};

/* ============ ENGINE.summary ============ small, for the shelf row and Compare (well under 4 KB) */
E.summary = function(){
  try{
    var X = ctx(); if(!X.ok) return null;   // no card data yet: nothing worth storing
    var P = E.pillars(), roles = { lands:0, ramp:0, tutor:0, draw:0, removal:0, wipes:0, protection:0, wincon:0, synergy:0 };
    (S.deck || []).forEach(function(d){ var k = fixOf(d.n) || d.role || 'synergy'; if(roles[k] != null) roles[k]++; });
    var curve = [0, 0, 0, 0, 0, 0, 0, 0], mvSum = 0, mvN = 0;
    spellsOf(X).forEach(function(r){ var m = r.c.mv || 0; curve[Math.min(7, Math.floor(m))] += r.q; mvSum += m * r.q; mvN += r.q; });
    var th = X.themes.filter(function(h){ return h.active; }).slice(0, 3).map(function(h){ return h.t.label; });
    var pr = E.price();
    return {
      key:E.key(), at:Date.now(),
      cmd:S.cmd.n, partner:S.partner ? S.partner.n : null, art:(S.cmd.img || '').replace('/normal/', '/art_crop/'),
      ci:(S.ci || []).slice(), bracket:S.bracket || null,
      pillars:{ c:P.consistency.score, e:P.efficiency.score, i:P.interaction.score, w:P.wincons.score, o:P.overall },
      roles:roles, curve:curve, avgMv:mvN ? r2(mvSum / mvN) : 0, gcs:X.gcs.length,
      combos:(CB.res && CB.key === namesSig()) || (S.lastCheck && S.lastCheck.combos) ? comboList().length : null,
      themes:th, usd:pr.usd, names:X.rows.filter(function(r){ return !r.basic; }).map(function(r){ return r.n; }), winTurn:P.winTurn || null
    };
  }catch(e){ return null; }
};

// Loads what the sync calls can use (combos, the exchange rate). Call it before
// pillars() or summary() when combos should count; it never rejects.
E.prime = function(){
  return Promise.all([E.combos().catch(function(){ return null; }), E.rate().catch(function(){ return null; })]).then(function(){ return true; });
};
// The TARGET table, for pages that want to show what a pillar aims for.
E.targets = function(b){
  var i = (b || bk()) - 1, o = {}; Object.keys(TARGET).forEach(function(k){ o[k] = TARGET[k][i]; });
  // This deck's own adjustment: a go-wide deck has no board wipe target (see the Interaction pillar).
  try{ if(has() && (!b || b === bk()) && ctx().goWide) o.wipes = null; }catch(e){}
  return o;
};
E.version = '1';

window.ENGINE = E;
})();
