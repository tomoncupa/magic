"""Tom's public Moxfield decks as one small JSON file.

Used two ways, with the same output:
  - the desktop server (desktop/Brewing Station.pyw) calls fetch_user() for
    GET /api/moxfield/decks?user=<name>, and fetch_deck() for one deck by id
    (anyone's public or unlisted deck) at GET /api/moxfield/deck?id=<publicId>
  - GitHub Actions runs it nightly to refresh decks/moxfield.json for the web
    and phone copies:  python build/moxfield_decks.py amoncupa decks/moxfield.json

Standard library only. Moxfield's API is public and read-only; its Cloudflare
front door refuses short user agents, so a full browser one is sent.

Output (SPEC.md, contract 1):
  {"user": name, "decks": [{"id","name","url","updated","format","ci","bracket",
    "commanders","companions","main","side","maybe"}]}
  card = {"n","q","set","cn","sid","type","cmc","ci"} plus "foil": true on foils.
No prices and no fetched-at time, so the file only changes when a deck does.
"""

import http.client
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")
API = "https://api2.moxfield.com"
SEARCH = API + "/v2/decks/search?pageNumber={page}&pageSize=64&sortType=updated&sortDirection=Descending&authorUserNames={user}"
DECK = API + "/v3/decks/all/{id}"
USER_OK = re.compile(r"[A-Za-z0-9_.-]{1,40}")
DECK_ID_OK = re.compile(r"[A-Za-z0-9_-]{5,40}")   # Moxfield publicIds are 22 of these
TRIES = 5                  # first try plus four retries
PAUSE = 0.5                # between calls, to be gentle with Moxfield
MAX_PAGES = 10             # 640 decks; a safety stop, never a real limit
BOARDS = (("commanders", "commanders"), ("companions", "companions"),
          ("main", "mainboard"), ("side", "sideboard"), ("maybe", "maybeboard"))


class MoxfieldError(RuntimeError):
    pass


class MoxfieldNotFound(MoxfieldError):
    """Moxfield answered 404: no such deck or user, or it is private."""


def get(url):
    """GET a Moxfield JSON address, retrying busy (429) and server (5xx) errors."""
    wait = 2.0
    for attempt in range(1, TRIES + 1):
        retry_after = None
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as res:
                raw = res.read()
            try:
                return json.loads(raw.decode("utf-8"))
            except ValueError:
                raise MoxfieldError("Moxfield answered with something that is not deck data "
                                    "(maybe a Cloudflare check page).")
        except urllib.error.HTTPError as e:
            code = e.code
            if code == 404:
                raise MoxfieldNotFound("Moxfield has no public deck or user at " + url + " (404).")
            if code == 403:
                raise MoxfieldError("Moxfield refused the request (403). Its Cloudflare guard may be "
                                    "blocking this network.")
            if code != 429 and code < 500:
                raise MoxfieldError(f"Moxfield answered {code} for {url}.")
            problem = f"Moxfield is busy ({code})" if code == 429 else f"Moxfield had a server error ({code})"
            try:
                retry_after = float(e.headers.get("Retry-After") or "")
            except (TypeError, ValueError):
                retry_after = None
        except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
            reason = getattr(e, "reason", e)
            problem = f"Could not reach Moxfield ({reason})"
        if attempt == TRIES:
            raise MoxfieldError(f"{problem}, gave up after {TRIES} tries.")
        time.sleep(min(retry_after, 60.0) if retry_after else wait)
        wait *= 2
    raise MoxfieldError("Could not reach Moxfield.")  # not reached


def whole(x):
    """1.0 -> 1, so the file stays small; other numbers pass through."""
    if isinstance(x, float) and x.is_integer():
        return int(x)
    return x


def slim_card(entry):
    c = entry.get("card") or {}
    out = {"n": c.get("name") or "", "q": int(entry.get("quantity") or 0),
           "set": c.get("set"), "cn": c.get("cn"), "sid": c.get("scryfall_id"),
           "type": c.get("type_line"), "cmc": whole(c.get("cmc")),
           "ci": list(c.get("color_identity") or [])}
    finish = entry.get("finish") or ""
    if entry.get("isFoil") or finish in ("foil", "etched"):
        out["foil"] = True
    return out


def sort_key(card):
    return (card["n"].casefold(), card["n"], card["set"] or "", card["cn"] or "", card.get("foil", False))


def slim_board(deck, board):
    cards = ((deck.get("boards") or {}).get(board) or {}).get("cards") or {}
    return sorted((slim_card(e) for e in cards.values()), key=sort_key)


def slim_deck(d):
    pid = d.get("publicId") or d.get("id")
    bracket = d.get("userBracket") or d.get("bracket") or d.get("autoBracket") or None
    out = {"id": pid, "name": d.get("name") or "",
           "url": "https://moxfield.com/decks/" + pid,
           "updated": d.get("lastUpdatedAtUtc"), "format": d.get("format"),
           "ci": list(d.get("colorIdentity") or []), "bracket": bracket}
    for key, board in BOARDS:
        out[key] = slim_board(d, board)
    return out


def by_user(row, user):
    names = [(row.get("createdByUser") or {}).get("userName")]
    names += [(a or {}).get("userName") for a in row.get("authors") or []]
    return any(isinstance(n, str) and n.casefold() == user.casefold() for n in names)


def deck_ids(user):
    """Every public deck id for the user, newest change first."""
    ids, page, pages = [], 1, 1
    while page <= pages:
        s = get(SEARCH.format(page=page, user=urllib.parse.quote(user)))
        if not isinstance(s, dict) or not isinstance(s.get("data"), list):
            raise MoxfieldError("Moxfield's deck search came back in an unexpected shape.")
        # For a name it does not know, Moxfield drops the filter and returns everyone's decks
        # (10,000 of them), so any deck by someone else means there is no such user.
        if any(not by_user(row, user) for row in s["data"]):
            raise MoxfieldError(f"Moxfield has no user called {user}.")
        for row in s["data"]:
            pid = row.get("publicId")
            if pid and pid not in ids:
                ids.append(pid)
        pages = min(int(s.get("totalPages") or 1), MAX_PAGES)
        page += 1
        if page <= pages:
            time.sleep(PAUSE)
    return ids


def read_deck(pid):
    """One deck from Moxfield's v3 API, slimmed to the contract 1 deck shape."""
    d = get(DECK.format(id=urllib.parse.quote(pid)))
    if not isinstance(d, dict) or not isinstance(d.get("boards"), dict):
        raise MoxfieldError(f"Moxfield sent deck {pid} in an unexpected shape.")
    return d


def fetch_deck(public_id):
    """One deck by its Moxfield publicId, in the contract 1 deck shape, plus "author".

    Works for anyone's public or unlisted deck. Raises MoxfieldNotFound when Moxfield
    has no such deck (or it is private) and MoxfieldError for anything else.
    """
    pid = str(public_id or "")
    if not DECK_ID_OK.fullmatch(pid):
        raise MoxfieldError("That is not a Moxfield deck id.")
    try:
        d = read_deck(pid)
    except MoxfieldNotFound:
        raise MoxfieldNotFound("Moxfield has no public deck with that id. "
                               "It may be private, deleted, or the link was copied wrong.")
    out = slim_deck(d)
    out["author"] = (d.get("createdByUser") or {}).get("userName") or None
    return out


def fetch_user(user):
    """Contract 1 for one Moxfield user. Raises MoxfieldError with plain words on any failure."""
    user = str(user or "")
    if not USER_OK.fullmatch(user):
        raise MoxfieldError("That is not a Moxfield user name.")
    ids = deck_ids(user)
    if not ids:
        raise MoxfieldError(f"No public decks found for Moxfield user {user}.")
    decks = []
    for i, pid in enumerate(ids):
        if i:
            time.sleep(PAUSE)
        decks.append(slim_deck(read_deck(pid)))
    return {"user": user, "decks": decks}


def dumps(feed):
    return json.dumps(feed, separators=(",", ":"), ensure_ascii=False)


def write_atomic(path, text):
    """Write next to the target, then swap it in, so a failure never leaves half a file."""
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".moxfield_", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def count(board):
    return sum(c["q"] for c in board)


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    if len(argv) != 3:
        print("Usage: py build/moxfield_decks.py <moxfield user> <output.json>", file=sys.stderr)
        return 2
    user, path = argv[1], argv[2]
    try:
        feed = fetch_user(user)
        text = dumps(feed)
    except Exception as e:  # any failure: say why, leave the old file alone
        print("Moxfield refresh failed: " + str(e), file=sys.stderr)
        return 1
    for d in feed["decks"]:
        cmd = " + ".join(c["n"] for c in d["commanders"]) or "no commander"
        print(f"{d['name']} | {cmd} | main {count(d['main'])} | side {count(d['side'])} | maybe {count(d['maybe'])}")
    old = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            old = f.read()
    if old == text:
        print(f"{len(feed['decks'])} decks, {len(text.encode('utf-8')):,} bytes, unchanged: {path}")
        return 0
    write_atomic(path, text)
    print(f"{len(feed['decks'])} decks, {len(text.encode('utf-8')):,} bytes, written: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
