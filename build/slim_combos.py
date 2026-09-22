"""Shrink Commander Spellbook's full combo dump into build/combos.json.

The dump is ~660 MB and web pages are not allowed to query Spellbook directly,
so a nightly GitHub job runs this and commits the small file the builder reads.

    py build/slim_combos.py variants.json build/combos.json
"""
import json, sys, ijson

src, dst = sys.argv[1], sys.argv[2]
names, index, out = [], {}, []

def idx(n):
    if n not in index:
        index[n] = len(names); names.append(n)
    return index[n]

with open(src, 'rb') as f:
    for v in ijson.items(f, 'variants.item'):
        if v.get('status') not in (None, 'OK'): continue
        if not (v.get('legalities') or {}).get('commander'): continue
        cards = [u['card']['name'] for u in v.get('uses', [])]
        if not cards: continue
        feats = [p['feature']['name'] for p in v.get('produces', [])]
        infinite = any(x.lower().startswith('infinite') for x in feats)
        # Short result: infinite features first, at most two.
        feats.sort(key=lambda x: (not x.lower().startswith('infinite'), len(x)))
        out.append([
            sorted(idx(c) for c in cards),
            v.get('bracketTag') or '',
            int(v.get('manaValueNeeded') or 0),
            1 if infinite else 0,
            ' + '.join(feats[:2]),
            v['id'],
            len(v.get('requires') or []),
            int(v.get('popularity') or 0),
        ])

with open(dst, 'w', encoding='utf-8') as f:
    json.dump({'names': names, 'v': out}, f, separators=(',', ':'), ensure_ascii=False)
print(len(out), 'combos,', len(names), 'cards')
