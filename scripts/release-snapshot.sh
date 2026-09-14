#!/usr/bin/env bash
# 发版与本地验证打包(一条脚本两个动作,按需选):
#   ./scripts/release-snapshot.sh          发版:bump beta → 构建 → 测试 → 发布 → commit → 更新 tooolx 引用
#   ./scripts/release-snapshot.sh --pack   只打包不发版:构建 → 测试 → pnpm pack 出 tarball(供 tooolx 本地验证)
# 发版纪律:提交≠发版。core 的 main 可领先 registry;只在 tooolx 要用新能力 /
# 一个主题批次收口 / 修消费端正在挨的 bug 时发版。平时想验证用 --pack 的
# tarball(tarball 是解包的真实文件、非项目外软链,Turbopack 不拒)。
# 可用环境变量:TOOLX_DIR(默认 ~/lib/web/tooolx-prompt)、PACK_PACKAGES(--pack 打哪些包,默认 core+provider-openai+tools,即 tooolx 消费的全集)
set -euo pipefail
cd "$(dirname "$0")/.."
TOOLX_DIR="${TOOLX_DIR:-$HOME/lib/web/tooolx-prompt}"

# ---------- --pack:只打包,不动版本、不发 npm、不碰 tooolx ----------
if [ "${1:-}" = "--pack" ]; then
	PACK_DIR="$(pwd)/pack"
	PACK_PACKAGES="${PACK_PACKAGES:-core provider-openai tools}"
	rm -rf "$PACK_DIR" && mkdir -p "$PACK_DIR"
	echo '==> 构建'
	pnpm -r build > /dev/null
	echo '==> 跨端纯度(主入口不得 import node:*)'
	node scripts/check-runtime-purity.mjs > /dev/null || { echo '纯度检查失败:通用主入口混入了 Node builtin,已中止打包'; exit 1; }
	echo '==> 测试'
	pnpm -r test > /dev/null 2>&1 || { echo '测试失败,已中止打包(版本未动,可安全重跑)'; exit 1; }
	echo '==> 打包(不发 npm)'
	# pnpm 10 的 pack 不支持 --filter/--pack-destination 组合:进目录打、再搬到 PACK_DIR
	for p in $PACK_PACKAGES; do
		(
			cd "packages/$p"
			rm -f ./*.tgz
			pnpm pack > /dev/null
			mv ./*.tgz "$PACK_DIR/"
		)
	done
	TARBALLS=()
	for p in $PACK_PACKAGES; do
		VER=$(node -p "require('./packages/$p/package.json').version")
		TARBALLS+=("$PACK_DIR/lingjing-agent-$p-$VER.tgz")
	done
	echo "✅ tarball 在 $PACK_DIR/(git 已忽略 *.tgz)"
	echo "   tooolx 本地验证(dev server 需重启;验证完正式发版会把引用切回 registry):"
	echo "   cd $TOOLX_DIR && pnpm add \\"
	for t in "${TARBALLS[@]}"; do
		if [ "$t" = "${TARBALLS[${#TARBALLS[@]}-1]}" ]; then
			echo "     '$t'"
		else
			echo "     '$t' \\"
		fi
	done
	exit 0
fi

# 1. 计算下一个 beta 号(0.1.0-beta.3 → 0.1.0-beta.4;无 beta 段则追加 -beta.1)
CURRENT=$(node -p "require('./packages/core/package.json').version")
NEXT=$(node -e "
	const v = process.argv[1];
	const m = v.match(/^(.*)-beta\.(\d+)\$/);
	console.log(m ? m[1] + '-beta.' + (+m[2] + 1) : v + '-beta.1');
" "$CURRENT")
echo "==> 版本:$CURRENT → $NEXT"

# 2. 五个包同步写入新版本
for p in core provider-openai provider-anthropic tools mcp; do
	node -e "
		const f = './packages/$p/package.json';
		const j = require(f);
		j.version = '$NEXT';
		require('fs').writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
	"
done

# 3. 构建 + 纯度 + 测试(挂了就中止,不发出坏版本)
echo '==> 构建'
pnpm -r build > /dev/null
echo '==> 跨端纯度(主入口不得 import node:*)'
node scripts/check-runtime-purity.mjs > /dev/null
echo '==> 测试'
pnpm -r test > /dev/null 2>&1 || { echo '测试失败,已中止发版(版本号未发布,可安全重跑)'; exit 1; }

# 4. 发布
echo '==> 发布'
# --access public:scoped 包首发默认 restricted,tools/mcp 首发必须显式 public(已 public 的包不受影响)
# --tag latest:prerelease 版本 npm 要求显式 tag(否则个别包被拒)
pnpm --filter @lingjing-agent/core --filter @lingjing-agent/provider-openai --filter @lingjing-agent/provider-anthropic --filter @lingjing-agent/tools --filter @lingjing-agent/mcp publish --no-git-checks --access public --tag latest

# 4b. 发版后校验:递归 publish 会静默跳过失败的包(2026-09-14 实际发生过),逐包确认
#     registry latest == NEXT 再往下走;对不上就停在 commit 之前(版本号未落 git,排查后重跑)
echo '==> 校验 registry'
for p in core provider-openai provider-anthropic tools mcp; do
	PUBLISHED=$(npm view "@lingjing-agent/$p" dist-tags.latest 2>/dev/null)
	if [ "$PUBLISHED" != "$NEXT" ]; then
		echo "❌ @lingjing-agent/$p registry latest = ${PUBLISHED:-未查到},期望 $NEXT —— 该包没发上去,中止(若确认是 registry 读滞后,稍后重跑本校验即可)"
		exit 1
	fi
done

# 5. 提交版本变更
git add packages pnpm-lock.yaml
git commit -m "chore: release $NEXT" > /dev/null

# 6. 更新 tooolx-prompt 引用(dependencies 精确锁,devDependencies 的 file: 若存在会被移除)
if [ -d "$TOOLX_DIR" ]; then
	echo '==> 更新 tooolx-prompt'
	cd "$TOOLX_DIR"
	pnpm remove @lingjing-agent/core @lingjing-agent/provider-openai @lingjing-agent/tools > /dev/null 2>&1 || true
	# registry 读滞后会让 add 解析不到新版本(tooolx 侧已发生过):失败重试一次,仍失败则醒目报告
	pnpm add "@lingjing-agent/core@$NEXT" "@lingjing-agent/provider-openai@$NEXT" "@lingjing-agent/tools@$NEXT" > /dev/null 2>&1 \
		|| { sleep 30 && pnpm add "@lingjing-agent/core@$NEXT" "@lingjing-agent/provider-openai@$NEXT" "@lingjing-agent/tools@$NEXT" > /dev/null; } \
		|| { echo "❌ tooolx 依赖没装上(registry 滞后或缓存),手动执行:cd $TOOLX_DIR && pnpm add @lingjing-agent/core@$NEXT @lingjing-agent/provider-openai@$NEXT @lingjing-agent/tools@$NEXT"; exit 1; }
	if ! grep -q "\"@lingjing-agent/tools\": \"$NEXT\"" package.json; then
		echo "❌ tooolx package.json 未写入 $NEXT 引用,手动检查 $TOOLX_DIR/package.json"
		exit 1
	fi
	echo "    已更新到 $NEXT"
fi

echo "✅ $NEXT 发布完成"
