// AI 摘要管线：无 API key 时自动跳过（不阻断构建）
// 用法：设置 DEEPSEEK_API_KEY 环境变量后运行；结果缓存进仓库，CI 零调用
import { readFile, writeFile, glob } from "node:fs/promises";
import { existsSync } from "node:fs";
async function listMd(dir) {
	const out = [];
	for await (const f of glob(`${dir}/**/*.md`)) out.push(f);
	return out.sort();
}
import crypto from "node:crypto";

const POSTS_DIR = "src/content/posts";
const CACHE_FILE = "scripts/.ai-summary-cache.json";
const OUT_FILE = "src/data/summaries.json";
const MODEL = "deepseek-flash";
const API_URL = "https://api.deepseek.com/chat/completions";
const API_KEY = process.env.DEEPSEEK_API_KEY;

const SYSTEM_PROMPT =
	"你是博客文章摘要生成器。只输出摘要正文本身，不要解释、不要引号。";
const userPrompt = (t) => `请为下面的博客文章写一段中文摘要：
1. 80-120 字，一段连贯的话；
2. 概括主题、关键结论或亮点；
3. 不要用"本文介绍"开头，直接陈述；
4. 保留技术名词原文。

文章正文：
${t.slice(0, 3000)}`;

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cache = {};
if (existsSync(CACHE_FILE)) cache = JSON.parse(await readFile(CACHE_FILE, "utf8"));

// frontmatter 简易解析：跳过 --- 块取正文
const bodyOf = (raw) => {
	const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return (m ? m[1] : raw).trim();
};

const files = await listMd(POSTS_DIR);
const tasks = [];
for (const file of files) {
	const raw = await readFile(file, "utf8");
	if (/^draft:\s*true/m.test(raw)) continue; // 草稿跳过
	if (/^description:\s*\S/m.test(raw) === false) {
		// 无手写 description 的才生成（有则尊重手写）
	}
	const slug = file.split("/").pop().replace(/\.md$/, "");
	const content = bodyOf(raw);
	const hash = md5(content);
	if (cache[slug]?.hash === hash && cache[slug]?.summary) continue;
	tasks.push({ slug, content, hash });
}
console.log(`[ai-summary] ${files.length} 篇，待处理 ${tasks.length} 篇`);

if (tasks.length && !API_KEY) {
	console.warn("[ai-summary] 未设置 DEEPSEEK_API_KEY，跳过（保留旧摘要）");
} else if (tasks.length) {
	async function summarize(text) {
		for (let i = 0; i < 2; i++) {
			try {
				const res = await fetch(API_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${API_KEY}`,
					},
					body: JSON.stringify({
						model: MODEL,
						messages: [
							{ role: "system", content: SYSTEM_PROMPT },
							{ role: "user", content: userPrompt(text) },
						],
						temperature: 1.0,
						max_tokens: 300,
						stream: false,
					}),
					signal: AbortSignal.timeout(60_000),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const out = await res.json();
				const s = out.choices?.[0]?.message?.content?.trim();
				if (!s) throw new Error("empty");
				return s;
			} catch (e) {
				if (i === 1) throw e;
				await sleep(1500);
			}
		}
	}
	let ok = 0;
	const queue = [...tasks];
	await Promise.all(
		Array.from({ length: 3 }, async () => {
			while (queue.length) {
				const t = queue.shift();
				try {
					cache[t.slug] = { hash: t.hash, summary: await summarize(t.content) };
					ok++;
				} catch (e) {
					console.error(`[ai-summary] 失败跳过 ${t.slug}: ${e.message}`);
				}
			}
		}),
	);
	console.log(`[ai-summary] 成功 ${ok}｜跳过 ${tasks.length - ok}`);
}

// 清理已删除文章的脏缓存，写回
const liveSlugs = new Set(files.map((f) => f.split("/").pop().replace(/\.md$/, "")));
cache = Object.fromEntries(Object.entries(cache).filter(([k]) => liveSlugs.has(k)));
await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
await writeFile(OUT_FILE, JSON.stringify(cache, null, 2));
console.log("[ai-summary] done");
