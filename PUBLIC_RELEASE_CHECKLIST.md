# Community release readiness

Preparation snapshot: **28 October 2026**. This checklist records completed work and what must still be confirmed for the community release. It does not claim that a tag, release or announcement has already been published.

## Ready for this alpha

- [x] Source prepared as a clean community snapshot, without personal data, environments, backups, downloaded engines or reference collections.
- [x] Local single-user access without account creation, password or login. Loopback and browser-origin restrictions are retained.
- [x] First-run assistant with three original CC0 examples; Stockfish is the recommended initial download, while Maia and large datasets remain optional.
- [x] Classic Guess the Move included; experimental Mix excluded from the active application.
- [x] CPU and Stockfish cache settings bounded by detected hardware, with reasonable presets and cancellable long analysis.
- [x] Catalogue coverage in twelve languages: **3,774 source messages**, with matching keys and preserved variables.
- [x] The source build used for release preparation passed **4,074 isolated Windows tests**, **22 browser scenario groups** and **193 checks from an extracted source archive**.
- [x] A fresh application folder and Python environment on Windows completed actual Stockfish installation, the three examples, first repertoire practice, reading, Guess the Move, analysis and restart persistence.
- [x] The maintainer tried the separate first-run installation and reported that it worked on 28 October 2026.
- [x] README, detailed guides, release notes, contribution guidance, issue templates and licence notices prepared for the community repository.

## Before making the repository public

- [ ] Confirm the exact release commit and successful GitHub Actions results for that commit.
- [ ] Confirm the final source archive and included licences; inspect the actual contents to be distributed.
- [x] Review the pinned dependencies: the 28 October 2026 audit found no known vulnerabilities after updating certifi to 2026.10.19.
- [ ] Enable GitHub private vulnerability reporting when available and verify its public reporting link. SECURITY.md documents a fallback while unavailable.
- [ ] Verify the repository description, screenshots and installation links; remove any preparation-only material not intended for readers.
- [ ] Publish the version tag and release from the validated commit. Check that the source download works without maintainer access.
- [ ] Test application update checks against the new repository before advertising automatic updates as validated there.
- [ ] Review the announcement and links after publication. Check each community's current posting rules before sharing.

## Known limits to state openly

These are areas for further testing and contribution, rather than claims of completed validation:

- The Windows first-run test started with Python and Chrome already installed. A completely fresh Windows operating-system setup remains to be checked.
- Linux has only a bounded automated startup/API check. Linux browser and engine workflows, and macOS, need end-to-end validation.
- Maia, the full puzzle bank, very large reference imports and their interruption/recovery paths need more testing across machines. A general user confirmation does not establish which optional downloads were tested.
- Large resource downloads need internet access, disk space and time. External services can be unavailable or rate-limit requests.
- The application is local to one computer. It is not a LAN, remote-hosting or multi-user service.
- Alpha features and formats can change. Existing users should keep a verified personal backup before updating.

The source-code licence is AGPL-3.0-or-later. Engines, models, datasets and artwork retain their own terms; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), [PIECE-SETS-NOTICES.md](PIECE-SETS-NOTICES.md) and [example provenance](examples/README.md).
