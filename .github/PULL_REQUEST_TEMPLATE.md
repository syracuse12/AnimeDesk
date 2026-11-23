## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Area

<!-- player / provider / history / UI / packaging / docs -->

## Checks run

<!-- Tick what you actually ran. Untick and explain what you could not. -->

- [ ] `npm run verify`
- [ ] `npm run test:ui`
- [ ] `npm run test:qa`
- [ ] `npm run test:live`

## Invariants

- [ ] No new runtime dependency (or: justified and licence-checked)
- [ ] Still loopback only, no new outbound host without a bound and a policy check
- [ ] Provider quirks kept inside the provider module
- [ ] Docs updated if behaviour, providers or setup changed

## Notes for the reviewer

<!-- Anything surprising, risky or deliberately left out. -->