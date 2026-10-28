# Plan d’intégration du module Mon entraînement dans ChessGym

Cadrage du 25 octobre 2026, actualisé le 27 octobre avec les catégories toujours présentes, les objectifs quotidiens et hebdomadaires indépendants, le cumul automatique et les statistiques du temps.

État de réalisation : les lots 1 à 8 sont intégrés. Le guide d’utilisation se trouve dans `LIRE-MOI.md`, et les points d’implémentation dans `IMPLEMENTATION.md`.

Le module permettra à l’usager de composer son programme, de fixer des objectifs hebdomadaires et de choisir quoi travailler selon le temps disponible. Les modèles serviront de point de départ modifiable. Le programme utilisera les outils de ChessGym pour exécuter les activités et leurs mesures existantes pour suivre le travail réalisé.

La version intégrée réunit le composeur, les modèles, la vue Jour et semaine, les propositions de séance et les statistiques. Les dix catégories existent sans programme et cumulent les mesures acceptées des révisions, de la lecture, des puzzles classiques et Storm, de Deviner le coup, de l’ordinateur, de l’analyse, d’Aveugle, de Coordonnées et de Color. Le travail externe reste déclaré par l’usager.

## 1 Principes du produit

- L’usager décide du contenu, des objectifs et des priorités de son programme.
- Le programme se répète par semaine, sans imposer de jours ni d’heures de rendez-vous.
- Le temps disponible sert à proposer une séance adaptée. L’usager peut modifier cette proposition ou lancer directement un bloc.
- Les objectifs mesurent le travail réalisé. La réussite aux exercices, la maîtrise et les résultats échiquéens restent des indicateurs distincts.
- Le travail commencé dans un outil existant alimente sa catégorie, avec ou sans programme et avec ou sans objectif.
- Un travail effectué ne contribue qu’une seule fois au cumul global. Les liens de compatibilité avec les blocs ne conditionnent pas sa présence dans une catégorie.
- Les objectifs de temps du jour et de la semaine sont indépendants. Zéro signifie « sans objectif », sans bloquer le lancement ni interrompre le cumul.
- Une semaine incomplète ne crée pas automatiquement de dette pour la suivante.

Un seul programme est actif à la fois. Plusieurs brouillons et modèles personnels peuvent être conservés. L’activation initiale peut commencer immédiatement; un changement de programme est proposé pour la semaine suivante, avec possibilité explicite de commencer tout de suite.

## 2 Place dans ChessGym et parcours des écrans

Ajouter **Mon entraînement** dans le menu Entraînement et conserver l’accès direct aux outils existants. Cette entrée regroupe trois onglets dans cet ordre : Jour et semaine, Programme, Statistiques. La page Bilan séparée est retirée; son ancienne adresse ouvre Statistiques.

| Écran | Ce que l’usager y fait | Informations principales |
| --- | --- | --- |
| Jour et semaine | Voir le travail et les objectifs du jour et de la semaine, puis continuer pour la période choisie | Dix lignes compactes avec les icônes et l’ordre des menus, un objectif de temps distinct par période; réglages et blocs réunis dans Programme |
| Programme | Composer, modifier, enregistrer et activer son programme | Blocs, ressources, objectifs, priorités, budget et modèles |
| Statistiques | Explorer le temps consacré par activité et dans le temps | Barres empilées par jour, semaine ou mois; répartition, calendrier, rythme hebdomadaire, indicateurs et comparaison avec la période précédente |

### Premier passage

Présenter les dix catégories dès le premier passage, sans demander de créer un programme. Les objectifs absents valent zéro et affichent **Sans objectif**. Dans Programme, proposer **Créer mon programme** et **Partir d’un modèle**. Un programme vide reste un choix normal. Un modèle ouvre son aperçu avant toute insertion; l’usager choisit les blocs à ajouter et associe ses propres ressources aux emplacements proposés.

Après enregistrement, afficher le résumé du programme et l’action **Activer mon programme**. Le passage à la semaine présente les objectifs sans exiger de construire un calendrier.

### Retour quotidien

L’écran **Jour et semaine** présente les dix catégories une seule fois, avec deux colonnes de même structure : temps effectué / objectif, barre de progression et mesures enregistrées. L’objectif quotidien et l’objectif hebdomadaire se modifient séparément : 5 minutes aujourd’hui et 20 minutes cette semaine doivent produire deux restants différents. Une période sans objectif affiche le temps effectué et **Sans objectif**, sans ratio ni état « terminé ». Les lignes reprennent les icônes et l’ordre des menus : Révisions, les six activités d’Exercices dans l’ordre du catalogue, Lecture, Analyse et Activité personnelle. Aucun panneau **Objectifs et détails** ne se répète dans la liste. Un sélecteur commun dans **Programme** donne accès aux objectifs, aux blocs planifiés avec leurs lancements et reprises, aux ressources et au travail déclaré de l’activité choisie. Les sections **Autres séances en cours**, **Travail par jour** et **Préparer une séance** sont retirées. Seule l’action quotidienne ayant un objectif restant porte la couleur d’accent; les autres actions sont grises.

Les puzzles à l’aveugle utilisent la banque de puzzles par défaut (Lichess), sans sélecteur de base personnelle dans cette vue. Les anciennes routes Aujourd’hui et Ma semaine ouvrent cette vue commune.

**Travail à attribuer** et toutes les commandes d’attribution sont retirés de la vue, du journal et des aides. Le cumul par catégorie inclut les crédits natifs et déclarés indépendamment d’un lien à un programme ou un bloc. Les identités, les dates, les mesures et les protections contre les doublons restent conservées.

**Statistiques** utilise la même projection des mesures. Les périodes de 7, 30, 90 et 365 jours, ou une plage personnalisée de 730 jours maximum, sont inclusives. Le regroupement en semaines commence le lundi; les mois respectent les frontières du calendrier. Tous les graphiques et indicateurs partagent le filtre d’activités. Les moyennes incluent les jours sans activité; la comparaison porte sur la période précédente de même longueur. Un temps inconnu est signalé à part et n’est pas inventé. Un tableau accessible complète les graphiques.

Au retour d’un outil, afficher la contribution réellement enregistrée et les prochaines actions : poursuivre le même bloc, choisir un autre bloc ou terminer. Un bandeau de contexte propose **Pause**, **Terminer ce bloc** et **Retour au programme**. Un changement d’écran ne termine pas automatiquement la séance. En lecture, l’action **Confirmer cette partie étudiée** permet de valider l’unité correspondante sans ajouter une seconde durée déclarée.

Si une révision ou une partie native est déjà ouverte, proposer sa reprise ou différer le nouveau lancement. Le programme ne remplace jamais silencieusement son contexte.

## 3 Composeur de programme fondé sur la maquette

Conserver l’organisation de la maquette : les blocs au centre, le budget et les modèles dans une colonne latérale. Sur mobile, ces éléments passent dans un ordre vertical lisible. Le style reprend les couleurs, composants et réglages d’apparence de ChessGym.

### Informations du programme

- Nom libre, par exemple « Ma routine de progression ».
- Budget hebdomadaire facultatif, par exemple 4 heures. Sans budget, afficher la charge prévue sans calculer de marge.
- Courte intention facultative, par exemple « Mieux calculer et reprendre mes erreurs ».
- Liste ordonnée des blocs et état brouillon, actif ou archivé.

### Informations d’un bloc

| Champ | Règle |
| --- | --- |
| Nom | Texte personnel, avec proposition issue de l’activité et de la ressource |
| Axe de travail | Calcul, ouvertures, finales, stratégie, parties et analyse, ou personnalisé |
| Activité | Réviser, lire, résoudre des puzzles, deviner le coup, jouer, analyser ou activité personnelle |
| Ressource | Base, livre, répertoire, sélection d’exercices ou ressource externe compatible avec l’activité |
| Objectif principal | Une seule métrique : minutes, séances ou quantité d’une unité définie |
| Quantité hebdomadaire | Valeur positive, validée selon l’unité |
| Durée habituelle d’une séance | Sert à composer une proposition de travail et à estimer les objectifs en séances |
| Durée estimée par unité | Champ distinct, utilisé uniquement pour un objectif en quantité |
| Priorité | Essentiel, normal ou facultatif |
| Consigne personnelle | Facultative, par exemple « Chercher sans déplacer les pièces » |

L’activité est choisie avant la ressource. Une base peut servir à la lecture, aux révisions ou à la reconstruction de parties, selon les fonctions qu’elle autorise. Le sélecteur doit proposer seulement les associations compatibles.

Chaque bloc possède une identité stable indépendante de son nom, de sa position et du nom de sa ressource. Deux blocs peuvent utiliser la même base pour des activités différentes. Une association apparemment identique déclenche un avertissement utile, sans interdiction générale.

Les actions visibles sont **Ajouter un bloc**, **Dupliquer**, **Monter**, **Descendre**, **Retirer**, **Enregistrer** et **Conserver comme modèle**. Le déplacement doit fonctionner au clavier et au toucher, même sans glisser-déposer. Une suppression de bloc dans le brouillon offre une annulation immédiate.

### Ajustements nécessaires par rapport à la maquette

Séparer le choix de l’activité de celui de la ressource. Séparer aussi la durée d’une séance de la durée estimée par unité : étudier deux parties de vingt minutes ne signifie pas obligatoirement faire deux séances de vingt minutes.

Remplacer les ressources d’exemple par le catalogue réel. Une ressource devenue indisponible reste visible avec **Choisir une autre ressource**; elle ne bloque pas l’enregistrement du reste du programme. L’activation exige au moins un bloc utilisable. Une fonction de lecture ou de révision désactivée n’est jamais réactivée silencieusement.

Conserver la saisie, le focus et la position dans la page lors des mises à jour de calcul. Une erreur d’enregistrement laisse le brouillon intact.

## 4 Modèles et estimation de la charge

### Modèles proposés au départ

| Modèle | Composition indicative | Personnalisation demandée |
| --- | --- | --- |
| Équilibré | Calcul, répertoire, lecture et analyse d’une partie | Choisir ses ressources et adapter les objectifs |
| Focus calcul | Exercices de calcul, révision des erreurs et finales | Choisir une base ou une sélection d’exercices |
| Jouer et progresser | Parties, analyse personnelle et travail des erreurs | Choisir le lieu de jeu et une base de travail |

Ces modèles organisent le travail; ils ne constituent pas une prescription de progression selon le classement. Éviter d’imposer un Elo ou des ressources précises pour les utiliser.

Les modèles intégrés sont versionnés dans l’application. Les modèles personnels sont enregistrés dans le compte. Appliquer un modèle en crée une copie indépendante : une modification ultérieure du modèle ne modifie jamais un programme existant.

L’ajout à un programme existant présente les blocs sélectionnés et la nouvelle charge. Le remplacement complet, s’il est proposé, est une action distincte avec un aperçu de son effet. Les blocs d’un modèle possèdent leurs propres identités, y compris lorsque plusieurs utilisent la même ressource.

### Calcul de la charge prévue

- Objectif en minutes : charge = minutes visées.
- Objectif en séances : charge = nombre de séances × durée habituelle d’une séance.
- Objectif en quantité : charge = quantité × durée estimée par unité.

Exemple issu de la maquette : 60 minutes de calcul, 3 séances de répertoire de 15 minutes et 2 parties étudiées estimées à 20 minutes donnent **145 minutes prévues**, soit **2 h 25**. Avec un budget de 4 heures, la marge est de **1 h 35**.

La colonne latérale présente la charge totale, le budget, la marge ou le dépassement, et la répartition par axe. Un dépassement signale un choix ambitieux mais n’empêche pas l’enregistrement. Une estimation manquante apparaît comme telle; elle ne vaut pas zéro.

Le volume de révisions arrivant à échéance est un indicateur de disponibilité. Il ne s’ajoute pas une seconde fois à la charge du bloc de révision. Les estimations saisies peuvent maintenant être ajustées à partir de durées réellement mesurées. Des ajustements d’objectif peuvent également être proposés à partir du volume des semaines précédentes. Chaque proposition indique ses observations et le champ à modifier; son application explicite ne réécrit pas les résultats passés.

## 5 Objectifs hebdomadaires et suggestions de séance

### Règles de semaine

Utiliser le fuseau et l’heure de début de journée d’étude déjà configurés dans ChessGym. La semaine commence le lundi de cette journée d’étude. Ainsi, avec un début à 4 h, une activité enregistrée le lundi à 2 h appartient encore au dimanche d’étude. Reprendre les fonctions existantes qui gèrent aussi les changements d’heure.

À l’ouverture d’une nouvelle semaine, une opération explicite et idempotente crée son état à partir du programme actif. Il n’est pas nécessaire d’installer une tâche planifiée. Les objectifs repartent de zéro; les résultats des semaines précédentes sont conservés. Le premier démarrage en milieu de semaine ne réduit pas silencieusement les objectifs : l’usager peut alléger cette première semaine.

Chaque semaine conserve la version du programme et des règles de date utilisées. Modifier le programme propose **À partir de la semaine prochaine**, par défaut, ou **Appliquer aussi à cette semaine** avec aperçu. Les objectifs des semaines passées ne sont pas réécrits. Les corrections de travail enregistré restent possibles et identifiables.

Changer de ressource ou d’activité après du travail crée une nouvelle version du bloc. Retirer un bloc conserve ses résultats. Les activités encore en cours restent liées à leur contexte d’origine; si le bloc n’existe plus dans la semaine suivante, leur nouveau travail apparaît dans une rubrique historique, sans réaffectation automatique.

### Progression par bloc

Afficher simultanément l’objectif principal, le réalisé, le restant et la durée enregistrée. Une barre est plafonnée visuellement à 100 %, mais le texte peut afficher « 75 / 60 min ». Ne pas calculer une moyenne trompeuse entre des minutes, des séances et des positions; le résumé peut afficher le nombre de blocs dont l’objectif est atteint.

Une séance désigne un épisode de travail explicitement terminé après une activité effective. La pause, le rechargement ou le passage à une autre semaine conservent son identité. Les minutes et les unités déjà enregistrées restent acquises; la séance compte une fois dans la semaine de sa fin. Une fin volontaire anticipée peut compter comme une séance, avec sa durée réelle visible.

Une quantité mesure une unité que l’outil sait établir. Une carte de révision n’est pas automatiquement une variante entière, un exercice réussi ou une notion maîtrisée. Dans une même exécution, les répétitions immédiates d’une carte ne gonflent pas le nombre de cartes travaillées. Une nouvelle séance peut constituer un nouveau travail de cette carte; le libellé doit distinguer ce compte d’un nombre de cartes distinctes.

Pour la lecture, les minutes peuvent être mesurées automatiquement. Une quantité comme « parties étudiées » demande en V1 une confirmation explicite par entrée : un signet déplacé à la fin n’atteste pas à lui seul qu’une partie a été étudiée.

### Proposition selon le temps disponible

Un calcul déterministe suffit en V1. Il sélectionne de un à trois blocs parmi ceux qui restent à travailler, en considérant la priorité, les objectifs restants, la disponibilité des ressources et les durées habituelles. Une activité indivisible trop longue n’est pas découpée artificiellement. La proposition peut laisser une marge.

Chaque suggestion explique son choix, par exemple « Répertoire · 15 min · bloc essentiel encore à travailler ». L’usager peut remplacer un bloc, modifier une durée, ignorer la proposition ou lancer un bloc de son choix. Une séance de révision sans carte disponible propose d’ajuster les options ou de choisir une autre activité.

La proposition lance les blocs successivement et laisse les outils natifs gérer leur déroulement. Elle ne promet pas de répartir exactement des minutes entre plusieurs bases à l’intérieur d’une séance native multibase : le moteur actuel ne garantit pas cette allocation.

## 6 Cumul du travail et sens des durées

### Travail lancé depuis le programme

Créer une exécution de bloc, puis attacher son identifiant au contexte natif lors du lancement. L’attribution survit à une pause, une reprise, un rechargement et un changement d’appareil après synchronisation.

Les résultats proviennent des écritures persistées par l’outil. Un clic sur **Lancer**, l’ouverture d’un échiquier ou un message de succès dans l’interface ne constitue pas du travail réalisé.

### Travail libre et activités externes

Toute activité mesurée compte automatiquement dans sa catégorie, même si aucun bloc ne correspond, si plusieurs blocs conviennent ou si aucun programme n’est actif. Les réglages historiques d’attribution n’excluent pas le travail du cumul global. Les liens compatibles avec les blocs restent utiles à leurs objectifs détaillés, sans créer une file d’attente à traiter. Le premier incrément natif prépare aussi la semaine courante et applique une activation différée arrivée à échéance, sans exiger d’ouvrir le planning.

Les mêmes contributions datées alimentent les compteurs du jour, de la semaine et les sept journées du bilan. Les essais persistés sont distincts des unités d’objectif : répéter une carte peut ajouter un essai sans ajouter une nouvelle carte travaillée, et répondre dans Deviner le coup ajoute un essai avant de terminer la partie. Les échecs comptent. Les minutes et essais sont acquis avant de terminer un épisode; seule cette fin explicite ajoute une séance.

Les liens historiques agissent sur les contributions existantes sans les recopier, sans changer leur date et sans les compter deux fois. Une séance multibase conserve ses réponses et ressources; le même parent ne peut pas ajouter une seconde durée à celle de ses réponses. Un cumul de catégorie ne doit jamais additionner les totaux de ses blocs si ceux-ci couvrent le même travail.

Rattacher du travail libre transfère ses minutes et unités compatibles, mais ne crée pas automatiquement une séance terminée. Pour un objectif en séances, l’action **Terminer cet épisode** conserve une identité d’épisode et regroupe les sources compatibles affectées à un même bloc. Elle produit un seul événement de fin, sans ajouter leur durée une seconde fois. Un épisode réparti entre plusieurs blocs ne donne pas une séance à chacun. Une visite de lecture terminée ou un changement d’écran ne suffit pas. La confirmation d’une partie étudiée utilise aussi une clé unique par épisode et entrée, avec une quantité seule.

Pour une partie de club, un livre papier ou un cours, proposer une saisie courte : activité, date, durée, quantité pertinente et note facultative. Ces valeurs sont indiquées comme **déclarées** et peuvent être corrigées. Éviter toute addition automatique entre une saisie déclarée et une activité native déjà liée. L’analyse sur l’échiquier dispose d’un suivi actif propre : page visible et focalisée, arrêt après 90 secondes sans interaction, pause et reprise, reçu stable en cas de répétition réseau. Lecture et analyse sont mutuellement exclusives pour un même intervalle.

L’ancien historique n’est pas rétroactivement transformé en séances ou ventilé entre des jours inconnus. Une attribution historique explicite, ajoutée ultérieurement, pourra utiliser une occurrence entière avec sa date et sa convention visibles.

### Mesures et passages entre semaines

Conserver la distinction entre temps actif, temps écoulé, temps déclaré et durée inconnue. Le total général porte le libellé **Durées renseignées**, avec le détail des bases de mesure. Une durée inconnue s’affiche par un tiret et ne devient pas zéro.

La V1 comptabilise les nouvelles réponses et les incréments de lecture à leur **date d’enregistrement par l’outil**. Les révisions produisent un crédit par réponse; la lecture, un crédit par incrément de temps accepté. Une reprise le lundi produit donc de nouveaux crédits sans déplacer tout le travail du dimanche.

Cette convention ne prétend pas découper exactement le temps actif à minuit. Un incrément de lecture reçu après la frontière appartient au nouveau jour d’étude. Une requête reçue tardivement peut aussi décaler la date de comptabilisation; un reçu déjà accepté conserve sa date lors des nouvelles tentatives. Le détail affiche la date utilisée. Une future mesure horodatée au moment du travail pourra affiner ce comportement, sans ajouter de chronomètre.

Pour les outils ne fournissant qu’un résultat final fiable, le raccordement initial utilisera une contribution par occurrence. Les outils à compteur cumulatif doivent conserver le maximum déjà crédité : une baisse puis une remontée du compteur ne doit pas recompter du temps.

## 7 Raccordement aux fonctions existantes

| Fonction existante | Intégration | Portée réalisée |
| --- | --- | --- |
| Révisions et Séance du jour | Réutiliser la préparation, la création, la reprise et la notation des séances; transmettre le contexte du bloc | Automatique en V1, lancement d’un bloc à la fois |
| Lecture | Ouvrir la bonne base et son point de reprise; utiliser les incréments déjà acceptés par le suivi de lecture | Minutes automatiques; quantité étudiée confirmée par l’usager |
| Puzzles | Lancement paramétré et contexte de programme; filtres et mode conservés | Automatique; tentatives classiques et séance parent Storm sans double compte |
| Deviner le coup | Sélection de partie, côté joué et reprise natifs | Automatique, avec temps et réponses réellement enregistrés |
| Jeu contre l’ordinateur | Historique durable, reprise et compteur d’activité | Automatique; partie ouverte préservée, recul de compteur sans double crédit |
| Aveugle, coordonnées et Color | Fins et interruptions natives selon les données réellement disponibles | Automatique; options du bloc, reprise et mesures natives conservées |
| Analyse personnelle | Mesurer les nouveaux intervalles actifs sur l’échiquier | Automatique lorsque visible et focalisé, arrêt après 90 secondes sans interaction; la fin d’un calcul moteur ne vaut pas séance terminée |
| Activité externe | Saisie courte liée à une catégorie ou à un bloc | Déclaration modifiable et supprimable |

L’analyse personnelle s’ouvre sur l’échiquier avec suivi actif. Les activités externes utilisent **Déclarer un travail**. Les autres outils prennent en charge le lancement paramétré, la reprise avec contexte de programme et le retour au programme. **Pause** conserve le travail et l’identité de la séance; **Terminer** compte une séance seulement après un travail effectif. Une activité chronométrée conserve ses règles natives d’expiration.

Le planificateur choisit le travail à ouvrir; le moteur de chaque outil reste responsable des exercices, des réponses, des notes et des pauses. En particulier, ne pas réimplémenter la sélection des cartes ni l’algorithme de répétition espacée.

La durée d’une réponse de révision et le temps actif de lecture n’ont pas exactement le même sens. Le bilan doit le conserver. Une carte marquée manuellement comme maîtrisée, sans réponse notée, ne produit pas une réponse travaillée. La copie d’un puzzle dans une base n’est pas non plus une nouvelle activité; sa révision ultérieure peut l’être.

## 8 Données à conserver

Conserver les nouvelles données dans la base SQLite personnelle afin de bénéficier des sauvegardes existantes. Les noms suivants sont proposés pour l’implémentation.

| Ensemble | Contenu principal et invariant |
| --- | --- |
| `training_programs` | UUID, propriétaire, nom, état, révision, éventuelle date d’activation prévue et définition JSON validée/versionnée; blocs avec UUID stables; au plus un programme actif |
| `training_weeks` | Programme, début de semaine, révision, copie de sa définition, fuseau et début de journée; unicité par programme et semaine |
| `training_runs` | Exécution d’un bloc ou épisode libre, origine, semaine prévue facultative, contexte de lancement, références natives, état et dates; une reprise conserve la même identité |
| `training_activity_links` | Identité immuable d’une occurrence native, origine libre ou planifiée et attribution à un bloc; aucune copie intégrale du journal natif |
| `training_activity_credits` | Événements mesurés acceptés, durée et type de mesure, unité éventuelle, date d’enregistrement, jour d’étude et version de règle; unicité de la clé d’événement |
| `training_manual_activities` | Activités déclarées avec date, durée, unité, note, révision et attribution; édition ou suppression ajuste les contributions |
| `training_templates` | Modèles personnels et leur définition versionnée; les modèles intégrés restent dans le code |
| `training_mutation_receipts` | Identifiant de requête, empreinte du contenu et réponse conservée pour les écritures pouvant être retentées |

La table des crédits est une projection limitée des faits acceptés par les outils. Elle ne lance pas de chronomètre et ne devient pas un second journal de résultats. Elle conserve les incréments nécessaires au suivi hebdomadaire que les totaux cumulatifs ne permettent pas de reconstruire.

Écrire le fait natif et son crédit dans la même transaction, après validation et déduplication. Une défaillance annule les deux. La clé combine l’identité de la source et celle de l’événement, par exemple un reçu de lecture ou une réponse de révision. Ne jamais utiliser seulement un identifiant entier susceptible d’être réutilisé après suppression; prévoir une identité immuable ou une génération, ainsi que les liens typés disponibles.

La semaine prévue d’une exécution et la semaine calculée pour un crédit sont distinctes. Le travail de lundi ne complète pas silencieusement l’objectif du dimanche. Les contributions rejoignent un bloc de la nouvelle semaine seulement si le programme, l’UUID du bloc et sa signature activité, ressource et unité correspondent. Un changement de cible ou de priorité conserve cette compatibilité; un changement de ressource, d’activité ou d’unité l’invalide. Les crédits incompatibles restent visibles sans objectif associé, sauf réaffectation explicite et validée.

La suppression d’une ressource de bibliothèque détache sa référence mais conserve les faits et leur titre d’origine. Une suppression explicite d’activité suit une règle distincte : retirer sa contribution des bilans et rendre cette correction identifiable. Ne pas confondre nettoyage des sources et effacement du travail réalisé.

Une activation future conserve sa date de prise d’effet et ne remplace pas immédiatement le programme actif. L’opération d’ouverture de semaine applique le changement arrivé à échéance et crée la copie hebdomadaire dans une même transaction, avant de choisir les blocs destinataires. Une seule activation future est prévue à la fois, avec possibilité de la modifier ou de l’annuler. Un simple accès en lecture ne déclenche aucune mutation.

Les migrations sont additives, idempotentes et participent à la transaction appelante. La restauration doit renouveler l’époque du workspace comme aujourd’hui pour empêcher un ancien brouillon local de réécrire des données restaurées.

## 9 Architecture et échanges avec le serveur

### Modules proposés

| Emplacement | Responsabilité |
| --- | --- |
| `training_programs.py` | Schéma, validation des programmes, blocs, modèles et versions hebdomadaires |
| `training_activity.py` | Adaptateurs de mesure, identités, attribution, crédits et agrégations |
| `training_program_api.py` | Routes authentifiées, transactions, révisions et reçus |
| `training_categories.py` | Projection globale par catégorie et période, objectifs quotidiens et hebdomadaires, statistiques sans dépendance à un programme |
| `static/training-plan.js` | Vue commune Jour et semaine, navigation vers Programme et Statistiques |
| `static/training-category-view.js` | Catégories compactes avec icônes des menus, progression des deux périodes et gestion commune dans Programme |
| `static/training-time-statistics.js` | Filtres, agrégations calendaires, graphiques et tableau des temps mesurés |
| `analysis_time.py`, `static/analysis-time.js` | Mesure active de l’analyse, pause et reçus sans double comptage |
| `static/training-program.js` | Composeur et choix des modèles |
| `static/training-plan-launch.js` | Lancement et reprise des outils avec leur contexte |
| `static/training-plan.css` | Mise en page adaptée aux différents écrans, fondée sur les styles existants |
| Ressources de traduction | Libellés français et anglais; les noms et notes personnels restent inchangés |

Conserver FastAPI, SQLite et les modules JavaScript natifs. Le module ne nécessite pas de nouveau framework, de service externe ou de système de recommandations par IA.

### Contrat d’API proposé

Utiliser le préfixe `/api/training`. Les lectures ne créent pas de semaine ou d’exécution.

| Opération | Route indicative |
| --- | --- |
| Lire le jour et la semaine par catégorie | `GET /overview` |
| Lire les temps par jour et activité | `GET /statistics?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` |
| Lister ou créer les programmes | `GET /programs`, `POST /programs` |
| Lire et modifier un programme | `GET /programs/{id}`, `PUT /programs/{id}` |
| Activer avec date de prise d’effet | `POST /programs/{id}/activate` |
| Garantir l’existence d’une semaine | `POST /programs/{id}/weeks` |
| Lire et ajuster la semaine | `GET /weeks/{id}`, `PATCH /weeks/{id}` |
| Obtenir une suggestion sans lancer | `POST /weeks/{id}/preview` |
| Créer une exécution de bloc | `POST /weeks/{id}/blocks/{block_id}/runs` |
| Lire ou terminer l’exécution | `GET /runs/{id}`, `PATCH /runs/{id}` |
| Lire la synthèse historique conservée pour compatibilité | `GET /summary` avec période explicite |
| Affecter ou corriger une attribution | `PUT /activities/{id}/assignment` |
| Gérer les activités déclarées | Routes de création, lecture, modification et suppression sous `/manual-activities` |
| Gérer les modèles personnels | Routes sous `/templates` |

Le lancement passe un `training_run_id` facultatif aux API natives concernées. Le serveur vérifie propriétaire, bloc, activité et ressource, puis attache le contexte dans la transaction de création native. L’exécution du plan peut exister avant cette création; elle reste en préparation tant que l’outil n’a pas confirmé son démarrage. Une reprise après réponse perdue retrouve le même lancement au lieu d’en créer un second.

La lecture demande un raccord particulier : fixer le contexte avant le premier incrément du suivi, puis transmettre l’exécution avec chaque reçu. Un changement d’exécution clôt la visite précédente sans déplacer ses crédits et démarre une nouvelle visite. Recharger la page ou reprendre la même exécution ne crée pas une nouvelle séance de programme.

Les écritures utilisent un identifiant de mutation et, pour les objets modifiables, la révision attendue. Même identifiant et même contenu : même réponse. Même identifiant et contenu différent : conflit. Vérifier le reçu avant de rejeter une ancienne révision. En cas de conflit entre appareils, préserver le brouillon et présenter les différences au lieu d’écraser les données.

Réserver le workspace aux états d’interface, brouillons et contextes de reprise. Les programmes, résultats et crédits sont persistés côté serveur. Une sauvegarde distante en attente est visible; aucun total définitif n’est annoncé avant son acceptation.

### Points d’intégration dans le code actuel

- `app.py` : initialisation des migrations et enregistrement du routeur avec la protection de compte existante.
- `static/main-navigation.js`, `static/section-navigation.js` et `static/app.js` : nouvelle entrée, routes sérialisées, montage et fermeture des vues. Conserver la suspension des révisions et la sauvegarde de lecture lors des changements d’écran.
- `static/startup-settings.js` : permettre de choisir Mon entraînement comme écran de départ, sans changer la préférence actuelle.
- `daily_review.py`, `review_sessions.py`, `training.py` et `learning_foundations.py` : réutilisation du plan de révision et raccordement des réponses persistées.
- `static/review-all.js` et les lancements Réviser / Apprendre dans `static/app.js` : réutiliser le chemin commun de création et de reprise de séance. L’ancienne interface `daily-review` a été retirée.
- `reading_progress.py`, `reading_visits.py` et `static/reading-progress.js` : branchement au suivi existant après acceptation d’un incrément, avec ses reçus.
- `training_history.py` et `static/training-history.js` : liens vers le journal et filtres contextuels. L’agrégat actuel des activités terminées ne suffit pas au programme, qui doit aussi compter le travail partiel.
- `workspace_state.py`, `workspace_api.py` et `static/workspace-store.js` : reprendre les conventions de révision, de reprise et d’époque.
- `backup_service.py` : vérifier la couverture des nouvelles tables et la restauration des références.

`sync.py` sert à importer des parties externes; ce n’est pas le mécanisme à utiliser pour synchroniser les programmes entre appareils.

## 10 Ordre de réalisation

Les lots 1 à 6 ont fourni le programme initial. Les lots 7 et 8 sont maintenant intégrés et vérifiés avec les parcours natifs. Le tableau conserve leur découpage et leurs critères de validation.

| Lot | Travail et résultat visible | Critères de sortie |
| --- | --- | --- |
| 1 Fondations | Définition des blocs, identités, migrations, API de programmes et règles de compatibilité des ressources | Enregistrement et relecture identiques; validation serveur; aucun changement des données historiques |
| 2 Composeur et modèles | Écran Programme, catalogue réel, édition des blocs, charge, modèles intégrés et personnels | Création vide ou depuis un modèle; ajout sélectif; ordre conservé; brouillon intact après erreur; usage mobile et clavier |
| 3 Semaine et saisie manuelle | Activation, état hebdomadaire, objectifs, activités déclarées et semaines précédentes | Réalisé et restant corrects; nouvelle semaine sans dette; édition courante explicite; suppression d’une déclaration corrigée |
| 4 Révisions et lecture | Lancements avec contexte, crédits dans les transactions natives, pause et reprise, travail libre suivi | Une activité apparaît une fois; durée partielle conservée; réponse perdue sans doublon; reprise après changement de semaine correcte |
| 5 Jour et semaine | Une ligne compacte par catégorie, icônes et ordre des menus, objectifs jour/semaine indépendants; gestion commune dans Programme et reprise en place | Toutes les catégories présentes sans programme; cumul avec objectifs à zéro; aucun doublon de bloc ou de durée; activité en cours préservée |
| 6 Bilan et finalisation | Synthèse hebdomadaire, répartition, liens au journal, traductions, conflits entre appareils et restauration | Totaux cohérents avec les faits natifs; types de durée visibles; sauvegarde restaurable; parcours complets sur mobile et ordinateur |
| 7 Extension des outils | Puzzles, deviner le coup, ordinateur, aveugle, coordonnées et Color | Chaque adaptateur respecte sa mesure native; Storm compté au niveau parent; compteurs cumulatifs sans double crédit |
| 8 Aides supplémentaires | Propositions d’estimations, duplication de semaines et ajustements suggérés | Propositions explicables et réversibles; aucun changement silencieux des objectifs |
| 9 Catégories et statistiques | Cumul global, objectifs indépendants, analyse automatique, évolution du temps et filtres | Travail libre et planifié compté une fois; graphiques cohérents entre jours, semaines et mois; durée inconnue distincte de zéro |

Les règles d’identité et de comptabilisation du lot 1 doivent être figées avant le lot 4. L’interface des lots 2 et 3 peut avancer avec des données de développement, mais ne doit pas dépendre d’un journal simulé pour valider le fonctionnement final.

## 11 Validation attendue

### Parcours fonctionnel de référence

1. Créer « Ma routine » avec un budget de 4 heures.
2. Ajouter calcul 60 minutes, répertoire 3 séances de 15 minutes et lecture 2 parties estimées à 20 minutes. Vérifier 2 h 25 prévues et 1 h 35 de marge.
3. Enregistrer, recharger et retrouver les mêmes valeurs et le même ordre.
4. Activer le programme et demander une séance de 30 minutes; changer une proposition avant le lancement.
5. Effectuer des révisions, interrompre puis reprendre. Vérifier que les réponses et le temps ne sont pas crédités deux fois.
6. Lire depuis l’outil existant et retrouver automatiquement ce temps dans Lire. Le signet et les statistiques de lecture restent cohérents.
7. Déclarer une activité externe, corriger sa durée, puis vérifier le bilan.
8. Passer à une nouvelle semaine et constater des objectifs réinitialisés, avec conservation du travail précédent.

### Vérifications bloquantes

| Cas | Résultat attendu |
| --- | --- |
| Double clic ou réponse réseau perdue | Une exécution, une écriture native et un crédit par événement |
| Échec au milieu d’une transaction | Aucun fait natif crédité sans son écriture correspondante |
| Incréments de lecture reçus dans le désordre | Temps accepté une fois; aucune régression du signet |
| Marquage manuel comme maîtrisé | Aucune fausse réponse de révision travaillée |
| Révision répétée dans la même exécution | Pas de gonflement de la quantité de cartes travaillées |
| Dimanche vers lundi, début de journée à 4 h et changement d’heure | Classement selon les règles de journée d’étude conservées |
| Activité commencée avant l’installation du module | Aucun cumul ancien présenté comme nouveau travail |
| Bloc ou base renommés, supprimés, puis nouvel identifiant entier réutilisé | Aucun rattachement du passé à une nouvelle ressource |
| Activité réaffectée à un autre bloc | Total global inchangé; contributions déplacées une seule fois |
| Aucun programme, objectif à zéro ou plusieurs blocs compatibles | Les dix catégories restent visibles et chaque durée rejoint une seule fois sa catégorie |
| Objectif quotidien 5 minutes et hebdomadaire 20 minutes | Barres et restants utilisent chacun leur objectif, y compris à la reprise |
| Statistiques filtrées aux frontières de semaine, mois et année | Totaux inchangés par le regroupement; comparaison avec une période de même longueur; catégories masquées exclues de tous les indicateurs |
| Ancienne activité reprise après changement de ressource du bloc | Travail visible, sans contribution automatique au nouvel objectif incompatible |
| Travail libre puis confirmation d’une séance ou d’une partie étudiée | Une fin d’épisode ou une quantité unique, sans deuxième durée; aucune multiplication des séances entre blocs |
| Deux appareils modifient le programme | Conflit explicite, sans perte du brouillon ni écrasement silencieux |
| Sauvegarde puis restauration | Programmes, semaines, crédits et reprise cohérents; ancien état local invalidé |
| Ressource indisponible ou aucune carte à réviser | Programme consultable; lancement concerné explique l’action possible |
| Écran étroit, textes longs, clavier et traduction anglaise | Champs accessibles, focus conservé, aucune action masquée par un débordement |

Les tests de comptabilisation comparent les crédits aux faits natifs acceptés. Ils ne se limitent pas à vérifier l’affichage d’un total. Les vérifications de navigation et de séance du jour existantes doivent continuer à passer.

## 12 Limites de portée et aides disponibles

La première version n’impose ni calendrier, ni notifications, ni partage avec un coach, ni objectifs selon le classement. Les activités externes restent déclarées. L’analyse automatique mesure les nouveaux intervalles actifs; elle ne reconstitue pas un temps historique jamais mesuré.

Les outils natifs sont raccordés et leur cumul par catégorie est automatique. Les règles historiques de correspondance avec un bloc détaillé restent distinctes du cumul global. Les suggestions d’estimations et d’objectifs fondées sur le travail observé exigent une application explicite. Dupliquer une semaine crée un programme brouillon avec ses blocs et objectifs, sans copier les crédits, les séances ni activer ce programme.

Le résultat attendu est un programme personnel durable qui relie les outils déjà présents dans ChessGym : choisir ses objectifs, décider quoi travailler maintenant et comprendre le travail accompli au fil des semaines.
