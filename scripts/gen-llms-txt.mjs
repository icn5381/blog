// 生成 public/llms.txt：给 AI 爬虫看的站点地图（Markdown 格式）
import { readFile, writeFile, glob } from "node:fs/promises";
import { existsSync } from "node:fs";
async function listMd(dir) {
	const out = [];
	for await (const f of glob(`${dir}/**/*.md`)) out.push(f);
	return out.sort();
}

const SITE = process.env.SITE_URL || "https://shiguang.dev";
const POSTS_DIR = "src/content/posts";

const files = await listMd(POSTS_DIR);
const posts = [];
for (const file of files) {
	const raw = await readFile(file, "utf8");
	if (/^draft:\s*true/m.test(raw)) continue;
	const title = raw.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? file;
	const desc = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
	const slug = file.split("/").pop().replace(/\.md$/, "");
	posts.push(`- [${title}](${SITE}/posts/${slug}/): ${desc}`);
}

const fm = (s) => s.replace(/^/gm, "").trim();
const out = `# 拾光集

> ${"记录技术、AI 与个人的缓慢生长。中文个人博客，全文 RSS 输出。"}

## 页面

- [首页](${SITE}/): 最新文章
- [关于](${SITE}/about/): 博主介绍与联系方式
- [隐私声明](${SITE}/privacy/): 数据收集说明
- [RSS 全文](${SITE}/rss.xml): 完整内容订阅源

## 文章

${posts.join("\n") || "（暂时没有已发布文章）"}
`;

await writeFile("public/llms.txt", out);
console.log(`[llms-txt] generated with ${posts.length} posts`);
