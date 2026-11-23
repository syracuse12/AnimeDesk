# Licensing: software versus media

Two different things are licensed here, and they are easy to confuse.

## 1. The software

AnimeDesk source code is MIT licensed ([LICENSE](../LICENSE)). You may use, modify,
redistribute and sell it, including commercially, provided the copyright notice
and permission notice travel with it. There is no warranty.

MIT is proposed for code the maintainer owns, subject to their approval of the
copyright line. Third-party packages keep their own licences (see
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)). A final publication decision
also requires the maintainer to confirm that no uncredited third-party source was
copied into the project.

## 2. The media

The MIT licence grants you **nothing** over any anime, artwork, subtitle or stream
URL that AnimeDesk displays. Those belong to their rights holders.

What that means in practice:

| Thing | Who owns it | Consequence |
| --- | --- | --- |
| Episodes and streams you play | The licensor of that title, and the host serving it | AnimeDesk only points at them; whether *you* may watch is between you and the source |
| Poster and cover artwork | The licensor or the metadata source | Fetched at runtime for display, not redistributed in the repo |
| Subtitles from a source | The source or the licensor | Served through the local proxy for the current episode only |
| Test fixture clips | Original generated test signals | Redistributable with this source tree |

So: **cloning this repository gives you a player, not a library.**

## No affiliation

AnimeDesk is not affiliated with any anime studio, licensor, distributor or
streaming service. It hosts nothing itself. Every integration is an unofficial
client of a site or API owned by someone else.

Who may watch what, through which source, is the user's own position to
establish. AnimeDesk can only resolve and play a stream; it confers no rights.

## Provider rights position

| Provider | Position |
| --- | --- |
| `hianime` | Unofficial streaming integration. The adapter is AnimeDesk's own code and is published; whether the endpoints it calls require permission is unresolved. It is absent from the installer payload. |
| `archive` | Internet Archive hosts the files. Membership of an Archive collection does **not** prove an item is public domain; each item's own licence field governs. This integration is absent from the installer payload. |
| `local` | Your files. Rights are entirely yours to establish. |

Metadata from AniList is used under the
[AniList API terms](https://docs.anilist.co/guide/terms-of-use). Skip timestamps
come from the community [AniSkip](https://api.aniskip.com) API.

## Test fixtures

The prior media files had no verifiable provenance and were replaced before
publication. The current `sample.mp4` and `long.mp4` are original synthetic
FFmpeg `testsrc2` video and sine-wave audio, generated for this audit. The current
`cover.png` is a plain generated color card. They contain no third-party show,
artwork, soundtrack, or subtitle content. The commands and tool version are
recorded in [FIXTURE-PROVENANCE.md](FIXTURE-PROVENANCE.md).

## The bundled player

mpv is **not** committed as a binary; `npm run setup:mpv` fetches a verified build
at install time. mpv is GPLv2-or-later by default, with LGPL builds possible
depending on configuration, and it links FFmpeg. Distributing a build you compiled
or repackaged means meeting those obligations — attribution, licence text, and a
source-availability route. Because AnimeDesk runs mpv as a **separate process**
and not as a linked library, AnimeDesk's own MIT licence is unaffected.

Upstream references:

- <https://github.com/mpv-player/mpv/blob/master/Copyright>
- <https://www.ffmpeg.org/legal.html>

## The bundled runtime

Release packages bundle the Node.js Windows runtime, which is MIT licensed and
carries its own third-party terms inside its `LICENSE`. Node's source is available
from the official release archive for the pinned version.

## If you fork this

- Keep `LICENSE` and `THIRD-PARTY-NOTICES.md`.
- Keep the media disclaimer; do not imply the repo includes the shows.
- If you add a provider, state its rights position honestly.
- If you bundle a player or codec build, add its notices and source route.
- Do not describe the project as "legal" or "fully licensed" without qualification.
