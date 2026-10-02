// AI 聊天 V1.5：预设提示词 + 文章检索注入（关键词匹配，零额外 API）+ 引用
// 部署在 Cloudflare Pages Functions（/api/chat）。
// 激活条件：Pages 环境变量 DEEPSEEK_API_KEY。未配置时友好降级。
// 数据源：构建产物 /search-index.json（scripts/gen-search-index.mjs 生成）。

interface Env {
	DEEPSEEK_API_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
}

interface Msg {
	role: "user" | "assistant";
	content: string;
}

interface Chunk {
	heading: string;
	text: string;
}
interface Post {
	slug: string;
	title: string;
	url: string;
	chunks: Chunk[];
}

// —— 简易限流（每节点每 IP 每分钟 10 次；正式防护靠 WAF 规则）——
const rateMap = new Map<string, { count: number; reset: number }>();
function rateLimited(ip: string): boolean {
	const bucket = Math.floor(Date.now() / 60_000);
	const key = `${ip}:${bucket}`;
	const v = rateMap.get(key);
	if (!v) {
		for (const [k] of rateMap) {
			if (Number(k.split(":")[1]) < bucket - 1) rateMap.delete(k);
		}
		rateMap.set(key, { count: 1, reset: bucket });
		return false;
	}
	v.count++;
	return v.count > 10;
}

// —— 索引缓存（Worker 实例级，10 分钟）——
let indexCache: { at: number; posts: Post[] } | null = null;
async function getIndex(origin: string): Promise<Post[]> {
	if (indexCache && Date.now() - indexCache.at < 10 * 60_000) return indexCache.posts;
	try {
		const res = await fetch(new URL("/search-index.json", origin).href, {
			cf: { cacheTtl: 600 },
		});
		const data = (await res.json()) as { posts: Post[] };
		indexCache = { at: Date.now(), posts: data.posts ?? [] };
		return indexCache.posts;
	} catch {
		return indexCache?.posts ?? [];
	}
}

// —— 关键词检索：把 query 切成 2 字滑窗，按命中次数对 chunk 打分 ——
function search(query: string, posts: Post[], topK = 3): Array<{ post: Post; chunk: Chunk; score: number }> {
	const q = query.toLowerCase().replace(/[，。？！、\s]/g, "");
	if (q.length < 2) return [];
	const grams = new Set<string>();
	for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2));
	const scored: Array<{ post: Post; chunk: Chunk; score: number }> = [];
	for (const post of posts) {
		for (const chunk of post.chunks) {
			const text = (chunk.heading + " " + chunk.text).toLowerCase();
			let score = 0;
			for (const g of grams) if (text.includes(g)) score++;
			if (score > 0) scored.push({ post, chunk, score });
		}
	}
	return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

const SYSTEM_PROMPT = `你是「拾光集」博客的站内助手。博主是一名程序员，这个博客记录技术实践、AI 协作和个人成长。
规则：
1. 用简洁友好的中文回答，段落短，不用列表堆砌；
2. 如果对话中附带了「博客文章资料」，回答相关问题时优先依据资料，并自然地提到文章标题；资料里没有的就直说不知道，绝不编造文章内容或链接；
3. 通用问题也认真答，但保持简短；
4. 读者想联系博主时，引导他们去「关于」页查看邮箱。`;

export const onRequestPost = async (context: {
	request: Request;
	env: Env;
}) => {
	const { request, env } = context;

	if (request.method !== "POST") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	if (rateLimited(ip)) {
		return Response.json({ error: "请求太频繁，请一分钟后再试" }, { status: 429 });
	}

	let body: { messages?: Msg[]; turnstileToken?: string };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "bad json" }, { status: 400 });
	}
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	if (!messages.length || typeof lastUser?.content !== "string") {
		return Response.json({ error: "messages 不能为空" }, { status: 400 });
	}

	if (!env.DEEPSEEK_API_KEY) {
		return Response.json({
			error: "AI 助手尚未上线：博主还没配置 API Key。欢迎通过「关于」页的邮箱联系。",
		});
	}

	// Turnstile（配置了 secret 才启用）
	if (env.TURNSTILE_SECRET_KEY && body.turnstileToken) {
		try {
			const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: body.turnstileToken, remoteip: ip }),
			});
			if (!(await verify.json()).success) {
				return Response.json({ error: "人机校验失败，请刷新重试" }, { status: 403 });
			}
		} catch {
			/* siteverify 异常放行，限流兜底 */
		}
	}

	// 检索相关文章片段，注入系统提示
	const origin = new URL(request.url).origin;
	const hits = search(lastUser.content, await getIndex(origin));
	let systemPrompt = SYSTEM_PROMPT;
	if (hits.length) {
		const ctx = hits
			.map((h, i) => `[资料${i + 1}｜《${h.post.title}》｜${h.chunk.heading}]\n${h.chunk.text}`)
			.join("\n\n");
		systemPrompt += `\n\n以下是可能相关的博客文章资料（如与问题无关请忽略）：\n${ctx}`;
	}

	const upstream = await fetch("https://api.deepseek.com/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
		},
		body: JSON.stringify({
			model: "deepseek-flash",
			messages: [
				{ role: "system", content: systemPrompt },
				...messages.slice(-12).map((m) => ({
					role: m.role,
					content: String(m.content).slice(0, 4000),
				})),
			],
			temperature: 0.7,
			max_tokens: 1024,
			stream: true,
		}),
		signal: AbortSignal.timeout(120_000),
	});

	if (!upstream.ok || !upstream.body) {
		console.error("[chat] upstream error", upstream.status);
		return Response.json({ error: "AI 服务暂时不可用，请稍后再试" }, { status: 502 });
	}

	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const citation =
		hits.length > 0
			? "\n\n——\n参考：" + hits.map((h) => `《${h.post.title}》 ${new URL(h.post.url, origin).href}`).join("\n")
			: "";

	const readable = new ReadableStream({
		async start(controller) {
			const reader = upstream.body!.getReader();
			try {
				let buffer = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data:")) continue;
						const data = trimmed.slice(5).trim();
						if (data === "[DONE]") continue;
						try {
							const delta = JSON.parse(data).choices?.[0]?.delta?.content;
							if (delta) controller.enqueue(encoder.encode(delta));
						} catch {
							/* 忽略不完整行 */
						}
					}
				}
				if (citation) controller.enqueue(encoder.encode(citation));
			} catch (e) {
				console.error("[chat] stream error", e);
			} finally {
				controller.close();
			}
		},
	});

	return new Response(readable, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
};
