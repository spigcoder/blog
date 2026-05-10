import { cp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const postsDir = path.join(root, "content", "posts");
const stylesPath = path.join(root, "src", "styles.css");
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");

const site = {
  title: "技术笔记",
  description: "一个简洁、快速、面向长期写作的个人技术博客。",
  motto: "保持前进的姿态，比写出完美的代码重要10000倍",
  defaultCover: "/assets/cover.png",
  categories: [
    {
      name: "开发内功",
      href: "/blog/开发内功/",
      description: "计算机基础、工程能力、系统设计和长期可复用的技术积累。"
    },
    {
      name: "源码分析",
      href: "/blog/源码分析/",
      description: "从真实项目源码出发，拆解架构、关键路径和工程取舍。"
    }
  ]
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

function isRemoteOrSiteAsset(src) {
  return /^(https?:)?\/\//i.test(src)
    || /^data:/i.test(src)
    || /^mailto:/i.test(src)
    || src.startsWith("/assets/");
}

function stripMarkdownUrlWrapper(src) {
  return src.trim().replace(/^<|>$/g, "");
}

function sanitizeAssetName(value) {
  return value
    .normalize("NFKD")
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "image";
}

function resolveLocalAssetPath(src, markdownDir) {
  const cleanSrc = stripMarkdownUrlWrapper(src);
  const withoutHash = cleanSrc.split("#")[0].split("?")[0];

  if (withoutHash.startsWith("file://")) {
    return fileURLToPath(withoutHash);
  }

  const decoded = decodeURI(withoutHash);
  return path.isAbsolute(decoded)
    ? decoded
    : path.resolve(markdownDir, decoded);
}

async function materializeMarkdownImages(markdown, markdownDir, slug) {
  const imagePattern = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
  let result = "";
  let lastIndex = 0;

  for (const match of markdown.matchAll(imagePattern)) {
    const [raw, alt, rawSrc] = match;
    const src = stripMarkdownUrlWrapper(rawSrc);
    result += markdown.slice(lastIndex, match.index);
    lastIndex = match.index + raw.length;

    if (isRemoteOrSiteAsset(src)) {
      result += raw;
      continue;
    }

    const sourcePath = resolveLocalAssetPath(src, markdownDir);
    if (!existsSync(sourcePath)) {
      console.warn(`[warn] Image not found: ${src}`);
      result += raw;
      continue;
    }

    const extension = path.extname(sourcePath) || ".png";
    const baseName = sanitizeAssetName(path.basename(sourcePath, extension));
    const hash = createHash("sha1").update(sourcePath).digest("hex").slice(0, 10);
    const fileName = `${sanitizeAssetName(slug.replaceAll("/", "-"))}-${baseName}-${hash}${extension}`;
    const assetDir = path.join(publicDir, "assets", "posts");
    const targetPath = path.join(assetDir, fileName);

    await mkdir(assetDir, { recursive: true });
    await copyFile(sourcePath, targetPath);

    result += `![${alt}](/assets/posts/${fileName})`;
  }

  return result + markdown.slice(lastIndex);
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/!\[([^\]]*)\]\(([^()\s]+(?:\([^)]*\)[^()\s]*)*)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^()\s]+(?:\([^)]*\)[^()\s]*)*)\)/g, '<a href="$2">$1</a>');
}

function renderImage(src, alt = "") {
  const safeSrc = escapeHtml(src);
  const safeAlt = escapeHtml(alt);
  return `<figure class="article-image">
  <a href="${safeSrc}" target="_blank" rel="noopener noreferrer">
    <img src="${safeSrc}" alt="${safeAlt}" loading="lazy">
  </a>
</figure>`;
}

function normalizeLanguage(language, code) {
  const hint = language.trim().toLowerCase();
  if (hint) return hint;
  if (/\b(package|func|type|struct|interface|defer|go|chan|map)\b/.test(code)) return "go";
  if (/\b(function|const|let|var|return|import|export|async|await)\b/.test(code)) return "js";
  if (/\b(class|def|self|None|True|False|import)\b/.test(code)) return "python";
  if (/<[a-z][\s\S]*>/i.test(code)) return "html";
  return "text";
}

function highlightCode(code, language = "") {
  const lang = normalizeLanguage(language, code);
  const keywordSet = new Set([
    "abstract", "as", "async", "await", "break", "case", "catch", "chan", "class",
    "const", "continue", "default", "defer", "delete", "do", "else", "export",
    "extends", "fallthrough", "finally", "for", "from", "func", "function", "go",
    "if", "import", "in", "interface", "let", "map", "new", "package", "range",
    "return", "select", "struct", "switch", "throw", "try", "type", "var", "while",
    "with", "yield"
  ]);
  const literalSet = new Set([
    "false", "nil", "null", "None", "true", "True", "False", "undefined"
  ]);
  const typeSet = new Set([
    "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
    "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8",
    "uint16", "uint32", "uint64", "uintptr", "Array", "Boolean", "Map", "Number",
    "Object", "Promise", "Set", "String", "Symbol"
  ]);
  const tokenPattern = /\/\/.*|\/\*[\s\S]*?\*\/|#.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|[{}()[\].,;:+\-*/%=&|!<>]+/g;
  let html = "";
  let lastIndex = 0;

  for (const match of code.matchAll(tokenPattern)) {
    const token = match[0];
    html += escapeHtml(code.slice(lastIndex, match.index));

    let className = "";
    if (/^(\/\/|\/\*|#)/.test(token)) className = "tok-comment";
    else if (/^["'`]/.test(token)) className = "tok-string";
    else if (/^\d/.test(token)) className = "tok-number";
    else if (keywordSet.has(token)) className = "tok-keyword";
    else if (literalSet.has(token)) className = "tok-literal";
    else if (typeSet.has(token) || /^[A-Z][A-Za-z0-9_]*$/.test(token)) className = "tok-type";
    else if (/^[{}()[\].,;:+\-*/%=&|!<>]+$/.test(token)) className = "tok-punctuation";

    html += className
      ? `<span class="${className}">${escapeHtml(token)}</span>`
      : escapeHtml(token);
    lastIndex = match.index + token.length;
  }

  html += escapeHtml(code.slice(lastIndex));
  return { html, lang };
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let list = [];
  let listType = "";
  let inCode = false;
  let codeLines = [];
  let codeLanguage = "";

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list.length) return;
    const tag = listType || "ul";
    html.push(`<${tag}>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    list = [];
    listType = "";
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        const highlighted = highlightCode(codeLines.join("\n"), codeLanguage);
        html.push(`<pre class="code-block language-${highlighted.lang}"><code>${highlighted.html}</code></pre>`);
        codeLines = [];
        codeLanguage = "";
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        codeLanguage = line.slice(3).trim().split(/\s+/)[0] || "";
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

    const image = line.match(/^!\[([^\]]*)\]\(([^()\s]+(?:\([^)]*\)[^()\s]*)*)\)$/);
    if (image) {
      flushParagraph();
      flushList();
      html.push(renderImage(image[2], image[1]));
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      list.push(bullet[1]);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      list.push(ordered[1]);
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
  const categoryLinks = site.categories
    .map((category) => `<a href="${category.href}">${escapeHtml(category.name)}</a>`)
    .join("");

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
        ${categoryLinks}
      </div>
      <a class="home-link" href="/">首页</a>
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
    <div class="meta">${post.dateText ? `<span>${post.dateText}</span>` : ""}<span>${escapeHtml(post.category)}</span></div>
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
    const htmlBody = await materializeMarkdownImages(normalizedBody, path.dirname(file.absolute), slug);
    const excerpt = data.excerpt || normalizedBody.replace(/[#>*`-]/g, "").trim().slice(0, 96);

    posts.push({
      slug,
      category,
      title,
      cover: data.cover || "",
      date: data.date || "",
      dateText: formatDate(data.date),
      tags: Array.isArray(data.tags) ? data.tags : [],
      excerpt,
      html: markdownToHtml(htmlBody)
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
  const knownCategoryNames = site.categories.map((category) => category.name);
  const orderedCategoryNames = [
    ...knownCategoryNames,
    ...[...groupedPosts.keys()].filter((category) => !knownCategoryNames.includes(category))
  ];
  const categorySections = orderedCategoryNames.map((category) => {
    const categoryPosts = groupedPosts.get(category) || [];
    if (!categoryPosts.length && !knownCategoryNames.includes(category)) return "";
    const categoryMeta = site.categories.find((item) => item.name === category);
    return `<section class="category-block">
    <div class="section-title">
      <div>
        <p class="section-kicker">${categoryPosts.length} 篇文章</p>
        <h2>${escapeHtml(category)}</h2>
      </div>
      ${categoryMeta ? `<a href="${categoryMeta.href}">进入目录</a>` : ""}
    </div>
    ${categoryPosts.length ? `<div class="post-grid">${categoryPosts.map(postCard).join("\n")}</div>` : `<p class="empty-state">这个目录还没有文章，之后可以把 Markdown 放到 <code>content/posts/${escapeHtml(category)}/</code>。</p>`}
  </section>`;
  }).join("\n");

  const indexBody = `<main>
  <section class="hero">
    <div class="hero-overlay"></div>
    <div class="hero-inner hero-centered">
      <p class="motto">“${escapeHtml(site.motto)}”</p>
    </div>
  </section>
  <section class="section">
    <div class="section-title">
      <div>
        <p class="section-kicker">最近更新</p>
        <h2>最新文章</h2>
      </div>
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

  for (const category of site.categories) {
    const categoryPosts = groupedPosts.get(category.name) || [];
    const categoryDir = path.join(distDir, "blog", category.name);
    await mkdir(categoryDir, { recursive: true });
    const body = `<main class="section category-page">
  <header class="category-hero">
    <p class="section-kicker">目录</p>
    <h1>${escapeHtml(category.name)}</h1>
    <p>${escapeHtml(category.description)}</p>
  </header>
  ${categoryPosts.length ? `<div class="post-grid">${categoryPosts.map(postCard).join("\n")}</div>` : `<p class="empty-state">这个目录还没有文章。把 Markdown 放到 <code>content/posts/${escapeHtml(category.name)}/</code> 后重新构建即可。</p>`}
</main>`;

    await writeFile(path.join(categoryDir, "index.html"), layout({
      title: category.name,
      description: category.description,
      body
    }));
  }

  for (const post of posts) {
    const postDir = path.join(distDir, "blog", post.slug);
    await mkdir(postDir, { recursive: true });
    const tags = post.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    const cover = post.cover ? `<figure class="article-cover">
    <img src="${escapeHtml(post.cover)}" alt="${escapeHtml(post.title)}">
  </figure>` : "";
    const body = `<main>
  ${cover}
  <div class="article-shell">
  <article>
    <header class="article-header">
      <div class="meta">${post.dateText ? `<span>${post.dateText}</span>` : ""}</div>
      <h1>${escapeHtml(post.title)}</h1>
      <div class="meta">${tags}</div>
    </header>
    <div class="article-content">${post.html}</div>
  </article>
  </div>
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
