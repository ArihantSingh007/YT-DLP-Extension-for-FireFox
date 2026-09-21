/**
 * Build script. No bundler config framework: esbuild does everything the
 * extension needs (bundle TypeScript to classic scripts, copy static assets).
 *
 *   node build.mjs           production build into dist/
 *   node build.mjs --watch   rebuild on change
 *   node build.mjs --tests   build the unit tests into dist-test/
 *   node build.mjs --zip     zip dist/ into web-ext-artifacts/
 */
import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");

const entryPoints = {
  background: "src/background.ts",
  content: "src/content.ts",
  options: "src/options.ts",
  popup: "src/popup.ts",
};

const shared = {
  bundle: true,
  format: "iife",
  target: ["firefox115"],
  platform: "browser",
  legalComments: "none",
  // Deliberately NOT minified: AMO reviewers must be able to read the shipped
  // code. Bundling is still needed because content scripts cannot use ES
  // module imports.
  minify: false,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

function copyStatic() {
  mkdirSync(dist, { recursive: true });
  cpSync(join(root, "public"), dist, { recursive: true });
  for (const file of ["options.html", "popup.html", "ui.css"]) {
    cpSync(join(root, "src", file), join(dist, file));
  }
}

async function buildExtension() {
  rmSync(dist, { recursive: true, force: true });
  copyStatic();
  const options = {
    ...shared,
    entryPoints: Object.fromEntries(
      Object.entries(entryPoints).map(([name, file]) => [name, join(root, file)]),
    ),
    outdir: dist,
  };
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log("watching for changes… (dist/ is ready to load in Firefox)");
  } else {
    await build(options);
    console.log(`built ${relative(root, dist)}`);
  }
}

async function buildTests() {
  const testDir = join(root, "dist-test");
  rmSync(testDir, { recursive: true, force: true });
  const tests = readdirSync(join(root, "src/test")).filter((f) => f.endsWith(".test.ts"));
  await build({
    ...shared,
    format: "esm",
    platform: "node",
    target: ["node18"],
    minify: false,
    entryPoints: tests.map((f) => join(root, "src/test", f)),
    outdir: testDir,
  });
  console.log(`built ${tests.length} test file(s)`);
}

/** Minimal store/deflate zip writer so packaging needs no extra dependency. */
function zipDirectory(sourceDir, outFile) {
  const files = [];
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const name = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, name);
      else files.push({ name, data: readFileSync(full) });
    }
  };
  walk(sourceDir);

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const compressed = deflateRawSync(file.data);
    const nameBuffer = Buffer.from(file.name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(file.data) >>> 0, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(header, nameBuffer, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(file.data) >>> 0, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += header.length + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, Buffer.concat([...chunks, centralBuffer, end]));
  console.log(`packaged ${relative(root, outFile)}`);
}

if (args.has("--tests")) {
  await buildTests();
} else if (args.has("--zip")) {
  if (!existsSync(dist)) await buildExtension();
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  zipDirectory(dist, join(root, "web-ext-artifacts", `ytdlp-bridge-${manifest.version}.zip`));
} else {
  await buildExtension();
}
