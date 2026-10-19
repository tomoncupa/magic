"""Shrink Commander Spellbook's full combo dump into build/combos.json.

The dump is ~660 MB and web pages are not allowed to query Spellbook directly,
so a nightly GitHub job runs this and commits the small file the builder reads.

With a third argument it also writes each combo's steps (what must be in play,
the steps, mana needed) into 64 files in that folder, so a page loads only the
one file a combo lives in (comboShard() in index.html picks the same file).

    py build/slim_combos.py variants.json build/combos.json build/steps
"""
import json, os, sys, ijson

src, dst = sys.argv[1], sys.argv[2]
steps_dir = sys.argv[3] if len(sys.argv) > 3 else None
SHARDS = 64
names, index, out = [], {}, []
steps = [{} for _ in range(SHARDS)]

def idx(n):
    if n not in index:
        index[n] = len(names); names.append(n)
    return index[n]

def shard(cid):
    h = 0
    for ch in cid:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h % SHARDS

def lines(t):
    return [x.strip() for x in str(t or '').splitlines() if x.strip()]

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
        if steps_dir:
            # [steps, before you start, also needed, mana to start it, everything it makes]
            steps[shard(v['id'])][v['id']] = [
                lines(v.get('description')),
                lines(v.get('easyPrerequisites')) + lines(v.get('notablePrerequisites')),
                [r['template']['name'] for r in (v.get('requires') or []) if (r.get('template') or {}).get('name')],
                v.get('manaNeeded') or '',
                [p['feature']['name'] for p in v.get('produces', [])],
            ]

with open(dst, 'w', encoding='utf-8') as f:
    json.dump({'names': names, 'v': out}, f, separators=(',', ':'), ensure_ascii=False)
print(len(out), 'combos,', len(names), 'cards')

if steps_dir:
    os.makedirs(steps_dir, exist_ok=True)
    total = 0
    for i, s in enumerate(steps):
        p = os.path.join(steps_dir, 's%02d.json' % i)
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(s, f, separators=(',', ':'), ensure_ascii=False, sort_keys=True)
        total += os.path.getsize(p)
    print('steps:', SHARDS, 'files,', round(total / 1e6, 1), 'MB')
