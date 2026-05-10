# 个人技术博客

这是一个轻量静态博客原型。文章使用 Markdown 编写，构建后输出纯静态 HTML，适合部署到 Cloudflare Pages、Vercel、Netlify、GitHub Pages 或任意静态文件服务器。

## 如何上传/添加文章

把你的 Markdown 文件放到：

```text
content/posts/
```

也可以用目录做内容分块：

```text
content/posts/
  frontend/
    css-layout.md
    react-notes.md
  backend/
    database-index.md
  life/
    weekly-review.md
```

构建后，文章列表会按一级目录分组；文章地址也会带上目录，例如：

```text
/blog/frontend/css-layout/
```

推荐每篇文章顶部加 frontmatter：

```md
---
title: 文章标题
date: 2026-05-10
tags: [JavaScript, 性能优化]
excerpt: 这是一句话摘要，会展示在文章列表里。
---

# 正文标题

这里写正文内容。
```

然后运行：

```bash
npm run build
```

如果你已经有一整个文章文件夹，可以一次性导入：

```bash
npm run import -- /你的旧文章目录
```

或者导入单篇：

```bash
npm run import -- /你的旧文章目录/example.md
```

生成后的站点在：

```text
dist/
```

本地预览：

```bash
npm run dev
```

浏览器打开：

```text
http://localhost:4321
```

## 文件说明

- `content/posts/`：你的 Markdown 文章
- `public/assets/cover.png`：首页封面图
- `src/styles.css`：网站样式
- `scripts/build.mjs`：Markdown 到静态页面的构建脚本
- `scripts/import-posts.mjs`：把已有 Markdown 文件导入 `content/posts/`
- `scripts/dev-server.mjs`：本地预览服务器
- `dist/`：构建产物，可直接部署
