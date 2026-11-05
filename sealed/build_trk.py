"""Builds sealed/trk/trk.json, the one Star Trek data file the Sealed helper and
Brewing Station's Sealed area both read: every card from Scryfall, Claude's
scores (trk/ratings.txt), the published grades (trk/published.json), and the
video's teaching (trk/teach.json, trk/tcc.json).
Run `py build_trk.py` from this folder; `py build_trk.py path/to/scryfall.json`
uses a saved Scryfall search instead of fetching."""
import json, re, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).parent / 'trk'
UA = {'User-Agent': 'TomTools/1.0', 'Accept': 'application/json'}
# Abilities a player can use straight from their hand at instant speed.
FROM_HAND = {
    '91': ('{2}{B}', 'Discard it: a creature gets -4/-4'),
    '204': ('{2}{G}', 'Discard it: two +1/+1 counters on a creature'),
    '245': ('{W}{B}', 'Discard it: 2 damage to a creature, gain 2 life'),
}
COST_NOTE = {
    '60': 'Costs 1 less against an attacker',
    '62': 'Kicked for 4 mana it counters any spell',
    '169': 'Costs 2 less while they attack you',
}
# The helper's colour-pair codes.
PAIR = {'WU': 'WU', 'UB': 'UB', 'BR': 'BR', 'RG': 'RG', 'WG': 'GW', 'GW': 'GW', 'WB': 'WB',
        'UR': 'UR', 'BG': 'BG', 'WR': 'RW', 'RW': 'RW', 'UG': 'GU', 'GU': 'GU'}


def fetch():
    if len(sys.argv) > 1:
        return json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    url, out = 'https://api.scryfall.com/cards/search?q=e%3Atrk&unique=cards&order=set', []
    while url:
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA)))
        out += d['data']
        url = d.get('next_page')
        time.sleep(0.12)
    return out


def ratings():
    r = {}
    for line in (HERE / 'ratings.txt').read_text(encoding='utf-8').splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        num, score, tags, note = [p.strip() for p in line.split('|', 3)]
        r[num] = (float(score), tags, note)
    return r


def published(rate, names):
    """Draftsim (N/10) and MTG Arena Zone (N/5), both read 2026-11-05. Draftsim's
    spread is matched to Claude's and Arena Zone's, as for Reality Fracture."""
    pub = json.loads((HERE / 'published.json').read_text(encoding='utf-8'))['cards']
    ids = [i for i in rate if names.get(i) in pub]
    g = {i: pub[names[i]] for i in ids}
    ds = {i: float(g[i]['draftsim'].split('/')[0]) for i in ids if 'draftsim' in g[i]}
    az = {i: float(g[i]['mtgazone'].split('/')[0]) for i in ids if 'mtgazone' in g[i]}
    base = [rate[i][0] for i in ids] + list(az.values())
    mean = lambda v: sum(v) / len(v)
    sd = lambda v: (sum((x - mean(v)) ** 2 for x in v) / len(v)) ** 0.5
    k = sd(base) / sd(list(ds.values()))
    dcal = {i: max(0, min(5, mean(base) + (v - mean(list(ds.values()))) * k)) for i, v in ds.items()}
    out = {}
    for i in ids:
        parts = [rate[i][0]] + ([dcal[i]] if i in dcal else []) + ([az[i]] if i in az else [])
        theirs = parts[1:]
        out[i] = {'s': round(mean(parts), 1), 'cl': rate[i][0], 'ds': g[i].get('draftsim'), 'az': g[i].get('mtgazone'),
                  'gap': bool(theirs) and abs(rate[i][0] - mean(theirs)) >= 1.0}
    print('draftsim scale x%.2f, mean %.2f' % (k, mean(list(ds.values()))))
    return out


def main():
    cards = fetch()
    rate = ratings()
    teach = json.loads((HERE / 'teach.json').read_text(encoding='utf-8'))
    tcc = json.loads((HERE / 'tcc.json').read_text(encoding='utf-8'))
    main_set = [c for c in cards if c['collector_number'].isdigit() and int(c['collector_number']) <= 306
                and 'Basic Land' not in c['type_line']]
    names = {c['collector_number']: c['name'] for c in main_set}
    pub = published(rate, names)
    out, byname = [], {}
    for c in sorted(main_set, key=lambda c: int(c['collector_number'])):
        num = c['collector_number']
        score, tags, note = rate.get(num, (None, '', ''))
        img = c.get('image_uris') or {}
        row = {'id': num, 'n': c['name'], 'full': c['name'], 'm': c.get('mana_cost', ''), 't': c['type_line'],
               'r': c['rarity'][0].upper(), 'col': ''.join(x for x in 'WUBRG' if x in (c.get('colors') or [])),
               'ci': ''.join(x for x in 'WUBRG' if x in (c.get('color_identity') or [])),
               'x': c.get('oracle_text', ''), 'img': img.get('normal', ''), 'art': img.get('art_crop', ''),
               's': score, 'note': note}
        if num in pub:
            row.update(pub[num])
            if not row['gap']:
                del row['gap']
        if 'power' in c:
            row['pt'] = f"{c['power']}/{c['toughness']}"
        if 'rm' in tags.split(','):
            row['rm'] = 1
        if 'Land' in c['type_line']:
            row['land'] = 1
            row['prod'] = ''.join(x for x in 'WUBRG' if x in (c.get('produced_mana') or []))
        if re.search(r'\{[WUBRG]/[WUBRG]\}', row['m']):
            row['hy'] = 1
        if 'Instant' in c['type_line'] or 'Flash' in (c.get('keywords') or []):
            row['ins'] = 1
        if num in FROM_HAND:
            row['hand'] = {'m': FROM_HAND[num][0], 'x': FROM_HAND[num][1]}
        if num in COST_NOTE:
            row['costnote'] = COST_NOTE[num]
        if c['name'] in teach['notes']:
            row['vid'] = teach['notes'][c['name']]
        if c['name'] in teach['bombs']:
            row['bomb'] = 1
        out.append(row)
        byname[c['name']] = num
    missing = [n for n in list(teach['notes']) + teach['bombs'] if n not in byname]
    to_ids = lambda d: {byname[n]: q for n, q in d.items() if n in byname}
    basics = {'Plains': 'W', 'Island': 'U', 'Swamp': 'B', 'Mountain': 'R', 'Forest': 'G'}
    data = {
        'set': 'trk', 'name': 'Star Trek', 'released': '2026-11-13',
        'sources': {'claude': 'Claude, from card text and the video, 2026-11-05',
                    'draftsim': 'https://draftsim.com/mtg-trk-limited-set-review/',
                    'mtgazone': 'https://mtgazone.com/star-trek-trk-limited-set-review-white/'},
        'video': {'title': 'Complete Guide To Star Trek Prerelease!', 'by': 'Tolarian Community College',
                  'url': 'https://www.youtube.com/watch?v=pvOOphY0Hgo'},
        'pairs': {PAIR[k]: {'name': v[0], 'plan': v[1], 'keys': teach['keys'].get(PAIR[k], teach['keys'].get(k, []))}
                  for k, v in teach['pairs'].items()},
        'primer': teach['primer'],
        'tcc': {'pool': to_ids(tcc['pool']), 'built': to_ids(tcc['built']),
                'basics': {basics[n]: q for n, q in tcc['built'].items() if n in basics}},
        'cards': out,
    }
    (HERE / 'trk.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(len(out), 'cards;', sum(r['s'] is None for r in out), 'without a score;', sum('gap' in r for r in out), 'split;',
          'teaching names not found:', missing)


if __name__ == '__main__':
    main()
