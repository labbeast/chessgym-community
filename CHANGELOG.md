# Changelog

## Unreleased

Changes after the first community alpha will be recorded here.

## 0.1.0-alpha.1 — First community alpha

### Library and analysis

- Personal PGN libraries with editable annotations, variations, advanced search and separate large reference stores.
- Stockfish position analysis and game reports, with deeper verification and exercises created from positions.
- Opening repertoires, reference comparisons, transpositions and draft recovery.
- Public Chess.com and Lichess game synchronization, preserving existing annotations and retrying temporarily missing archives.
- Hardware-aware CPU and Stockfish cache budgets, with Economy, Balanced and Custom profiles. Removed the former application caps on analysis depth and duration; continuous analysis remains cancellable.

### Study and training

- Spaced review and learning of new moves, complete-game review, maintenance reminders and resumable sessions.
- Reading bookmarks, progress and active study time.
- Classic Guess the Move with Stockfish scoring, player details and recorded game clocks when available.
- Puzzles, Puzzle Storm, blindfold visualization, coordinates and square-colour exercises, with separate histories and results.
- Stockfish and optional Maia 3 opponents, configurable clocks, saved game history and optional copies to a study base.
- Daily and weekly goals, a personal training programme, activity history and time statistics.
- Retired the experimental Guess the Move Mix from the active application. Removed the unused daily-session and work-assignment screens while retaining useful review services and historical data.

### First use and local operation

- Direct access without an account, password or login screen. Existing local study data and browser workspace identities are preserved.
- Loopback-only access with local-host and browser-origin checks; network bind addresses are refused.
- First-run assistant with three editable examples: repertoire, Guess the Move and reading. Original teaching comments are included in French and English under CC0.
- Stockfish is the only preselected download. Maia, Lichess datasets and separately licensed Lumbra imports remain optional.
- Re-adding examples creates only missing bases and preserves existing notes and progress.
- Resource management, optional maintenance and application updates, personal backups and restoration tools.

### Interface and community

- Complete catalogue coverage in twelve languages, including Arabic layout without reversing chess notation or board orientation.
- Themes, board palettes, bundled piece sets, text-size preferences and Kenney CC0 sounds.
- Code under AGPL-3.0-or-later, third-party notices, contribution guidance and issue templates.
- Public source starts from the reviewed community snapshot; personal data, downloaded engines and reference collections are excluded.

### Validation scope

The source build used for this release preparation passed 4,074 isolated Windows tests, 22 browser scenario groups and 193 extracted-source checks. An actual first-run installation of Stockfish and the three examples was exercised on Windows, including restart persistence. Python and Chrome were already installed on that machine. Linux has a bounded startup/API check; other platforms and optional large downloads still need wider testing. See [release notes](RELEASE_NOTES.md) and the [CI results](https://github.com/vincentinogec/chessgym-community/actions).
