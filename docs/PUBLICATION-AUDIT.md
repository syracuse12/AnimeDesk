# Independent publication audit

Date: 23 November 2026. Scope: the publication source snapshot, its complete
candidate Git history, ignored release output, and the embedded installer payload.
Nothing was pushed or uploaded. The private development repository was not edited.

## Repairs

- Removed the optional private model launcher, connectivity test, model config,
  and credential examples from the public tree. No credential file was opened.
  These were later removed from the complete history as well, not only the tip;
  see the history rewrite note below.
- Replaced the earlier publication report that disclosed a developer path and
  incorrectly accepted that disclosure. The README and current docs use generic
  or environment-based paths.
- Replaced three media fixtures of unverified provenance with original synthetic
  test signals. [Fixture provenance](FIXTURE-PROVENANCE.md) records the commands.
- Pinned both the optional mpv download and the release Node download to explicit
  SHA-256 values. The release build also checks Node's published checksum list.
- Changed the proposed MIT copyright identifier to `syracuse12`.
- Created a new root commit after these repairs; the prior sensitive commit is
  not an ancestor of the publication branch. The root hash is reported separately
  because embedding it in its own commit would be circular.

## Later history rewrite

On 25 November 2026 the publication history was rewritten a second time with
`git filter-repo`, after the launcher, model config, agent instructions, the
vendored Impeccable skill and a v0.1.0 source snapshot had been committed and
then dropped at the tip. `--invert-paths` removed those paths from every commit,
so they are absent from all reachable history rather than only the newest tree.
Every commit hash changed and both branches were force-pushed. A pre-rewrite
bundle was kept locally. `git log --all` for any removed path is now empty, and a
history-wide text search returns no developer path, Windows username or internal
hostname. The tracked tree is now project files only.

## Secret and privacy scans

Gitleaks 8.30.1 was downloaded from the official release, with archive SHA-256
`d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`
checked before execution. The scanner was stored only in ignored audit scratch.
Commands were run from the publication root, with `--redact` and JSON reports in
ignored scratch:

```text
gitleaks git --no-banner --redact --report-format json --report-path <report> .
gitleaks dir --no-banner --redact --max-archive-depth 2 --report-format json --report-path <report> <source snapshot>
gitleaks dir --no-banner --redact --max-archive-depth 2 --report-format json --report-path <report> .release/payload
gitleaks dir --no-banner --redact --max-archive-depth 2 --report-format json --report-path <report> .release/AnimeDesk-payload.zip
```

The old candidate history scan found zero secret-rule hits; that is **not** a
privacy pass, because Gitleaks did not flag its personal paths. The sanitized
source, new history, unpacked payload, and payload zip also had zero Gitleaks
hits. The installer executable itself yielded zero scanned bytes to Gitleaks;
its embedded `AnimeDeskPayload` resource was independently extracted and proved
byte-identical to the scanned payload zip by SHA-256. Separate filename and text
checks looked for OAuth and API tokens, passwords, private-key markers, cookies,
personal email addresses, browser profile paths, business identifiers, Windows
usernames, and machine-specific absolute paths. The initial candidate failed the
path checks; the final tracked snapshot and installer payload passed. Generic
`C:\path\to\...` examples and system `Program Files` paths are not personal paths.

Gitleaks is a pattern scanner and cannot prove that an unusual or encoded secret
is absent. Generated binaries and minified bundles were checked by payload scan,
string checks, and manifest review; no claim is made that static scanning can
recover every possible runtime value.

## Supply chain and release

- `package-lock.json` is lockfile version 3, with 125 package entries, all
  resolved tarballs carrying integrity hashes from `registry.npmjs.org`.
- The 124 third-party lockfile entries declare 114 MIT, 3 Apache-2.0, 5 ISC,
  1 BSD-3-Clause, and 1 CC-BY-4.0 licences. The CC-BY entry is build-time
  `caniuse-lite`; no package directories are copied into the installer. Runtime
  notices cover the libraries actually bundled into its UI and Node runtime.
- `npm audit --json` reported zero vulnerabilities at every severity on this
  date. This is a point-in-time advisory check, not a guarantee.
- The snapshot carries two GitHub Actions workflows, `ci.yml` and `windows.yml`,
  alongside the issue and PR templates. They postdate the original audit and were
  not part of its scope.
- The release payload contains 36 files. It contains no private application
  state, local media, mpv or FFmpeg binary, or remote provider implementation.
  The installer embeds exactly the same payload zip, verified by SHA-256.
- The installed host forces the local-only distribution profile and a random
  loopback port. Host, Origin, and browser fetch metadata guards were exercised.
- The release installer installed, started its bundled Node runtime, served a
  local media range, persisted history across restart, and uninstalled cleanly.
  It was not tested on a separate clean Windows machine.

## Verification

- `npm run verify`: typecheck passed, 177/177 tests passed, production build
  passed. (97/97 at the time of the audit; the count rose with the discovery,
  quality, subtitle and player-recovery suites.)
- `npm run test:ui`: 22/22 stages passed.
- `npm run test:qa`: AniSkip map 11/11, autoplay 21/21, persistence 13/13,
  mpv fallback 11/11, screenshot and corrupt-file stages passed.
- `npm run test:continue`: 20/20 checks passed.
- `npm run test:layout`: 56/56 checks passed.
- `npm run test:live`: 33/33 stages passed.
- `scripts/build-release.ps1`: passed and reran the 97 tests and build.
- `scripts/smoke-release.ps1`: passed install, loopback startup, local playback,
  history persistence, and uninstall.

Security tests covered loopback and private-address denial, DNS pinning and
redirect checks, artwork content and size limits, Host/Origin/fetch-metadata
validation, local file containment, and history durability. The live tests also
exercised remote media proxy playlist, segment, subtitle, and Range handling.

## Remaining publication decisions

1. ~~Maintainer approval of the `syracuse12` copyright attribution.~~ Approved.
   The maintainer has also confirmed authority to licence the project's own code
   under MIT and authorised public source publication.
2. ~~The `hianime` source integration.~~ Approved for retention. It stays in the
   source tree as an independently written adapter. Its unresolved part is
   narrower than first recorded: the adapter code is ours, but whether the
   upstream endpoints it calls may be used has not been established. It remains
   excluded from the installer payload.
3. The installed build has been smoke-tested on this machine, but clean-machine
   Windows 10 prerequisites, including .NET Framework availability and unsigned
   installer warnings, have not been established. This is a release gap, not a
   source-publication blocker.

### Still unestablished after publication

- Whether hianime.at terms permit third-party client access. No permission has
  been obtained or cited; the integration is published on the honest footing that
  it is unofficial.
- Per-item rights for anything the `archive` provider returns.
- Clean-machine installer behaviour and code-signing reputation.
- mpv/FFmpeg build configuration for any future bundled player.

An "educational use" label is not treated here as a source of rights.

See [PUBLICATION-MANIFEST.txt](PUBLICATION-MANIFEST.txt) for the candidate tracked
file list and SHA-256 hashes. Release payload hashes are in the ignored local
`.release/payload-manifest.json` generated by the build script.
