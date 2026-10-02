// AI 聊天 V1：预设提示词版（文章级 RAG 留待 V2）
// 部署在 Cloudflare Pages Functions（/api/chat），纯 fetch 实现，零额外依赖。
// 激活条件：在 Pages 项目设置环境变量 DEEPSEEK_API_KEY（可选 TURNSTILE_SECRET_KEY）。
// 未配置 key 时返回友好提示，不影响站点其他功能。

interface Env {
	DEEPSEEK_API_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
}

interface Msg {
	role: "user" | "assistant";
	content: string;
}

// 简易限流：每个 Cloudflare 节点每 IP 每分钟 10 次（V1 够用；正式防护靠 WAF 规则）
const rateMap = new Map<string, { count: number; reset: number }>();
function rateLimited(ip: string): boolean {
	const now = Date.now();
	const bucket = Math.floor(now / 60_000);
	const key = `${ip}:${bucket}`;
	const v = rateMap.get(key);
	if (!v) {
		// 顺手清理过期桶
		for (const [k] of rateMap) {
			if (Number(k.split(":")[1]) < bucket - 1) rateMap.delete(k);
		}
		rateMap.set(key, { count: 1, reset: bucket });
		return false;
	}
	v.count++;
	return v.count > 10;
}

const SYSTEM_PROMPT = `你是「拾光集」博客的站内助手。博主是一名程序员，这个博客记录技术实践、AI 协作和个人成长。
规则：
1. 用简洁友好的中文回答，段落短，不用列表堆砌；
2. 博客相关的问题（内容/搭建/订阅）按你所知回答，不确定就说不知道，不要编造文章内容或链接；
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

	// 限流
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	if (rateLimited(ip)) {
		return Response.json({ error: "请求太频繁，请一分钟后再试" }, { status: 429 });
	}

	// 解析请求
	let body: { messages?: Msg[]; turnstileToken?: string };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "bad json" }, { status: 400 });
	}
	const messages = Array.isArray(body.messages) ? body.messages : [];
	if (messages.length === 0 || typeof messages[messages.length - 1]?.content !== "string") {
		return Response.json({ error: "messages 不能为空" }, { status: 400 });
	}

	// 未配置 key：友好降级（站点其他功能不受影响）
	if (!env.DEEPSEEK_API_KEY) {
		return Response.json({
			error: "AI 助手尚未上线：博主还没配置 API Key。欢迎通过「关于」页的邮箱联系。",
		});
	}

	// Turnstile 校验（配置了 secret 才启用；本地调试不配即跳过）
	if (env.TURNSTILE_SECRET_KEY && body.turnstileToken) {
		try {
			const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					secret: env.TURNSTILE_SECRET_KEY,
					response: body.turnstileToken,
					remoteip: ip,
				}),
			});
			const result = (await verify.json()) as { success: boolean };
			if (!result.success) {
				return Response.json({ error: "人机校验失败，请刷新重试" }, { status: 403 });
			}
		} catch {
			// siteverify 网络异常时放行，靠限流兜底
		}
	}

	// 调 DeepSeek（OpenAI 兼容），流式转发
	const upstream = await fetch("https://api.deepseek.com/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
		},
		body: JSON.stringify({
			model: "deepseek-flash",
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				// 只带最近 12 条：防注入 + 省钱
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
		const detail = await upstream.text().catch(() => "");
		console.error("[chat] upstream error", upstream.status, detail.slice(0, 200));
		return Response.json({ error: "AI 服务暂时不可用，请稍后再试" }, { status: 502 });
	}

	// 把 SSE 流转成纯文本流（简单可靠，前端按 chunk 渲染）
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
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
							const json = JSON.parse(data);
							const delta = json.choices?.[0]?.delta?.content;
							if (delta) controller.enqueue(encoder.encode(delta));
						} catch {
							// 忽略不完整行
						}
					}
				}
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
