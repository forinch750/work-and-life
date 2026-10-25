/**
 * 修复 electronGet.js 的补丁损坏（DEVPLAN 阶段 7 的一次性修复）
 *
 * 背景：早前用 PowerShell 手工撤销补丁时，只删掉了一部分注入代码，
 * 导致 `_renamed` 变量失去声明、结构不完整。
 * 本脚本把该处严格改回完整形式（含补丁 9 的"旧目录让路 + 重试"）。
 *
 * 幂等：修好后再跑不会有变化。
 * 用法：node scripts/fix-electron-get.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PNPM_DIR = join(ROOT, 'node_modules', '.pnpm')

function log(message) {
  process.stdout.write(`${message}\n`)
}

const entry = existsSync(PNPM_DIR)
  ? readdirSync(PNPM_DIR).find((name) => name.startsWith('app-builder-lib@'))
  : undefined
if (!entry) {
  log('找不到 app-builder-lib，跳过')
  process.exit(0)
}

const file = join(PNPM_DIR, entry, 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js')
if (!existsSync(file)) {
  log('找不到 electronGet.js，跳过')
  process.exit(0)
}

let source = readFileSync(file, 'utf8')

const BROKEN = `        const extractedFiles = await fs.readdir(tmpDir);
        if (extractedFiles.length === 0) {
            throw new Error(\`Extraction of \${path.basename(file)} produced no files\`);
        }
                await fs.rename(tmpDir, dir);
                _renamed = true;
            }
            catch (error) {
                if (_attempt === 4) throw error;
                builder_util_1.log.warn({ attempt: _attempt + 1, tmpDir, dir }, 'rename failed, retrying');
                await new Promise(r => setTimeout(r, 1500 * (_attempt + 1)));
            }
        }
`

const FIXED = `        const extractedFiles = await fs.readdir(tmpDir);
        if (extractedFiles.length === 0) {
            throw new Error(\`Extraction of \${path.basename(file)} produced no files\`);
        }
        /* worklife:patched-rename-with-retry */
        // 本机环境下，上一轮解包出来的文件会被系统组件（杀毒实时扫描等）持续占用，
        // 于是 fs.rm(dir) 会静默失败（force: true 不抛错），目录仍然存在，
        // 紧接着的 rename 就会因为"目标已存在且非空"而报 EPERM/EBUSY。
        // 解决：把旧目录改名让路（改名只需要目录项，不要求里面没有打开的文件），
        // 再重试改名本身；清理旧目录失败不影响本次构建。
        if (await (0, builder_util_1.exists)(dir)) {
            const _parked = dir + '-old-' + Date.now();
            try {
                await fs.rename(dir, _parked);
                builder_util_1.log.info({ from: dir, to: _parked }, 'previous output renamed aside');
                try {
                    await fs.rm(_parked, { recursive: true, force: true });
                }
                catch (_e) {
                    builder_util_1.log.warn({ dir: _parked }, 'could not remove the parked directory; leaving it in place');
                }
            }
            catch (_e) {
                await fs.rm(dir, { recursive: true, force: true });
            }
        }
        let _renamed = false;
        for (let _attempt = 0; _attempt < 5 && !_renamed; _attempt += 1) {
            try {
                await fs.rename(tmpDir, dir);
                _renamed = true;
            }
            catch (error) {
                if (_attempt === 4) throw error;
                builder_util_1.log.warn({ attempt: _attempt + 1, tmpDir, dir }, 'rename failed, retrying');
                await new Promise(r => setTimeout(r, 1500 * (_attempt + 1)));
            }
        }
`

if (source.includes(BROKEN)) {
  source = source.replace(BROKEN, FIXED)
  writeFileSync(file, source, 'utf8')
  log('已修复 electronGet.js 的改名逻辑')
} else if (source.includes('worklife:patched-rename-with-retry')) {
  log('electronGet.js 已是修复后的状态，跳过')
} else {
  log('警告：未识别出损坏片段，请人工检查 electronGet.js')
  process.exit(1)
}
