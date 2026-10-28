# Composants tiers de ChessGym

## Licence du code ChessGym

Sauf mention contraire dans un fichier ou une notice tierce, le code source propre à ChessGym est distribué sous GNU Affero General Public License, version 3 ou, au choix du destinataire, toute version ultérieure (`AGPL-3.0-or-later`). Le texte intégral figure dans [LICENSE](LICENSE). Cette licence du code ne remplace pas les licences des composants, ressources, modèles et jeux de données tiers décrits ci-dessous. La provenance du logo ChessGym et de ses variantes d’icônes est décrite dans la section Identité ChessGym.

## Pièces et échiquier

Les douze pièces SVG Cburnett sont de Colin M. L. Burnett, sous GPL version 2 ou ultérieure. Elles proviennent du dépôt officiel Lichess, sans modification des fichiers :
https://github.com/lichess-org/lila/tree/master/public/piece/cburnett

Attribution et licence upstream :
https://github.com/lichess-org/lila/blob/master/COPYING.md

Cette copie utilise l’option GPL version 3 ; le texte est fourni dans licenses/GPL-3.0.txt. Le dessin de l’échiquier est une implémentation ChessGym utilisant les couleurs classiques brun et beige. ChessGym n’est pas affilié à Lichess.

## Stockfish

Le script facultatif de préparation Windows installe Stockfish 18 dans engines/stockfish, sous GNU GPL version 3. Le dossier engines/ est exclu du partage du code source de ChessGym. Lorsqu’il est installé, les crédits, la licence et le code source fournis par la distribution officielle sont conservés dans ce dossier; les réseaux neuronaux requis sont intégrés au binaire officiel.

https://github.com/official-stockfish/Stockfish/releases/tag/sf_18

Archive Windows x86-64 générique : stockfish-windows-x86-64.zip
SHA-256 : 40cc975817e7eee270b03f354810d20956df565420d320f6dd37d454dc81a139

Le moteur fonctionne comme programme UCI séparé. Les distributions pour d’autres systèmes doivent utiliser un binaire adapté et conserver leurs licences et sources correspondantes.

Le gestionnaire **Réglages → Moteurs** utilise les publications officielles pour installer d’autres versions Stockfish dans `engines/managed/`. Il conserve le contenu de la distribution, les informations de provenance et le SHA-256 dans chaque installation. Les téléchargements restent distincts du code source de ChessGym et ne changent pas les obligations de redistribution du moteur. Les versions Maia installées par ce gestionnaire conservent également leurs sources, modèles et notices dans leur installation locale.

## Maia 3

L’installateur facultatif `scripts/install_maia.py` télécharge le code officiel CSSLab/Maia 3, des modèles officiels UofTCSSLab et un environnement Python/PyTorch CPU séparé. Les fichiers sont conservés dans `engines/maia3/`, exclu du partage du code ChessGym. Le manifeste conserve les révisions, les URL, les SHA-256 et les références des licences; le code source utilisé et sa licence restent disponibles dans ce dossier.

- Code Maia 3 : https://github.com/CSSLab/maia3/tree/1e13597c42d4858b7cfd7cfdae01e297263364b2 — AGPL version 3.
- Modèle 5M : https://huggingface.co/UofTCSSLab/Maia3-5M
- Modèle 79M : https://huggingface.co/UofTCSSLab/Maia3-79M — AGPL version 3, selon sa fiche officielle.
- PyTorch : https://github.com/pytorch/pytorch — licences et notices dans son paquet installé.

Les fiches officielles des modèles sont conservées avec les téléchargements. La fiche du modèle 5M renvoie au dépôt pour la licence des poids; sa mention CC BY 4.0 concerne l’article scientifique. ChessGym n’attribue pas de licence supplémentaire aux poids et ne les inclut pas dans un export de son code. Le moteur officiel fonctionne dans un processus UCI séparé, sans modification de son code.

Les anciennes installations peuvent encore contenir `engines/maia/` : Maia-1 (GPL version 3) et lc0 v0.32.1 (GPL version 3), leurs licences, notices oneDNN/mimalloc et sources restent conservées, mais ces fichiers ne sont plus utilisés par ChessGym. Sources : https://github.com/CSSLab/maia-chess et https://github.com/LeelaChessZero/lc0/tree/v0.32.1. ChessGym n’est pas affilié à Maia, CSSLab ni lc0.

## Bibliothèques Python

Les versions installées sont consignées dans requirements.lock.txt. Les métadonnées et licences des paquets installés sont conservées dans le répertoire site-packages de l’environnement virtuel.

- python-chess / chess : GPL version 3 ou ultérieure — https://github.com/niklasf/python-chess
- FastAPI : MIT — https://github.com/fastapi/fastapi
- Uvicorn : BSD à trois clauses — https://github.com/encode/uvicorn
- Les dépendances transitives et outils de test conservent leurs licences propres.

## Banque de puzzles Lichess et sons

La banque facultative de puzzles est publiée par Lichess sous CC0 : https://database.lichess.org/#puzzles. Elle est téléchargée séparément et ne fait pas partie du code distribué. Chaque puzzle conserve son identifiant, ses thèmes, sa cote et le lien vers la partie source. La cote personnelle ChessGym est indépendante de celle du compte Lichess.

Les cinq sons distribués dans `static/sounds/kenney/` proviennent des packs [Impact Sounds](https://kenney.nl/assets/impact-sounds) et [Interface Sounds](https://kenney.nl/assets/interface-sounds) de Kenney, sous [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Ils ont été convertis en WAV mono avec un volume adapté. Les licences originales sont conservées dans `licenses/Kenney-Impact-Sounds.txt` et `licenses/Kenney-Interface-Sounds.txt`; les sources exactes, transformations et empreintes figurent dans [la notice des sons](static/sounds/kenney/README.md) et son manifeste. Les sons distribués avec ce dépôt sont les fichiers Kenney décrits ci-dessus. Aucun ancien MP3 standard de Lichess n’est inclus dans les sources ni dans l’historique de ce dépôt.

## Bases de référence Lumbra et extraction 7-Zip

Les cartes **Lumbra OTB Elite — maîtres 2400+** et **Lumbra Gigabase OTB — complète** renvoient vers les [téléchargements officiels de Lumbra’s Gigabase](https://lumbrasgigabase.com/en/download-area-en/), par **Michael Jansen**. Les données OTB proposées sont sous [Creative Commons Attribution — Pas d’utilisation commerciale 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/). Leur usage demande de conserver l’attribution et de respecter la restriction non commerciale; une utilisation commerciale relève d’une licence distincte du fournisseur. Cette licence des données est indépendante de l’AGPL du code ChessGym.

Aucune base ni archive Lumbra n’est distribuée avec l’application. L’utilisateur télécharge les fichiers depuis le site officiel et y accepte la licence, puis importe son fichier dans ChessGym. L’application conserve les archives et PGN sources, ainsi que la provenance de l’import. Les éditions Lumbra ne sont pas téléchargées par les mises à jour automatiques.

Pour les archives `.7z`, ChessGym utilise le programme [7-Zip](https://www.7-zip.org/) installé séparément sur le serveur. Aucun exécutable 7-Zip n’est fourni par ChessGym. Le programme et ses composants conservent leurs [licences propres](https://www.7-zip.org/license.txt). L’import d’un PGN déjà extrait ne requiert pas 7-Zip.

## Identité ChessGym

Le responsable du projet a confirmé le 27 octobre 2026 que le logo a été généré avec ChatGPT à partir de son prompt « fait moi un logo pour chess gym moderne », puis fourni pour ChessGym. Les variantes d’icônes sont dérivées de cette image. Le logo et ces variantes sont inclus dans la distribution sous AGPL-3.0-or-later dans la mesure où des droits applicables existent. Cette mention documente la provenance déclarée; elle ne revendique pas un droit exclusif sur une image générée ni une marque enregistrée. Aucun emprunt à Lichess ou Stockfish n’est déclaré pour cette identité.

## Autres jeux de pièces

Les attributions et licences de Merida et Chessnut sont détaillées dans [PIECE-SETS-NOTICES.md](PIECE-SETS-NOTICES.md). Les textes de licence sont conservés dans licenses/.

## Bundled starter examples

The three study examples in `examples/starter.json` contain original ChessGym educational lines and French/English comments, written with AI assistance. They are not attributed historical games and contain no copied book annotations or commercial collection. To the extent applicable rights exist, the example contents are dedicated under CC0 1.0 Universal. This is a specific exception to the source-code license. See [provenance](examples/README.md) and the [complete CC0 legal text](licenses/CC0-1.0.txt). The installation code retains the application license.
