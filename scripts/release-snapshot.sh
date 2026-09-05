#!/usr/bin/env bash
# 快照发版:bump beta 号 → 构建 → 测试 → 发布两个包 → 更新 tooolx-prompt 引用
# 用法:./scripts/release-snapshot.sh
# 可用环境变量:TOOLX_DIR(默认 ~/lib/web/tooolx-prompt)
set -euo pipefail
cd "$(dirname "$0")/.."
export npm_config_manage_package_manager_versions=false
TOOLX_DIR="${TOOLX_DIR:-$HOME/lib/web/tooolx-prompt}"

# 1. 计算下一个 beta 号(0.1.0-beta.3 → 0.1.0-beta.4;无 beta 段则追加 -beta.1)
CURRENT=$(node -p "require('./packages/core/package.json').version")
NEXT=$(node -e "
	const v = process.argv[1];
	const m = v.match(/^(.*)-beta\.(\d+)\$/);
	console.log(m ? m[1] + '-beta.' + (+m[2] + 1) : v + '-beta.1');
" "$CURRENT")
echo "==> 版本:$CURRENT → $NEXT"

# 2. 两个包同步写入新版本
for p in core provider-openai; do
	node -e "
		const f = './packages/$p/package.json';
		const j = require(f);
		j.version = '$NEXT';
		require('fs').writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
	"
done

# 3. 构建 + 测试(测试挂了就中止,不发出坏版本)
echo '==> 构建'
pnpm -r build > /dev/null
echo '==> 测试'
pnpm -r test > /dev/null 2>&1 || { echo '测试失败,已中止发版(版本号未发布,可安全重跑)'; exit 1; }

# 4. 发布
echo '==> 发布'
pnpm --filter @lingjing/agent-core --filter @lingjing/provider-openai publish --no-git-checks

# 5. 提交版本变更
git add packages pnpm-lock.yaml
git commit -m "chore: release $NEXT" > /dev/null

# 6. 更新 tooolx-prompt 引用(dependencies 精确锁,devDependencies 的 file: 若存在会被移除)
if [ -d "$TOOLX_DIR" ]; then
	echo '==> 更新 tooolx-prompt'
	cd "$TOOLX_DIR"
	pnpm remove @lingjing/agent-core @lingjing/provider-openai > /dev/null 2>&1 || true
	pnpm add "@lingjing/agent-core@$NEXT" "@lingjing/provider-openai@$NEXT" > /dev/null
	echo "    已更新到 $NEXT"
fi

echo "✅ $NEXT 发布完成"
