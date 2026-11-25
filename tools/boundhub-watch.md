# boundhub-watch

Resolve a BoundHub private video to a direct CDN URL, then play or download it.

```powershell
.\boundhub-watch.ps1 1031329              # play
.\boundhub-watch.ps1 1045199 -Print       # print the CDN URL only
.\boundhub-watch.ps1 1045199 -Out a.mp4   # download
.\boundhub-watch.ps1 1045199 -Player mpv  # force a player
.\boundhub-watch.ps1 1045199 -Preview     # stills for any private video, no login
```

Accepts a bare id or a `https://www.boundhub.com/videos/<id>/<slug>/` URL.

`-Player` defaults to `auto`: it uses VLC, mpv or ffplay if one is installed,
otherwise hands the URL to the Windows default handler. `-Player default` forces
the OS handler, `-Player only` just prints the URL. Nothing needs to be installed
for the script to work - `-Out` and `-Print` never launch a player.

## Previews: any video, no login

`-Preview` fetches the public preview still and timeline thumbnails for a video
and needs neither a login nor the debugging browser. The screenshot CDN is **not**
gated: the directory is `floor(id/1000)*1000`, so it is plain arithmetic on the id,
and the stills return `200 image/jpeg` for private videos the account cannot play
(12/12 random gated ids, zero misses).

This is the only part of the tree that is open. The same host serves no video
(`contents/videos_sources/...` is 404), so stills tell you whether a gated video
is worth requesting rather than replacing playback.

## Setup

Once per session, launch Edge with remote debugging and log in:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --profile-directory=Default
```

The script reads the player data out of your own logged-in tab, so it inherits
whatever that account is allowed to watch.

## How the gate works

Private videos are gated server-side. The page emits a per-file random hash and
a signed `v-acctoken` only when the account may watch; for anyone else it renders
`<div class="no-player">` with the message *"Only <uploader>'s friends can watch
private videos."* Nothing usable is present in the gated HTML.

Findings that close off the obvious shortcuts:

- **The token is signed and the signature is checked.** Zeroing the 12-byte
  signature, or dropping it, degrades a valid pair to the 40 KB placeholder
  (`60260166.mp4`). Serial, uploader, flags and nonce are all signed. The
  signature is deterministic across reloads, so it is a keyed hash - but not one
  found among ~600 secret/HMAC constructions over the decoded prefix.
- **The hash is random, not derived.** ~9,000 preimage constructions over paths,
  ids, the site license code, salts, separators, double-hashing and
  shuffle/unshuffle both ways produced no match.
- **The hash is mandatory.** A valid token paired with a wrong hash returns 404,
  so a token alone is not enough.
- **No alternate surface leaks the pair.** Block AJAX, `player/html.php`,
  `js_player`, embeds, AMP, RSS, related-videos, member pages, sitemaps, Wayback
  and archive.today all return nothing for private ids. Raw MP4s are not on the
  anonymous screenshot host under any tried path.

Consequence: access is purely a matter of the account relationship. Friending
the uploader is the only lever, and a *pending* request does not unlock anything -
the uploader has to accept.

## Mechanics worth knowing

- The hash and token live in `flashvars.video_url` on a permitted page.
- The token is scoped to the **uploader**, not the viewer.
- `get_file` is cookieless: resolve with a `VLC/3.0.20` user agent, take the
  `Location`, and follow it verbatim. Servers 1-7 all work.
- The CDN key is short-lived (~5 min). Resolve and play immediately; do not
  cache the URL. A `60260166` redirect means a stale key - retry.
- Bare `/videos/<id>/` is a 404 stub. Any junk slug (`/videos/<id>/a/`) returns
  the real page, which is how the script resolves an id to a slug.
- Video pages intermittently serve a 1,497-byte Cloudflare stub to `curl`; the
  script goes through the browser instead.

## Third-party resolvers: all dead or insufficient

Checked directly, because they are the obvious place to look for a shortcut.

- **transpiria.com** - the historical provider. Its userscript called
  `https://transpiria.com/api/boundhub/videos/<id>` server-side and injected
  `resolvedVideoUrl` into the `no-player` element, so it genuinely worked while
  gated and with no cookies. The route is now **404** for every id, public and
  private, from curl and from a real browser origin, with and without a session.
  Its archived responses only ever carried a resolved CDN URL (short-lived key),
  so the archive is not a usable cache - and no Wayback snapshot exists for any
  of the 720 private ids.
- **vededown.com** - returns an empty body to curl; no reachable endpoint.
- **boundhub-media-helper** (browser extension) - only reads `video.src` off an
  already-loaded player, so it inherits the same account gate.
- **yt-dlp `boundhub.py`** - extracts `flashvars` and calls `_kvs_get_real_url`,
  but that helper only rewrites the legacy `function/0/` URL form. BoundHub
  already serves direct `get_file` URLs, so it adds nothing for private ids and
  needs `--cookies` anyway.
- **Token-less URL forms** - the archived 40-hex hash form and the bare 32-hex
  hash both return the placeholder without a `v-acctoken` on any server, so the
  token is always required.
- **Wayback / archive.today** - `wayback/available` answers correctly (control:
  `example.com` and `boundhub.com/` both have snapshots) but reports **no
  snapshot at all** for gated video pages, so there is no archived `flashvars` to
  mine. archive.today connection-refuses.
- **Raw source MP4 on the CDN** - `cdn.bdsmactually.com/contents/videos_sources/
  <dir>/<id>/<id>.mp4` returns `403 Key must be specified`; a `Referer`, a
  trailing slash, or passing `v-acctoken` / the hash as a query parameter does not
  satisfy it. Only a freshly signed `key=...&end=...` works, and the key is
  path-bound (changing the filename in a valid URL breaks it).
- **`/embed/<id>/`** - differs only in gate copy ("Only active members"). It is a
  1.9 KB stub anonymously and a full player with a session, so it inherits the
  same gate.
- **Playlists** - a private item inside a playlist page emits no player.
- **`/admin/`** - flat nginx `403` (1,636 bytes) with no `WWW-Authenticate`, i.e. not
a password prompt. Special-cased: a random path returns the 80 KB site 404 instead.
Fails identically from a logged-in browser, so it is blocked below PHP. No admin
subdomain exists either (20 tried, all NXDOMAIN).
- **`/edit-profile/`** - the only account-writable fields are cosmetic
(`display_name, avatar, country_id, city, gender_id, relationship_status_id,
orientation_id, birth_date_*, about_me`). Mass-assigning `premium, is_premium,
member_type, status, type, role, group, active, level, is_admin` onto a valid
`action=change_profile` POST is accepted (`302 change_profile_done`) but does not
move the gate.
- **Subscribing** - unlike friending this is instant and needs no approval:
`GET <member page>?mode=async&format=json&action=subscribe&subscribe_user_id=<id>`
returns `{"status":"success"}` and flips the button to `Unsubscribe`. It does
**not** unlock private videos - 147 non-friends subscribed, gate unchanged on all
of them (only ~10 persist, the rest are rate-limited).
- **Legacy `function/0/` URL forms** - return `200`, but the body is the homepage
HTML, not a stream. Extra params (`download`, `embed`, `check`, `lrcv`,
`license_code`, `serial`) change nothing.
- **Player endpoints** - `float.php` is a JSON API that always returns `[]`
(empty even on a permitted video); `html.php` returns an empty body;
`timelines.php` and `embed_null.php` return `500`. Async `get_block` returns 0
bytes even on a permitted video, so it is dead method rather than gated.
- **Token transport** - `get_file` sets `kt_qparams` / `kt_acctoken` cookies, but a
token supplied by cookie alone gives the placeholder; the `v-acctoken` **query
parameter** is required. Tokens are not IP-bound (a bogus `kt_acctoken` still
resolves) and resolve cookieless, which is why harvested pairs keep working.
- **Hash case** - uppercase hex is a hard `404`; it is case-sensitive.
- **Storage-server sweep (srv 0-30)** - only `1,3,4,6,7` ever redirect to the CDN.
`srv2` returns the homepage HTML (`200`, 81 KB). `srv5` redirects to a different
satellite, `albums.bondageobserver.com/remote_control.php`, and `srv8+` all `503`.
No mirror skips validation: every one of them needs the same hash+token pair.
Named aliases (`cdn`, `cdn1`, `storage`, `origin`, `v`, `v1`, `a`, `b`) all just
render the homepage.
- **`albums.bondageobserver.com/remote_control.php`** - the srv5 satellite. Takes
the file path in a plaintext `file=` param with the signature in separate
`cv`/`cv2`/`cv3`/`cv4`/`lr` params, which looked replayable. It is not:
`cv3`/`cv4` are site constants but the signature is still **path-bound** - correct
path gives `404 Not Found` (the albums host does not hold that file) and a sibling
filename in the same directory gives `403 Access denied (errno 6)`. So a valid
set from any permitted video cannot be replayed onto a gated path.
- **`event_reporting2`** - a second `get_file` URL in `flashvars` with a
*different* token, but its payload is a **guest** token (`<video_id>|0|0|<nonce>`)
not an account token, so it resolves to the placeholder on private files.
- **Public screenshot CDN** - this is the one genuinely open part of the tree.
`cnt.bondageobserver.com/contents/videos_screenshots/<floor(id/1000)*1000>/<id>/preview.jpg`
and `.../timelines/timeline/120x90/1.jpg` return `200 image/jpeg` for **gated**
ids, so the directory rule is public and derivable. But the same host does not
serve video sources (`contents/videos_sources/...` is `404`), preview/trailer
`.mp4` variants are `404`, and directory listings are `403`.
- **HD / quality variants** - `video_url_hd: '1'` is present, but `_hd`, `.720`,
`_720`, `hd/` path forms are all `404`; only the exact signed filename works.
- **Endpoint shapes** - `/download/<id>/`, `/videos/<id>/download/`, and a
doubled directory segment all fail. `?download=1` and `?video_id=` on a valid URL
change nothing.
- **Sitemaps** - `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap/videos.xml` are
all `403`; `robots.txt` is `200` but lists no video URLs.
- **Listing surfaces** - `/private/`, `/premium/`, `/latest/`, `/top-rated/`,
`/most-viewed/`, and the private RSS all emit **zero** `get_file`; only individual
video pages do.
- **Player assets** - `kt_player.js` contains no URL builder at all (0 occurrences
of `get_file`, `v-acctoken`, `remote_control`). `stats.php` returns a 1x1 GIF.

Net: no third party resolves this today. The local script is the working path.

## Verified

- Streams are real MP4s, cookieless: `206 video/mp4`, magic `ftypisom`,
  `Content-Range: bytes 0-99/748991396`; a full 47,873,706-byte download.
- Resolves by bare id, by URL, and reports gated videos with exit code 3.