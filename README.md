# Qi-Blog-YM

**语暮的技术手记**是一套以原生 HTML、CSS 与 JavaScript 构建的静态个人博客。项目无需安装依赖或运行构建流程，双击 `index.html` 即可浏览。

## 页面与资源

首页以星图呈现站点栏目；文章页提供目录、阅读进度、代码块操作与公式排版；作品页展示四项项目截图，支持放大、拖动、滚轮缩放、复制与下载。截图以无损 WebP 提供，PNG 文件作为浏览器回退来源。

页面入口位于 `index.html` 与 `pages/`。`assets/styles/`、`assets/scripts/`、`assets/media/` 分别保存样式、页面交互与图片；第三方渲染库集中在 `assets/vendor/`，仅在文章内容需要时加载。

## 浏览方式

双击项目根目录的 `index.html` 可浏览站点页面。需要验证自定义 404 页面或使用 HTTP 环境时，在项目目录运行：

```sh
node tools/static-server.mjs
```

随后访问终端显示的本地地址。服务默认使用 8000 端口，首页地址会返回 `index.html`；端口被占用时可指定其他端口，例如 `node tools/static-server.mjs --port 8001`。访问未知地址时，服务返回根目录 `404.html` 的内容，并保留 HTTP 404 状态码和原请求地址。

静态托管时，发布目录根部须包含 `404.html`，并由托管平台将未知地址交给该文件处理。GitHub Pages 会按约定使用发布目录根部的 `404.html`；其他平台须在托管设置中配置对应错误页。浏览器以 `file://` 打开时，文件协议不会触发服务器级 404；Python 自带静态服务器也不会自动读取项目的 `404.html`。

## 检查命令

维护脚本需要 Node.js 20 或更新版本；浏览器检查还需要本机安装相应浏览器。

| 命令 | 检查内容 |
| --- | --- |
| `node tools/check-content.mjs` | 页面链接、资源、锚点、图片尺寸、文章列表与搜索索引一致性 |
| `node tools/check-syntax.mjs` | 项目脚本的 JavaScript 语法 |
| `node tools/browser-check.mjs` | Chromium 下的布局、星图、灯箱、代码块、搜索与设备能力分级 |
| `node tools/acceptance-check.mjs` | 键盘流程、打印、按需加载与托管目录行为 |
| `node tools/perf-check.mjs` | 页面绘制、布局偏移、帧间隔与窄屏文字放大检查 |
| `node tools/firefox-check.mjs` | Firefox 下的页面与交互检查 |

GitHub Actions 会在推送与合并请求时运行内容检查和脚本语法检查。完整的检查结果、版本与未测环境记在 [审查记录](docs/audit-todo.md)。

## 项目文档

项目说明见 [项目概览](docs/project-brief.md)。

设计理念与视觉系统见 [设计说明](docs/design-note.md)，技术选型与开发记录见 [项目规划](docs/plan.md)，栏目与文章资料见 [内容规划](docs/content-plan.md)。
