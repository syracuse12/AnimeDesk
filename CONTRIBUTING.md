# Contributing

Thanks for looking. This is a small, single-maintainer project; please open an
issue before a large pull request so the shape can be agreed first.

## Ground rules

- Target Windows 10/11 x64 and Node 24+. Other platforms are out of scope for now.
- Keep the provider layer extensible. Provider quirks stay inside the provider.
- No new runtime dependency without a reason and a licence check. Node, React and
  hls.js cover the needs; anything else has to earn its place.
- Nothing may leave the machine except the requests listed in
  [docs/PRIVACY.md](docs/PRIVACY.md). No analytics, no beacons, no third-party
  fonts.
- Keep the local-only threat model intact: loopback binding, host/origin checks,
  public-address policy on outbound requests, bounded tokens, bounded bodies.
- Match the surrounding code: TypeScript, strict, small functions, comments that
  explain *why*.

## Getting set up

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). In short:

```powershell
npm ci
npm run dev
```

## What to run before a pull request

Minimum, always:

```powershell
npm run verify
```

Also run these if you touched the player, proxy, store, providers or installer,
and list what you ran in the PR:

```powershell
npm run test:ui
npm run test:qa
```

`npm run test:live` needs the network; run it if you changed the proxy or a
provider's resolve step.

## Adding a provider

1. Implement `server/providers/types.ts` in a new module under
   `server/providers/`.
2. Register it in `server/providers/index.ts`, gated by profile if it needs the
   network.
3. Add a fixture-backed parse test plus a security test for any new URL shape.
4. Document it in the README table and, honestly, in
   [docs/LICENSING.md](docs/LICENSING.md).
5. Do not assume dub availability.

## Style

- `.ts`/`.tsx` only. No `.js` under `src/`, `server/` or `shared/`.
- Validate every inbound value; bound every outbound call.
- Prefer a small pure function in `shared/` over duplicated logic on both sides.
- No emoji in code comments. Sentence case in UI copy.

## Commits

Short imperative subject, then a body saying what was verified. Example:

```
Bound artwork cache by entry count

Verified: npm run verify; npm run test:ui
```

## Reporting bugs

Use the bug template. Include version, Windows build, whether the source was
`hianime`, `archive` or `local`, and what you expected. Redact personal paths if
you care about them. Do not paste cookies or keys.

Security issues go through [SECURITY.md](SECURITY.md), not the public issue
tracker.

## Licence of contributions

By opening a pull request you agree your contribution is licensed under the MIT
licence that covers this project. Do not paste code from a copyleft project
without saying so.