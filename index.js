// peak-hint — Host half: decide whether right now is DeepSeek's peak (full-price)
// window or the off-peak (discounted) window, and answer one read-only web route
// that the Client half polls for the composer placeholder.
//
// Rules match 01-时间路由/llm-time-router.js:
//   peak    = Asia/Shanghai, Mon–Fri, 09:00–12:00 or 14:00–18:00,
//             excluding China's statutory holidays (those bill at off-peak rates)
//   off-peak = everything else: weekends, holidays, and the time between windows.
//
// Why a web route instead of host.call: an installed bundle's browser half is an
// ordinary Cordis client plugin, and `host.call` belongs to session-scoped dynamic
// packages (cordis_define). A read-only GET route on the existing web server is the
// channel that needs no code generation — same pattern as 04-统计插件/index.js.
//
// This file imports no third-party package: a plugin loaded by absolute path cannot
// resolve bare specifiers, so only `node:` builtins are used.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'peak-hint'
export const inject = ['webServer']

/** Fixed in both halves; not configurable so the two can never disagree. */
const ROUTE_PATH = '/plugin-peak-hint/state'

/**
 * The Client half is a plain browser module with no console anyone can read from
 * here, so it reports "I ran" or "I threw" back over this route and the state
 * response echoes the last report. That is the only way to tell a broken client
 * from a client that never loaded.
 */
const PING_PATH = '/plugin-peak-hint/ping'

/** Last report from the Client half; null until a browser page calls PING_PATH. */
let lastClientReport = null

const REPORT_LIMIT = 300

function reportField(params, key) {
  const raw = params.get(key)
  return raw === null || raw.length === 0 ? undefined : raw.slice(0, REPORT_LIMIT)
}

const DEFAULTS = {
  timeZone: 'Asia/Shanghai',
  weekdays: [1, 2, 3, 4, 5],
  windows: [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  // Empty = the copy bundled next to this file. Point it at 01-时间路由's table to
  // keep one source of truth; an unreadable path falls back to the bundled copy.
  holidaysPath: '',
}

/** cordis config values may arrive as live refs (`.get()`) or plain values. */
function value(input, fallback) {
  const raw = input !== null && typeof input === 'object' && typeof input.get === 'function' ? input.get() : input
  return raw === undefined || raw === null ? fallback : raw
}

function list(input, fallback) {
  const raw = value(input, fallback)
  return Array.isArray(raw) ? raw : fallback
}

function str(input, fallback) {
  const text = value(input, fallback)
  return typeof text === 'string' && text.length > 0 ? text : fallback
}

/** "09:00" → 540 (minutes since midnight); undefined when unparseable. */
export function minutesOf(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 24 || minute > 59) return undefined
  return hour * 60 + minute
}

/** Normalize window specs to minute ranges; "24:00" ends the day. */
export function normalizeWindows(config) {
  const specified = list(config, DEFAULTS.windows)
  const windows = []
  for (const entry of specified) {
    if (entry === null || typeof entry !== 'object') continue
    const start = minutesOf(entry.start ?? '')
    const end = minutesOf(entry.end ?? '')
    if (start === undefined || end === undefined || end <= start) continue
    windows.push({ start, end })
  }
  return windows.length === 0 ? DEFAULTS.windows : windows
}

export function readSettings(config) {
  return {
    timeZone: str(value(config, {}).timeZone, DEFAULTS.timeZone),
    weekdays: list(value(config, {}).weekdays, DEFAULTS.weekdays)
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    windows: normalizeWindows(value(config, {}).windows),
    holidaysPath: str(value(config, {}).holidaysPath, ''),
  }
}

/** Date, weekday and minute-of-day in the configured time zone. */
export function clockAt(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at)
  const field = {}
  for (const part of parts) field[part.type] = part.value
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[field.weekday]
  return {
    date: `${field.year}-${field.month}-${field.day}`,
    weekday: weekday === undefined ? -1 : weekday,
    minutes: Number(field.hour) * 60 + Number(field.minute),
    hhmm: `${field.hour}:${field.minute}`,
  }
}

const BUNDLED_HOLIDAYS = fileURLToPath(new URL('./cn-holidays.json', import.meta.url))

/** Parse a table shaped like {"2026": ["2026-01-01", ...]}; throws on bad input. */
export function parseHolidays(source) {
  const data = JSON.parse(readFileSync(source, 'utf8'))
  const dates = new Set()
  for (const [key, days] of Object.entries(data)) {
    if (key.startsWith('_') || !Array.isArray(days)) continue
    for (const day of days) if (typeof day === 'string') dates.add(day)
  }
  return dates
}

function readBundledHolidays() {
  try {
    return { dates: parseHolidays(BUNDLED_HOLIDAYS), source: BUNDLED_HOLIDAYS, error: null }
  } catch (error) {
    return { dates: new Set(), source: BUNDLED_HOLIDAYS, error: String(error?.message ?? error) }
  }
}

/**
 * Holidays from the configured table, or from the copy bundled with this plugin
 * when the path is empty or unreadable. A configured path that broke is reported
 * back so it can be diagnosed instead of silently billing holidays as peak days.
 */
function readHolidays(path) {
  if (!path) return readBundledHolidays()
  try {
    return { dates: parseHolidays(path), source: path, error: null }
  } catch (error) {
    return { ...readBundledHolidays(), error: `configured table ${path}: ${String(error?.message ?? error)}` }
  }
}

// A configured path may live on a slow drive; keep the parsed set for a minute.
// Keyed by path so a config reload never reuses another table.
let holidayCache = { key: '', at: 0, value: undefined }

function holidays(settings, nowMs) {
  const key = settings.holidaysPath || '<bundled>'
  if (holidayCache.value !== undefined && holidayCache.key === key && nowMs - holidayCache.at < 60000) {
    return holidayCache.value
  }
  const loaded = readHolidays(settings.holidaysPath)
  holidayCache = { key, at: nowMs, value: loaded }
  return loaded
}

export function phaseAt(clock, settings, table) {
  if (!settings.weekdays.includes(clock.weekday)) return { phase: 'offpeak', reason: 'weekend' }
  if (table.dates.has(clock.date)) return { phase: 'offpeak', reason: 'holiday' }
  for (const window of settings.windows) {
    if (clock.minutes >= window.start && clock.minutes < window.end) return { phase: 'peak', reason: 'window' }
  }
  return { phase: 'offpeak', reason: 'outside-window' }
}

function pad(minutes) {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0')
  const minute = String(minutes % 60).padStart(2, '0')
  return `${hour}:${minute}`
}

export function apply(ctx, config) {
  const settings = () => readSettings(config)

  const respond = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    let payload
    try {
      const current = settings()
      const now = new Date()
      const clock = clockAt(current.timeZone, now)
      const table = holidays(current, now.getTime())
      const state = phaseAt(clock, current, table)
      payload = {
        phase: state.phase,
        reason: state.reason,
        at: now.toISOString(),
        local: `${clock.date} ${clock.hhmm}`,
        timeZone: current.timeZone,
        windows: current.windows.map((window) => `${pad(window.start)}-${pad(window.end)}`),
        holidaySource: table.source === BUNDLED_HOLIDAYS ? 'bundled' : 'configured',
      }
      if (table.error !== null) payload.holidayError = table.error
      if (lastClientReport !== null) payload.client = lastClientReport
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      return
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: respond,
      }),
    'peak-hint: state route',
  )

  const ping = (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    const params = new URL(req.url, 'http://localhost').searchParams
    lastClientReport = {
      at: new Date().toISOString(),
      note: reportField(params, 'note'),
      phase: reportField(params, 'phase'),
      applied: reportField(params, 'applied'),
      placeholders: reportField(params, 'placeholders'),
      error: reportField(params, 'error'),
    }
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PING_PATH,
        handler: ping,
      }),
    'peak-hint: client report route',
  )

  console.warn(`[peak-hint] serving GET ${ROUTE_PATH} and GET ${PING_PATH}`)
}
