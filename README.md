# KOTP — King Of The Provence

Classement de bridge du Comité de Provence — saison 2026/2027, **PP Base ≥ 125**.

- Le site public utilise `index.html` (GitHub Pages).
- Les **PP gagnés** sont vérifiés chaque **dimanche à 23 h 59, heure de Paris** grâce à GitHub Actions.
- Le même contrôle peut être lancé à tout moment depuis **Actions → MAJ PP KOTP → Run workflow → Run workflow**.
- Le classement, les tris et les couleurs restent accessibles aux visiteurs, **sans compte FFB**.
- Les PP Base et les abattements enregistrés restent inchangés. Si la FFB change de saison ou si une requête échoue définitivement, **le site n'est pas modifié**.

## Configuration (une fois)

1. Ouvrir **Settings → Secrets and variables → Actions → New repository secret** sur ce dépôt. Créer les deux secrets :
   - `FFB_EMAIL` : adresse e-mail de connexion FFB (pas uniquement un numéro de licence).
   - `FFB_PASSWORD` : mot de passe de connexion FFB.
   Ne jamais écrire ces valeurs dans un fichier, un commit, une issue ou un chat.
2. Dans **Settings → Pages**, choisir **Deploy from a branch**, branche `main`, dossier `/ (root)`, puis **Save**.
3. Dans **Settings → Actions → General → Workflow permissions**, s'assurer que GitHub Actions est autorisé à écrire dans le dépôt (le workflow demande `contents: write`).
4. Déclencher **Actions → MAJ PP KOTP → Run workflow** une première fois pour vérifier la connexion et les 342 classements. Si la FFB impose un code de validation supplémentaire, le mode automatique devra être adapté.

Page publique, une fois Pages activé : **https://capgui13.github.io/KOTP/**.

> GitHub peut retarder ou exceptionnellement omettre un lancement planifié. Le déclenchement manuel reste disponible.

## Contenu

- `.github/workflows/update-pp.yml` : calendrier + bouton de lancement manuel + publication automatique.
- `scripts/update-pp.mjs` : authentification Firebase/FFB, lecture des classements et calcul atomique des PP.
- `tests/update-pp.test.mjs` : tests sans accès réseau ni identifiants.
- `index.html` : interface publique avec données intégrées et classements.

Le programme consulte les mêmes API que la version KOTP d'origine via le relais FFB existant. Aucun mot de passe, jeton de session ni adresse e-mail de connexion n'est écrit dans la page publique.