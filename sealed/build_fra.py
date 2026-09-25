"""Builds sealed/fra.json: every Reality Fracture card from Scryfall, joined to
the scores in ratings.txt. Run with `py build_fra.py` from this folder whenever
the scores change or Scryfall adds cards."""
import json, re, time, urllib.request
from pathlib import Path

HERE = Path(__file__).parent
SET = 'fra'
UA = {'User-Agent': 'TomTools/1.0', 'Accept': 'application/json'}

# Abilities a player can use straight from their hand at instant speed, so they
# belong on the trick list even though the card is not an instant.
FROM_HAND = {
    '115': ('{3}{G}', 'Discard it: destroy a flying creature'),
    '198': ('{1}{W}', 'Discard it: 4 damage to an attacker or blocker'),
    '235': ('{B}', 'Discard it: a creature gets -3/-1'),
}
COST_NOTE = {
    '25': 'Costs 1 more unless they have a Jace',
    '96': 'Costs 1 less if they have a legendary creature',
}


def fetch_set():
    ids = [{'set': SET, 'collector_number': str(i)} for i in range(1, 400)]
    out = []
    for k in range(0, len(ids), 75):
        body = json.dumps({'identifiers': ids[k:k + 75]}).encode()
        req = urllib.request.Request('https://api.scryfall.com/cards/collection', data=body,
                                     headers={**UA, 'Content-Type': 'application/json'})
        d = json.load(urllib.request.urlopen(req))
        out += d['data']
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


def strip_reminders(t):
    return re.sub(r' ?\([^)]*\)', '', t or '').strip()


def main():
    cards = fetch_set()
    rate = ratings()
    seen, out = set(), []
    for c in cards:
        num = c['collector_number']
        if not num.isdigit() or 'Basic Land' in c['type_line'] or c['name'] in seen:
            continue
        # The main set ends at the basics; higher numbers are alternate art.
        if int(num) > 291:
            continue
        seen.add(c['name'])
        faces = c.get('card_faces') if c['layout'] != 'normal' else None
        front = faces[0] if faces else c
        text = c.get('oracle_text')
        if faces:
            text = '\n\n'.join(
                (f"{f['name']} {f.get('mana_cost', '')}\n" if i else '') + (f.get('oracle_text') or '')
                for i, f in enumerate(faces))
        img = (c.get('image_uris') or faces[0].get('image_uris') or {}).get('normal', '')
        score, tags, note = rate.get(num, (None, '', ''))
        row = {
            'id': num,
            'n': front['name'],
            'full': c['name'],
            'm': front.get('mana_cost', ''),
            't': front['type_line'],
            'r': c['rarity'][0].upper(),
            'col': ''.join(x for x in 'WUBRG' if x in (c.get('colors') or front.get('colors') or [])),
            'x': text or '',
            'img': img,
            's': score,
            'note': note,
        }
        if 'power' in front:
            row['pt'] = f"{front['power']}/{front['toughness']}"
        if 'loyalty' in front:
            row['loy'] = front['loyalty']
        if 'rm' in tags.split(','):
            row['rm'] = 1
        if 'Land' in front['type_line']:
            row['land'] = 1
            row['prod'] = ''.join(x for x in 'WUBRG' if x in (c.get('produced_mana') or []))
        if faces and c['layout'] == 'prepare':
            spell = faces[1]
            row['prep'] = {'n': spell['name'], 'm': spell.get('mana_cost', ''),
                           't': spell['type_line'], 'x': strip_reminders(spell.get('oracle_text'))}
        instant = 'Instant' in front['type_line'] or 'Flash' in (c.get('keywords') or [])
        if instant:
            row['ins'] = 1
        if num in FROM_HAND:
            row['hand'] = {'m': FROM_HAND[num][0], 'x': FROM_HAND[num][1]}
        if num in COST_NOTE:
            row['costnote'] = COST_NOTE[num]
        out.append(row)
    missing = [r['n'] for r in out if r['s'] is None]
    (HERE / 'fra.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(len(out), 'cards;', len(missing), 'without a score', missing[:10])


if __name__ == '__main__':
    main()
