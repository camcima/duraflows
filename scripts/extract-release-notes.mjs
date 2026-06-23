// Print the CHANGELOG section for a given version to stdout, with the
// "## [version] (date)" heading stripped (the GitHub release shows the tag as
// the title). Used by .github/workflows/release.yml to build release notes.
//
//   node scripts/extract-release-notes.mjs 3.0.0 > RELEASE_NOTES.md
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: extract-release-notes.mjs <version>");
  process.exit(1);
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Match this version's section up to the next "## [" heading or end of file.
const section = changelog.match(new RegExp(`## \\[${escaped}\\][\\s\\S]*?(?=\\n## \\[|$)`));
const body = (section ? section[0] : `Release v${version}`).replace(/^## \[[^\n]*\n/, "").trim();
process.stdout.write(body + "\n");
