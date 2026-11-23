# Test fixture provenance

On 23 November 2026, the publication auditor replaced all three media fixtures
whose earlier redistribution rights could not be established. The current files
were generated locally from FFmpeg's synthetic `testsrc2`, `sine`, and `color`
filters. No input media files were used.

The generator was FFmpeg n8.1, Windows x64 GPL shared build from
`FFmpeg-Builds/FFmpeg-Builds`. Its downloaded archive was checked against the
release API's SHA-256 digest
`c29341cf9593aa30c86bd0cd2384bc3cd56891467d53dfcdbf03c278936a62ae`.
The FFmpeg executable and libraries are audit tools only; they are not included
in the tracked source or installer.

From the repository root, with `ffmpeg` on PATH:

```powershell
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=320x180:rate=30' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 5.759 -c:v libx264 -preset veryfast -crf 36 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart tests/fixtures/media/sample.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=320x180:rate=30' -f lavfi -i 'sine=frequency=220:sample_rate=48000' -t 34.5 -c:v libx264 -preset veryfast -crf 38 -pix_fmt yuv420p -c:a aac -b:a 24k -movflags +faststart tests/fixtures/media/long.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'color=c=0x32506e:s=320x180' -frames:v 1 -update 1 tests/fixtures/media/cover.png
```

These files are original test signals generated for AnimeDesk and may be
redistributed under the repository's MIT licence, subject to the maintainer's
approval of that licence.
