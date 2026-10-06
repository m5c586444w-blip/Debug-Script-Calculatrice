# Analyse de Salty-OS : pourquoi la calculatrice reste sur le slot A

Code analysé : [SaltyMold/Salty-OS](https://github.com/SaltyMold/Salty-OS), commit `2043e93` (« Refresh themes when quiting usb »).
J'ai aussi lu [ABLauncher](https://github.com/SaltyMold/ABLauncher-Numworks) et [l'installeur web](https://github.com/SaltyMold/Custom-Userland-Installer-Numworks), qui font partie de la chaîne de démarrage.

Méthode : comparaison avec Epsilon d'origine (commit `72c8306`), puis compilation réelle du firmware (`userland.allow3rdparty.B`) avec `arm-none-eabi-gcc 13.2` pour n0120, n0115 et n0110. J'ai ensuite inspecté le binaire produit (`readelf`, `objdump`, `nm`).

---

## 1. Comment le slot B démarre (et pourquoi on « retombe » sur A)

- Le bootloader démarre **toujours le slot A**.
- ABLauncher (installé dans le slot A) ne redémarre pas la calculatrice. Il **saute directement** dans le userland du slot B : il lit le vecteur d'init à `0x90410030` (pile + adresse de `start()`) puis fait `bx`.
- Salty-OS tourne donc **par-dessus le noyau (kernel) du slot A**, la version officielle installée sur la calculatrice.
- **Au moindre plantage** (HardFault, accès mémoire interdit…), le noyau redémarre la calculatrice, et le bootloader relance… **le slot A**.

« La calculatrice reste sur le A » veut donc dire l'une de ces deux choses :
1. le saut n'atteint jamais un Salty-OS valide (mauvais fichier, rien d'écrit dans le slot B, mauvais slot de départ) ;
2. Salty-OS démarre puis plante tout de suite, et la calculatrice redémarre sur A.

## 2. Vérifications à faire sur ta calculatrice (dans cet ordre)

| # | Vérification | Pourquoi |
|---|---|---|
| 1 | **Modèle** au dos de la calculatrice : `N0110`, `N0115` ou `N0120`. Le `.dfu` doit correspondre **exactement**. | La RAM commence à `0x24000000` sur n0120 et à `0x20000000` sur n0110/n0115. Avec le mauvais fichier, Salty-OS plante à la première instruction, puis redémarrage sur A. |
| 2 | **Version** : Paramètres → À propos. Salty-OS n'a été testé qu'avec **26.3.0**. | Le code de Salty-OS est celui d'Epsilon **25.2.2** ; seule la chaîne de version a été forcée à `26.3.0` (`epsilon/Makefile`). Le userland appelle le noyau du slot A par appels système (SVC). Si ta version est différente (ex. une 26.x plus récente), rien ne garantit que ces appels restent compatibles. |
| 3 | Dans ABLauncher, avant d'appuyer sur EXE, l'écran doit afficher **« Slot A detected »**. | S'il affiche « Slot B detected », la calculatrice tourne déjà sur B, et EXE renvoie vers **A**. Il faut d'abord revenir sur A (mise à jour officielle). |
| 4 | As-tu flashé un fichier de thèmes (`theme_area.bin` à `0x901F0000`) ? | Cette zone (2 Mo, `0x901F0000`–`0x903F0000`) est **dans le slot A**, sur la zone des applications externes. Flasher les thèmes peut effacer ABLauncher ; à l'inverse, installer des apps peut abîmer les thèmes (voir bug 2). |
| 5 | Ne touche **aucune touche, surtout HOME**, pendant « Switching to slot B… ». | Jusqu'à ce que Salty-OS appelle `unsetCheckpoint(Home)` (`apps_container.cpp:350`), le noyau garde le point de reprise HOME du slot A. Un appui sur HOME à ce moment renvoie probablement dans le code du slot A, dont la RAM vient d'être écrasée, d'où plantage et retour sur A. |
| 6 | Réessayer plusieurs fois. | Le README de Salty-OS dit lui-même : « If it crashes, retry ». Le démarrage n'est donc pas fiable à 100 %. |

Dans le code actuel (`master`), je n'ai **pas** trouvé, dans le chemin de démarrage (`start()` → `Apps::Init()` → `ThemeManager::init()` → écran d'accueil avec le thème par défaut), de bug qui fasse planter **à coup sûr** sur un n0120/n0115 en 26.3.0. Si les points 1 à 3 sont bons et que ça bloque encore, c'est très probablement le point 2 (version) qui est en cause.

## 3. Bugs trouvés dans le code

### Bug 1 (majeur, prouvé dans le binaire) : des variables globales ne sont jamais initialisées

- `shared/ion/src/device/userland/flash/userland_B.ld` passe `ALLOW_INIT_ARRAY` de `0` à **`1`**.
- Or le userland de production est lié avec `rt0_no_init_array.cpp` (`epsilon.device.userland.mak:49`), qui **n'exécute jamais** les constructeurs statiques (`.init_array`).
- Le garde-fou de l'éditeur de liens a donc été désactivé, sans que rien n'exécute ces constructeurs. Toute variable globale initialisée à partir d'une couleur de `Palette` (devenue modifiable pour les thèmes) reste à **0 (noir)**.

Dans le binaire compilé, `.init_array` contient une fonction (`_sub_I_65535_0.0`) qui n'est jamais appelée. Elle était censée initialiser :

| Variable | Fichier | Effet sur la calculatrice |
|---|---|---|
| `sTurtle` (objet tortue entier) | `python/port/mod/turtle/turtle.h` (`k_defaultColor` n'est plus `constexpr`) | Module Python `turtle` : stylo levé, tortue invisible, vitesse 0, épaisseur 0. **La tortue ne dessine rien.** |
| `Shared::ColorNames::k_colors` | `apps/shared/color_names.h` | Grapheur → options d'une fonction → Couleur : **toutes les pastilles sont noires**, et choisir une couleur rend la courbe noire. Le nom des couleurs devient « indéfini ». |
| `PlotPolicy::WithCurves::Pattern::k_transparent` | `apps/shared/plot_view_plots.h` | Les motifs (aires hachurées) prennent le noir pour « transparent » au lieu du blanc. |
| `SumGraphController::LegendView::k_glyphsFormat` | `apps/shared/sum_graph_controller.h` | Légende des calculs d'intégrale ou de somme : **fond noir**, texte illisible. |
| `Code::HighlightColor` | `apps/code/python_text_area.cpp` | Éditeur Python : la sélection est surlignée en **noir**. |
| `USB::sUSBConnectedColors` | `apps/usb/usb_connected_controller.cpp` | Écran « USB connecté » : la ligne d'URL n'est plus jaune. |

**Correction** (fournie dans le patch) : remettre `ALLOW_INIT_ARRAY = 0`, puis rendre chacune de ces valeurs constante ou calculée au moment de l'usage (fonction ou pointeur vers la couleur de `Palette`).
Vérifié : après correction, l'édition de liens passe avec le garde-fou rétabli et `.init_array` fait **0 octet**. `sTurtle` est bien initialisée dans `.data` (stylo baissé, visible, vitesse 8, épaisseur 1).

### Bug 2 : la zone des thèmes est dans le slot A, et ses offsets ne sont pas vérifiés

- `ThemeAreaStart = 0x901F0000` (2 Mo, défini dans les trois `board.h`) : c'est la fin du **slot A**, là où le slot A range ses **applications externes** (dont ABLauncher).
  - Flasher les thèmes peut effacer ABLauncher (et la fin du userland officiel du slot A si celui-ci dépasse ~1,8 Mo).
  - Installer des apps sur le slot A peut écraser les thèmes.
- `ThemeManager` lit `wallpaperOffset`, `paletteOffset`, `iconOffsets[]` et les tables de morceaux du fond d'écran **sans jamais vérifier** qu'ils restent dans la zone. Si l'en-tête est valide mais le reste abîmé, changer de thème (`(` + `)` + `shift`/`alpha`) lit n'importe où dans la mémoire. Résultat : plantage, puis redémarrage sur A.

**Correction** (fournie) : vérification des bornes (`inThemeArea()`) pour le fond d'écran, la palette, les icônes et chaque morceau du fond d'écran.
**Recommandation** (non faite, car elle change le format) : déplacer la zone dans le **slot B**. Une option est déjà prévue en commentaire dans `board.h` : `0x907B0000`, 256 Kio.

### Bug 3 : plantage garanti sur le simulateur

`ThemeManager::init()` lit l'adresse fixe `0x901F0000`, même dans le simulateur PC (`theme_manager.cpp:-test` est compilé partout). Sur PC, c'est une erreur de segmentation au démarrage.
**Correction** (fournie) : `#if !PLATFORM_DEVICE` → thèmes désactivés sur le simulateur.

### Bug 4 : fichier `dummy/init.cpp` écrasé

`shared/ion/src/shared/dummy/init.cpp` (qui contenait `Ion::Init() {}`) a été remplacé par une copie de `Apps::Init()` (commit `24a7a17`, « Temp while implementing »). Aucune cible ne le compile aujourd'hui, mais il casserait toute compilation qui l'utiliserait.
**Correction** (fournie) : fichier d'origine restauré.

### Risques (non corrigés, à surveiller)

- **Pile** : `AppCell::drawRect` réserve ~6,3 Ko de pile et `fillRoundedIcon` ~6,2 Ko (tampons `KDColor[55*56]`, `[104*20]`), soit environ 12,5 Ko sur une pile de 32 Ko.
  - ABLauncher ne réinitialise pas réellement la pile : `msr MSP` est ignoré en mode non privilégié. Salty-OS démarre donc avec la pile déjà en partie occupée par le slot A.
  - Avec un fond d'écran et des icônes à thème, la marge devient faible.
- `theme_manager.h` inclut en dur `n0120/config/board.h` pour tous les modèles. Ça fonctionne parce que les valeurs sont identiques, mais c'est fragile.
- **ABLauncher** : `SLOT_A_HEADER_SIZE = 0x20000` suppose la disposition officielle du n0120 (avec « extra data »). Sur n0110/n0115, le userland officiel du slot A est à `0x90010000`, donc le retour B → A saute au milieu du code. On finit sur A quand même, mais par un plantage.

## 4. Cas N0115 : le fichier publié

J'ai téléchargé et décodé `userland.allow3rdparty.B.n0115.dfu` de la release **Salty-OS-v1.0** (sha256 `4848d972…`).

- **Le fichier est correct pour un N0115** :
  - userland à `0x90410000`, là où ABLauncher saute ;
  - pile initiale `0x2003eff8`, dans la RAM du N0115 (`0x20000000`) ;
  - en-tête valide (magic `0xDEC0EDFE`, version `26.3.0`).
- **La release v1.0 a été compilée depuis un ancien commit** (`76ad24d`), pas depuis le code actuel. Ce commit n'a **ni** le système de thèmes **ni** `ALLOW_INIT_ARRAY = 1`. Les bugs 1 à 4 ci-dessus concernent le code actuel (`master`), **pas** ce fichier. Ses modifications par rapport à Epsilon sont minimes (palette rose constante, fond d'écran intégré, `unsetCheckpoint(Home)`) et je n'y vois rien qui plante au démarrage.
- **Ce fichier contient 2 blocs** :
  - le userland (`0x90410000`, 1,45 Mo) ;
  - **64 Ko de `0xFF` à `0x907F0000`** : les « persisting bytes » du slot B (nom de l'appareil, octets du mode examen).

L'installeur web **efface tous les blocs d'abord, puis écrit**. Si le noyau refuse l'effacement de `0x907F0000`, l'installeur s'arrête sur une erreur. Les octets du mode examen sont typiquement protégés, mais je ne peux pas le vérifier : le code du noyau n'est pas public. Le userland vient alors **d'être effacé et n'est jamais réécrit**. ABLauncher saute ensuite dans une zone vide (`0xFFFFFFFF`), ce qui fait planter la calculatrice, et elle redémarre sur A.

`dfu/userland.allow3rdparty.B.n0115.sans-persisting-bytes.dfu` est le **même userland, octet pour octet**, sans le bloc `0x907F0000`. Il est produit par `tools/strip_dfu.py`, avec CRC et taille vérifiés. Il est utile si l'installeur affichait une erreur avec le fichier d'origine.

## 5. Fichiers fournis

- `patches/0001-Fix-static-initialization-and-theme-area-bounds.patch` : à appliquer sur Salty-OS `2043e93` :
  ```sh
  git clone https://github.com/SaltyMold/Salty-OS && cd Salty-OS
  git am ../Debug-Script-Calculatrice/patches/0001-Fix-static-initialization-and-theme-area-bounds.patch
  cd epsilon && make -j$(nproc) PLATFORM=n0120 userland.allow3rdparty.B.dfu   # adapter le modèle
  ```

Compilation vérifiée avec le patch : n0120, n0115 et n0110 (`.init_array` vide sur les trois).
**Non testé sur une vraie calculatrice** : je n'ai pas de matériel ici. Ce patch corrige les bugs ci-dessus, mais il ne garantit pas, à lui seul, que le saut vers le slot B fonctionnera si la cause est le modèle, la version ou l'installation (section 2).
- `dfu/userland.allow3rdparty.B.n0115.sans-persisting-bytes.dfu` : le userland officiel v1.0 pour N0115, sans le bloc `0x907F0000` (section 4).
- `tools/strip_dfu.py` : script qui a produit ce fichier :
  ```sh
  python3 tools/strip_dfu.py userland.allow3rdparty.B.n0115.dfu sortie.dfu 90410000
  ```
