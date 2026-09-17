"""Resolve every decklist in decks/ against Scryfall and write decks.js.

Card facts (names, costs, types, rules text, image URLs) come from Scryfall at
build time. Pictures are never copied into this repo; the app loads them from
Scryfall's own host at run time.

    py build_decks.py
"""
import json, os, re, time, urllib.request

UA = {"User-Agent": "kitchen-table-magic/1.0",
      "Accept": "application/json",
      "Content-Type": "application/json"}


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers=UA, method="POST")
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode())


def parse(path):
    """Read a Moxfield-style export into (qty, name, section) rows."""
    rows, section = [], "deck"
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        if re.match(r"^(Commander|Deck|Sideboard)$", line, re.I):
            section = line.lower()
            continue
        m = re.match(r"^(\d+)\s+(.+?)\s*(?:\([A-Za-z0-9]{2,6}\)\s*[\w-]*)?$", line)
        if not m:
            print("  SKIP:", line)
            continue
        rows.append((int(m.group(1)), m.group(2).strip(), section))
    return rows


def resolve(names):
    found, missing = {}, []
    for i in range(0, len(names), 70):
        chunk = names[i:i + 70]
        res = post("https://api.scryfall.com/cards/collection",
                   {"identifiers": [{"name": n} for n in chunk]})
        for nf in res.get("not_found", []):
            missing.append(nf.get("name"))
        for c in res.get("data", []):
            found[c["name"].lower()] = c
            # A double-faced card comes back as "Front // Back", but decklists
            # name it by the front face alone.
            if " // " in c["name"]:
                found[c["name"].split(" // ")[0].strip().lower()] = c
        time.sleep(0.15)
    return found, missing


def img_of(c):
    if c.get("image_uris"):
        return c["image_uris"].get("normal")
    for f in c.get("card_faces") or []:
        if f.get("image_uris"):
            return f["image_uris"].get("normal")
    return None


def card_def(c, qty, section):
    face = c if c.get("mana_cost") is not None else (c.get("card_faces") or [{}])[0]
    oracle = (c.get("oracle_text") or face.get("oracle_text") or "")[:400]
    d = {
        "id": c["id"],
        "n": c["name"].split(" // ")[0].strip(),
        "t": c.get("type_line") or face.get("type_line", ""),
        "m": c.get("mana_cost") if c.get("mana_cost") is not None else face.get("mana_cost", ""),
        "cmc": c.get("cmc", 0),
        "ci": c.get("color_identity", []),
        "pm": c.get("produced_mana") or [],
        "o": oracle,
        "u": img_of(c),
        "q": 0 if section == "sideboard" else qty,
    }
    if section == "sideboard":
        d["side"] = 1
    p = c.get("power") if c.get("power") is not None else face.get("power")
    t = c.get("toughness") if c.get("toughness") is not None else face.get("toughness")
    if p is not None:
        d["p"] = str(p)
    if t is not None:
        d["tg"] = str(t)
    loy = c.get("loyalty") or face.get("loyalty")
    if loy:
        d["loy"] = loy
    if "enters the battlefield tapped" in oracle or "enters tapped" in oracle:
        d["ebt"] = 1
    return d


decks = []
for fn in sorted(os.listdir("decks")):
    if not fn.endswith(".txt"):
        continue
    path = os.path.join("decks", fn)
    rows = parse(path)
    names, seen = [], set()
    for _, n, _s in rows:
        if n.lower() not in seen:
            seen.add(n.lower())
            names.append(n)
    found, missing = resolve(names)
    if missing:
        print("  NOT FOUND in %s: %s" % (fn, missing))

    cards, commander = [], None
    for qty, name, section in rows:
        c = found.get(name.lower())
        if not c:
            continue
        if section == "commander" and not commander:
            commander = c["name"]
        cards.append(card_def(c, qty, section))

    main = sum(d["q"] for d in cards if not d.get("side"))
    side = len([d for d in cards if d.get("side")])
    decks.append({"id": fn[:-4], "name": commander or fn[:-4],
                  "commander": commander, "cards": cards})
    print("  %-12s %s  main %d, sideboard %d, unique %d"
          % (fn[:-4], commander, main, side, len(names)))

js = "window.MTG_DECKS=%s;\n" % json.dumps(decks, ensure_ascii=True, separators=(",", ":"))
js += "window.MTG_DECK=window.MTG_DECKS[0];\n"   # what older code still reads
open("decks.js", "w", encoding="ascii").write(js)
print("decks.js written, %d bytes, %d decks" % (len(js), len(decks)))
