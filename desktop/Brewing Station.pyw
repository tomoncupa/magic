"""Brewing Station on Windows.

Serves the magic-web folder on this PC only (127.0.0.1) and opens the builder
in an Edge app window. The page asks this server to run Claude for deck
reviews. It uses the Claude command that ships with the Claude desktop app,
signed in with Tom's own account, so nothing extra is installed or paid for.

Claude is given no tools and runs in an empty temp folder, so it cannot read or
change anything on the PC. It only answers.

The server stops itself after three hours with no requests. Opening the
shortcut again starts it again.
"""

import glob
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

PORT = 8766
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = f"http://127.0.0.1:{PORT}/build/"
IDLE_LIMIT = 3 * 3600
NO_WINDOW = 0x08000000          # CREATE_NO_WINDOW: no black window flashing up
last_hit = time.time()


def find_claude():
    """The newest copy of the Claude command the desktop app has installed."""
    pattern = os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude-code", "*", "claude.exe")

    def version(path):
        try:
            return tuple(int(x) for x in os.path.basename(os.path.dirname(path)).split("."))
        except ValueError:
            return (0,)
    hits = sorted(glob.glob(pattern), key=version)
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


def claude_ask(prompt):
    # Two Claude processes renewing the sign-in at once fails the second; it clears in seconds.
    try:
        return claude_ask_once(prompt)
    except RuntimeError as e:
        if "OAuth token" not in str(e):
            raise
        time.sleep(20)
        return claude_ask_once(prompt)


def claude_ask_once(prompt):
    exe = find_claude()
    if not exe:
        raise RuntimeError("The Claude app's command was not found on this PC.")
    work = tempfile.mkdtemp(prefix="brew_ai_")
    try:
        proc = subprocess.run(
            [exe, "-p", "--output-format", "json", "--tools", "", "--no-session-persistence"],
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


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def local_only(self):
        """Refuse pages from other sites that try to reach this server."""
        host = (self.headers.get("Host") or "").split(":")[0]
        origin = self.headers.get("Origin") or ""
        ok_host = host in ("127.0.0.1", "localhost")
        ok_origin = not origin or origin in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}")
        if not (ok_host and ok_origin):
            self.send_error(403)
            return False
        return True

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
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
        last_hit = time.time()
        if not self.local_only():
            return
        if self.path == "/api/claude/status":
            return self.send_json(claude_status())
        return super().do_GET()

    def do_POST(self):
        global last_hit
        last_hit = time.time()
        if not self.local_only():
            return
        try:
            size = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(size) or b"{}")
            if self.path == "/api/claude/login":
                claude_login()
                return self.send_json({"ok": True})
            if self.path == "/api/claude/ask":
                prompt = str(data.get("prompt") or "")
                if not prompt:
                    raise RuntimeError("Nothing to ask.")
                return self.send_json({"text": claude_ask(prompt)})
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
    if show:
        open_window()
    server.serve_forever()


if __name__ == "__main__":
    main()
