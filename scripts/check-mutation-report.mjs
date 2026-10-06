import { readFileSync } from "node:fs";

const reportPath = process.argv[2] ?? "reports/mutation/mutation.json";
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const invalid = [];
let mutants = 0;

for (const [fileName, file] of Object.entries(report.files)) {
  for (const mutant of file.mutants) {
    mutants++;
    // A runner compatibility failure can silently skip all selected tests and
    // falsely classify every mutation as survived. NoCoverage is a separate,
    // legitimate result; a survivor must have actually run at least one test.
    if (mutant.status === "Survived" && !(mutant.testsCompleted > 0)) {
      invalid.push(`${fileName}:${mutant.location.start.line} (mutant ${mutant.id})`);
    }
  }
}

if (mutants === 0) {
  throw new Error(`Mutation report ${reportPath} contains no mutants.`);
}
if (invalid.length) {
  throw new Error(
    `${invalid.length} survivors completed no tests. Check the Stryker/Vitest integration before trusting the score:\n` +
      invalid.slice(0, 10).join("\n"),
  );
}

console.log(`Validated ${mutants} mutation results: every survivor completed at least one test.`);
