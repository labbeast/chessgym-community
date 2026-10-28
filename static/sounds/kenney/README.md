# ChessGym sounds — Kenney CC0

Five short local samples replace the former Lichess standard sounds. Move and capture use wood impacts; feedback uses brief interface tones. No Lichess audio was used to create these files.

Sources retrieved on 2026-10-27:

- [Impact Sounds 1.0](https://kenney.nl/assets/impact-sounds), by Kenney. Original license: [Kenney-Impact-Sounds.txt](../../../licenses/Kenney-Impact-Sounds.txt).
- [Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds), by Kenney. Original license: [Kenney-Interface-Sounds.txt](../../../licenses/Kenney-Interface-Sounds.txt).

Both packs are dedicated under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). Kenney explicitly permits personal, educational and commercial use; attribution is optional and retained here for provenance. ChessGym is not affiliated with or endorsed by Kenney. These sounds retain CC0 independently of ChessGym's AGPL source-code license.

| Event | Bundled file | Original archive entry | Gain |
| --- | --- | --- | ---: |
| Move / castling | move.wav | Audio/impactWood_light_000.ogg | 0.8 |
| capture | capture.wav | Audio/impactWood_medium_000.ogg | 0.8 |
| correct | correct.wav | Audio/confirmation_001.ogg | 0.35 |
| incorrect | incorrect.wav | Audio/error_004.ogg | 0.65 |
| complete | complete.wav | Audio/confirmation_002.ogg | 0.65 |

Conversion: Ogg Vorbis decoded at 44,100 Hz, channels averaged to mono, fixed gain as listed above, then rounded to signed 16-bit PCM WAV. WAV keeps playback compatible with browsers without Ogg support. Global user volume and event preferences continue to apply. No looping, network streaming or external audio request is used during play.

[sources.json](sources.json) records the official archive URLs and SHA-256 hashes, each original sample hash, conversion settings, duration and bundled WAV hash.

The previous Lichess MP3 files were removed from the working tree and from all branch/tag history on 2026-10-27. A fresh GitHub clone was verified to contain none of those blobs. GitHub still serves the original commit by its exact SHA in the private repository: request GitHub-side removal or publish the sanitized history in a new repository before making that retained object public. The private recovery bundle is stored outside this repository.
