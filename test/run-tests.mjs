// 离线回归测试：不需要 DSH、不读 ~/.dsh、不联网。
//
//   node test/run-tests.mjs
//
// 覆盖四块：
//   1. package 契约 —— DSH 怎么加载这个包（入口、bundle patch、client、locale）
//   2. 峰谷判定 —— 用固定时刻验证窗口边界、周末、节假日、自定义时区
//   3. Host 路由 —— GET / HEAD / 405、节假日表回退、自检上报
//   4. 客户端 bundle —— 在 vm 里跑 client.js，验 data 属性、<style>、语言切换、清理
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(read(rel))

let failures = 0
function group(label) {
  console.log(`\n${label}`)
}
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---------------------------------------------------------------------------
// 1. package 契约
// ---------------------------------------------------------------------------
group('用例 1：package.json 是 DSH 认得的 bundle')

const pkg = readJson('package.json')
check('名字不带 scope，能被 profile 当包名引用', /^[a-z0-9-]+$/.test(pkg.name), pkg.name)
check('是 ESM', pkg.type === 'module', pkg.type)
check('main 指向仓库里真实存在的入口', pkg.main === 'index.js' && existsSync(join(ROOT, pkg.main)), String(pkg.main))
check('dsh.bundle.patch 指向真实存在的 patch', existsSync(join(ROOT, pkg.dsh?.bundle?.patch ?? 'nope')), String(pkg.dsh?.bundle?.patch))
check('dsh.client 声明为 web 平台并立即加载', pkg.dsh?.client?.platform === 'web' && pkg.dsh?.client?.immediately === true)
check('exports 有 "./client"（浏览器半边按这个路径取）', pkg.exports?.['./client'] === './client.js', String(pkg.exports?.['./client']))
check('files 会把 client.js / 图标 / 节假日表带出去',
  ['index.js', 'client.js', 'cn-holidays.json', 'icon.svg', 'cordis.patch.yml'].every((f) => pkg.files?.includes(f)),
  JSON.stringify(pkg.files))
check('files 不会把 test / tools / examples 发出去',
  !pkg.files?.some((f) => /^(test|tools|examples)\//.test(f)), JSON.stringify(pkg.files))

// ---------------------------------------------------------------------------
// 2. 峰谷判定（固定时刻，Asia/Shanghai）
// ---------------------------------------------------------------------------
const host = await import('../index.js')

/** 北京时间某个时刻的 Date 对象（+08:00 偏移显式写出来，不依赖本机时区）。 */
const at = (iso) => new Date(iso)

const settings = (over = {}) => ({
  timeZone: 'Asia/Shanghai',
  weekdays: [1, 2, 3, 4, 5],
  holidaysPath: '',
  ...over,
  // Keep the normalization last: `over.windows` is still raw text ("00:00"),
  // phaseAt expects minutes.
  windows: host.normalizeWindows(over.windows),
})

const table = (dates = []) => ({ dates: new Set(dates), source: '', error: null })

const phase = (iso, over = {}, dates = []) => {
  const current = settings(over)
  const clock = host.clockAt(current.timeZone, at(iso))
  return { clock, ...host.phaseAt(clock, current, table(dates)) }
}

group('用例 2：窗口边界（2026-11-09 是周一）')
check('08:59 → 低谷 / 窗口之外', phase('2026-11-09T08:59:00+08:00').phase === 'offpeak' && phase('2026-11-09T08:59:00+08:00').reason === 'outside-window')
check('09:00 整 → 高峰（左闭）', phase('2026-11-09T09:00:00+08:00').phase === 'peak')
check('11:59 → 高峰', phase('2026-11-09T11:59:00+08:00').phase === 'peak')
check('12:00 整 → 低谷（右开）', phase('2026-11-09T12:00:00+08:00').phase === 'offpeak')
check('13:00 午休 → 低谷', phase('2026-11-09T13:00:00+08:00').phase === 'offpeak')
check('14:00 → 高峰', phase('2026-11-09T14:00:00+08:00').phase === 'peak')
check('17:59 → 高峰', phase('2026-11-09T17:59:00+08:00').phase === 'peak')
check('18:00 整 → 低谷', phase('2026-11-09T18:00:00+08:00').phase === 'offpeak')
check('00:00 深夜 → 低谷', phase('2026-11-09T00:00:00+08:00').phase === 'offpeak')
check('命中窗口时 reason 是 window', phase('2026-11-09T10:00:00+08:00').reason === 'window')

group('用例 3：周末与节假日')
check('2026-11-07（周六）10:00 → 低谷 / weekend', phase('2026-11-07T10:00:00+08:00').reason === 'weekend')
check('2026-11-08（周日）10:00 → 低谷', phase('2026-11-08T10:00:00+08:00').phase === 'offpeak')
check('2026-10-01（周四）10:00 且表里有这一天 → 低谷 / holiday',
  phase('2026-10-01T10:00:00+08:00', {}, ['2026-10-01']).reason === 'holiday')
check('同一天不放进表 → 高峰（证明是表在起作用）', phase('2026-10-01T10:00:00+08:00').phase === 'peak')
check('节假日判断优先于窗口', phase('2026-10-01T15:00:00+08:00', {}, ['2026-10-01']).reason === 'holiday')
check('周末优先于节假日（理由写成 weekend）', phase('2026-10-03T15:00:00+08:00', {}, ['2026-10-03']).reason === 'weekend')

group('用例 4：时区与自定义窗口')
const utc = host.clockAt('UTC', at('2026-11-09T10:00:00+08:00'))
const sh = host.clockAt('Asia/Shanghai', at('2026-11-09T10:00:00+08:00'))
check('同一瞬间在 UTC 是 02:00', utc.hhmm === '02:00', utc.hhmm)
check('同一瞬间在 Asia/Shanghai 是 10:00', sh.hhmm === '10:00', sh.hhmm)
check('星期几按配置时区算（周一 = 1）', sh.weekday === 1 && utc.weekday === 1)
check('日期在 UTC 下仍是同一天（跨时不跨日）', utc.date === '2026-11-09', utc.date)
const allDay = { windows: [{ start: '00:00', end: '24:00' }] }
check('窗口 00:00–24:00 时 20:00 也算高峰', phase('2026-11-09T20:00:00+08:00', allDay).phase === 'peak')
check('weekdays 为空 → 每天都算周末', phase('2026-11-09T10:00:00+08:00', { weekdays: [] }).reason === 'weekend')
check('"09:60" 这种脏窗口被丢掉后回落到默认窗口', host.normalizeWindows([{ start: '09:60', end: '10:00' }]).length === 2)
check('"9:00"-"12:00" 也能解析', host.minutesOf('9:00') === 540 && host.minutesOf('12:00') === 720)

// ---------------------------------------------------------------------------
// 3. Host 路由协议
// ---------------------------------------------------------------------------
group('用例 5：只读路由 GET /plugin-peak-hint/state')

function makeCtx(config) {
  const routes = new Map()
  const ctx = {
    webServer: { register: (spec) => (routes.set(spec.path, spec.handler), () => {}) },
    effect: (fn) => fn(),
  }
  host.apply(ctx, config)
  const call = (path, method = 'GET') =>
    new Promise((resolve) => {
      let status = 0
      let headers = {}
      let body = ''
      const res = {
        writeHead: (code, extra) => {
          status = code
          headers = extra ?? {}
        },
        end: (chunk) => {
          if (chunk) body += chunk.toString()
          resolve({ status, headers, body })
        },
      }
      routes.get(path.split('?')[0])({ method, url: path }, res)
    })
  return { routes, call }
}

const live = makeCtx({ timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5] })
check('注册了 state 与 ping 两条精确路由',
  [...live.routes.keys()].sort().join(',') === '/plugin-peak-hint/ping,/plugin-peak-hint/state',
  [...live.routes.keys()].join(','))

const stateBefore = await live.call('/plugin-peak-hint/state')
const state = JSON.parse(stateBefore.body)
check('GET 返回 200', stateBefore.status === 200, String(stateBefore.status))
check('带 no-store，别让浏览器缓存峰谷状态', stateBefore.headers['cache-control'] === 'no-store')
check('phase 只能是 peak / offpeak', state.phase === 'peak' || state.phase === 'offpeak', state.phase)
check('reason 是四种已知取值之一', ['weekend', 'holiday', 'window', 'outside-window'].includes(state.reason), state.reason)
check('窗口列表按 HH:MM-HH:MM 回显', Array.isArray(state.windows) && state.windows.every((w) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(w)), JSON.stringify(state.windows))
check('回显时区与本地时间', state.timeZone === 'Asia/Shanghai' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(state.local), state.local)
check('没有上报过时 state 不带 client 字段', state.client === undefined, JSON.stringify(state.client))
check('节假日表留空时用包内副本', state.holidaySource === 'bundled')

const head = await live.call('/plugin-peak-hint/state', 'HEAD')
check('HEAD 返回 200 且没有响应体', head.status === 200 && head.body === '', `${head.status}/${head.body.length}`)

const post = await live.call('/plugin-peak-hint/state', 'POST')
check('POST 返回 405 并在 allow 里写 GET, HEAD', post.status === 405 && post.headers.allow === 'GET, HEAD', `${post.status} ${post.headers.allow}`)

group('用例 6：节假日表读不出来时退回副本并说明原因')
const broken = makeCtx({ timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], holidaysPath: 'Z:/does-not-exist.json' })
const brokenResponse = await broken.call('/plugin-peak-hint/state')
const brokenState = JSON.parse(brokenResponse.body)
check('仍然返回 200（回退而不是报错）', brokenResponse.status === 200, String(brokenResponse.status))
check('回退到 bundled', brokenState.holidaySource === 'bundled', brokenState.holidaySource)
check('holidayError 里带路径与 ENOENT 线索',
  typeof brokenState.holidayError === 'string' && brokenState.holidayError.includes('does-not-exist.json') && /ENOENT/.test(brokenState.holidayError),
  brokenState.holidayError)

group('用例 7：读到配置的表时按表判定')
const dir = mkdtempSync(join(tmpdir(), 'peak-hint-'))
try {
  const today = host.clockAt('Asia/Shanghai', new Date()).date
  const tablePath = join(dir, 'cn-holidays.json')
  writeFileSync(tablePath, JSON.stringify({ [today.slice(0, 4)]: [today] }))
  const configured = makeCtx({ timeZone: 'Asia/Shanghai', weekdays: [0, 1, 2, 3, 4, 5, 6], holidaysPath: tablePath })
  const configuredState = JSON.parse((await configured.call('/plugin-peak-hint/state')).body)
  check('holidaySource 标为 configured', configuredState.holidaySource === 'configured', configuredState.holidaySource)
  check('今天在表里 → 低谷 / holiday', configuredState.phase === 'offpeak' && configuredState.reason === 'holiday', `${configuredState.phase}/${configuredState.reason}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

group('用例 8：自检上报（浏览器半边没有控制台时靠它）')
const ping = await live.call('/plugin-peak-hint/ping?note=ready&phase=peak&applied=1&placeholders=2')
check('ping 返回 204', ping.status === 204, String(ping.status))
check('ping 没有响应体', ping.body === '')
const echoed = JSON.parse((await live.call('/plugin-peak-hint/state')).body)
check('state 回显最近一次上报', echoed.client?.note === 'ready' && echoed.client?.placeholders === '2', JSON.stringify(echoed.client))
check('上报带时间戳', /^\d{4}-\d{2}-\d{2}T/.test(echoed.client?.at ?? ''), echoed.client?.at)
const pingPost = await live.call('/plugin-peak-hint/ping', 'POST')
check('ping 只收 GET，POST 返回 405', pingPost.status === 405, String(pingPost.status))

// ---------------------------------------------------------------------------
// 4. 客户端 bundle
// ---------------------------------------------------------------------------
group('用例 9：client.js 给占位符加属性，不改宿主的文本节点')

const clientSource = read('client.js')

function fakePlatform() {
  const nodes = []
  const makeNode = (text = '') => {
    const node = {
      nodeType: 1,
      textContent: text,
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = String(value)
      },
      removeAttribute(name) {
        delete this.attributes[name]
      },
      getAttribute(name) {
        return this.attributes[name]
      },
      matches(selector) {
        return selector === '[data-composer-placeholder]' && this.isPlaceholder === true
      },
      querySelector() {
        return null
      },
    }
    node.isPlaceholder = true
    return node
  }
  const styleTags = []
  const doc = {
    visibilityState: 'visible',
    body: {},
    head: { appendChild: (tag) => (styleTags.push(tag), tag) },
    createElement: () => {
      const tag = {
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = String(value)
        },
        textContent: '',
        removed: false,
        remove() {
          this.removed = true
        },
      }
      return tag
    },
    querySelectorAll: (selector) => (selector === '[data-composer-placeholder]' ? nodes.slice() : []),
    addEventListener() {},
    removeEventListener() {},
  }
  const locale = {
    active: 'zh-CN',
    listeners: new Set(),
    getSnapshot() {
      return { active: this.active }
    },
    subscribe(fn) {
      this.listeners.add(fn)
      return () => this.listeners.delete(fn)
    },
    switchTo(value) {
      this.active = value
      for (const fn of this.listeners) fn()
    },
  }
  const requests = []
  const observers = []
  const timers = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => (sandbox.definition = definition) } },
    document: doc,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        this.disconnected = false
        observers.push(this)
      }
      observe() {}
      disconnect() {
        this.disconnected = true
      }
      emit(nodes) {
        this.callback([{ addedNodes: nodes }])
      }
    },
    fetch: async (url) => {
      requests.push(String(url))
      return { ok: true, status: 200, json: async () => ({ phase: 'peak' }) }
    },
    URLSearchParams,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms }
      timers.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      if (handle) handle.cleared = true
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox)
  return { sandbox, doc, locale, nodes, makeNode, styleTags, requests, observers, timers }
}

const client = fakePlatform()
const definition = client.sandbox.definition
check('注册的 id 就是包名（模块加载器按它去重）', definition?.id === pkg.name, String(definition?.id))

let cleanup
const module = definition.factory(() => {})
module.apply({
  get: (name) => (name === 'locale' ? client.locale : undefined),
  effect: (fn) => {
    cleanup = fn()
    return () => {}
  },
})

const first = client.makeNode()
client.nodes.push(first)
await new Promise((resolve) => setTimeout(resolve, 0))

check('轮询了 state 路由', client.requests.some((url) => url.includes('/plugin-peak-hint/state')), client.requests.join(','))
check('占位符上设了 data-peak-phase', first.getAttribute('data-peak-phase') === 'peak', String(first.getAttribute('data-peak-phase')))
check('占位符上设了中文提示', first.getAttribute('data-peak-hint') === '现在高峰时段', String(first.getAttribute('data-peak-hint')))
check('没有改动宿主渲染的文本节点', first.textContent === '')
check('插入了 <style data-plugin>', client.styleTags.length === 1 && client.styleTags[0].attributes['data-plugin'] === pkg.name,
  JSON.stringify(client.styleTags.map((tag) => tag.attributes)))
check('CSS 用 ::after 拼出尾句', /::after/.test(client.styleTags[0].textContent) && /attr\(data-peak-hint\)/.test(client.styleTags[0].textContent))

client.locale.switchTo('en-US')
await new Promise((resolve) => setTimeout(resolve, 0))
check('切到英文后换成英文提示', first.getAttribute('data-peak-hint') === 'peak hours now', String(first.getAttribute('data-peak-hint')))

const mounted = client.makeNode()
client.observers[0].emit([mounted])
check('新挂载的输入框会被 MutationObserver 补上属性', mounted.getAttribute('data-peak-phase') === 'peak')

client.observers[0].emit([{ nodeType: 1, matches: () => false, querySelector: () => null }])
check('不含占位符的子树不触发重绘（不会每帧全量扫描）', mounted.getAttribute('data-peak-phase') === 'peak')

const poll = client.timers.find((handle) => handle.ms === 30000)
check('按 30 秒轮询', poll !== undefined)

cleanup()
check('清理后属性被移除', first.getAttribute('data-peak-phase') === undefined)
check('清理后 <style> 被移除', client.styleTags[0].removed === true)
check('清理后断开 MutationObserver', client.observers[0].disconnected === true)
check('清理后取消定时器', poll.cleared === true)

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
