"""EDHREC's salt ratings, slimmed for Brewing Station (Tom, 2026-10-21: "copy commander salt").

EDHREC's /top/salt-1.json carries every rated card (about 32,000, 7 MB). This keeps name -> salt
(0 to 4, players' average of how unhappy a card makes them) for cards rated 0.05 or more, about
600 KB. Run nightly by .github/workflows/combos.yml: python build/slim_salt.py <in.json> build/salt.json
"""
import json
import sys
import time


def main(src, dst):
    d = json.load(open(src, encoding="utf-8"))
    lists = d.get("container", {}).get("json_dict", {}).get("cardlists", [])
    cards = max((cl.get("cardviews", []) for cl in lists), key=len, default=[])
    salt = {c["name"]: round(c["salt"], 2) for c in cards if c.get("name") and (c.get("salt") or 0) >= 0.05}
    if len(salt) < 5000:
        raise SystemExit("EDHREC's salt list came back short (%d cards); keeping the old file." % len(salt))
    out = {"at": time.strftime("%Y-%m-%d"), "s": salt}
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print("salt.json:", len(salt), "cards")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
