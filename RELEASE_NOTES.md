# ChessGym v0.1.0-alpha.1

The first community alpha of ChessGym: an open-source chess study workspace that runs on your own computer.

The aim is to bring useful study tools together and improve them with other players. This is already a usable application, but it is an early release, with rough edges and more work ahead. It is not a complete replacement for established commercial study products.

## Start here

Follow the [Windows installation guide](README.md#install-on-windows) or the [guide en français](LIRE-MOI.md#installer-depuis-github). Python 3.12 is required. The application opens directly without creating an account, password or login.

The first-run assistant offers three small examples: an opening repertoire, a Guess the Move game and a reading lesson. Add the examples, install Stockfish, and try the tools. Maia and the large optional datasets can wait until you need them. Source archives do not include engines, third-party databases or personal study data.

## Included in this alpha

- PGN libraries, annotations, variations, advanced game and position search, and separately indexed reference collections.
- Stockfish analysis, game reports, repertoire comparisons and transpositions, and exercises created from positions.
- Opening repertoires, move-frequency and branch-probability estimates, scans for unprepared replies, spaced reviews, annotated reading and persistent bookmarks.
- Personal pattern exercises, with prefilled solutions when creating an exercise from a solved puzzle.
- Classic Guess the Move, puzzles and Storm, blindfold visualization, coordinates and square-colour exercises.
- Games against Stockfish or optional Maia 3, configurable clocks and saved game history.
- Public-game synchronization from Chess.com and Lichess, with duplicate detection and preservation of annotations.
- Daily and weekly training goals, a personal programme, activity history and statistics.
- Hardware-aware CPU and Stockfish memory settings, with recommended profiles and long or continuous analysis.
- Twelve interface languages, local themes and piece sets, recoverable drafts, and personal backups.

The experimental Guess the Move Mix is not included. The classic mode remains available.

## Validation and limits

The application build used for this release preparation passed **4,074 isolated tests** on Windows, **22 browser scenario groups** and **193 checks from an extracted source archive**. A fresh application folder and virtual environment were also tested with an actual Stockfish download, all three examples, a first repertoire answer, a reading bookmark, Guess the Move, engine analysis and persistence after restart. The Windows machine already had Python and Chrome installed; this was not a clean operating-system installation.

Check the [GitHub Actions results](https://github.com/labbeast/chessgym-community/actions) for the published commit. Local test results do not substitute for those checks or guarantee every machine and workflow.

- **Windows with Python 3.12 is the tested platform.** Linux has a limited startup/API test; Linux browser and engine workflows, and macOS, still need end-to-end validation.
- **This release is local and single-user.** It accepts connections only from the same computer. It does not provide LAN, remote-server or multi-user access.
- **Optional resources have their own requirements.** Large databases need disk space and time to import. Maia and full dataset installation need wider testing across machines.
- **Online integrations depend on their sources.** Downloads and public-game synchronization can be delayed or rate-limited; incomplete operations are reported.
- **Keep a backup.** Features and data formats may evolve during the alpha series. Use a verified personal backup before updating an existing installation.

## Contributing and licences

Feedback from players is as useful as code: try the examples, describe confusing steps, help with translations, test another platform or propose a focused improvement. See [CONTRIBUTING.md](CONTRIBUTING.md).

ChessGym's own code is under [AGPL-3.0-or-later](LICENSE). The original starter examples are under [CC0](examples/README.md). Libraries, artwork, engines, models and datasets retain their own licences; see the [third-party notices](THIRD-PARTY-NOTICES.md) and [piece-set notices](PIECE-SETS-NOTICES.md). No commercial course or proprietary game collection is included.
