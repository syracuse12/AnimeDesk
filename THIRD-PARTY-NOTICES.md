# Third-party notices

This repository and the optional local-only installer bundle include or depend on
the following software.

| Component | Version | Licence | Included notice |
| --- | --- | --- | --- |
| Node.js Windows x64 runtime | 24.18.0 | MIT and bundled third-party terms | `Node-LICENSE.txt` |
| hls.js | 1.7.4 | Apache-2.0 | `hls.js-LICENSE.txt`, `Apache-2.0.txt` |
| React | 18.3.1 | MIT | `react-LICENSE.txt` |
| React DOM | 18.3.1 | MIT | `react-dom-LICENSE.txt` |
| scheduler | 0.23.2 | MIT | `scheduler-LICENSE.txt` |
| loose-envify | 1.4.0 | MIT | `loose-envify-LICENSE.txt` |
| js-tokens | 4.0.0 | MIT | `js-tokens-LICENSE.txt` |

Node's `LICENSE` includes licence and attribution text for components in the
runtime. The hls.js notice includes its Brightcove derived-code attribution.
`Apache-2.0.txt` is the full text from the
[Apache Software Foundation](https://www.apache.org/licenses/LICENSE-2.0.txt).
These notices describe this candidate's payload, not an assertion of complete
legal compliance. The release manifest and bundle contents should be checked
against this list before any distribution.

The source build also installs development dependencies from `package-lock.json`.
Its `caniuse-lite` browser-support dataset is CC-BY-4.0; the package supplies its
own licence text when installed. The dataset is not copied as a standalone file
into the release payload.

**In the source repository:** all providers are present, including the unofficial
hianime and Internet Archive integrations, AniList and AniSkip lookups. They run
from source with the development profile. In the installed `distribution` profile
those are disabled and only the local library provider is registered; the hianime
and Archive modules are omitted from the payload. No mpv or FFmpeg binary is in
the installer. Any future
mpv inclusion requires evidence of the exact build configuration and all
linked libraries, their applicable GPL/LGPL terms, attribution, and the
corresponding-source or other applicable source availability method. The
existing local mpv executable's matching upstream archive did not contain
licence files; its GPL/LGPL build mode and FFmpeg components remain unresolved.
See [mpv's copyright and build-mode notes](https://github.com/mpv-player/mpv/blob/master/Copyright)
and [FFmpeg's legal guidance](https://www.ffmpeg.org/legal.html).

Node.js source for the pinned binary is available from the [official 24.18.0
release archive](https://nodejs.org/en/download/archive/v24.18.0). The runtime
archive is checked against that release's published SHA-256 list during build.
