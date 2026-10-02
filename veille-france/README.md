# Veille France

Carte des incidents graves en France, mise à jour toute seule toutes les 10 minutes, gratuitement, sur GitHub.

Un robot (GitHub Actions) lit les flux RSS des journaux, reconnaît la commune parmi les 35 000 de France grâce à l'API officielle geo.api.gouv.fr, classe la gravité, regroupe les articles qui parlent du même fait, publie la page et t'envoie une notification push sur ton téléphone quand un fait grave tombe.

## Mise en route (15 minutes, une seule fois)

1. **Crée un compte** sur github.com si tu n'en as pas, puis un dépôt **public** nommé `veille-france` (bouton « New repository »).

2. **Envoie les fichiers.** Dans le dépôt, clique « uploading an existing file » et glisse tout le contenu du dossier dézippé. Le dossier `.github` est caché sur Mac et Windows : si GitHub ne le prend pas, fais « Add file > Create new file », tape `.github/workflows/update.yml` comme nom et colle le contenu du fichier.

3. **Autorise le robot à écrire.** Settings > Actions > General > Workflow permissions : coche « Read and write permissions » et enregistre.

4. **Active la page web.** Settings > Pages > Source : choisis « GitHub Actions ».

5. **Lance le premier passage.** Onglet Actions > « Mise à jour des incidents » > « Run workflow ». Au bout d'une minute ou deux, ta carte est en ligne à l'adresse `https://TON-PSEUDO.github.io/veille-france/`. Ensuite le robot repasse tout seul toutes les 10 minutes.

## Alertes push sur le téléphone

1. Installe l'appli gratuite **ntfy** (Android ou iPhone).
2. Dans l'appli, abonne-toi à un nom de sujet difficile à deviner, par exemple `veille-fr-7k2q9x` (n'importe qui connaissant ce nom peut lire les alertes, donc invente-le).
3. Sur GitHub : Settings > Secrets and variables > Actions > « New repository secret ». Nom : `NTFY_TOPIC`, valeur : ton nom de sujet.

C'est tout : chaque fait grave arrive en notification, et un appui ouvre l'article.

Le premier passage du robot n'envoie rien, pour éviter une rafale d'alertes sur les faits déjà en mémoire.

## Réglages (fichier `config.json`)

`alerts.minSeverity` : `"crit"` pour être prévenu seulement des faits avec mort(s), `"grave"` pour ajouter les blessés graves et les armes, `"eleve"` pour tout.

`alerts.departements` : la liste des départements qui t'intéressent, par exemple `["75", "93", "13"]`. Vide, ça couvre toute la France.

`alerts.pageUrl` : l'adresse de ta carte, pour avoir un bouton « Ouvrir la carte » dans chaque notification.

`feeds` : la liste des flux RSS lus. Tu peux en ajouter (journaux régionaux, recherches Google Actualités en RSS) ou en enlever.

`keepDays` : combien de jours d'historique sont gardés (7 par défaut).

Sur la page elle-même, le bouton « Réglages » permet aussi d'avoir des alertes dans le navigateur quand la page est ouverte, avec un filtre par département.

## Ce qu'il y a sur la page

La carte affiche les faits en points (taille selon le nombre de sources) et une carte de chaleur par département ; un clic sur un département filtre tout le reste. Le fil à droite regroupe les articles d'un même fait, et le panneau de détail liste toutes les sources avec leurs liens. En bas : les chiffres de la période, l'indice d'intensité sur 24 h, le graphique heure par heure, la répartition par type et le classement des départements.

## Limites à connaître

La gravité, le type et le lieu sont devinés à partir des mots du titre. Ça marche bien dans la grande majorité des cas mais un fait peut être mal classé ou mal placé : l'article fait foi.

GitHub peut retarder les passages programmés de quelques minutes quand ses serveurs sont chargés.

Certains journaux bloquent parfois les robots ; la page « Réglages » montre quelles sources ont répondu au dernier passage.

## Tester sur ton ordinateur

Avec Node.js installé : `npm install`, puis `node scripts/update.mjs` pour un passage du robot, puis `npx serve .` et ouvre l'adresse affichée. La page ne marche pas en double-cliquant sur `index.html`, le navigateur bloque la lecture des données dans ce cas.
