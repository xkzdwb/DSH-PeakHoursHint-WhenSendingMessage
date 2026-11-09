// 静态资源自检：不跑插件，只查文件本身对不对。适合 CI 与提交前的一眼确认。
//
//   node tools/check-assets.mjs
//
// 查六件事：
//   1. icon.svg 是合法 SVG，且带 viewBox（插件行图标用得到）
//   2. locale/*.json 是合法 JSON，meta.title / meta.description 非空，中英齐全
//   3. package.json 的 exports/files 覆盖 locale、client、patch 与节假日表
//   4. cordis.patch.yml 里的包名与 package.json 一致，且没有写死本机绝对路径
//   5. client.js 里 __ModuleLoader__ 的 id 与包名一致，data-plugin 标签也是
//   6. index.js / client.js 都能通过 node --check（语法即可，不加载）
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const pkg = JSON.parse(read('package.json'))

console.log('icon.svg')
const icon = read('icon.svg')
check('以 <svg 开头', /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(icon), icon.slice(0, 40))
check('带 viewBox（缩放不自适应会糊）', /viewBox\s*=/.test(icon))
check('是闭合的 <svg>', /<\/svg>\s*$/.test(icon.trimEnd()))
check('没有外部引用', !/href\s*=\s*["']https?:/i.test(icon))

console.log('\nlocale')
const localeFiles = readdirSync(join(ROOT, 'locale')).filter((name) => name.endsWith('.json')).sort()
check('至少 en / zh 两种语言', localeFiles.join(',') === 'en.json,zh.json', localeFiles.join(','))
const titles = new Set()
for (const file of localeFiles) {
  let parsed
  try {
    parsed = JSON.parse(read(`locale/${file}`))
  } catch (error) {
    check(`${file} 是合法 JSON`, false, String(error.message))
    continue
  }
  check(`${file} 是合法 JSON`, true)
  check(`${file} 有非空 meta.title`, typeof parsed.meta?.title === 'string' && parsed.meta.title.trim().length > 0,
    JSON.stringify(parsed.meta?.title))
  check(`${file} 有非空 meta.description`,
    typeof parsed.meta?.description === 'string' && parsed.meta.description.trim().length > 0)
  check(`${file} 没有多余字段`, Object.keys(parsed).join(',') === 'meta', Object.keys(parsed).join(','))
  titles.add(parsed.meta?.title)
}
check('各语言标题互不相同（不是复制没改）', titles.size === localeFiles.length, [...titles].join(' / '))

console.log('\ncn-holidays.json')
let holidays = null
try {
  holidays = JSON.parse(read('cn-holidays.json'))
  check('是合法 JSON', true)
} catch (error) {
  check('是合法 JSON', false, String(error.message))
}
if (holidays !== null) {
  const years = Object.keys(holidays).filter((key) => !key.startsWith('_'))
  check('至少覆盖 2026', years.includes('2026'), years.join(','))
  check('每个年份都是 YYYY 四位数字', years.every((year) => /^\d{4}$/.test(year)), years.join(','))
  const days = years.flatMap((year) => holidays[year])
  check('每天的写法都是 YYYY-MM-DD', days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)), days.slice(0, 3).join(','))
  check('每年都是非空数组', years.every((year) => Array.isArray(holidays[year]) && holidays[year].length > 0))
}

console.log('\npackage.json 覆盖')
check('exports 覆盖 client.js', pkg.exports?.['./client'] === './client.js', String(pkg.exports?.['./client']))
check('exports 覆盖 cordis.patch.yml', pkg.exports?.['./cordis.patch.yml'] === './cordis.patch.yml')
check('exports 覆盖 cn-holidays.json（Host 半边按相对路径直接读）', Boolean(pkg.exports?.['./cn-holidays.json']))
check('exports 覆盖 locale/*.json', Boolean(pkg.exports?.['./locale/*.json']))
check('files 覆盖 client.js / 图标 / 节假日表',
  ['client.js', 'icon.svg', 'cn-holidays.json', 'cordis.patch.yml'].every((f) => pkg.files?.includes(f)),
  JSON.stringify(pkg.files))
check('files 不会把 test / tools / examples 发出去',
  !pkg.files?.some((f) => /^(test|tools|examples)\//.test(f)), JSON.stringify(pkg.files))

console.log('\ncordis.patch.yml')
const patch = read('cordis.patch.yml')
check(`patch 里的 name 是 '${pkg.name}'`, patch.includes(`name: '${pkg.name}'`), pkg.name)
check('patch 里没有写死本机绝对路径（发布版用包内节假日表）',
  !/[A-Za-z]:[\\/]/.test(patch), (patch.match(/[A-Za-z]:[\\/][^\s']*/) ?? []).join(','))
check('patch 里有 insert 行', /^-\s*insert:/m.test(patch))

console.log('\nclient.js 的注册 id')
const clientSource = read('client.js')
check('__ModuleLoader__ 的 id 与包名一致', clientSource.includes(`id: '${pkg.name}'`), pkg.name)
check('样式标签的 data-plugin 与包名一致', clientSource.includes(`setAttribute('data-plugin', '${pkg.name}')`))
check('bundle 里没有引用 styles / host 这类只给动态包的全局',
  !/\bstyles\.(insert|remove)\b/.test(clientSource) && !/\bhost\.call\b/.test(clientSource))

console.log('\n语法')
// Electron 里 process.execPath 是应用自身，直接 spawn 可能被拒（EPERM）；
// 依次退到 PATH 上的 node。都没有时如实报告「没检查」，不假装通过。
const candidates = [process.execPath, 'node']
let skipped = 0
for (const file of ['index.js', 'client.js']) {
  let ok = false
  let detail = ''
  let ran = false
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--check', join(ROOT, file)], {
        stdio: 'pipe',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      ok = true
      ran = true
      break
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EPERM' || error.code === 'EACCES') {
        detail = `${candidate}: ${error.code}`
        continue
      }
      detail = String(error.stderr ?? error.message).split('\n').slice(0, 3).join(' ')
      ran = true
      break
    }
  }
  if (!ran) {
    skipped += 1
    console.log(`  skip ${file}（本机没有可直接调用的 node：${detail}）`)
    continue
  }
  check(`${file} 通过 node --check`, ok, detail)
}
if (skipped > 0) console.log(`  注意：${skipped} 个文件未做语法检查，可用 \`node test/run-tests.mjs\` 覆盖（它会加载这两个文件）`)

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
