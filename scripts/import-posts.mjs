import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const targetDir = path.join(root, "content", "posts");
const source = process.argv[2];

if (!source) {
  console.error("Usage: npm run import -- /path/to/posts-or-file.md");
  process.exit(1);
}

async function collectMarkdownFiles(inputPath, base = inputPath) {
  const info = await stat(inputPath);
  if (info.isFile()) {
    return inputPath.endsWith(".md") ? [{ absolute: inputPath, relative: path.basename(inputPath) }] : [];
  }

  const files = [];
  const entries = await readdir(inputPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(entryPath, base));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push({
        absolute: entryPath,
        relative: path.relative(base, entryPath)
      });
    }
  }

  return files;
}

await mkdir(targetDir, { recursive: true });

const files = await collectMarkdownFiles(path.resolve(source));

for (const file of files) {
  const targetPath = path.join(targetDir, file.relative);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(file.absolute, targetPath);
}

console.log(`Imported ${files.length} markdown files to ${targetDir}`);
