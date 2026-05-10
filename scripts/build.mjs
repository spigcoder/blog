import { cp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const postsDir = path.join(root, "content", "posts");
const stylesPath = path.join(root, "src", "styles.css");
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");

const site = {
  title: "技术笔记",
  description: "一个简洁、快速、面向长期写作的个人技术博客。",
  motto: "保持前进的姿态，比写出完美的代码重要10000倍"
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slugify(fileName) {
  return fileName
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function listMarkdownFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(entryPath, base));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push({
        absolute: entryPath,
        relative: path.relative(base, entryPath)
      });
    }
  }

  return files;
}

function parseFrontmatter(raw, fallbackTitle) {
  if (!raw.startsWith("---")) {
    return {
      data: { title: fallbackTitle, date: "", tags: [], excerpt: "" },
      body: raw.trim()
    };
  }

  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return {
      data: { title: fallbackTitle, date: "", tags: [], excerpt: "" },
      body: raw.trim()
    };
  }

  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const data = { title: fallbackTitle, date: "", tags: [], excerpt: "" };

  for (const line of header.split("\n")) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const value = rest.join(":").trim();
    if (key.trim() === "tags") {
      data.tags = value
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      data[key.trim()] = value.replace(/^["']|["']$/g, "");
    }
  }

  return { data, body };
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let list = [];
  let inCode = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }

    const quote = line.match(/^>\s+(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return html.join("\n");
}

function formatDate(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date(`${date}T00:00:00`));
}

function layout({ title, description, body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · ${escapeHtml(site.title)}</title>
  <meta name="description" content="${escapeHtml(description || site.description)}">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <nav class="nav">
      <a class="brand" href="/">${escapeHtml(site.title)}</a>
      <div class="nav-links">
        <a href="/">首页</a>
        <a href="/blog/">文章</a>
      </div>
    </nav>
  </header>
  ${body}
  <footer class="footer">© ${new Date().getFullYear()} 技术笔记。${escapeHtml(site.motto)}</footer>
</body>
</html>`;
}

function postCard(post) {
  return `<a class="post-card" href="/blog/${post.slug}/">
  <div>
    <div class="meta">${post.dateText ? `<span>${post.dateText}</span>` : ""}</div>
    <h3>${escapeHtml(post.title)}</h3>
    <p>${escapeHtml(post.excerpt)}</p>
  </div>
  <div class="meta">${post.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
</a>`;
}

async function readPosts() {
  if (!existsSync(postsDir)) return [];
  const files = await listMarkdownFiles(postsDir);
  const posts = [];

  for (const file of files) {
    const raw = await readFile(file.absolute, "utf8");
    const fallbackTitle = path.basename(file.relative).replace(/\.md$/i, "");
    const { data, body } = parseFrontmatter(raw, fallbackTitle);
    const segments = file.relative.split(path.sep);
    const category = segments.length > 1 ? segments[0] : "未分类";
    const slug = segments.map(slugify).join("/");
    const title = data.title || fallbackTitle;
    const normalizedBody = body.replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n+`), "");
    const excerpt = data.excerpt || normalizedBody.replace(/[#>*`-]/g, "").trim().slice(0, 96);

    posts.push({
      slug,
      category,
      title,
      date: data.date || "",
      dateText: formatDate(data.date),
      tags: Array.isArray(data.tags) ? data.tags : [],
      excerpt,
      html: markdownToHtml(normalizedBody)
    });
  }

  return posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

async function build() {
  const posts = await readPosts();
  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, "blog"), { recursive: true });
  await copyFile(stylesPath, path.join(distDir, "styles.css"));
  if (existsSync(publicDir)) {
    await cp(publicDir, distDir, { recursive: true });
  }

  const latest = posts.slice(0, 4).map(postCard).join("\n");
  const groupedPosts = Map.groupBy(posts, (post) => post.category);
  const categorySections = [...groupedPosts.entries()].map(([category, categoryPosts]) => `<section class="category-block">
    <div class="section-title">
      <h2>${escapeHtml(category)}</h2>
    </div>
    <div class="post-grid">${categoryPosts.map(postCard).join("\n")}</div>
  </section>`).join("\n");

  const indexBody = `<main>
  <section class="hero">
    <div class="hero-overlay"></div>
    <div class="hero-inner hero-centered">
      <p class="motto">“${escapeHtml(site.motto)}”</p>
    </div>
  </section>
  <section class="section">
    <div class="section-title">
      <h2>最新文章</h2>
      <a href="/blog/">查看全部</a>
    </div>
    <div class="post-grid">${latest}</div>
  </section>
</main>`;

  await writeFile(path.join(distDir, "index.html"), layout({
    title: "首页",
    description: site.description,
    body: indexBody
  }));

  const blogBody = `<main class="section">
  <div class="section-title">
    <h2>全部文章</h2>
  </div>
  ${categorySections}
</main>`;

  await writeFile(path.join(distDir, "blog", "index.html"), layout({
    title: "全部文章",
    description: "全部 Markdown 技术文章。",
    body: blogBody
  }));

  for (const post of posts) {
    const postDir = path.join(distDir, "blog", post.slug);
    await mkdir(postDir, { recursive: true });
    const tags = post.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    const body = `<main class="article-shell">
  <article>
    <header class="article-header">
      <div class="meta">${post.dateText ? `<span>${post.dateText}</span>` : ""}</div>
      <h1>${escapeHtml(post.title)}</h1>
      <div class="meta">${tags}</div>
    </header>
    <div class="article-content">${post.html}</div>
  </article>
</main>`;

    await writeFile(path.join(postDir, "index.html"), layout({
      title: post.title,
      description: post.excerpt,
      body
    }));
  }

  console.log(`Built ${posts.length} posts to ${distDir}`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
