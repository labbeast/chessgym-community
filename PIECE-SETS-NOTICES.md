# Jeux de pièces supplémentaires

Les SVG sont distribués sans modification, à partir du dépôt officiel Lichess.

| Dossier | Dessinateur | Licence |
| --- | --- | --- |
| `static/pieces/merida` | Armando Hernandez Marroquin | GNU GPL version 2 ou ultérieure ; cette copie utilise l’option version 3. |
| `static/pieces/chessnut` | Alexis Luengas | Apache License 2.0. |
| `static/pieces/celtic` | Maurizio Monge | MIT. |
| `static/pieces/fantasy` | Maurizio Monge | MIT. |
| `static/pieces/shapes` | flugsio | Creative Commons Attribution – Partage dans les mêmes conditions 4.0 International (CC BY-SA 4.0). |
| `static/pieces/pirouetti` | pirouetti | GNU AGPL version 3 ou ultérieure. |
| `static/pieces/spatial` | Maurizio Monge | MIT. |

Les attributions sont documentées par [Lichess](https://github.com/lichess-org/lila/blob/master/COPYING.md). Une copie de ce document est conservée dans `licenses/Lichess-COPYING.md`.

Le texte GPL version 3 est déjà fourni dans `licenses/GPL-3.0.txt`. Le texte de la licence Chessnut, provenant du [dépôt du dessinateur](https://github.com/LexLuengas/chessnut-pieces/blob/master/LICENSE.txt), est conservé dans `licenses/Chessnut-Apache-2.0.txt`.

Les cinq jeux ajoutés le 26 octobre 2026 proviennent de la révision Lichess
[`9b7a53ab3e3e113d67a2b7a3a8a96555281b6e19`](https://github.com/lichess-org/lila/tree/9b7a53ab3e3e113d67a2b7a3a8a96555281b6e19/public/piece).
Chaque jeu contient les six pièces blanches et les six pièces noires. Ces SVG
sont les sources originales distribuées par Lichess, sans modification par
ChessGym. Les attributions de cette révision sont conservées dans
`licenses/Lichess-COPYING-9b7a53a.md` ; la copie antérieure est conservée intacte.

- **Celtic, Fantasy et Spatial** : [œuvres de Maurizio Monge](https://github.com/maurimo/chess-art).
  Le texte MIT avec la mention de copyright de l’auteur est conservé dans
  `licenses/Maurizio-Monge-MIT.txt`, depuis la
  [révision `d8705d8bc9879fef44208de19e2a20c937409e1f`](https://github.com/maurimo/chess-art/blob/d8705d8bc9879fef44208de19e2a20c937409e1f/LICENSE).
- **Shapes** : [œuvre de flugsio](https://github.com/flugsio/chess_shapes), sous
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  Le texte intégral est conservé dans `licenses/CC-BY-SA-4.0.txt`.
- **Pirouetti** : œuvre de [pirouetti](https://lichess.org/@/pirouetti), sous
  AGPL version 3 ou ultérieure, selon la notice Lichess. Le texte intégral est
  conservé dans `licenses/AGPL-3.0.txt`, provenant de la même révision Lichess.

Les sources exactes de chaque fichier et leurs empreintes SHA-256 figurent dans
`licenses/piece-sets-sources.json`. Les enregistrements des ressources antérieures
restent inchangés. Le script `scripts/download_piece_sets.py` récupère uniquement
les ressources manquantes, conserve les fichiers déjà vérifiés et refuse de
remplacer un fichier dont l’empreinte diffère. L’option `--verify-only` vérifie
hors ligne les 84 SVG, leur contenu et les licences enregistrées. Les schémas de
couleurs sont dessinés directement par ChessGym, sans texture d’échiquier externe.
