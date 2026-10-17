# Qi-blog-ds

个人博客的前端设计项目。页面围绕个人介绍、文章阅读与作品陈列组织内容，视觉语言取自星图意象，全部由原生 HTML、CSS 与 JavaScript 实现，没有构建步骤。

## 项目定位

博客以阅读体验为核心，同时承担个人形象展示与作品陈列。页面组织围绕三条线索展开：访客快速建立对博主的印象，顺畅读完一篇文章，便捷浏览作品集。导航结构、排版层级与加载性能围绕这三条线索确定。

## 设计方向

主题意象取自星图。首屏把四个栏目画成一组星座节点，站点结构本身成为第一屏的视觉主体，其余部分保持安静，让正文与列表承担阅读任务。配色分为月白与夜空两套，正文对比度均在 16 以上。具体方向与约束记录在 [docs/project-brief.md](docs/project-brief.md)，完整的设计说明见 [docs/design-note.md](docs/design-note.md)。

## 技术方向

产出为静态页面，不引入构建步骤与运行时框架。页面结构使用语义化 HTML，样式以原生 CSS 配合自建设计令牌组织，交互由原生 JavaScript 承担。图标取 Lucide 的 SVG 内联，代码高亮在文章页按需引入 highlight.js。

首页星图的四个节点各自漂浮，指针靠近时被轻微吸引、移开后回位，连线为随位置变化的曲线；缩放与平移由自研视图变换承担，未引入图形库。访问端按 User-Agent、硬件线索与运行时 API 可用性划分为四档，功能机与低端机型自动卸载高开销项，并改用简化样式表。

同源页面之间的跳转在支持跨文档视图过渡的引擎中保持页头与页脚位置连续，该规则随系统减少动态效果偏好一并开关；指针在站内链接上停留时由内核提前取回目标页面，预取仅在静态托管、设备档位允许增强脚本且未开启省流时注册。

选型的完整依据、开发阶段划分与性能预算记录在 [docs/plan.md](docs/plan.md)。

## 目录结构

```text
Qi-blog-ds/
├─ index.html            首页
├─ 404.html              托管环境下的未知地址页面
├─ manifest.webmanifest  应用清单
├─ robots.txt
├─ pages/
│  ├─ posts.html         文章列表
│  ├─ post-reader.html   文章详情：阅读增强与按需渲染
│  ├─ post-capability.html 文章详情：访问端能力分级
│  ├─ post-no-build.html 文章详情：无构建方案
│  ├─ archive.html       归档：按时间与标签两种视图
│  ├─ works.html         作品陈列
│  └─ about.html         个人介绍
├─ assets/
│  ├─ favicon.svg        站点图标
│  ├─ data/              站内搜索索引
│  ├─ icons/             应用图标（192 与 512 像素，含遮罩版本）
│  ├─ media/             作品截图
│  ├─ styles/            设计令牌、基础样式、文章样式与兜底样式
│  ├─ scripts/           能力分级、全局交互、星图交互、站内搜索与阅读增强
│  ├─ vendor/            本地化的 highlight.js 与 KaTeX
├─ docs/                 项目说明、内容规划、设计说明、检查清单与开发记录
├─ tools/                提交前运行的检查脚本（Node.js，不参与页面运行）
├─ .editorconfig
├─ .gitattributes        文字文件统一以 LF 存储
├─ .gitignore
└─ README.md
```

## 开发环境

本机 Node.js 位于 Windows 侧，版本 v24.19.0。在 WSL 中执行构建命令需调用 Windows 端可执行文件，或在 PowerShell、CMD 中运行。浏览器核对使用 Chrome 155.0.8059.80 与 Firefox 157.0.1；Edge 在本机以 MSIX 包形式安装，命令行无法启动无头实例，未纳入引擎核对，Safari 无可用环境。

## 工作顺序

1. 确立技术底座与脚手架
2. 确定内容规划与栏目结构
3. 搭建页面与导航骨架
4. 实现内容模块与交互
5. 性能、兼容性与无障碍核对
6. 视觉打磨
7. 打包与交付

前六阶段与第二轮检查的阶段一至阶段五均已完成，设计说明写入 `docs/design-note.md`。第六阶段的核对于 2026-10-17 执行完毕，命令与结果记录在 `docs/audit-todo.md` 与 `docs/plan.md`，压缩包待按赛事命名规则打包。

## 性能实测

本项目统一以 `node tools/check-content.mjs --sizes` 统计体积，范围内页面自身的 HTML、其引用的本地样式表与页面自带脚本，不含按需加载的第三方库、图片与字体，按 1 KB 等于 1024 字节换算。2026-10-17 的复测结果：首页 79.4 KB（gzip 22.1 KB）；文章列表 49.4 KB、关于 48.6 KB、归档 52.5 KB、作品 55.7 KB，gzip 在 14.2 KB 到 15.8 KB 之间；文章详情页在 77.0 KB 到 79.8 KB 之间，gzip 在 21.8 KB 到 22.6 KB 之间。未知地址页面 6.6 KB（gzip 2.5 KB）。单页 DOM 节点最多 391 个，360、768、1440 三种宽度下共二十七组测量，横向溢出与页面级越界元素均为 0。

运行期数据由 `node tools/perf-check.mjs` 记录，采样窗口 2.4 秒，1440×900 视口，采样之前先以未知地址页面完成一次预热导航，因此首个页面的数据不含新档案的初始化代价。九个页面的帧间隔中位数落在 17.8 到 18.0 毫秒，第九十五百分位落在 18.3 到 18.6 毫秒；首页、文章详情页在加载阶段各出现一次 56 到 87 毫秒的长任务，其余页面没有长任务；累积布局偏移为 0 到 0.022，首次内容绘制为 44 到 192 毫秒。320 像素宽度下把行高放大到 1.5、字距 0.12em、词距 0.16em 之后，九个页面均无文档级横向溢出，宽于视口的元素只有代码块与表格内容，且都位于各自的横向滚动容器内。

## 维护脚本

`tools/` 下的脚本只在开发与提交前运行，浏览页面不需要它们。运行需要 Node.js 20 以上；浏览器核对用到全局 WebSocket，建议 22 以上。环境变量 `QI_BROWSER` 可取 `chrome`、`edge`，或直接给出 Chromium 内核可执行文件地址；`QI_FIREFOX` 可给出 Firefox 可执行文件地址。

| 脚本 | 用途 |
| --- | --- |
| `node tools/check-content.mjs` | 核对本地引用、锚点、图片固有尺寸、文章在列表与归档中的记录，以及搜索索引与文章头部是否一致 |
| `node tools/check-content.mjs --write-index` | 按文章页面重建 `assets/data/search-index.js` |
| `node tools/check-content.mjs --sizes` | 输出各页面首屏资源的体积统计 |
| `node tools/browser-check.mjs` | 以无头 Chromium 核对布局、结构、星图、灯箱、代码块复制与框内滚动、搜索、访问端分档，以及页面跳转衔接与预取规则的注册条件 |
| `node tools/browser-check.mjs --layout` | 只做布局与结构核对 |
| `node tools/acceptance-check.mjs` | 核对站内链接点击前后配色、键盘流程、搜索面板的滚动锁定与背景键盘屏蔽、打印样式、第三方库按需加载，以及域名根与项目子目录两种托管方式 |
| `node tools/perf-check.mjs` | 记录九个页面的帧间隔、布局偏移、首次绘制与长任务，并在 320 像素宽度下放大文字复查横向重排 |
| `node tools/a11y-check.mjs --axe <axe.min.js>` | 以 axe-core 扫描九个页面与暗色主题、搜索面板、灯箱三处状态 |
| `node tools/static-server.mjs` | 按域名根或 `/Qi-blog-ds/` 子目录托管项目目录，供浏览器核对脚本使用 |
| `node tools/firefox-check.mjs` | 以 Firefox 的 Marionette 通道完成同一套页面核对，含代码块滚动窗口、搜索面板与灯箱的滚动锁定及背景键盘屏蔽 |
| `node tools/marionette.mjs` | Firefox 核对脚本使用的 Marionette 客户端，只依赖 Node 内置模块 |

