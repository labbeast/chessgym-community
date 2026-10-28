# ChessGym — detailed guide

This guide covers the available tools and advanced settings. For the shortest installation path, start with the [README](README.md#install-on-windows). ChessGym runs on your computer without an account or login. Optional private access lets you pair your phone with the same installation.

## Training

Study bases offer **Review** (previously studied cards due now, including maintenance reminders) and **Learn** (only cards never studied). Reviews opens directly on **Databases to review**. **Review all** and **Learn all** launch the corresponding cards from every enabled study base, independently of list filters. Manual launches start directly without session goals. Training blocks choose Review, Learn, or both and control the workload through their card/time goals; mixed blocks finish due reviews before introducing new cards. Daily new-card quotas have been removed; values retained in older backups are ignored. Future reviews are not included in either mode. Answers, schedules, history, and paused sessions are preserved.

During an activity, the existing top bar keeps its logo, height and styling while navigation gives way to Training, the activity name, session time and progress on one line. Exercise counts stay separate from the clock; session details and goals remain available in the **…** menu. Reviews, reading, analysis and computer games can pause in place; timed challenges keep their native countdown and cannot be paused. Choose to continue toward today's goal or the week's goal: the timer or exercise allowance uses what remains for that period. Where a tool only exposes accepted statistical time, the programme shows an estimated remaining duration refreshed from those records. Reaching a programme time target does not automatically complete the block or interrupt a game. On mobile, the timer and available pause control stay visible, with secondary actions in the **…** menu. Paused reviews retain their position and time when restored, following the existing startup preference.

**Training → My training** has three tabs in this order: **Day and week**, **Programme**, **Statistics**. The separate Summary page is removed. Day and week always shows all ten activities, even without a programme, in the same order as the menus: review, puzzles, blindfold, coordinates, square colours, guess-the-move, computer games, reading, analysis and personal activities. Compact rows use the same activity icons as the menus. All recorded time accumulates in its activity, whether started freely or from a planned block. Daily and weekly time goals are independent: for example, 5 minutes today and 20 minutes this week. Both columns use the same progress display. A zero goal means **No goal** and keeps counting time without treating the activity as complete. The repeated **Goals and details** panels are removed from this list. **Programme** keeps one shared activity selector for editing daily and weekly goals and accessing planned blocks, resources and declared work. Compose your own blocks or copy selected blocks from templates, choose resources, and set more specific goals in minutes, sessions or quantities. Personal templates and programmes persist in ChessGym; activate now or next week.

Planned reviews and reading reuse their native tools, receipts and saved progress. Pause preserves the episode; explicit completion counts one session after actual work. Studied reading games require a separate confirmation, without duplicating native time. Puzzles (including Storm), guess-the-move, computer games, blindfold, coordinates and Color credit their accepted native measurements once. Analysis records time while its board is visible and focused, stopping after 90 seconds without interaction or during a pause; reading and analysis never record the same interval together. External activities use editable manual declarations. **Work to assign** and its assignment controls have been removed: recorded work appears automatically in its activity. Failed attempts count as work, independently of goal units and explicitly completed sessions. Programme aids retain observed-duration suggestions and previous-week duplication; changes to goals require explicit application. Weeks reset without carrying unfinished goals forward. Known historical measurements are preserved; missing durations remain unknown. Programmes, templates and results are included in personal backups.

**Statistics** explores that same recorded time by day, week or month. Stacked activity bars, a time-distribution chart, an activity calendar and weekday averages share the same date and activity filters. Totals, active days, daily averages and a comparison with the previous period update together. Use 7, 30, 90 or 365 days, or choose a custom range; a data table provides the underlying values. Unknown durations are identified separately and are never guessed.

The **Library** menu groups study bases, personal games and repertoires. **Training** groups spaced reviews, reading, puzzles, guess-the-move, blindfold exercises, coordinates and Color. The **Board** dropdown provides the current analysis, new analyses, recent boards and draft management. On mobile, all three dropdowns are directly accessible as icons; opening a menu also reveals its name.

- **Complete game** is a review type set on a base: play both sides of its main line and grade the whole game once. Opening reviews still track individual moves; **Line / full PGN** lets you consult the source and return to the same card.
- **Guess the move** accepts study or reference games, or the current analysis document. Every move is graded solely by Stockfish, including the original PGN move, using its evaluation loss against the best move. Play then follows the original game. Player names and available Elo ratings frame the board; the event and date appear above it. Available game clocks follow the revealed original position without counting down during your thinking time, and are hidden while exploring alternatives. Missing metadata stays hidden. Attempts never overwrite source PGNs.
- **Play against the computer** offers Stockfish levels 0–20 and optional Maia 3 with human rating targets 600–2600, with a choice of side and starting position. Paste a FEN or choose **Play this position** in the analysis board's **…** menu. Games have their own durable history, optional library copies and configurable clocks; see [Computer games](#computer-games) below.
- **Puzzles** provides classic calculation with a local personal rating, saved filters, attempt history and optional automatic copying of failed puzzles to a study base. Time is statistical only. Standard **Storm** has a three-minute clock, increasing difficulty, combo bonuses and separate records. Each correct player move advances the combo: +3 seconds at 5 moves, +5 at 12, +7 at 20, then +10 at 30 and every further 10 moves. A mistake costs 10 seconds and resets the combo. The bar shows the next bonus and the clock displays time gained or lost. Difficulty follows the 137-puzzle bucket cadence in [Lichess’s selector](https://github.com/lichess-org/lila/blob/master/modules/storm/src/main/StormSelector.scala), advancing after both solved and failed puzzles. The local bank uses ordered rating targets within those buckets, excludes equality puzzles and requires rating deviation ≤85; Lichess’s live quality-ranked paths are unavailable locally, so individual puzzle selection is an approximation.
- **Blindfold Puzzles** offers **Openings** (visualize the source game sequence) and **Positions** (visualize a piece description), with separate local ratings starting at 500. Rated exercises automatically increase visual load using `x = clamp((rating - 500) / 2500, 0, 1)`, `moves = round(5 + 45*x^1.4)` and `pieces = round(3 + 29*x^1.4)`, choosing approximately ±2 full moves or ±1 piece. Kings and pawns count. The nominal Lichess tactical target is `800 + 0.5*(rating - 500)`; the selection widens this tactical range before changing visual load. The versioned local exercise difficulty is `clamp(500 + 0.5*(visual_level - 500) + lichess_rating - 800, 500, 3000)`, where visual_level is the inverse curve evaluated at the actual move/piece count. This is a local training scale, not a calibrated Lichess equivalence. Standard and blindfold puzzles share the Lichess Glicko-2 calculation (initial rating deviation 500, volatility 0.09, tau 0.75). Large initial changes decrease as uncertainty shrinks; ratings are provisional while deviation is at least 110. Existing ratings and history are preserved, with high initial uncertainty for recalibration. The blindfold modes retain their separate local scale and progression. **Points require a complete error-free solution.** Final-position reconstruction is optional, including in rated exercises, and appears as a secondary statistic without affecting puzzle success or rating. Skipping, revealing or leaving during reconstruction preserves the solution result. Revealing or abandoning before completing the solution counts as a failure; retries grade only once and previously started puzzles cannot earn another rating in the same mode. Unstarted exercises and service failures do not change ratings. Time is statistical only. Free practice retains manual filters; personal-game reconstruction remains available separately. Legacy sessions remain unranked, and already recorded results are preserved. Ratings and the grade ledger are included in personal backups. Opening puzzles retrieve and cache their exact source game from Lichess when necessary; uncached sources require Internet access, and the saved Explorer token is reused when required.
- Blindfold's start menu places a **Rated puzzle** button beneath each mode's rating. **Custom set** opens manual settings for Openings, Positions or personal-game reconstruction.
- Blindfold displays **Visualization time** while the moves or piece description are shown, then freezes it at **I'm ready** (or **Reconstruct the position**). It survives reloading, appears in the result and counts toward total history time. Position descriptions group pieces by color and type, with one piece icon followed by its squares.
- **Coordinates** offers square names, move destinations and mixed prompts, both board orientations, 30/60-second sessions and separate records by configuration.
- **Color** displays a square name and asks whether it is light or dark, using buttons or the left/right arrow keys. Choose 30 or 60 seconds; the clock begins with the first submitted answer. Every answer advances to a new square, including mistakes. Personal records are separated by duration and accept only completed sessions with at least one answer and **no errors**. A percentage rounded to 100% never makes an imperfect session eligible. Interrupted sessions started over before their deadline do not count as records; recent sessions remain available for comparison.
- **Settings → Sounds** controls volume, move and answer sounds, and optional navigation sounds. ChessGym uses locally bundled Kenney wood impacts and interface sounds under CC0, with no external audio requests during play. See [sound provenance](static/sounds/kenney/README.md). Hover previews remain silent.
- **Settings → Appearance → Text size** enlarges text throughout the interface to 110%, 125% or 150%, including menus, lists and annotations. The choice is saved in ChessGym; select 100% to restore normal size.

Download the optional public puzzle bank and import it once (use `.venv\\Scripts\\python.exe` on Windows):

```sh
.venv/bin/python scripts/download_puzzle_bank.py
.venv/bin/python scripts/import_puzzle_bank.py data/puzzles/source/lichess_db_puzzle.csv.zst
```

The bank is stored separately in `data/puzzles/bank.sqlite3`; `CHESSGYM_PUZZLE_BANK` can select an absolute alternative path. The Puzzles screen also accepts a local CSV, CSV.ZST or CSV.GZ path on the server. Source archives are not bundled with ChessGym. Attempt histories and personal ratings stay in the personal database. Personal backups include these histories but omit the downloadable bank; full backups also snapshot `puzzles/bank.sqlite3`. As with reference stores, transfer that file separately while stopped when restoring a full backup to another machine.

## Lists and search

Study games, reference games and exercise game selection share the advanced player, date, Elo, ECO and cadence filters. Applied criteria stay visible as removable chips when advanced search is closed; edited criteria apply explicitly. Quick search is debounced, with Enter applying it immediately, and ignores accents and case. Paging offers 25, 50 or 100 rows where supported, with server-side filtering for large databases and training history. Training history also supports sorting by date, duration or activity across the complete filtered population.

Library, reading, repertoires, review bases, draft management and installed engines reuse local collection controls with appropriate filters and sorting. Applied search, sorting and page state are retained while navigating within the app, separately by view and base, and cleared when the local profile or restored workspace changes. This navigation state remains in browser memory. Source PGNs and review schedules are not modified by searching.

Long searches show an animated activity bar in reference game lists, player and tournament directories, the training game picker and the position explorer. It remains visible during automatic background preparation and stops on completion or when a manual retry is needed. The bar is indeterminate because search queries do not provide a measurable completion percentage, and it respects reduced-motion preferences.

## Training history

**Training → History** combines all nine training tools in one filterable table. Each tool also opens the same history view limited to its own activities. The shared columns show when an activity occurred, what was worked on, its recorded duration, completion state and result; contextual columns or details retain ratings, scores, errors, hints, source bases and other relevant information. Filter by tool, date range, status, outcome or text, and open the recorded answers or the source exercise where available. Calendar-date filters use the browser's time zone. Both activities and long answer lists are paginated on the server.

The table keeps the original meaning of each record: a graded **review answer**, a classic **puzzle attempt**, a **Storm, guess-the-move, blindfold, coordinates or Color session**, a **computer game**, or a **reading visit**. Storm attempts appear inside their parent session rather than being counted twice. Review answers are not retroactively grouped into invented sessions. Manual marking as mastered does not create a graded answer in the legacy review log.

Durations describe the data actually recorded. Reading visits and new computer games measure active time; other tools retain their recorded response or elapsed duration. Older timed computer games can use consumed clock time, excluding increment, while an older untimed game with no measurement displays **—**, not the time between opening and reopening it. Scores and accuracy stay separate from completion: an unfinished activity is not silently treated as a success.

Reading visits begin with this feature; older cumulative reading totals are retained without inventing past visits. Visits keep the first and last recorded main-line positions and active time. The book's overall bookmark progress remains a separate metric, not a count of moves newly read during that visit. Personal backups include the history and new visit journal. Previously deleted or never-recorded activity cannot be reconstructed.

## Computer games

Every newly played computer game is retained in the local **History**, including unfinished games, independently of study bases and the currently resumed workspace. Open **History** from the computer mode to review moves, analyse a detached copy, resume an unfinished game or copy it to a personal base. Starting another game or using **Replay** keeps the previous game in this history. The full path from an analysis position is retained for repetition rules, while the source analysis remains untouched.

The mode's **Settings** offers **Automatically copy finished games** and a personal destination base. It is disabled by default. When enabled, a newly finished game is copied once to that base; older completed games are not copied retroactively. Existing copies and their annotations are never rewritten by later clock updates or takebacks. Manual **Copy** is also available for unfinished games. Reference bases cannot be copy destinations. A failed automatic copy is reported without discarding the archived game.

Choose **Unlimited**, a preset (3, 5, 10 or 30 minutes, or 15 minutes + 10 seconds), or a custom duration and increment. Each side has its own clock, and the increment is added after a legal move. The game pauses when its browser tab becomes hidden, the browser closes, or you leave the computer board. Returning restores the remaining time in pause; press **Resume** to run the clocks again. Time spent away is not deducted. The clock result is checked against the position, including a draw when the opponent has insufficient mating material. PGN copies include the time control and recorded move clocks.

The active game and unsent history updates are first retained on the device, then synchronized with the server. Wait for successful synchronization before closing the tab; a connection or storage problem remains visible. Conflicting updates are rejected rather than silently replacing a more recent game. Personal backups include computer history, clocks, copy settings and the links to library copies.

This history starts with this feature. The last computer game still retained by an older version can be carried over, but previously replaced games that were never saved cannot be reconstructed.

## Requirements

- Python 3.12 and a virtual environment.
- The packages pinned in `requirements.txt`.
- A native UCI engine (Stockfish recommended) for computer analysis. Library and study data remain usable without an engine.
- A browser with JavaScript enabled. Node.js 24 is used for frontend tests; Node.js is not needed to run ChessGym.

All twelve offered languages cover the full interface catalogue, including onboarding and advanced settings. The included teaching examples retain their French and English comments.

Windows is the development and test environment. The Linux instructions below use the existing portable server entry point and native engine discovery; they have not been validated by a Linux end-to-end run.

## Install on Windows

Install Python 3.12 and Git. In PowerShell:

```powershell
git clone https://github.com/labbeast/chessgym-community.git
cd chessgym-community
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

If you already downloaded and extracted this release's source archive, start with the virtual-environment command from that extracted folder. The source checkout contains no personal database, login credentials, downloaded puzzle bank, reference collection, Python environment or engine installation; a new installation starts with an empty library.

Start ChessGym and use the welcome screen to add the examples and install Stockfish:

```powershell
.\.venv\Scripts\python.exe run.py
```

Alternatively, use `Demarrer ChessGym.cmd` or `Start-ChessGym.ps1` to start the server in the background and open the browser. `Arreter ChessGym.cmd` stops the instance managed by that launcher. The launcher uses localhost by default, follows the enabled private-access setting after a restart, and reuses an existing running instance.

The optional `scripts/prepare_local.py` helper installs the pinned Python packages, obtains missing Cburnett pieces, and downloads a checksum-verified Stockfish 18 **only on Windows x86-64**. It does not rewrite dependency files. Use `--dev` for test dependencies or `--skip-engine` to keep your own engine. Running this helper makes network requests; it is not required when the dependencies, assets, and engine are already installed.

After installing the dependencies above, you can install that optional engine with:

```powershell
.\.venv\Scripts\python.exe scripts/prepare_local.py --skip-dependencies
```

For local Maia 3 opponents, run `.venv\Scripts\python.exe scripts/install_maia.py`. The optional installer keeps a separate CPU-only Python/PyTorch runtime, the pinned official CSSLab source, model checkpoints, licenses and provenance under `engines/maia3/`. ChessGym's own Python environment is unchanged. The engine loads local files and performs no downloads during a game. Human rating targets 600–2600 use the Lichess scale as a reference, not a calibrated engine rating or a Chess.com equivalent. Stockfish's 0–20 levels are also not advertised as Elo ratings. Use `scripts/install_maia.py --verify` to check the installed files. Existing retained Maia games keep their position, side and selected level and continue with Maia 3. Installing or selecting a model does not create a PGN entry; optional copies are controlled separately in the computer mode settings. Previous Maia-1 files, if present, remain untouched and are no longer used.

The default model is Maia 3 **79M**. On the development PC, a one-thread CPU benchmark over 12 moves in four positions measured a 0.212-second median response after a 1.738-second cold startup. These are local measurements, not a guarantee for other machines. Use `scripts/install_maia.py --with-small` to also download **5M**, then select it in **Settings → Engines** on a less powerful server. `--model 5m` installs and selects the small model directly. `--models-only` reuses an existing verified runtime without reinstalling its packages.

## Hardware budgets and long analysis

**Settings → Performance** shows the usable logical CPU count and detected RAM of the ChessGym server. Choose a recommended Economy or Balanced profile, or set a custom CPU budget, total Stockfish hash cache and import worker count. Values are bounded by the machine, keeping at least 2 GiB or 20% of RAM in reserve when capacity allows. If memory detection is unavailable, the hash limit is a conservative 128 MB. Saved configurations are adjusted when restored onto a smaller machine.

CPU reservations keep active calculations and imports within the selected budget, including machines with one or two logical cores. The memory setting covers the two Stockfish hash caches; it does not cap Maia, imports or total application RAM. Changes apply to subsequent tasks; an idle engine resizes its retained cache on its next search.

The board engine settings accept a free duration (minimum 0.1 seconds), a positive target depth without an added time limit, or **Unlimited** analysis until the engine is turned off or the position changes. Explorer depth searches and game-report depth searches also have no hidden duration cap; game reports accept a free duration instead of short presets. The former application limits of 30 plies and 60 seconds are removed. Attainable depth still depends on the engine. Leaving a position, cancelling a report or disconnecting an analysis client stops its work and releases its CPU reservation.

## First-run resources and updates

On the first visit, **Settings → Installation** opens automatically, including when opening a direct board link. Choose **Add the examples** to create three small, editable study bases: an Italian repertoire with move reviews, a Guess the Move game, and a reading lesson with variations and a bookmark. Open each activity from its card. Repertoire and reading need no engine; Guess the Move uses Stockfish to score attempts. The original French/English teaching comments are included under CC0; see [example provenance and license](examples/README.md). Adding the pack again creates only missing bases and preserves your edits and progress.

Stockfish is the only recommended preselection. Maia and large databases are optional; no download begins before you choose **Download and configure**. The screen offers Stockfish, Maia 3 (79M or the smaller 5M model), the full Lichess puzzle bank, and the latest published month of Lichess broadcast tournament games. Select the resources and choose **Download and configure**. Engines are verified and selected for their roles; datasets are imported for immediate use. Downloads run in the background with progress and individual error messages. You can skip this step and return later.

Lichess datasets are optional. Puzzles require several GiB for the downloaded, staged and indexed data; the installer checks free space before proceeding. Tournament games come from the official broadcast archives, rather than the much larger monthly rated-game dumps. Each new month becomes a separate reference base and earlier months remain available. Puzzle updates preserve puzzle IDs and personal history while refreshing ratings and metadata. Interrupted or failed work can be retried.

The same screen offers **Lumbra OTB Elite — masters 2400+** and **Lumbra Gigabase OTB — complete** as optional reference databases. Choose **Download from Lumbra**, select the matching PGN edition on the [official download page](https://lumbrasgigabase.com/en/download-area-en/), and accept its license there. Back in ChessGym, enter the path to the downloaded `.7z` or `.pgn` on the computer or server running ChessGym, then choose **Import downloaded database**. Importing `.7z` requires an installed [7-Zip](https://www.7-zip.org/) command-line program; an extracted PGN does not. The file is checked and indexed in a preparation area with progress reporting before the reference is added to the library. Retained source files and archives are stored under `data/resources/lumbra/`; full Gigabase indexing can require several hours and substantial disk space.

An interrupted Lumbra import retains its committed index checkpoints: import the same file again to resume. Partial references are not published. Brief Windows file locks are retried automatically.

For Elite, **Use as the master reference database** optionally selects the imported base as the local master comparison source; it is off initially. Lumbra's databases are by Michael Jansen and licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/): attribution and non-commercial use are required, with separate terms for commercial use. No Lumbra data is bundled with ChessGym. New Lumbra editions follow the same browser download and import steps; automatic resource updates do not download or replace them.

**Update installed resources** refreshes the recognized installed resources. The optional **Update automatically every week** setting is off initially and runs while the ChessGym server is active, including when the browser is closed. Checks that became due while the server was off run after restart. This updates Stockfish from its stable official release, Maia from the source/models validated by the installed ChessGym version, and the installed Lichess resources. Application updates have their own controls below. New unvalidated Maia releases are reported in **Settings → Engines**.

Engine versions are retained, and a selection changed during a download is respected. Updates keep disabled roles disabled and defer activation during game-report analysis. Host settings and progress are saved in `data/resource-setup.json`; downloaded Lichess metadata and archives live in `data/resources/lichess/` (under `CHESSGYM_DATA_DIR` when set). Like engines and reference files, these host resources need separate provisioning when moving to another server.

## Application updates and languages

**Settings → Installation → ChessGym updates** checks published version tags from the official repository. Choose **Check for new versions**, then **Prepare update** and **Restart and update**. Preparation downloads the release and creates a separate Python environment, checks the application, and verifies a personal backup. The launcher stops the serving process, takes a final database snapshot and applies only a fast-forward release. If the new version fails its startup check, the previous code, environment and database are restored. Existing engines and reference files are retained.

The separate **Update ChessGym automatically every week** option is disabled initially. When enabled, preparation runs while the server is active; restart waits for at least five minutes without API activity and for analyses, imports, resource installations and backups to finish. A prepared version is also applied on the next normal launch. Settings show progress, failures and any required action.

Application updates require Git, access to `github.com/labbeast/chessgym-community`, an unmodified checkout on a branch, and startup through `run.py` or the supplied launcher. Local code changes, divergent history, source archives without Git, or a directly launched Uvicorn process prevent automatic application replacement. Updates follow newer published versions, including preview versions when the installed version is itself a preview. They do not follow every development commit.

Choose an interface language under **Settings → General → Language**. The choice is saved in ChessGym and on the device for the next visit. Arabic uses right-to-left layout while the chessboard, notation and FEN/PGN fields retain their chess orientation. Translation catalogues are included locally; changing language does not make a translation-service request or alter imported content.

## Engine management

**Settings → Engines** lists local engines, their availability and verified versions. Choose the native UCI engine used for analysis and ordinary computer play, and choose the Maia 3 model separately. Changes apply to subsequent calculations without restarting the server. Existing games retain their position and settings and use the currently selected engine when resumed. Analysis caches distinguish executable versions.

- **Add an engine** accepts a name and the absolute executable path on the hosting computer. It validates UCI communication and a legal move before registering the engine. No shell command or additional arguments are accepted. Engines without a supported skill option play at their normal strength.
- **Test** checks an installed engine; **Edit** changes its display name or, for an externally installed UCI engine, its path. **Remove** unregisters an inactive engine and keeps its files on disk. Select another engine or disable its role before removing an active one.
- **Check for updates** contacts the official sources. The catalogue can install the current supported Stockfish release and the validated Maia 3 5M/79M models. Downloads run in the background, with progress and checksum verification. Successful installations are added without selecting them automatically; older versions remain available. A newer, unvalidated Maia source revision is reported but is not installed automatically.

The catalogue and selections are host configuration stored in `data/engine-catalog.json` (under `CHESSGYM_DATA_DIR` when configured). The initial discovery uses existing engine installations and environment settings; after that, the saved catalogue takes precedence. Removing or disabling an engine does not make it reappear through discovery. This file and the engine packages are **not included in personal backups** and should be configured separately on a new server. Engine files stay on the computer running ChessGym.

## Install on Linux

From the project folder:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export CHESSGYM_ENGINE=/absolute/path/to/stockfish
.venv/bin/python run.py
```

Install Stockfish through your distribution or use an upstream build for your architecture, with executable permissions. ChessGym also searches `PATH`, `/usr/games/stockfish`, and executable files under `engines/`. The optional setup helper gives manual engine instructions on non-Windows systems; it does not download a Windows binary there.

For Maia 3 on Linux, run `.venv/bin/python scripts/install_maia.py` to prepare its separate CPU runtime and local model files. An upstream PyTorch CPU wheel must be available for the host platform. The environment variables below support a separately provisioned runtime. Linux Maia 3 has not been end-to-end validated here.

Open **http://127.0.0.1:8765**, and import a PGN into a new library base. Optional example bases are available in the interface. Stop a foreground server with Ctrl+C.

## Phone access on a private network

The host computer keeps the library and runs Stockfish or Maia. Your phone uses the browser interface and the same study progress. There is one personal workspace, not separate user accounts.

1. On the host computer, open **Settings → Private access** and enable access from a phone.
2. Stop and restart ChessGym when the setting asks you to. Reopening a browser tab alone does not restart the application.
3. Open the same settings again. Copy the **Wi-Fi** pairing link for a phone on your trusted home network, or the **Tailscale** pairing link for a phone connected to your private Tailscale network.
4. Open the complete pairing link on your phone. The secret is removed from the address after pairing, and the browser remembers the device for up to 30 days. Treat the link as private: it grants access to your library.
5. Use **Revoke devices** on the host to replace the link and invalidate existing pairings, or disable private access to refuse network requests. Stop and restart the application to return the listener to localhost.

For access away from home, install and connect Tailscale on both devices, then use ChessGym’s generated Tailscale IP link. Tailscale’s access rules must allow the connection; see the [official device connection guide](https://tailscale.com/docs/how-to/connect-to-devices). No router port forwarding, Tailscale Serve or Funnel is needed. The host computer must stay awake with ChessGym running.

A direct Wi-Fi link uses HTTP and should be used only on a trusted local network. Tailscale encrypts traffic between its devices. If a link does not open, check that the private mode is active after restart, both devices are on the expected network, and the computer’s firewall allows ChessGym’s port on that private network. Do not disable the firewall globally or open the port to the public Internet.

If the host changes network or gains a new network address, restart ChessGym to refresh the permitted addresses, then copy the new pairing link. The interface is responsive; phone-sized browser checks are distinct from testing every iOS or Android browser. Pairing settings are managed from the host computer, not from a paired phone.

## Configuration

Set environment variables **before** starting `run.py`. Relative data paths are resolved from the project folder; an absolute path is recommended for a server installation.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHESSGYM_HOST` | Automatic | Localhost by default; private access selects the network listener after restart. An explicit localhost address keeps the process local. Network binding requires private access to be enabled. |
| `CHESSGYM_PORT` | `8765` | HTTP port. |
| `CHESSGYM_DATA_DIR` | `data/` in the project | Personal database, settings, progress, and reference stores. |
| `CHESSGYM_ENGINE` | Automatic discovery | Initial discovery path for a native UCI executable, before a local engine catalogue exists. |
| `CHESSGYM_MAIA3_ROOT` | `engines/maia3/` | Maia 3 installation root, including its manifest, runtime and models. |
| `CHESSGYM_MAIA3_PYTHON` | `runtime/Scripts/python.exe` or `runtime/bin/python` under that root | Python executable with the official Maia 3 package and CPU dependencies installed. |
| `CHESSGYM_MAIA3_MODEL` | Installation manifest, then `maia3-5m` | Architecture: `maia3-5m`, `maia3-23m` or `maia3-79m`; the matching checkpoint must be installed. |
| `CHESSGYM_MAIA3_CHECKPOINT` | Selected model file under the installation root | Explicit local checkpoint matching the selected architecture. |
| `CHESSGYM_IMPORT_WORKERS` | `auto` | `1`–`16` parsing processes. Automatic mode reserves CPU capacity and uses at most four processes. |
| `CHESSGYM_IMPORT_CACHE_MB` | `128` | `64`–`4096` MiB for the single reference import writer's SQLite cache. |

The Windows launcher's defaults are **up to four import processes** (bounded by available CPUs) and **256 MiB** of writer cache. Override them explicitly when needed:

```powershell
.\Start-ChessGym.ps1 -NoBrowser -ImportWorkers 4 -ImportCacheMB 256
```

`-ImportWorkers 0` selects its automatic budget. An already running server retains its configuration until restarted. More processes or cache do not guarantee faster imports; storage throughput and index size matter. Import progress distinguishes reading, saved batches, and final consolidation. Reading 100% of the source does not mean the import is finished.

Local access without pairing requires both a loopback connection and a local Host header. The optional private mode accepts only private network clients addressed to detected private host IPs, with a valid pairing cookie. Browser-origin checks remain enforced and forwarded proxy headers do not grant access. Public hosting, port forwarding and Tailscale Funnel are not supported.

## Study and recovery

- Search personal games and reference archives with combined player/name/color, event/site/round, date, Elo, result, ECO, opening and time-control filters. Pagination and next/previous analysis retain the active criteria.
- Browse a database’s **Players** and **Tournaments** directories, including game counts, recorded Elo ranges, dates and linked games. Tournament editions are separated by event/site/EventDate or year. Unknown PGN metadata is not fabricated.

- Analyse and edit complete games, variations, comments, annotations, clocks, and engine lines. The deepest available evaluation is used for each move and the graph; equal or shallower results keep the saved score. Position analysis adds its score and depth to the move even without a full-game report. These annotations are retained in the automatically recoverable draft; **Save** writes them into the library PGN.
- Build multiple repertoires and compare local reference games or configured online explorer sources.
- Review a visual game report with prioritized decisions, repertoire departures, move times, and deeper verification. Retry on a temporary board, compare alternatives, and create your own linked exercises while preserving the source game and its draft. Reviewed moments, hints, revealed solutions and attempts persist in ChessGym, with explicit conflict resolution and reset.
- Compare repertoire transpositions by exact legal position, inspect the move orders and annotations, and open the matching branch while retaining the current draft. Bounded searches report partial results.
- Synchronize public Chess.com and Lichess games without duplicating existing games or replacing their annotations. A temporarily missing Chess.com monthly archive is reported as a partial synchronization and retried on the next run.
- Review tactics, opening moves, and playable positions; scheduling preferences and mastery thresholds are configurable.
- Track course reading, bookmarks, and active reading time.
- Resume analysis and review across browser tabs on this computer. Drafts are stored separately from saved PGNs; competing saves report a conflict instead of silently replacing newer content when the client supplies the expected revision.
- Change the interface language in Settings. Display layout preferences remain local to each device.
- **Settings → Appearance** offers 8 interface themes (including Pearl and Linen light themes and High contrast), 8 piece sets and 12 board palettes, with visual previews. Choices are saved automatically in ChessGym and restored when reopening the application. Pieces are bundled locally; see [piece-set notices](PIECE-SETS-NOTICES.md) for credits and licences.
- Choose a device-specific start page and whether to ask, automatically resume, or leave saved work available for later.
- Set a shared study time zone and day-start hour. Activity, streaks and maintenance reminders follow that study day.
- Set optional session goals in minutes/cards, and choose PGN or shuffled ordering for new exercises in each database. Opening probability priorities are retained.
- Apply the global initial review intervals to selected existing databases after previewing changes; already scheduled dates and history are preserved.
- Review sessions load cards in small batches while retaining a durable order and progress. Single-base unlimited settings remain available.
- **Reviews → Databases to review** opens the study bases directly. Use Review or Learn for one base, or Review all / Learn all for every enabled study base. The Daily session tab and manual session preparation have been removed; configure card/time goals in the training plan. Each base retains its answer, grading mode and scheduling settings, and saved answers are skipped when resuming.
- **Settings → Reviews → Maintenance** keeps mastered cards mastered while scheduling occasional reminders separately. Defaults: enabled, 30 days after mastery, at most 5 reminders per study day. Previously mastered cards are staggered from the next study day. Failed reminders return to learning; disabling maintenance preserves schedules and history.
- New review attempts retain source and configuration context; new game reports identify analysis provenance. Historical records remain unchanged, and unavailable historical provenance stays unknown.

Server performance settings offer Economy, Balanced and Custom CPU/memory budgets. The budget is shared by the two Stockfish lanes and reference imports. A pending change waits for ongoing searches/imports to finish. Explicit launcher import settings are retained when no saved profile exists; a fresh generic installation uses a modest automatic budget.

## Backups

The default **personal backup** contains the personal SQLite database, study PGNs, settings, drafts, computer-game history and clocks, and learning/reading progress. It deliberately **omits the large reference database files**, and its manifest identifies the omitted references. Keep those reference sources or stores separately if they are needed for recovery.

A **full backup** remains available and also snapshots the reference stores; it can be much larger and slower. Both archive types contain private data. See the French guide for the existing restore procedure. Do not publish `data/`, backups, logs, downloaded archives, or local credentials with the application source.

Settings also provide automatic **personal** backups, a server-side destination folder, frequency and retention (suggested values: every 24 hours, 7 copies). Automatic backups are initially disabled on a fresh installation. Rotation removes only application-generated automatic archives after the newest copy has passed verification; manual copies and unrelated files are retained. Copying to another disk/server remains useful against a disk failure.

To restore personal data on Windows, stop ChessGym and run **Restaurer ChessGym.cmd**, select the archive, review it and confirm. On Linux, first verify with `.venv/bin/python scripts/restore_backup.py /path/to/backup.zip`; after stopping ChessGym, repeat with `--confirm`. The tool verifies SQLite integrity, keeps a rollback copy, invalidates legacy login sessions and separates pre-restore local drafts from restored work. The application lock prevents restoration while the new server is running. The personal database extraction is limited to 1 GiB. Existing reference files are preserved; transferring references from a full archive is a separate offline operation using the manifest. Restart ChessGym and open it directly after restoration.

## Development

```sh
# Use the corresponding virtual-environment Python path on Windows.
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python scripts/test_learning_changes.py --full
```

`requirements.txt` and `requirements-dev.txt` pin the supported direct dependencies. They use `requirements.lock.txt` as constraints for the validated transitive versions; a constraint does not install a development or optional package unless that package is requested. The setup helper consumes these inputs and never regenerates them. The test runner creates isolated data and temporary directories; no personal database or downloaded commercial collection is needed. Install Node.js 24 for frontend tests and make it available on `PATH`.

The [GitHub Actions workflow](.github/workflows/ci.yml) runs the full suite on Windows Server 2022 with Python 3.12, Node.js 24 and Stockfish. A separate Linux job runs a bounded startup/API smoke suite. Its scope does not establish Linux browser or engine compatibility end to end; check the workflow results for the commit being tested.

