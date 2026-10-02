#!/bin/bash
# ==========================================
#  博客一键发布.command —— 写完双击这个文件即可发布
# ==========================================

BLOG_DIR="$(cd "$(dirname "$0")" && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"

notify() {
  osascript -e "display notification \"$2\" with title \"博客发布\" subtitle \"$1\"" 2>/dev/null
}
pause() { printf '按回车键关闭本窗口...'; read -r _; }

echo "========================================"
echo "  博客一键发布  $(date '+%Y-%m-%d %H:%M')"
echo "========================================"

if ! command -v git >/dev/null 2>&1; then
  echo "[失败] 没有安装 git。请打开终端运行: xcode-select --install"
  notify "缺少 git" "请先安装命令行工具"; pause; exit 1
fi

cd "$BLOG_DIR" || { pause; exit 1; }

# 等待可能存在的 git 锁（Obsidian Git 插件同步中）
for i in 1 2 3 4 5 6; do
  [ ! -f .git/index.lock ] && break
  echo "· git 正在被其他程序占用（如 Obsidian 同步），等待 10 秒…"
  sleep 10
done
if [ -f .git/index.lock ]; then
  echo "[中止] git 一直被占用。请关闭 Obsidian 后重试。"; notify "git 被占用" "请关闭 Obsidian 再双击"; pause; exit 1
fi

# 未解决的冲突标记检查
CONFLICTS=$(grep -rln --include='*.md' -e '^<<<<<<<' -e '^>>>>>>>' src 2>/dev/null | head -5)
if [ -n "$CONFLICTS" ]; then
  echo "[中止] 发现未解决的冲突标记，本次不发布（内容没有丢）。"
  echo "涉及文件："; echo "$CONFLICTS"
  echo "处理方法：在编辑器打开这些文件，搜索 <<<<<<< ，保留你要的段落、删掉标记行。"
  notify "发现冲突已中止" "请先处理冲突文件"; pause; exit 1
fi

# 草稿提醒
DRAFTS=$(grep -rln --include='*.md' '^draft: *true' src/content/posts 2>/dev/null | head -5)
if [ -n "$DRAFTS" ]; then
  echo "[提醒] 以下文章仍是草稿，构建时会跳过："; echo "$DRAFTS"
  read -r -p "直接回车=继续发布；想回去改就关掉本窗口 " _
fi

# 提交
git add -A
if git diff --cached --quiet; then
  echo "· 本地没有新修改，跳过提交"
else
  git commit -m "发布:$(date '+%Y-%m-%d %H:%M:%S')" || { echo "[失败] 提交出错，请截图红字求助。"; notify "提交失败" "查看终端报错"; pause; exit 1; }
  echo "[成功] 已提交本地修改"
fi

# 拉取（自动同步可能已推过内容）
if ! git pull --rebase; then
  git rebase --abort 2>/dev/null
  echo "[中止] 与云端同步失败（多设备改了同一文件）。已恢复发布前状态，内容未丢。"
  notify "同步冲突已安全中止" "本地内容未丢失"; pause; exit 1
fi

# 推送（触发 Cloudflare Pages 自动构建）
if git push; then
  echo "[成功] 已推送，Cloudflare 正在自动构建，1~2 分钟后刷新网站可见。"
  notify "发布成功" "网站构建中"
else
  echo "[失败] 推送失败。常见原因：1) 网络 → 几分钟后再双击；2) 未登录 → 按终端提示登录一次。"
  notify "推送失败" "查看终端提示"; pause; exit 1
fi

pause
