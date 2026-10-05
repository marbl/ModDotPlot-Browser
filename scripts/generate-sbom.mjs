import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const components = new Map();
const licenseSections = [];

function addComponent(component) {
  components.set(component.purl, component);
}

function licenseExpression(value) {
  if (!value) return [{ license: { name: "UNKNOWN" } }];
  return [{ expression: value }];
}

function collectLicenseText(label, packageDirectory) {
  if (!existsSync(packageDirectory)) return;
  const names = readdirSync(packageDirectory)
    .filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name))
    .sort();
  for (const name of names) {
    const path = join(packageDirectory, name);
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) licenseSections.push(`===== ${label} :: ${name} =====\n${text}`);
    } catch {
      // Directories and non-UTF-8 auxiliary files are not distributable license texts.
    }
  }
}

addComponent({
  type: "library",
  name: "ColorBrewer color schemes",
  version: "2.0",
  purl: "pkg:generic/colorbrewer@2.0",
  licenses: [{ license: { id: "Apache-2.0" } }],
  externalReferences: [
    { type: "website", url: "https://colorbrewer2.org/" },
    { type: "vcs", url: "https://github.com/axismaps/colorbrewer" },
  ],
});
licenseSections.push(
  `===== ColorBrewer 2 :: Apache-2.0 =====\n${readFileSync(join(root, "COLORBREWER_LICENSE.txt"), "utf8").trim()}`,
);

addComponent({
  type: "library",
  name: "d3-scale-chromatic",
  version: "3.1.0",
  purl: "pkg:npm/d3-scale-chromatic@3.1.0",
  licenses: [{ license: { id: "ISC" } }],
  externalReferences: [
    { type: "website", url: "https://d3js.org/d3-scale-chromatic/" },
    { type: "vcs", url: "https://github.com/d3/d3-scale-chromatic" },
  ],
});
licenseSections.push(
  `===== d3-scale-chromatic 3.1.0 :: LICENSE =====\n${readFileSync(join(root, "D3_SCALE_CHROMATIC_LICENSE.txt"), "utf8").trim()}`,
);

const cargo = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
  cwd: root,
  encoding: "utf8",
}));
for (const pkg of cargo.packages) {
  if (pkg.name.startsWith("moddotplot-")) continue;
  const purl = `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`;
  addComponent({
    type: "library",
    name: pkg.name,
    version: pkg.version,
    purl,
    licenses: licenseExpression(pkg.license),
    ...(pkg.source ? { externalReferences: [{ type: "distribution", url: pkg.source }] } : {}),
  });
  collectLicenseText(`${pkg.name} ${pkg.version}`, dirname(pkg.manifest_path));
}

const npmLock = JSON.parse(readFileSync(join(root, "web", "package-lock.json"), "utf8"));
const applicationVersion = npmLock.packages[""]?.version;
if (!applicationVersion) throw new Error("root npm package version is missing");
for (const [relativePath, pkg] of Object.entries(npmLock.packages)) {
  if (!relativePath.startsWith("node_modules/") || !pkg.version) continue;
  const name = relativePath.slice("node_modules/".length);
  const scopeSeparator = name.startsWith("@") ? name.indexOf("/") : -1;
  const purlName = scopeSeparator > 0
    ? `${encodeURIComponent(name.slice(0, scopeSeparator))}/${encodeURIComponent(name.slice(scopeSeparator + 1))}`
    : encodeURIComponent(name);
  const purl = `pkg:npm/${purlName}@${encodeURIComponent(pkg.version)}`;
  const component = {
    type: "library",
    name,
    version: pkg.version,
    purl,
    licenses: licenseExpression(pkg.license),
  };
  if (pkg.integrity) {
    const [algorithm, content] = pkg.integrity.split("-", 2);
    if (algorithm && content) {
      component.hashes = [{ alg: algorithm.toUpperCase().replace("SHA", "SHA-"), content }];
    }
  }
  if (pkg.resolved) component.externalReferences = [{ type: "distribution", url: pkg.resolved }];
  addComponent(component);
  // Optional native packages are installed according to the host OS. Keep every
  // lockfile package in the SBOM, but omit platform-conditional license text so
  // the generated distributable bundle is identical on macOS and Linux.
  if (!pkg.optional) collectLicenseText(`${name} ${pkg.version}`, join(root, "web", relativePath));
}

const sortedComponents = [...components.values()].sort((left, right) => left.purl.localeCompare(right.purl));
const dependencyFingerprint = createHash("sha256")
  .update(sortedComponents.map((component) => component.purl).join("\n"))
  .digest("hex");
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: "moddotplot-interactive",
      version: applicationVersion,
      licenses: [{ license: { id: "MIT-0" } }],
      properties: [
        { name: "moddotplot-interactive:dependency-fingerprint", value: dependencyFingerprint },
        { name: "moddotplot-interactive:generator", value: "scripts/generate-sbom.mjs" },
      ],
    },
  },
  components: sortedComponents,
};

writeFileSync(join(root, "SBOM.cdx.json"), `${JSON.stringify(bom, null, 2)}\n`);
writeFileSync(
  join(root, "THIRD_PARTY_LICENSES.txt"),
  `${licenseSections.sort().join("\n\n")}\n`,
);
