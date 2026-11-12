// Garde-fou : aucune publication sur npm sans la confirmation explicite du fondateur.
// La personne qui publie définit WYRLO_PUBLISH_CONFIRMED à la version confirmée
// (voir la procédure de publication de WYRLO).
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (process.env.WYRLO_PUBLISH_CONFIRMED !== version) {
  console.error(
    `Publication bloquée : la version ${version} n'a pas été confirmée par le fondateur ` +
      "(WYRLO_PUBLISH_CONFIRMED). Voir la procédure de publication de WYRLO.",
  );
  process.exit(1);
}
