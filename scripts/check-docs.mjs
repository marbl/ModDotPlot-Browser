import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const allowedMarkdown = new Set([
  "README.md",
  "docs/CITATIONS.md",
  "docs/DEPLOYMENT.md",
  "docs/METHODS.md",
  "docs/PRIVACY.md",
  "docs/RELEASE_CHECKLIST.md",
  "docs/USER_GUIDE.md",
]);
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "release-artifacts",
]);
const markdown = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) collect(absolutePath);
    else if (entry.name.endsWith(".md")) markdown.push(relative(repository, absolutePath));
  }
}

collect(repository);

const failures = [];
for (const expected of allowedMarkdown) {
  if (!existsSync(join(repository, expected))) failures.push(`${expected}: required document is missing`);
}
for (const found of markdown) {
  if (!allowedMarkdown.has(found)) failures.push(`${found}: Markdown file is outside the retained documentation set`);
}

for (const relativePath of [...allowedMarkdown].filter((path) => existsSync(join(repository, path)))) {
  const absolutePath = join(repository, relativePath);
  const contents = readFileSync(absolutePath, "utf8");

  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
    const resolved = target.startsWith("/")
      ? join(repository, target.slice(1))
      : normalize(join(dirname(absolutePath), target));
    if (!existsSync(resolved)) failures.push(`${relativePath}: broken local link ${match[1]}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Documentation checks failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

console.log(`Checked ${markdown.length} retained Markdown documents and their local links.`);
