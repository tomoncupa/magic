import json, re, os, time, urllib.request, sys

UA = {"User-Agent": "mtg-table-builder/1.0", "Accept": "application/json", "Content-Type": "application/json"}

def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=UA, method="POST")
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode())

entries = []
section = "deck"
for line in open("deck.txt", encoding="utf-8"):
    line = line.strip()
    if not line: continue
    if re.match(r"^(Commander|Deck|Sideboard)$", line, re.I):
        section = line.lower(); continue
    m = re.match(r"^(\d+)\s+(.+?)\s*(?:\([A-Za-z0-9]{2,6}\)\s*[\w-]*)?$", line)
    if not m:
        print("SKIP:", line); continue
    entries.append((int(m.group(1)), m.group(2).strip(), section))

names = []
for _, n, _s in entries:
    if n not in names: names.append(n)
print("unique names:", len(names))

cards = {}
for i in range(0, len(names), 70):
    chunk = names[i:i+70]
    res = post("https://api.scryfall.com/cards/collection",
               {"identifiers": [{"name": n} for n in chunk]})
    for nf in res.get("not_found", []):
        print("NOT FOUND:", nf)
    for c in res.get("data", []):
        cards[c["name"]] = c
    time.sleep(0.15)

def slug(n):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", n.lower())).strip("-")[:60]

def img_of(c):
    if c.get("image_uris"): return c["image_uris"].get("normal")
    f = c.get("card_faces") or []
    if f and f[0].get("image_uris"): return f[0]["image_uris"].get("normal")
    return None

out, missing = [], []
lookup = {k.lower(): v for k, v in cards.items()}
for qty, name, sect in entries:
    c = cards.get(name) or lookup.get(name.lower())
    if not c:
        missing.append(name); continue
    face = (c.get("card_faces") or [{}])[0] if not c.get("mana_cost") and c.get("card_faces") else c
    out.append({
        "q": 0 if sect == "sideboard" else qty,
        "side": 1 if sect == "sideboard" else 0,
        "cmd": 1 if sect == "commander" else 0,
        "n": c["name"],
        "s": slug(c["name"]),
        "t": c.get("type_line") or face.get("type_line", ""),
        "m": c.get("mana_cost") if c.get("mana_cost") is not None else face.get("mana_cost", ""),
        "cmc": c.get("cmc", 0),
        "ci": c.get("color_identity", []),
        "p": c.get("power") or face.get("power"),
        "tg": c.get("toughness") or face.get("toughness"),
        "o": (c.get("oracle_text") or face.get("oracle_text") or "")[:400],
        "pm": c.get("produced_mana") or [],
        "u": img_of(c),
    })
print("resolved:", len(out), "missing:", missing)
json.dump(out, open("cards.json", "w", encoding="utf-8"), ensure_ascii=False)
