# DSH-PeakHoursHint-WhenSendingMessage

> 给 DSH 的每个输入框加一句「现在高峰时段 / 现在低谷时段」——发消息之前就知道
> 这一条按哪个价计费。零依赖，Host 只读路由，Client 只改属性。

```
描述你想要构建的内容, / 调用指令, @ 文件或对话 · 现在高峰时段
```

DeepSeek 的 API 按北京时间分时定价：工作日两个窗口是高峰价，其余时间（含午休、深夜、
周末、法定节假日）是低谷价。这句话就是把这件"每次发消息都会遇到、但平时看不见"的事
放进你本来就要看的那行浅色提示文字里。

| 状态 | 时间 | 计费 |
|---|---|---|
| 高峰 | 北京时间 周一至周五 09:00–12:00、14:00–18:00，且不是法定节假日 | 高峰价 |
| 低谷 | 其余时间：周末、法定节假日全天、工作日两个窗口之外 | 低谷价（半价档） |

判定规则、时区、窗口、节假日表都可配置，默认值就是上表。

---

## 1. 文件

| 文件 | 作用 |
|---|---|
| [index.js](index.js) | Host 半边：判定峰谷，注册只读路由 `GET /plugin-peak-hint/state` 与自检路由 `GET /plugin-peak-hint/ping` |
| [client.js](client.js) | Client 半边：轮询 Host，给占位符元素加 `data-peak-phase` / `data-peak-hint`，由 CSS 拼出尾句 |
| [cordis.patch.yml](cordis.patch.yml) | 包自带的 patch：插入 `peak-hint` 行，四个配置项都在这里 |
| [cn-holidays.json](cn-holidays.json) | 中国法定节假日表（按年，`{"2026": ["2026-01-01", ...]}`） |
| [locale/en.json](locale/en.json)、[locale/zh.json](locale/zh.json) | 插件管理页显示用的 `meta.title` / `meta.description` |
| [icon.svg](icon.svg) | 插件行图标（自绘） |
| [test/run-tests.mjs](test/run-tests.mjs) | 离线回归：package 契约、峰谷判定、路由协议、客户端 bundle |
| [tools/check-assets.mjs](tools/check-assets.mjs) | 静态资源自检：svg、locale、节假日表、patch、语法 |
| [examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml) | 装进 DSH 的两种写法 |

Host 半边只 import `node:` 内置模块；Client 半边不 import 任何模块（连 `react` 都不用）——
按包名加载的插件解析不到额外的裸包名。

## 2. 装进 DSH

两种方式任选一种，改完**重启 DSH**（Host 半边在启动时装载），再**刷新页面**
（Client 半边在页面加载时取）。括号里的说明见 [examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml)。

**A. 作为包（推荐）**：在 profile 的 `package.json` 里加一条 `link:` 依赖，并把包名加进
`dsh.profile.bundles`。包自带的 patch 会把 Host 行挂上，不需要再手写 `name`。

```json
{
  "dependencies": {
    "dsh-peak-hours-hint": "link:P:/path/to/DSH-PeakHoursHint-WhenSendingMessage"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-peak-hours-hint"]
    }
  }
}
```

**B. 只加 patch 行**：把 snippet 里那段 `- insert:` 追加到
`~/.dsh/profiles/<profile>/cordis.patch.yml`，`name` 写本仓库 `index.js` 的绝对路径。

装好后侧栏插件列表里会出现「峰谷提示 / Peak Hours Hint」，卡片描述来自 `locale/*.json`。

## 3. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `timeZone` | `Asia/Shanghai` | 用哪个时区判定「几点算高峰」 |
| `weekdays` | `[1,2,3,4,5]` | 哪几天算工作日（0=周日 … 6=周六） |
| `windows` | `09:00-12:00`、`14:00-18:00` | 高峰窗口，左闭右开；`24:00` 表示到当天结束 |
| `holidaysPath` | 空 | 空 = 用包内 `cn-holidays.json`；填绝对路径则读那份 |

窗口写错（比如 `09:60`）会被丢掉并回落到默认窗口，不会让整个判定失效。
配置的节假日表读不出来时**退回包内副本**，并在路由返回的 `holidayError` 里说明原因——
不会悄悄把节假日当高峰日。

## 4. 怎么做的（以及为什么这么做）

输入框的占位符是宿主插件 `@deepseek-ai/dsh-client-ui-conversation` 渲染的
`<div data-composer-placeholder>`，slot 目录里**没有**针对这段文字的扩展点；
能替换整个 composer 的 slot（`conversation.composer.bar`）又会盖掉宿主 UI。

所以两个半边各做一半：

- **Host** 只判定，开一条只读路由。已安装 bundle 的浏览器半边用不了 `host.call`
  （那是会话级动态包的通道），只读 GET 路由才是常驻可用的那条。
- **Client** 不改宿主的文本节点：它给占位符元素加两个 data 属性，
  再由一条 CSS 规则拼出尾句 `::after { content: ' · ' attr(data-peak-hint) }`。
  React 重渲染会换掉文本子节点，但不会动它没管过的 data 属性；输入框重新挂载
  （新建会话、草稿恢复）时由 `MutationObserver` 补回属性。

占位符本身的颜色、字号、单行省略、Hero 两行截断都沿用宿主样式，这里只加尾巴。
每 30 秒重新问一次 Host，跨过窗口边界自动换词；页面从后台回到前台时立即刷新。
语言跟随界面语言：中文「现在高峰时段 / 现在低谷时段」，英文 `peak hours now / off-peak hours`。

**踩过的坑**：已安装 bundle 的浏览器半边拿不到 `ctx` / `styles` / `host` 这些内置全局
（那些只提供给会话级动态包）。最初写成 `styles.insert(css)` 时，bundle 能加载、`apply()`
却抛 `ReferenceError`，界面看起来"什么都没发生"。现在样式是一个普通
`<style data-plugin="dsh-peak-hours-hint">` 标签，`apply` 里没有任何依赖内置对象的语句。

## 5. 自检：没有 devtools 时怎么知道浏览器半边有没有跑

桌面壳里看不到控制台，所以 Client 半边会往 `GET /plugin-peak-hint/ping` 上报：
启动成功后报 `note=ready`（带当时的 `phase` 和占位符数量），被加载时抛错则报
`note=effect-failed` 与错误文本。Host 把**最近一次上报**存进内存，随 `state` 一起返回：

```bash
curl -s http://127.0.0.1:12484/plugin-peak-hint/state
# {..., "client": {"at":"...","note":"ready","phase":"peak","applied":"1","placeholders":"1"}}
```

- 没有 `client` 字段 = 这页还没刷新过（浏览器仍在跑旧 bundle）；
- 有 `client.error` = 浏览器半边抛错了，错误文本就在里面。

`GET /plugin-peak-hint/state` 也可以直接 curl，它是纯只读 JSON，`phase` 为
`peak` / `offpeak`，`reason` 为 `weekend` / `holiday` / `window` / `outside-window`。

## 6. 先跑离线测试（不需要装 DSH）

```bash
node test/run-tests.mjs      # 峰谷判定、路由协议、客户端 bundle，全离线
node tools/check-assets.mjs  # svg / locale / 节假日表 / patch / 语法
```

测试用固定时刻验证窗口边界（08:59、09:00、12:00、17:59、18:00…）、周末、节假日，
以及 `client.js` 在 `vm` 里跑起来后的属性、`<style>`、语言切换与清理。
CI 在 `.github/workflows/test.yml`，Node 20。

## 7. 已知边界

- 占位符只在**输入框为空**时出现（宿主逻辑），有草稿时看不到这句话。
- 普通（非 Hero）输入框是单行 `nowrap` + 省略号；窗口极窄时尾巴可能被截断，
  这是宿主布局的结果，不是提示丢失。
- 节假日表是静态数据；每年安排公布后需要更新 `cn-holidays.json`。
- 它只判定**计费窗口**，不判断你这条消息最终走哪个 provider；路由配置若与此规则脱钩，
  这句话也会跟着不准。

## 8. 许可

MIT，见 [LICENSE](LICENSE)。
