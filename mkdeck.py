"""Build deck.js from cards.json. Art is a Scryfall URL, not a local file."""
import json

cards = json.load(open("cards.json", encoding="utf-8"))
COMMANDER = next((c["n"] for c in cards if c.get("cmd")), None)

defs = []
for c in cards:
    d = {"n": c["n"], "t": c["t"], "m": c["m"] or "", "cmc": c["cmc"],
         "ci": c["ci"], "pm": c["pm"], "q": c["q"], "u": c["u"]}
    if c.get("side"):
        d["side"] = 1
    if c["p"] is not None:
        d["p"] = c["p"]
    if c["tg"] is not None:
        d["tg"] = c["tg"]
    o = c["o"]
    if "enters the battlefield tapped" in o or "enters tapped" in o:
        d["ebt"] = 1
    d["o"] = o
    defs.append(d)

js = "window.MTG_DECK={name:%s,commander:%s,cards:%s};\n" % (
    json.dumps(COMMANDER), json.dumps(COMMANDER),
    json.dumps(defs, ensure_ascii=True, separators=(",", ":")))
open("deck.js", "w", encoding="ascii").write(js)

print("deck.js bytes:", len(js))
print("cards:", len(defs),
      "| deck:", sum(d["q"] for d in defs if not d.get("side")),
      "| sideboard:", len([d for d in defs if d.get("side")]))
