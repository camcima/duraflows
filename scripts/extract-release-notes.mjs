#!/usr/bin/env node
// Prints the CHANGELOG.md section for a given version to stdout, so it can be
// used as the body of a GitHub Release (see .release-it.publish.json and
// RELEASING.md). Exits non-zero when the section is missing or empty -- a
// release with no notes should fail loudly rather than publish an empty page.

import { readFileSync } from "node:fs";

const CHANGELOG = new URL("../CHANGELOG.md", import.meta.url);

/**
 * Extracts the notes for `version` from conventional-changelog output.
 *
 * Sections look like either of:
 *   ## [4.0.1](https://github.com/camcima/duraflows/compare/v4.0.0...v4.0.1) (2026-08-15)
 *   ## 1.0.0 (2026-04-25)
 *
 * @param {string} changelog full CHANGELOG.md contents
 * @param {string} version version without the leading `v`
 * @returns {string} the section body, plus a compare link when the heading had one
 */
export const extractReleaseNotes = (changelog, version) => {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## (?:\\[${escaped}\\](\\([^)]*\\))?|${escaped})(?:\\s.*)?$`, "m");
  const match = heading.exec(changelog);

  if (!match) {
    throw new Error(`No CHANGELOG.md section found for version ${version}`);
  }

  const rest = changelog.slice(match.index + match[0].length);
  const next = /^## /m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();

  if (!body) {
    throw new Error(`CHANGELOG.md section for version ${version} is empty`);
  }

  const compareUrl = match[1]?.slice(1, -1);
  return compareUrl ? `${body}\n\n**Full changelog**: ${compareUrl}` : body;
};

const [, , rawVersion] = process.argv;

if (!rawVersion) {
  console.error("Usage: node scripts/extract-release-notes.mjs <version>");
  process.exit(1);
}

try {
  const version = rawVersion.replace(/^v/, "");
  console.log(extractReleaseNotes(readFileSync(CHANGELOG, "utf8"), version));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
