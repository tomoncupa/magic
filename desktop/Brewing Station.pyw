"""Brewing Station on Windows.

Serves the magic-web folder on this PC only (127.0.0.1) and opens the builder
in an Edge app window. The page asks this server to run Claude for deck
reviews. It uses the Claude command that ships with the Claude desktop app,
signed in with Tom's own account, so nothing extra is installed or paid for.

Claude is given no tools and runs in an empty temp folder, so it cannot read or
change anything on the PC. It only answers.

It also hands the page Tom's public Moxfield decks (GET /api/moxfield/decks),
and any one public Moxfield deck by id for Import a deck
(GET /api/moxfield/deck?id=<publicId>), read live through
build/moxfield_decks.py and kept for a minute.

It keeps Tom's decks in a file on this PC (GET/POST /api/store), outside the
public repo, in %LOCALAPPDATA%/Brewing Station/store.json. The page mirrors
every forge.* setting there, so his decks survive Edge's storage being cleared
and every window on this PC shows one shelf (Tom, 2026-10-18).

It keeps every card in his Moxfield collection beside the store (cards/cards.json,
GET /api/cards) with its picture on disk, and every card picture the page shows
comes through GET /api/pic, saved the first time (Tom, 2026-11-03).

The server stops itself after three hours with no requests. Opening the
shortcut again starts it again.
"""

import glob
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import webbrowser

def _arg(name, default):
    """--port 8767 / --store <file>, for testing beside the running copy."""
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv[:-1] else default


PORT = int(_arg("--port", 8766))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = f"http://127.0.0.1:{PORT}/build/"
STORE = _arg("--store", os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
                                     "Brewing Station", "store.json"))
STORE_KEY = re.compile(r"forge\.[A-Za-z0-9_.:-]{1,120}")
store_lock = threading.Lock()
IDLE_LIMIT = 3 * 3600
NO_WINDOW = 0x08000000          # CREATE_NO_WINDOW: no black window flashing up
last_hit = time.time()
sys.path.insert(0, os.path.join(ROOT, "build"))   # for moxfield_decks.py
sys.dont_write_bytecode = True  # no __pycache__ folder left in the public repo

MOX_USER = re.compile(r"[A-Za-z0-9_.-]{1,40}")
MOX_TTL = 60                    # seconds a Moxfield read is reused
mox_cache = {}                  # user -> (time fetched, JSON text)
mox_lock = threading.Lock()     # one Moxfield read at a time; a second ask waits and reuses it
MOX_DECK_ID = re.compile(r"[A-Za-z0-9_-]{5,40}")
deck_cache = {}                 # deck id -> (time fetched, JSON text)
deck_lock = threading.Lock()    # separate, so one deck is not held up by a whole-feed read


def find_claude():
    """The newest copy of the Claude command the desktop app has installed."""
    # Since the app's 2026-10-02 update the command sits one folder deeper: <version>/<hash>/claude.exe.
    root = os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude-code")
    hits = glob.glob(os.path.join(root, "*", "claude.exe")) + glob.glob(os.path.join(root, "*", "*", "claude.exe"))

    def version(path):
        try:
            return tuple(int(x) for x in os.path.relpath(path, root).split(os.sep)[0].split("."))
        except ValueError:
            return (0,)
    hits = sorted(hits, key=version)
    return hits[-1] if hits else None


def claude_status():
    exe = find_claude()
    if not exe:
        return {"available": False, "signed_in": False,
                "reason": "The Claude app's command was not found on this PC."}
    try:
        out = subprocess.run([exe, "auth", "status", "--json"], capture_output=True,
                             text=True, timeout=60, creationflags=NO_WINDOW).stdout
        signed_in = bool(json.loads(out or "{}").get("loggedIn"))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        signed_in = False
    return {"available": True, "signed_in": signed_in}


def claude_login():
    exe = find_claude()
    if not exe:
        raise RuntimeError("The Claude app's command was not found on this PC.")
    subprocess.Popen([exe, "auth", "login", "--claudeai"], creationflags=subprocess.CREATE_NEW_CONSOLE)


SYSTEM = ("You are a Magic: The Gathering Commander player of the highest level, the kind who wins "
          "tournaments and brews decks other players copy, working inside Brewing Station, Tom's deck app. "
          "Think like that player: read the deck's plan before judging a card, count, check rules text, and "
          "never state a rule, number or card text you have not checked. Follow the instructions in the message exactly.")

# Tom, 2026-10-21: "make the claude in brewing station a lot smarter, like a super pro player" (picked A to E).
# A: the strongest model, thinking hard. D: Ask Claude may search the web (rulings, EDHREC, current lists).
# Tom, 2026-10-30: "Make the model in Bstation Opus 5.5": named exactly, so the "opus" alias moving never changes it.
MODEL, EFFORT = "claude-opus-5-5", "high"
WEB_TOOLS = "WebSearch,WebFetch"


def claude_ask(prompt, web=False):
    # Two Claude processes renewing the sign-in at once fails the second; it clears in seconds.
    try:
        return claude_ask_once(prompt, web)
    except RuntimeError as e:
        if "OAuth token" not in str(e):
            raise
        time.sleep(20)
        return claude_ask_once(prompt, web)


def claude_ask_once(prompt, web=False):
    exe = find_claude()
    if not exe:
        raise RuntimeError("The Claude app's command was not found on this PC.")
    work = tempfile.mkdtemp(prefix="brew_ai_")
    try:
        proc = subprocess.run(
            # Only the page's own prompt: no CLAUDE.md files, MCP servers, skills or Claude Code's own
            # system prompt. That cut one question from about 48,000 tokens of context to under 700.
            [exe, "-p", "--output-format", "json", "--model", MODEL, "--effort", EFFORT,
             "--tools", WEB_TOOLS if web else ""] + (["--allowedTools", WEB_TOOLS] if web else []) + ["--no-session-persistence",
             "--setting-sources", "project", "--settings", json.dumps({"claudeMdExcludes": ["**/*.md"]}),
             "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", SYSTEM],
            input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=work, timeout=900, creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Claude took too long to answer. Try again.")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    try:
        reply = json.loads(proc.stdout or "{}")
    except ValueError:
        raise RuntimeError("Claude did not answer. " + (proc.stderr or "")[-300:])
    said = str(reply.get("result") or "")
    if reply.get("is_error"):
        if "login" in said.lower() or "logged in" in said.lower():
            raise RuntimeError("Claude is not signed in on this PC yet. Press Sign in to Claude.")
        raise RuntimeError("Claude could not answer: " + said[:300])
    return said


def moxfield_feed(user, fresh=False):
    """Tom's public Moxfield decks as JSON text (SPEC.md contract 1), the same as decks/moxfield.json.

    Reused for a minute. fresh=True reads Moxfield again, unless a read finished while this one waited.
    """
    if not MOX_USER.fullmatch(user):
        raise ValueError("That is not a Moxfield user name.")
    asked = time.time()
    with mox_lock:
        hit = mox_cache.get(user)
        if hit and (hit[0] >= asked or (not fresh and time.time() - hit[0] < MOX_TTL)):
            return hit[1]
        import moxfield_decks
        text = moxfield_decks.dumps(moxfield_decks.fetch_user(user))
        now = time.time()
        for k in [k for k, v in mox_cache.items() if now - v[0] > MOX_TTL]:
            del mox_cache[k]
        mox_cache[user] = (now, text)
        return text


def moxfield_deck(pid, fresh=False):
    """One Moxfield deck as JSON text in the contract 1 deck shape (plus "author"). Reused for a minute."""
    if not MOX_DECK_ID.fullmatch(pid):
        raise ValueError("That is not a Moxfield deck id.")
    asked = time.time()
    with deck_lock:
        hit = deck_cache.get(pid)
        if hit and (hit[0] >= asked or (not fresh and time.time() - hit[0] < MOX_TTL)):
            return hit[1]
        import moxfield_decks
        text = moxfield_decks.dumps(moxfield_decks.fetch_deck(pid))
        now = time.time()
        for k in [k for k, v in deck_cache.items() if now - v[0] > MOX_TTL]:
            del deck_cache[k]
        deck_cache[pid] = (now, text)
        return text


# Moxfield sync mailbox (Tom, 2026-10-21: "automake the sync to moxfield", picked A). Brewing Station (in Edge) queues
# one job per deck: the card moves that make Moxfield match. FOE, the extension in his Chrome where he is signed in
# to Moxfield, asks for the next job every half minute, makes the moves in a Moxfield tab and reports back. Only
# adds, removes and moves between boards: his printings on Moxfield are never touched. A job for "wishlist" only adds
# cards to his Moxfield wishlist (Tom, 2026-11-02: "allow me to have a send to wishlist feature"); FOE reports the list.
# A job for "collection" changes nothing: FOE reads his Moxfield collection and reports each card's copies.
DECK_ID_OK = re.compile(r"[A-Za-z0-9_-]{5,40}")
MOXQ = {"jobs": [], "seen": 0.0}
MOXQ_LOCK = threading.Lock()


def moxq_put(job):
    with MOXQ_LOCK:
        # The newest list of moves for a deck replaces one still waiting; one being made is left to finish.
        MOXQ["jobs"] = [j for j in MOXQ["jobs"] if not (j["publicId"] == job["publicId"] and j["state"] == "waiting")]
        job.update({"id": "%d%04d" % (time.time() * 1000, len(MOXQ["jobs"])), "state": "waiting", "at": time.time()})
        MOXQ["jobs"].append(job)
        MOXQ["jobs"] = MOXQ["jobs"][-40:]
        return job["id"]


def moxq_next():
    with MOXQ_LOCK:
        MOXQ["seen"] = time.time()
        for j in MOXQ["jobs"]:
            # A job FOE took but never finished (Chrome closed) is offered again after 3 minutes.
            if j["state"] == "waiting" or (j["state"] == "working" and time.time() - j.get("took", 0) > 180):
                j["state"], j["took"] = "working", time.time()
                return {k: j.get(k) for k in ("id", "publicId", "ops", "dry")}
        return None


def moxq_done(data):
    with MOXQ_LOCK:
        for j in MOXQ["jobs"]:
            if j["id"] == str(data.get("id")):
                j["state"] = "done" if data.get("ok") else "failed"
                j["result"] = {k: data.get(k) for k in ("ok", "err", "results", "updated", "version", "plan", "dry", "wish", "collection")}
                j["ended"] = time.time()
                col = data.get("collection")
                if j["publicId"] == "collection" and data.get("ok") and isinstance(col, dict):
                    threading.Thread(target=cards_sync, args=(col,), daemon=True).start()
                return True
        return False


def moxq_status(public_id):
    with MOXQ_LOCK:
        mine = [j for j in MOXQ["jobs"] if j["publicId"] == public_id]
        last = mine[-1] if mine else None
        return {"seen": MOXQ["seen"], "now": time.time(),
                "job": {k: last.get(k) for k in ("id", "state", "at", "ended", "result", "count")} if last else None}


def store_read():
    """{"exists": bool, "keys": {key: text}}. A broken file falls back to the newest daily copy."""
    for path in [STORE] + sorted(glob.glob(STORE[:-5] + "-*.json"), reverse=True):
        try:
            with open(path, encoding="utf-8") as f:
                keys = json.load(f).get("keys")
            if isinstance(keys, dict):
                return {"exists": True, "keys": keys}
        except (OSError, ValueError, AttributeError):
            continue
    return {"exists": False, "keys": {}}


def store_write(set_keys, del_keys):
    """Applies one batch of changes and writes the file through a temp file. One copy a day is kept, 14 days."""
    with store_lock:
        keys = store_read()["keys"]
        for k, v in set_keys.items():
            if STORE_KEY.fullmatch(k) and isinstance(v, str):
                keys[k] = v
        for k in del_keys:
            keys.pop(k, None)
        os.makedirs(os.path.dirname(STORE), exist_ok=True)
        tmp = STORE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"saved": time.strftime("%Y-%m-%d %H:%M:%S"), "keys": keys}, f, ensure_ascii=False)
        os.replace(tmp, STORE)
        day = STORE[:-5] + "-" + time.strftime("%Y-%m-%d") + ".json"
        if not os.path.exists(day):
            shutil.copyfile(STORE, day)
            for old in sorted(glob.glob(STORE[:-5] + "-*.json"))[:-14]:
                os.remove(old)
        return len(keys)


# EDHPlay games from FOE's overlay (2026-10-28), kept beside the store on this PC, never in the repo.
# Only these fields are kept, so nothing about the other players (their names, their seats) is saved.
EDH_FILE = os.path.join(os.path.dirname(STORE), "edhplay-games.json")
EDH_KEYS = {"id": str, "start": (int, float), "end": (int, float), "mins": (int, float), "turns": int, "myTurns": int,
            "players": int, "solo": bool, "deck": str, "commander": str, "result": str, "auto": bool, "mulls": int,
            "keptLands": int, "keptSize": int, "drawn": list, "cmdTurn": int, "unspent": (int, float), "missed": int,
            "mySecs": (int, float), "otherSecs": (int, float), "oppCmd": list, "open": bool}
edh_lock = threading.Lock()


def edh_clean(g):
    out = {}
    for k, t in EDH_KEYS.items():
        v = g.get(k)
        if isinstance(v, t) and not (t is int and isinstance(v, bool)):
            if isinstance(v, list):
                v = [str(x)[:120] for x in v if isinstance(x, str)][:200]
            elif isinstance(v, str):
                v = v[:200]
            out[k] = v
    if out.get("result") not in ("win", "loss", "draw"):
        out.pop("result", None)
    return out if out.get("id") else None


def edh_read():
    try:
        with open(EDH_FILE, encoding="utf-8") as f:
            return json.load(f).get("games", [])
    except (OSError, ValueError):
        return []


def edh_write(games):
    clean = [g for g in (edh_clean(x) for x in games[-3000:] if isinstance(x, dict)) if g]
    with edh_lock:
        os.makedirs(os.path.dirname(EDH_FILE), exist_ok=True)
        tmp = EDH_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"at": time.time(), "games": clean}, f, ensure_ascii=False)
        os.replace(tmp, EDH_FILE)
    return len(clean)


# His collection kept on this PC (Tom, 2026-11-03: "a standing copy of every card in my collection as well as their
# images", picked both). When FOE reports a collection read, every printing he owns is looked up on Scryfall once
# (cards.json) and its picture saved under cards/img/, beside the store, never in the repo. The page's service worker
# sends every cards.scryfall.io picture through /api/pic, which answers from disk and saves any it has not got yet,
# so a picture seen once stays on this PC for good, Edge's storage cleared or not.
CARDS_DIR = os.path.join(os.path.dirname(STORE), "cards")
CARDS_FILE = os.path.join(CARDS_DIR, "cards.json")
PIC_PATH = re.compile(r"/(small|normal|large|png|art_crop|border_crop)/(front|back)/[0-9a-f]/[0-9a-f]/([0-9a-f-]{36})\.(jpg|png)")
SCRYFALL = {"User-Agent": "BrewingStation/1.0", "Accept": "application/json"}
DISK_FLOOR = 2 * 1024 ** 3      # pictures stop while the disk has under 2 GB free
cards_lock = threading.Lock()
CARDS_RUN = {"busy": False, "step": "", "done": 0, "total": 0, "err": ""}


def pic_file(path):
    m = PIC_PATH.fullmatch(path)
    return os.path.join(CARDS_DIR, "img", m.group(1), m.group(2), m.group(3) + "." + m.group(4)) if m else None


def pic_get(path):
    """A Scryfall picture by its path on cards.scryfall.io: from disk, or fetched once and kept."""
    file = pic_file(path)
    if not file:
        raise ValueError("Not a card picture.")
    try:
        with open(file, "rb") as f:
            return f.read()
    except OSError:
        pass
    import urllib.request
    with urllib.request.urlopen(urllib.request.Request("https://cards.scryfall.io" + path, headers=SCRYFALL), timeout=30) as r:
        body = r.read()
    if not (body[:3] == b"\xff\xd8\xff" or body[:4] == b"\x89PNG"):
        raise RuntimeError("Scryfall did not send a picture.")
    os.makedirs(os.path.dirname(file), exist_ok=True)
    if shutil.disk_usage(CARDS_DIR).free > DISK_FLOOR:
        tmp = file + ".%d.tmp" % threading.get_ident()
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, file)
    return body


def cards_read():
    try:
        with open(CARDS_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("cards"), dict):
            return d
    except (OSError, ValueError):
        pass
    return {"at": 0, "n": 0, "prints": [], "cards": {}}


def cards_write(d):
    with cards_lock:
        os.makedirs(CARDS_DIR, exist_ok=True)
        tmp = CARDS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        os.replace(tmp, CARDS_FILE)


def card_slim(c):
    f = c.get("card_faces") or []
    iu = c.get("image_uris") or (f[0].get("image_uris") if f and f[0].get("image_uris") else {}) or {}
    bk = f[1]["image_uris"].get("normal", "") if not c.get("image_uris") and len(f) > 1 and f[1].get("image_uris") else ""
    both = lambda k: c.get(k) or " // ".join(x.get(k, "") for x in f if x.get(k))
    return {"id": c.get("id", ""), "n": c.get("name", ""), "set": c.get("set", ""), "sn": c.get("set_name", ""),
            "cn": c.get("collector_number", ""), "r": c.get("rarity", ""), "mv": c.get("cmc", 0) or 0,
            "t": both("type_line"), "mc": both("mana_cost"), "o": both("oracle_text"),
            "ci": c.get("color_identity") or [], "img": iu.get("normal", ""), "bk": bk}


def scryfall_post(url, body):
    import urllib.request
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers=dict(SCRYFALL, **{"Content-Type": "application/json"}))
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def cards_sync(col):
    """A collection FOE just read: keep its printings, look up the ones not known yet, then save their pictures."""
    global last_hit
    if CARDS_RUN["busy"]:
        CARDS_RUN["again"] = col
        return
    CARDS_RUN.update(busy=True, step="cards", done=0, total=0, err="")
    try:
        d = cards_read()
        prints = col.get("prints")
        if not isinstance(prints, list) or not prints:   # FOE before 1.8.1 sends names only: Scryfall's own printing
            prints = [{"n": n, "q": q, "id": ""} for n, q in (col.get("cards") or {}).items()]
        prints = [{"n": str(p.get("n") or "")[:200], "q": int(p.get("q") or 1), "id": str(p.get("id") or "")[:36],
                   "set": str(p.get("set") or "")[:10], "cn": str(p.get("cn") or "")[:12], "foil": bool(p.get("foil"))}
                  for p in prints if isinstance(p, dict) and p.get("n")]
        d.update(at=time.time(), n=int(col.get("n") or sum(p["q"] for p in prints)), prints=prints)
        known, by_name = d["cards"], {}
        for c in known.values():
            by_name.setdefault(c["n"].lower(), c["id"])
        for p in prints:
            if not p["id"] or p["id"] not in known:
                p["id"] = p["id"] if p["id"] else by_name.get(p["n"].lower(), "")
        want = [p for p in prints if not p["id"] or p["id"] not in known]
        asks, seen = [], set()
        for p in want:
            key = p["id"] or p["n"].lower()
            if key not in seen:
                seen.add(key)
                asks.append({"id": p["id"]} if p["id"] else {"name": p["n"].split(" // ")[0]})
        CARDS_RUN["total"] = len(asks)
        for i in range(0, len(asks), 75):
            last_hit = time.time()
            got = scryfall_post("https://api.scryfall.com/cards/collection", {"identifiers": asks[i:i + 75]})
            for c in got.get("data") or []:
                s = card_slim(c)
                known[s["id"]] = s
                by_name.setdefault(s["n"].lower(), s["id"])
                for face in (c.get("card_faces") or []):
                    by_name.setdefault(str(face.get("name", "")).lower(), s["id"])
            CARDS_RUN["done"] = min(len(asks), i + 75)
            time.sleep(0.12)
        for p in prints:
            if not p["id"]:
                p["id"] = by_name.get(p["n"].lower()) or by_name.get(p["n"].split(" // ")[0].lower(), "")
        cards_write(d)
        cards_pics(d)
    except Exception as e:   # the Collection page shows it; the next read tries again
        CARDS_RUN["err"] = str(e)[:200] or "Scryfall could not be read."
    finally:
        CARDS_RUN.update(busy=False, step="")
        again = CARDS_RUN.pop("again", None)
        if again:
            threading.Thread(target=cards_sync, args=(again,), daemon=True).start()


def cards_pics(d):
    """Saves the picture of every printing he owns that is not on disk yet, front and back."""
    global last_hit
    paths = []
    for p in d.get("prints", []):
        c = d["cards"].get(p.get("id"))
        for u in ((c["img"], c["bk"]) if c else ()):
            if u:
                path = urllib.parse.urlsplit(u).path
                f = pic_file(path)
                if f and not os.path.exists(f) and path not in paths:
                    paths.append(path)
    CARDS_RUN.update(step="pictures", done=0, total=len(paths))
    for i, path in enumerate(paths):
        if shutil.disk_usage(CARDS_DIR).free < DISK_FLOOR:
            CARDS_RUN["err"] = "The disk has under 2 GB free, so pictures stopped."
            return
        last_hit = time.time()   # the server stays up until every picture is saved
        try:
            pic_get(path)
        except Exception:
            pass   # one picture failing leaves it for the next read
        CARDS_RUN["done"] = i + 1
        time.sleep(0.05)


def cards_resume():
    if CARDS_RUN["busy"]:
        return
    CARDS_RUN.update(busy=True, err="")
    try:
        cards_pics(cards_read())
    finally:
        CARDS_RUN.update(busy=False, step="")


def cards_view():
    d = cards_read()
    have = 0
    for c in d["cards"].values():
        f = pic_file(urllib.parse.urlsplit(c.get("img") or "").path)
        if f and os.path.exists(f):
            have += 1
    size = 0
    for root, _, files in os.walk(os.path.join(CARDS_DIR, "img")):
        for name in files:
            try:
                size += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    d["run"] = {k: CARDS_RUN.get(k) for k in ("busy", "step", "done", "total", "err")}
    d["pics"], d["bytes"] = have, size
    return d


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def route(self):
        """The path without its ?query, so /api/... routes still match when one is added."""
        return urllib.parse.urlsplit(self.path).path

    def local_only(self):
        """Refuse pages from other sites that try to reach this server."""
        host = (self.headers.get("Host") or "").split(":")[0]
        origin = self.headers.get("Origin") or ""
        ok_host = host in ("127.0.0.1", "localhost")
        ok_origin = not origin or origin in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}")
        # FOE, his Chrome extension, fetches the Moxfield sync jobs; no web page can send a chrome-extension Origin.
        grab = origin.startswith("chrome-extension://") and self.route().startswith(("/api/moxsync/", "/api/edhplay/")) and self.headers.get("X-Grab") == "1"
        if grab:
            return ok_host
        # Other sites' <img>/<script> tags send no Origin, but browsers mark them cross-site.
        fetch_site = self.headers.get("Sec-Fetch-Site") or ""
        if self.route().startswith("/api/") and fetch_site not in ("", "same-origin", "none"):
            ok_origin = False
        if not (ok_host and ok_origin):
            self.send_error(403)
            return False
        return True

    def send_json(self, obj, code=200):
        self.send_json_text(json.dumps(obj, ensure_ascii=False), code)

    def send_json_text(self, text, code=200):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Always serve the newest page after an update.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        global last_hit
        path = self.route()
        if path != "/api/moxsync/next":   # FOE asking every half minute must not keep the server up forever
            last_hit = time.time()
        if not self.local_only():
            return
        if path == "/api/moxsync/next":
            return self.send_json({"job": moxq_next()})
        if path == "/api/moxsync/status":
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            return self.send_json(moxq_status((q.get("id") or [""])[0]))
        if path == "/api/claude/status":
            return self.send_json(claude_status())
        if path == "/api/store":
            return self.send_json(store_read())
        if path == "/api/cards":
            return self.send_json(cards_view())
        if path == "/api/pic":
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            p = (q.get("p") or [""])[0]
            try:
                body = pic_get(p)
            except ValueError:
                return self.send_error(400)
            except Exception:
                return self.send_error(502)
            self.send_response(200)
            self.send_header("Content-Type", "image/png" if p.endswith(".png") else "image/jpeg")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/edhplay/games":
            return self.send_json({"games": edh_read()})
        if path == "/api/moxfield/decks":
            try:
                q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                user = (q.get("user") or ["amoncupa"])[0]
                if not MOX_USER.fullmatch(user):
                    return self.send_json({"error": "That is not a Moxfield user name."}, 400)
                fresh = (q.get("fresh") or ["0"])[0] not in ("", "0")
                return self.send_json_text(moxfield_feed(user, fresh))
            except Exception as e:  # the page shows the message and falls back to decks/moxfield.json
                return self.send_json({"error": str(e) or "Moxfield could not be read."}, 502)
        if path == "/api/moxfield/history":
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            pid = (q.get("id") or [""])[0]
            if not MOX_DECK_ID.fullmatch(pid):
                return self.send_json({"error": "That is not a Moxfield deck id."}, 400)
            try:
                import moxfield_decks
                return self.send_json({"rows": moxfield_decks.fetch_history(pid)})
            except Exception as e:  # the compare view shows Moxfield's side without dates
                return self.send_json({"error": str(e) or "Moxfield could not be read."}, 502)
        if path == "/api/moxfield/deck":
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            pid = (q.get("id") or [""])[0]
            if not MOX_DECK_ID.fullmatch(pid):
                return self.send_json({"error": "That is not a Moxfield deck id. Paste the deck's "
                                       "link, like moxfield.com/decks/abc123."}, 400)
            fresh = (q.get("fresh") or ["0"])[0] not in ("", "0")
            try:
                import moxfield_decks
                try:
                    return self.send_json_text(moxfield_deck(pid, fresh))
                except moxfield_decks.MoxfieldNotFound as e:
                    return self.send_json({"error": str(e)}, 404)
            except Exception as e:  # the page shows the message and offers the paste box instead
                return self.send_json({"error": str(e) or "Moxfield could not be read."}, 502)
        return super().do_GET()

    def do_HEAD(self):
        if not self.local_only():
            return
        return super().do_HEAD()

    def do_POST(self):
        global last_hit
        last_hit = time.time()
        if not self.local_only():
            return
        try:
            size = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(size) or b"{}")
            path = self.route()
            if path == "/api/moxsync/queue":
                ops = data.get("ops")
                if not isinstance(ops, list) or not DECK_ID_OK.fullmatch(str(data.get("publicId") or "")):
                    raise RuntimeError("Nothing to send to Moxfield.")
                return self.send_json({"id": moxq_put({"publicId": str(data["publicId"]), "ops": ops[:300], "count": len(ops), "dry": bool(data.get("dry"))})})
            if path == "/api/edhplay/games":
                games = data.get("games")
                if not isinstance(games, list):
                    raise RuntimeError("No games.")
                return self.send_json({"ok": True, "n": edh_write(games)})
            if path == "/api/moxsync/done":
                return self.send_json({"ok": moxq_done(data)})
            if path == "/api/store":
                sets, dels = data.get("set") or {}, data.get("del") or []
                if not isinstance(sets, dict) or not isinstance(dels, list):
                    raise RuntimeError("Not a store change.")
                return self.send_json({"ok": True, "n": store_write(sets, [str(k) for k in dels])})
            if path == "/api/claude/login":
                claude_login()
                return self.send_json({"ok": True})
            if path == "/api/open":
                open_site(str(data.get("url") or ""))
                return self.send_json({"ok": True})
            if path == "/api/claude/ask":
                prompt = str(data.get("prompt") or "")
                if not prompt:
                    raise RuntimeError("Nothing to ask.")
                return self.send_json({"text": claude_ask(prompt, bool(data.get("web")))})
            self.send_error(404)
        except Exception as e:  # the page shows the message
            self.send_json({"error": str(e)}, 500)


def find_edge():
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            p = os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")
            if os.path.exists(p):
                return p
    return None


def find_chrome():
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LOCALAPPDATA")):
        if base:
            p = os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")
            if os.path.exists(p):
                return p
    return None


def open_site(url):
    """Outside sites open in Chrome, where Tom is signed in. Web addresses only."""
    if not url.startswith(("https://", "http://")) or any(ch.isspace() for ch in url):
        raise RuntimeError("Not a web address.")
    chrome = find_chrome()
    if chrome:
        subprocess.Popen([chrome, url])
    else:
        webbrowser.open(url)


def open_window():
    edge = find_edge()
    if edge:
        subprocess.Popen([edge, f"--app={URL}"])
    else:
        os.startfile(URL)


def already_running():
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def idle_watch(server):
    while True:
        time.sleep(300)
        if time.time() - last_hit > IDLE_LIMIT:
            server.shutdown()
            return


def main():
    show = "--no-window" not in sys.argv
    if already_running():
        if show:
            open_window()
        return
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=idle_watch, args=(server,), daemon=True).start()
    # Pictures left unsaved when the server last stopped are saved now.
    threading.Thread(target=cards_resume, daemon=True).start()
    if show:
        open_window()
    server.serve_forever()


if __name__ == "__main__":
    main()
