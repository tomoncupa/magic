"""Build "Brewing Station Setup.exe" for friends (Tom, 2026-11-16).

    py desktop/installer/build.py

1. PyInstaller turns desktop/Brewing Station.pyw into a program that needs no Python on the friend's PC.
2. The page files go beside it in "site", the copy used when GitHub cannot be reached
   (the program takes the newest page from tomoncupa.github.io/magic whenever it can).
3. Inno Setup wraps both into one setup file: desktop/installer/output/Brewing Station Setup.exe.

Needs: pip install pyinstaller, and Inno Setup 6 (winget install JRSoftware.InnoSetup).
"""
import datetime
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DIST = os.path.join(HERE, "dist")
APP = os.path.join(DIST, "Brewing Station")
SITE_FILES = ["sw.js", "apple-touch-icon.png"] + ["build/" + f for f in (
    "index.html", "engine.js", "pages.js", "mine.js", "brew.css", "pages.css", "combos.json", "salt.json",
    "staples.json", "sealed.html", "icon-32.png", "icon-256.png", "moxfield_decks.py")]


def iscc():
    for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if base:
            for p in (os.path.join(base, "Programs", "Inno Setup 6", "ISCC.exe"), os.path.join(base, "Inno Setup 6", "ISCC.exe")):
                if os.path.exists(p):
                    return p
    sys.exit("Inno Setup 6 is not installed: winget install JRSoftware.InnoSetup")


def main():
    shutil.rmtree(DIST, ignore_errors=True)
    shutil.rmtree(os.path.join(HERE, "work"), ignore_errors=True)
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--windowed", "--onedir",
                    "--name", "Brewing Station", "--icon", os.path.join(REPO, "desktop", "brewing.ico"),
                    "--paths", os.path.join(REPO, "build"), "--hidden-import", "moxfield_decks",
                    "--distpath", DIST, "--workpath", os.path.join(HERE, "work"), "--specpath", os.path.join(HERE, "work"),
                    os.path.join(REPO, "desktop", "Brewing Station.pyw")], check=True)
    for f in SITE_FILES:
        dst = os.path.join(APP, "site", *f.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(REPO, *f.split("/")), dst)
    version = datetime.datetime.now().strftime("%Y.%m.%d.%H%M")
    with open(os.path.join(APP, "version.txt"), "w", encoding="utf-8") as f:
        f.write(version)
    env = dict(os.environ, BREW_VERSION=version)
    subprocess.run([iscc(), "/Q", os.path.join(HERE, "BrewingStation.iss")], check=True, env=env)
    out = os.path.join(HERE, "output", "Brewing Station Setup.exe")
    print("Built", out, version, round(os.path.getsize(out) / 1e6, 1), "MB")
    if "--publish" in sys.argv:
        publish(out, version)


def publish(out, version):
    """Friends' copies update themselves from this: a GitHub release with the setup, and latest.json naming it."""
    import hashlib
    import json
    tag = "brew-" + version
    h = hashlib.sha256(open(out, "rb").read()).hexdigest()
    subprocess.run(["gh", "release", "create", tag, out, "-R", "tomoncupa/magic", "--title", "Brewing Station " + version,
                    "--notes", "Brewing Station for Windows. Installed copies update themselves."], check=True)
    url = "https://github.com/tomoncupa/magic/releases/download/%s/Brewing.Station.Setup.exe" % tag
    with open(os.path.join(HERE, "latest.json"), "w", encoding="utf-8") as f:
        json.dump({"version": version, "url": url, "sha256": h}, f)
    subprocess.run(["git", "-C", REPO, "add", "desktop/installer/latest.json"], check=True)
    subprocess.run(["git", "-C", REPO, "commit", "-q", "-m", "Brewing Station installer " + version], check=True)
    subprocess.run(["git", "-C", REPO, "push", "-q", "origin", "main"], check=True)
    print("Published", tag)


if __name__ == "__main__":
    main()
