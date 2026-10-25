/**
 * 打包前补丁（DEVPLAN 阶段 7）
 *
 * 三处上游问题，都在本机沙箱环境下必然触发；本脚本逐一处理，幂等可重复执行。
 *
 * 1) electron-builder 26.15.3 声明依赖 @electron/get@^3.0.0，
 *    但代码里用了只存在于 5.x 的 ElectronDownloadCacheMode → 打包必崩。
 *    已用 pnpm-workspace.yaml 的 overrides 统一到 5.1.0，本脚本再校验一次。
 *
 * 2) 收集生产依赖时它会用**管道**执行 `pnpm list --json`。
 *    沙箱禁止带管道 stdio 的 spawn（EPERM），这一步必然失败。
 *    本项目没有任何运行期依赖，因此加一个前置判断：无依赖时返回空树。
 *    只是跳过一步"结果必然为空"的工作，不改变打包产物内容。
 *
 * 3) 解压 nsis / winCodeSign 工具包时它用管道调用 7za，同样会被拦下。
 *    改成同步调用 + stdio: 'ignore'（7za 的输出无关紧要）。
 *
 * 用法：node scripts/patch-deps.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PNPM_DIR = join(ROOT, 'node_modules', '.pnpm')

function log(message) {
  process.stdout.write(`${message}\n`)
}

/** 找到 app-builder-lib 的安装目录 */
function findAppBuilderLib() {
  if (!existsSync(PNPM_DIR)) return null
  const entry = readdirSync(PNPM_DIR).find((name) => name.startsWith('app-builder-lib@'))
  if (!entry) return null
  return join(PNPM_DIR, entry, 'node_modules', 'app-builder-lib')
}

const appBuilderLib = findAppBuilderLib()
if (!appBuilderLib) {
  log('跳过：找不到 app-builder-lib（依赖可能尚未安装）')
  process.exit(0)
}

let failed = false

// ---- 补丁 1：校验 @electron/get 版本 ----
const electronGetPkg = join(appBuilderLib, 'node_modules', '@electron', 'get', 'package.json')
if (existsSync(electronGetPkg)) {
  const version = JSON.parse(readFileSync(electronGetPkg, 'utf8')).version
  const major = Number.parseInt(String(version).split('.')[0], 10)
  if (major < 5) {
    log(`警告：app-builder-lib 链接的 @electron/get 是 ${version}，需要 5.x 才能打包。`)
    log('      请确认 pnpm-workspace.yaml 里有 overrides: "@electron/get": 5.1.0，并重新 pnpm install。')
    failed = true
  } else {
    log(`检查通过：@electron/get ${version}`)
  }
}

// ---- 补丁 2：无运行期依赖时跳过 pnpm list ----
const collector = join(appBuilderLib, 'out', 'node-module-collector', 'nodeModulesCollector.js')
const depsMarker = '/* worklife:patched-skip-empty-deps */'

if (!existsSync(collector)) {
  log('跳过补丁 2：找不到 nodeModulesCollector.js')
} else {
  let source = readFileSync(collector, 'utf8')
  if (source.includes(depsMarker)) {
    log('补丁 2 已存在')
  } else {
    const anchor = `    async getDependenciesTree(pm) {
        const command = (0, packageManager_1.getPackageManagerCommand)(pm);`
    if (!source.includes(anchor)) {
      log('警告：nodeModulesCollector.js 结构与预期不符，未打补丁 2')
    } else {
      source = source.replace(
        anchor,
        `    async getDependenciesTree(pm) {
        ${depsMarker}
        // 本项目没有运行期依赖，依赖树必然是空的，无需执行包管理器命令
        try {
            const _pkg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(this.rootDir, 'package.json'), 'utf8'));
            const _depCount = Object.keys(_pkg.dependencies || {}).length;
            if (_depCount === 0) {
                builder_util_1.log.info('no runtime dependencies, skipping package manager dependency collection');
                return { dependencies: {} };
            }
        }
        catch (_e) { /* 读不到 package.json 时按原逻辑继续 */ }
        const command = (0, packageManager_1.getPackageManagerCommand)(pm);`
      )
      writeFileSync(collector, source, 'utf8')
      log('已打补丁 2：无运行期依赖时跳过 pnpm 依赖收集')
    }
  }
}

// ---- 补丁 3：7z 解压不用管道 ----
const electronGet = join(appBuilderLib, 'out', 'util', 'electronGet.js')
const sevenZipMarker = '/* worklife:patched-7z-stdio */'

if (!existsSync(electronGet)) {
  log('跳过补丁 3：找不到 electronGet.js')
} else {
  let getSource = readFileSync(electronGet, 'utf8')
  if (getSource.includes(sevenZipMarker)) {
    log('补丁 3 已存在')
  } else {
    const sevenZipAnchor = `await (0, builder_util_1.exec)(cmd7za, ["x", "-bd", file, (0, builder_util_1.to7zaOutputSwitch)((0, builder_util_1.sanitizeDirPath)(tmpDir)), "-y"]);`
    if (!getSource.includes(sevenZipAnchor)) {
      log('警告：未找到 7z 解压调用，未打补丁 3')
    } else {
      getSource = getSource.replace(
        sevenZipAnchor,
        `${sevenZipMarker}
                // 本机沙箱禁止带管道 stdio 的 spawn；
                // 7za 是命令行工具，输出无关紧要，用 ignore 即可。
                require('node:child_process').execFileSync(cmd7za, ["x", "-bd", file, \`-o\${tmpDir}\`, "-y"], { stdio: 'ignore' });`
      )
      writeFileSync(electronGet, getSource, 'utf8')
      log('已打补丁 3：7z 解压改用 execFileSync（stdio: ignore）')
    }
  }
}

// ---- 补丁 4：打 app 压缩包时同样不用管道 ----
const archiveFile = join(appBuilderLib, 'out', 'targets', 'archive.js')
const archiveMarker = '/* worklife:patched-archive-stdio */'

if (!existsSync(archiveFile)) {
  log('跳过补丁 4：找不到 archive.js')
} else {
  let archiveSource = readFileSync(archiveFile, 'utf8')
  if (archiveSource.includes(archiveMarker)) {
    log('补丁 4 已存在')
  } else {
    const archiveAnchor = `await (0, builder_util_1.exec)(await (0, _7zip_1.getPath7za)(), args, { cwd: options.withoutDir ? dirToArchive : path.dirname(dirToArchive) }, builder_util_1.debug7z.enabled);`
    if (!archiveSource.includes(archiveAnchor)) {
      log('警告：未找到打压缩包的调用，未打补丁 4')
    } else {
      archiveSource = archiveSource.replace(
        archiveAnchor,
        `${archiveMarker}
            // 沙箱禁止带管道 stdio 的 spawn；用同步执行 + ignore 输出即可。
            // 7za 的结果靠 outFile 是否存在与大小来判断，不需要读它的 stdout。
            {
                const _cp = require('node:child_process');
                const _r = _cp.spawnSync(await (0, _7zip_1.getPath7za)(), args, {
                    cwd: options.withoutDir ? dirToArchive : path.dirname(dirToArchive),
                    stdio: 'ignore'
                });
                if (_r.error) throw _r.error;
                if (typeof _r.status === 'number' && _r.status !== 0) {
                    throw Object.assign(new Error('7za exited with code ' + _r.status), { code: 'E7ZA' });
                }
            }`
      )
      writeFileSync(archiveFile, archiveSource, 'utf8')
      log('已打补丁 4：打 app 压缩包改用 spawnSync（stdio: ignore）')
    }
  }
}

// ---- 补丁 5：子进程默认不用管道（makensis 等）----
const builderUtilFile = (() => {
  const entry = existsSync(PNPM_DIR)
    ? readdirSync(PNPM_DIR).find((name) => name.startsWith('builder-util@'))
    : undefined
  return entry ? join(PNPM_DIR, entry, 'node_modules', 'builder-util', 'out', 'util.js') : null
})()

const spawnMarker = '/* worklife:patched-spawn-stdio */'

if (!builderUtilFile || !existsSync(builderUtilFile)) {
  log('跳过补丁 5：找不到 builder-util/out/util.js')
} else {
  let utilSource = readFileSync(builderUtilFile, 'utf8')
  if (utilSource.includes(spawnMarker)) {
    log('补丁 5 已存在')
  } else {
    const spawnAnchor = `        options.stdio = [extraOptions != null && extraOptions.isPipeInput ? "pipe" : "ignore", isDebugEnabled ? "inherit" : "pipe", isDebugEnabled ? "inherit" : "pipe"];`
    if (!utilSource.includes(spawnAnchor)) {
      log('警告：未找到 doSpawn 的 stdio 设置，未打补丁 5')
    } else {
      utilSource = utilSource.replace(
        spawnAnchor,
        `        ${spawnMarker}
        // 本机沙箱禁止带管道 stdio 的 spawn，因此输出一律走 inherit（直接打到控制台）。
        // 退出码判断不受影响，只是失败时错误信息里不再附带 stdout。
        options.stdio = [extraOptions != null && extraOptions.isPipeInput ? "pipe" : "ignore", "inherit", "inherit"];`
      )
      writeFileSync(builderUtilFile, utilSource, 'utf8')
      log('已打补丁 5：子进程输出改用 inherit')
    }
  }
}

// ---- 补丁 6：makensis 用 inherit 输出（脚本仍通过 stdin 传入）----
const spawnOutMarker = '/* worklife:patched-spawn-output */'

if (!builderUtilFile || !existsSync(builderUtilFile)) {
  log('跳过补丁 6：找不到 builder-util/out/util.js')
} else {
  let utilSource2 = readFileSync(builderUtilFile, 'utf8')
  if (utilSource2.includes(spawnOutMarker)) {
    log('补丁 6 已存在')
  } else {
    const spawnOutAnchor = `    const childProcess = doSpawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });`
    if (!utilSource2.includes(spawnOutAnchor)) {
      log('警告：未找到 spawnAndWriteWithOutput 的 stdio，未打补丁 6')
    } else {
      utilSource2 = utilSource2.replace(
        spawnOutAnchor,
        `    ${spawnOutMarker}
    // 脚本仍通过 stdin 传入（makensis 需要），但 stdout/stderr 改为 inherit：
    // 沙箱禁止带管道 stdout 的 spawn，而 makensis 的输出只是日志，
    // 真正的成功判据是安装包文件是否生成（exec 之后另有大小校验）。
    const childProcess = doSpawn(command, args, { ...options, stdio: ["pipe", "inherit", "inherit"] });`
      )
      writeFileSync(builderUtilFile, utilSource2, 'utf8')
      log('已打补丁 6：makensis 输出改用 inherit')
    }
  }
}

// ---- 补丁 7：stdin 一律 ignore（沙箱只拒绝管道 stdin）----
if (!builderUtilFile || !existsSync(builderUtilFile)) {
  log('跳过补丁 7：找不到 builder-util/out/util.js')
} else {
  let utilSource3 = readFileSync(builderUtilFile, 'utf8')
  if (utilSource3.includes('worklife:patched-stdin-ignore')) {
    log('补丁 7 已存在')
  } else {
    const stdinAnchor = `        options.stdio = [extraOptions != null && extraOptions.isPipeInput ? "pipe" : "ignore", "inherit", "inherit"];`
    if (!utilSource3.includes(stdinAnchor)) {
      log('警告：未找到 stdio 设置，未打补丁 7')
    } else {
      utilSource3 = utilSource3.replace(
        stdinAnchor,
        `        // worklife:patched-stdin-ignore
        // 经实测：本机沙箱只拒绝"管道 stdin"的 spawn（stdout/stderr 用管道反而不受影响）。
        // 因此 stdin 一律 ignore；需要脚本输入的 makensis 改由文件读取（见补丁 8）。
        options.stdio = ["ignore", "inherit", "inherit"];`
      )
      writeFileSync(builderUtilFile, utilSource3, 'utf8')
      log('已打补丁 7：stdin 一律 ignore')
    }
  }
}

// ---- 补丁 8：makensis 改为从文件读脚本 ----
const nsisTargetFile = join(appBuilderLib, 'out', 'targets', 'nsis', 'NsisTarget.js')
const nsisMarker = '/* worklife:patched-makensis-file-input */'

if (!existsSync(nsisTargetFile)) {
  log('跳过补丁 8：找不到 NsisTarget.js')
} else {
  let nsisSource = readFileSync(nsisTargetFile, 'utf8')
  if (nsisSource.includes(nsisMarker)) {
    log('补丁 8 已存在')
  } else {
    const nsisAnchor = `        args.push("-");
        if (this.packager.debugLogger.isEnabled) {
            this.packager.debugLogger.add("nsis.script", script);
        }`
    if (!nsisSource.includes(nsisAnchor)) {
      log('警告：未找到 makensis 参数拼装处，未打补丁 8')
    } else {
      nsisSource = nsisSource.replace(
        nsisAnchor,
        `        ${nsisMarker}
        // 不能用 "-" 让 makensis 从 stdin 读脚本：本机沙箱拒绝管道 stdin。
        // 改成把脚本写进文件再传路径；文件必须放在 NSIS 模板目录里，
        // 因为脚本里有 !include "common.nsh" 这样的相对引用（cwd 也在此）。
        const _worklifeCp = require('node:child_process');
        const _worklifeFs = require('node:fs');
        const _worklifePath = require('node:path');
        const _worklifeScriptFile = _worklifePath.join(
            nsisUtil_1.nsisTemplatesDir,
            '.worklife-installer-' + process.pid + '-' + Date.now() + '.nsi'
        );
        _worklifeFs.writeFileSync(_worklifeScriptFile, script, 'utf8');
        args.push(_worklifeScriptFile);
        if (this.packager.debugLogger.isEnabled) {
            this.packager.debugLogger.add("nsis.script", script);
        }`
      )

      const spawnAnchor = `        const { stdout, stderr } = await (0, builder_util_1.spawnAndWriteWithOutput)(makensis.path, args, script, {
            env: { ...process.env, ...((_b = makensis.env) !== null && _b !== void 0 ? _b : {}) },
            cwd: nsisUtil_1.nsisTemplatesDir,
        });`
      if (!nsisSource.includes(spawnAnchor)) {
        log('警告：未找到 makensis 调用处，仅完成了脚本写入部分')
      } else {
        nsisSource = nsisSource.replace(
          spawnAnchor,
          `        // 同步执行 + 全部 inherit：标准输出直接进控制台，出错时凭退出码判断。
        // 真正的成功判据是安装包文件是否生成（下面还有大小校验）。
        const _worklifeResult = _worklifeCp.spawnSync(makensis.path, args, {
            env: { ...process.env, ...((_b = makensis.env) !== null && _b !== void 0 ? _b : {}) },
            cwd: nsisUtil_1.nsisTemplatesDir,
            stdio: ['ignore', 'inherit', 'inherit']
        });
        const stdout = '';
        const stderr = '';
        if (_worklifeResult.error) {
            throw _worklifeResult.error;
        }
        if (typeof _worklifeResult.status === 'number' && _worklifeResult.status !== 0) {
            throw Object.assign(new Error('makensis exited with code ' + _worklifeResult.status), { code: 'EMAKENSIS' });
        }`
        )
        writeFileSync(nsisTargetFile, nsisSource, 'utf8')
        log('已打补丁 8：makensis 改为从文件读脚本并同步执行')
      }
    }
  }
}

// ---- 补丁 9：解包到最终目录时，旧目录改名让路而不是尝试删除 ----
const getFile2 = join(appBuilderLib, 'out', 'util', 'electronGet.js')
const renameMarker = '/* worklife:patched-rename-with-retry */'

if (!existsSync(getFile2)) {
  log('跳过补丁 9：找不到 electronGet.js')
} else {
  let getSource2 = readFileSync(getFile2, 'utf8')
  if (getSource2.includes(renameMarker)) {
    log('补丁 9 已存在')
  } else {
    const renameAnchor = `await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(tmpDir, dir);`
    const tmpRmAnchor = `        // rm + mkdir happen AFTER acquiring the lock so no concurrent caller can clear our tmpDir mid-extraction
        await fs.rm(tmpDir, { recursive: true, force: true });
        await fs.mkdir(tmpDir, { recursive: true });`
    // 允许前导空白差异（文件被上一轮补丁改动过）
    const renamePattern = /^\s*await fs\.rm\(dir, \{ recursive: true, force: true \}\);\r?\n\s*await fs\.rename\(tmpDir, dir\);$/m
    if (!renamePattern.test(getSource2)) {
      log('警告：未找到解包改名的调用，未打补丁 9')
    } else {
      getSource2 = getSource2.replace(
        tmpRmAnchor,
        `        // rm + mkdir happen AFTER acquiring the lock so no concurrent caller can clear our tmpDir mid-extraction
        // worklife:patched-extract-in-place
        // 本机沙箱不允许把"刚解包出来的目录"改名（rename 一律 EPERM），
        // 因此干脆不建 .tmp 子目录，直接解包到最终目录，
        // 也就完全不需要后面那次 rename。tmpDir 重新指向目标目录本身。
        const _worklifeTarget = dir;
        tmpDir = _worklifeTarget;
        if (await (0, builder_util_1.exists)(_worklifeTarget)) {
            const _parkedOld = _worklifeTarget + '-old-' + Date.now();
            try {
                await fs.rename(_worklifeTarget, _parkedOld);
                try {
                    await fs.rm(_parkedOld, { recursive: true, force: true });
                }
                catch (_e) {
                    builder_util_1.log.warn({ dir: _parkedOld }, 'could not remove the parked directory; leaving it in place');
                }
            }
            catch (_e) {
                try {
                    await fs.rm(_worklifeTarget, { recursive: true, force: true });
                }
                catch (_e2) {
                    builder_util_1.log.warn({ dir: _worklifeTarget }, 'could not clear the previous output directory');
                }
            }
        }
        await fs.mkdir(_worklifeTarget, { recursive: true });`
      )
      getSource2 = getSource2.replace(
        renamePattern,
        `        ${renameMarker}
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
        }`
      )
      writeFileSync(getFile2, getSource2, 'utf8')
      log('已打补丁 9：解包改名与 .tmp 清理改为"让路 + 重试"')
    }
  }
}

// ---- 补丁 10：删除 default_app.asar 时先改名让路 ----
const frameworkFile = join(appBuilderLib, 'out', 'electron', 'ElectronFramework.js')
const defaultAppMarker = '/* worklife:patched-park-default-app */'

if (!existsSync(frameworkFile)) {
  log('跳过补丁 10：找不到 ElectronFramework.js')
} else {
  let frameworkSource = readFileSync(frameworkFile, 'utf8')
  if (frameworkSource.includes(defaultAppMarker)) {
    log('补丁 10 已存在')
  } else {
    const defaultAppAnchor = `        isFullCleanup ? (0, builder_util_1.unlinkIfExists)(path.join(resourcesPath, "default_app.asar")) : Promise.resolve(),`
    if (!frameworkSource.includes(defaultAppAnchor)) {
      log('警告：未找到 default_app.asar 的清理调用，未打补丁 10')
    } else {
      frameworkSource = frameworkSource.replace(
        defaultAppAnchor,
        `        ${defaultAppMarker}
        // 本机环境下 default_app.asar 会被系统组件（杀毒实时扫描等）持续占用，
        // unlinkIfExists 因此抛 EBUSY 让整个打包失败。这里改成"改名让路"：
        // 改名成功后删不删都行，删不掉就留着（那个文件对运行没有影响）。
        isFullCleanup ? (async () => {
            const _da = path.join(resourcesPath, "default_app.asar");
            if (!(await (0, builder_util_1.exists)(_da))) return;
            try {
                const _parkedDa = _da + '.removed-' + Date.now();
                await fs_extra_1.rename(_da, _parkedDa);
                await (0, builder_util_1.unlinkIfExists)(_parkedDa).catch(() => {});
            }
            catch (_e) {
                builder_util_1.log.warn({ file: _da }, 'could not remove default_app.asar; leaving it in place');
            }
        })() : Promise.resolve(),`
      )
      writeFileSync(frameworkFile, frameworkSource, 'utf8')
      log('已打补丁 10：default_app.asar 改为改名让路')
    }
  }
}

process.exit(failed ? 1 : 0)
