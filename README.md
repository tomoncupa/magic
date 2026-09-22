# Kitchen Table Magic

A Magic playmat across two devices. The iPad holds the board, the iPhone holds
your hand, and the two stay in sync.

Built for one person playing with real cards on the other side of the table:
opponents are tracked as life totals and commander damage, never as boards.

## Running it

It is a plain static site. Any web host works, including GitHub Pages. Open the
same link on both devices and give them the same table code from the menu.

## Brewing Station on Windows

`desktop/Brewing Station.pyw` serves this folder on 127.0.0.1:8766 and opens
`/build/` in an Edge app window. Its Claude review (Check step) runs the Claude
desktop app's own `claude.exe` with no tools in an empty temp folder, on the
signed-in subscription. Anywhere else the page offers copy prompt / paste answer.
Decks saved in the app window are separate from the web version's (different
origin, different local storage).

## Card data

Card art and rules text come from Scryfall at run time, so any deck you paste
gets real pictures. Paste a Moxfield export (More > Export > Copy) into the
import box, keeping its Commander / Deck / Sideboard headers.

Moxfield's own API is behind Cloudflare and refuses scripts, so pasting the
export is the way in. There is no way around that.

`deck.js` holds one deck baked in so the app opens with something to play.
Rebuild it from a Moxfield export with:

    py fetch.py     # resolve names against Scryfall -> cards.json
    py mkdeck.py    # build deck.js

## Sync

`config.js` points at a Firebase Realtime Database. The app talks to it over
plain HTTP: PUT to write, EventSource to listen. There is no SDK.

The database URL is not a secret. Access is controlled by the database rules,
which allow reads and writes only under `/tables/<code>` and `/decks/<code>`:

    {
      "rules": {
        "tables": { "$code": { ".read": true, ".write": true } },
        "decks":  { "$code": { ".read": true, ".write": true } }
      }
    }

Anyone who knows a table code can read and write that game, which is why codes
are eight characters. Do not put anything private in a game.

Delete `config.js` to run with no sync at all. The app then keeps each device's
game to itself.

Measured latency, Manila to the Singapore region: about 250 to 340 ms for a
change to reach the other device, and about 750 ms for the first change after
a page load while the stream warms up.

Two notes on Firebase. It does not store empty arrays or empty objects, so an
empty graveyard comes back missing entirely; `normalise()` puts that right on
arrival. And writes are last writer wins, so two devices changing the same
thing in the same instant will have one overwrite the other.

## Offline

`sw.js` caches the app and every card picture seen. A venue with no wifi can
still deal a game. Sync needs a connection, so the two devices will not agree
again until there is one.
