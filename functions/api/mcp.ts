// 博客 MCP Server（stateless，Streamable HTTP）
// 端点：POST /api/mcp（JSON-RPC 2.0）
// 工具：search_posts(query) / get_post(slug)
// 数据源：构建产物 /search-index.json
// 让读者在 Claude/ChatGPT 等 MCP 客户端里把本博客当数据源调用。

interface Env {}

interface Chunk {
	heading: string;
	text: string;
}
interface Post {
	slug: string;
	title: string;
	description: string;
	published: string;
	url: string;
	chunks: Chunk[];
}

let indexCache: { at: number; posts: Post[] } | null = null;
async function getIndex(origin: string): Promise<Post[]> {
	if (indexCache && Date.now() - indexCache.at < 10 * 60_000) return indexCache.posts;
	try {
		const res = await fetch(new URL("/search-index.json", origin).href, { cf: { cacheTtl: 600 } });
		const data = (await res.json()) as { posts: Post[] };
		indexCache = { at: Date.now(), posts: data.posts ?? [] };
		return indexCache.posts;
	} catch {
		return indexCache?.posts ?? [];
	}
}

function search(query: string, posts: Post[], topK = 5) {
	const q = query.toLowerCase().replace(/[，。？！、\s]/g, "");
	if (q.length < 2) return [];
	const grams = new Set<string>();
	for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2));
	return posts
		.map((post) => {
			const text = (post.title + " " + post.description + " " + post.chunks.map((c) => c.heading + " " + c.text).join(" ")).toLowerCase();
			let score = 0;
			for (const g of grams) if (text.includes(g)) score++;
			return { post, score };
		})
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK)
		.map((r) => r.post);
}

const PROTOCOL = "2025-06-18";
const TOOLS = [
	{
		name: "search_posts",
		description: "按关键词搜索本博客的文章，返回匹配文章的标题、摘要和链接",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "搜索关键词（中文或英文）" },
			},
			required: ["query"],
		},
	},
	{
		name: "get_post",
		description: "按 slug 获取一篇文章的完整内容（Markdown 分块）",
		inputSchema: {
			type: "object",
			properties: {
				slug: { type: "string", description: "文章 slug（可从 search_posts 结果获得）" },
			},
			required: ["slug"],
		},
	},
];

function rpcResult(id: unknown, result: unknown) {
	return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string) {
	return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

export const onRequestPost = async (context: { request: Request; env: Env }) => {
	const { request } = context;
	let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, string> } };
	try {
		msg = await request.json();
	} catch {
		return rpcError(null, -32700, "Parse error");
	}
	const origin = new URL(request.url).origin;
	const posts = await getIndex(origin);

	switch (msg.method) {
		case "initialize":
			return rpcResult(msg.id, {
				protocolVersion: PROTOCOL,
				capabilities: { tools: {} },
				serverInfo: { name: "shiguang-blog-mcp", version: "1.0.0" },
			});
		case "tools/list":
			return rpcResult(msg.id, { tools: TOOLS });
		case "tools/call": {
			const name = msg.params?.name;
			const args = msg.params?.arguments ?? {};
			if (name === "search_posts") {
				const q = String(args.query ?? "");
				const hits = search(q, posts);
				return rpcResult(msg.id, {
					content: [
						{
							type: "text",
							text: hits.length
								? hits
										.map((p) => `- 《${p.title}》（${p.published.slice(0, 10)}）：${p.description}\n  ${new URL(p.url, origin).href}\n  slug: ${p.slug}`)
										.join("\n")
								: "没有找到相关文章。",
						},
					],
				});
			}
			if (name === "get_post") {
				const slug = String(args.slug ?? "");
				const post = posts.find((p) => p.slug === slug);
				if (!post) return rpcError(msg.id, -32602, `文章不存在：${slug}`);
				return rpcResult(msg.id, {
					content: [
						{
							type: "text",
							text: `# ${post.title}\n\n${post.description}\n\n${post.chunks
								.map((c) => (c.heading ? `## ${c.heading}\n${c.text}` : c.text))
								.join("\n\n")}\n\n原文：${new URL(post.url, origin).href}`,
						},
					],
				});
			}
			return rpcError(msg.id, -32602, `未知工具：${name}`);
		}
		case "ping":
			return rpcResult(msg.id, {});
		default:
			return rpcError(msg.id, -32601, `未知方法：${msg.method ?? "(空)"}`);
	}
};

export const onRequestGet = () =>
	Response.json({
		name: "shiguang-blog-mcp",
		description: "拾光集博客的 MCP 服务：搜索与阅读文章",
		endpoint: "/api/mcp",
		transport: "streamable-http (JSON-RPC 2.0 POST)",
		tools: TOOLS.map((t) => t.name),
	});
