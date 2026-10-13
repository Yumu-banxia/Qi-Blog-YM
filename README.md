# Qi-blog-ds

个人博客的前端设计项目。页面围绕个人介绍、文章阅读与作品陈列组织内容，并在内容结构与视觉语言上形成统一的设计方向。

## 项目定位

博客以阅读体验为核心，同时承担个人形象展示与作品陈列。页面组织围绕三条线索展开：访客快速建立对博主的印象，顺畅读完一篇文章，便捷浏览作品集。导航结构、排版层级与加载性能围绕这三条线索确定。

## 设计方向

主题意象取自星河，视觉表达从这一意象延伸，落到配色、字体、版式与动效四个层面，目标是形成具备辨识度的观感。具体方向与约束记录在 [docs/project-brief.md](docs/project-brief.md)。

## 技术方向

产出为静态页面，不引入构建步骤与运行时框架。页面结构使用语义化 HTML，样式以原生 CSS 配合自建设计令牌组织，交互由原生 JavaScript 承担。图标取 Lucide 的 SVG 内联，代码高亮在文章页按需引入 highlight.js。

访问端按 User-Agent、硬件线索与运行时 API 可用性划分为四档，功能机与低端机型自动卸载高开销项，并改用简化样式表。

选型的完整依据、开发阶段划分与性能预算记录在 [docs/plan.md](docs/plan.md)。

## 目录结构

```text
Qi-blog-ds/
├─ index.html            首页
├─ pages/
│  ├─ posts.html         文章列表
│  ├─ post-sample.html   文章详情模板
│  ├─ works.html         作品陈列
│  └─ about.html         个人介绍
├─ assets/
│  ├─ styles/            设计令牌与基础样式
│  ├─ scripts/           全局交互
│  ├─ icons/             SVG 图标
│  └─ media/             图片与字体
├─ docs/                 项目说明、内容规划与设计记录
├─ .editorconfig
├─ .gitignore
└─ README.md
```

## 开发环境

本机 Node.js 位于 Windows 侧，版本 v24.19.0。在 WSL 中执行构建命令需调用 Windows 端可执行文件，或在 PowerShell、CMD 中运行。

## 工作顺序

1. 确立技术底座与脚手架
2. 确定内容规划与栏目结构
3. 搭建页面与导航骨架
4. 实现内容模块与交互
5. 性能、兼容性与无障碍核对
6. 视觉打磨
7. 打包与交付

