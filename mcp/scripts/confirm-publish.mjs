// Garde-fou : aucune publication sur npm sans la confirmation explicite du fondateur, ni
// avec une dépendance locale.
// La personne qui publie définit WYRLO_PUBLISH_CONFIRMED à la version confirmée
// (voir la procédure de publication de WYRLO).
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const { version } = pkg;

// Une dépendance locale (« file: », « link: », « workspace: ») ne doit jamais partir sur npm :
// remplacez-la d'abord par la version publiée du SDK.
const local = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) =>
  /^(file|link|workspace):/.test(String(spec)),
);
if (local.length) {
  console.error(
    `Publication bloquée : dépendance locale (${local.map(([n, s]) => `${n}@${s}`).join(", ")}). ` +
      "Publiez d'abord @wyrlo/sdk, puis remplacez-la par sa version.",
  );
  process.exit(1);
}

if (process.env.WYRLO_PUBLISH_CONFIRMED !== version) {
  console.error(
    `Publication bloquée : la version ${version} n'a pas été confirmée par le fondateur ` +
      "(WYRLO_PUBLISH_CONFIRMED). Voir la procédure de publication de WYRLO.",
  );
  process.exit(1);
}
