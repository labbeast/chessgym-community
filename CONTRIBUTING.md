# Contributing to ChessGym

ChessGym is a community project for chess players. Small, useful contributions are welcome: clearer wording, a reproducible bug report, an installation test, a translation correction or a focused code change.

## Start with an issue

For a bug, use the [bug report form](https://github.com/vincentinogec/chessgym-community/issues/new?template=bug_report.yml). Include the version, operating system, steps to reproduce, what happened and what you expected. A small PGN made for the report is more useful than an entire personal database.

For a larger feature or refactor, describe the problem in an issue before starting. Explain the study workflow and who it helps. An implementation proposal is welcome, but a clear example of the problem is enough.

Do not attach personal backups, saved tokens, private game collections or material from a commercial course. Check screenshots and logs before sharing them. For security problems, follow [SECURITY.md](SECURITY.md) instead of publishing technical details in an issue.

## Set up a development copy

Use a separate checkout and example data so experiments do not affect your own study library. Python 3.12 is the supported development version. Install Node.js 24 for the frontend tests.

On Windows, from the project folder:

    py -3.12 -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
    .\.venv\Scripts\python.exe scripts\test_learning_changes.py --full

The commands above use Windows paths; on Linux the environment executable is .venv/bin/python. The test runner creates isolated data and temporary folders. Some engine integration checks require a local Stockfish installation; the CI workflow provisions one. Use the existing test helpers rather than pointing tests at your personal data/ directory.

For a focused change, pass the relevant test files to the same runner:

    .\.venv\Scripts\python.exe scripts\test_learning_changes.py tests\test_starter_examples.py

The application itself does not require Node.js. Start the development copy with .venv/Scripts/python.exe run.py after installing runtime dependencies. Avoid running two copies on the same port; when needed, set CHESSGYM_PORT before using run.py, or pass -Port explicitly to Start-ChessGym.ps1.

## Send a pull request

1. Fork the repository and make a branch for one change.
2. Keep the change focused and follow nearby code and UI patterns.
3. Add or update meaningful tests when behavior changes. For interface changes, check the actual screen and include a screenshot when useful.
4. Run the relevant checks and state exactly what passed, what was not run and why.
5. Explain the user-visible problem and resulting behavior in the pull request. Link the related issue, if there is one.

Preserve existing PGNs, annotations, drafts, progress and histories unless a change explicitly requires a migration. Import/export and backup changes deserve particular attention. Keep downloads optional and distinguish third-party resource licences from the source-code licence.

## Translations and examples

The interface catalogue lives in static/locales/. Preserve placeholders, chess notation and the meaning of the source text. A translation should sound natural to someone using a chess application. Include the relevant language tests with catalogue changes.

The starter examples live in examples/. Contributions must have clear provenance and redistribution rights. Original teaching examples are preferred; do not copy annotations from books, courses or commercial databases.

## AI-assisted work

AI coding tools are welcome. The contributor remains responsible for understanding the change, checking its output and running the relevant tests. Mention substantial AI assistance when it helps a reviewer understand how the change was developed or validated. Do not submit generated code, translations or claims that you have not reviewed, and do not upload private study data or credentials to a tool without permission.

## Licence and conduct

By submitting a contribution, you agree that it may be distributed under the project's [AGPL-3.0-or-later licence](LICENSE), or the existing licence of the affected asset where applicable. Include the provenance and licence of any new third-party material.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Be specific, respectful and patient: people may be contributing in a second language or learning both chess and programming.
