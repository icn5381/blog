// 生成 public/search-index.json：文章元数据 + 分块正文
// 供 AI 聊天检索注入（V1.5）与 MCP server 共用。纯构建期，零 API。
import { readFile, writeFile } from "node:fs/promises";

async function listMd(dir) {
	const out = [];
	const { glob } = await import("node:fs/promises");
	for await (const f of glob(`${dir}/**/*.md`)) out.push(f);
	return out.sort();
}

const POSTS_DIR = "src/content/posts";

// 按二级标题切块，保留标题路径作为元数据
function chunk(md) {
	const fm = md.match(/^---\n[\s\S]*?\n---\n/);
	const body = fm ? md.slice(fm[0].length) : md;
	const sections = body.split(/\n(?=#{1,3}\s)/g);
	return sections
		.map((sec) => sec.trim())
		.filter((sec) => sec.length > 0)
		.map((sec) => {
			const m = sec.match(/^#{1,3}\s+(.+)$/m);
			const text = sec.replace(/\s+/g, " ").trim();
			return {
				heading: m ? m[1].trim() : "",
				text: text.slice(0, 1200),
			};
		})
		.filter((c) => c.text.length > 30);
}

const files = await listMd(POSTS_DIR);
const posts = [];
for (const file of files) {
	const raw = await readFile(file, "utf8");
	if (/^draft:\s*true/m.test(raw)) continue;
	const title = raw.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? file;
	const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
	const published = raw.match(/^published:\s*(.+)$/m)?.[1]?.trim() ?? "";
	const slug = file.split("/").pop().replace(/\.md$/, "");
	posts.push({ slug, title, description, published, url: `/posts/${slug}/`, chunks: chunk(raw) });
}

await writeFile("public/search-index.json", JSON.stringify({ generated: new Date().toISOString(), posts }));
console.log(`[search-index] ${posts.length} posts, ${posts.reduce((n, p) => n + p.chunks.length, 0)} chunks`);
