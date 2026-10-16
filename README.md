---
created: 2026-10-13 16:33
date modified: 2026.10.16 15:03:35
tags: [Obsidian, 插件开发, 图注]
---

# 论文写作视图 · Paper Writing View

让 Obsidian 的论文写作界面接近 Word 的成稿排版：中文宋体、西文 Times New Roman、段落缩进与两端对齐、紧凑空行、图表公式预览及引用补全。字体、字号、颜色、行距、图片边框和表格外观都能在插件设置中调整。

插件 ID 保持 `paper-caption-preview`，当前版本 **0.9.0**。已有本机版本可直接升级，保留设置。这是显示与写作辅助插件；Word 导出由独立项目 [MD Export Word](https://github.com/2891892831z-ship-it/obsidian-md-export-word) 负责，两者可分别安装。

## 通过 BRAT 安装

1. 在 Obsidian 社区插件中安装并启用 **BRAT**。
2. 打开 BRAT 设置，点击 **Add Beta plugin**。
3. 输入 `2891892831z-ship-it/obsidian-paper-writing-view`。
4. 安装后启用 **论文写作视图**。
5. 在插件设置中选择中文稿或英文稿外观，再调整字体、颜色和间距。

不需要安装 Node.js、Python、Pandoc 或导出插件来使用基础排版、图注、图片、表格及图表公式补全。默认字体需要本机已安装；缺少时由系统回退，也可以在设置中选择其他字体。

手动安装：下载 Release 中的 `paper-caption-preview.zip`，将其中的 `paper-caption-preview` 文件夹放到库的 `.obsidian/plugins/` 下。安装目录内只需要 `main.js`、`manifest.json`、`styles.css`。升级时保留自己的 `data.json`，不要用其他人的配置覆盖。

## 功能

- **中英文分别排版**：优先读取 `lang`，其次 `cssclasses: [en-doc]`，再判断正文；状态栏可手动切换。中文默认首行两汉字宽，英文默认两半角字符宽，两者正文均两端对齐。
- **统一外观设置**：中文/西文字体、屏幕字号、正文/图注/表格行距、段间距、缩进、文字和引用颜色；可保存自己的外观方案，并提供即时样例预览。
- **图片与图注**：Markdown 图片长图注、HTML 真上下标、百分号编码及括号路径、紧邻下一行的图标签、多图并排；统一放大预览和源码入口。图片默认红色虚线边框，可调颜色、线宽、线型和间距。
- **表格**：单元格水平与垂直居中、长文字换行、宽表滚动、表题编号。
- **图表公式交叉引用**：识别 `{#fig:id}`、`{#tbl:id}`、`{#eq:id}`；输入 `@fig:`、`@tbl:`、`@eq:` 可搜索当前稿件候选，并用普通半角空格显示“图 1 / 表 1 / 式 1”。
- **写作辅助**：空行检查、修复预览、按选中项补空行、图表公式导航、缺图及重复标签诊断。日常预览不改正文；只有主动确认补空行时才编辑源码，一次撤销可恢复。
- **稳定编辑**：重复使用已加载的图片，不因普通文字编辑重新载入；未变化的外观不反复触发布局测量。

屏幕字号是写作观感设置，并非精确的 Word 页面、纸张尺寸或打印分页预览。实时预览是主要功能模式；阅读模式支持排版、原生图片边框、居中和表格样式，复杂图注与交叉引用的完整替换主要在实时预览中实现。

## 作者—年份引用（可选）

需要另行安装 **Pandoc Reference List**（ID：`obsidian-pandoc-reference-list`），并配置其文库、CSL 与 Pandoc。论文写作视图复用它的文献数据，为图注与表格补充显示；没有依赖或文献未找到时保留 citekey，不编造引用。

引用样式由使用者配置：笔记的 `csl` 优先于引用插件的全局默认；`bibliography`、`csl`、`lang` 请写为单字符串。此项目不附带维护者的文库、CSL 文件路径或个人默认样式，不联网同步 Zotero 偏好。

中英文排版选择与 CSL 样式不同：改变排版语言不自动改写 `lang`、`csl` 或期刊要求。可用“检查稿件语言与引用样式”核对配置。

## 与旧配置的关系

字体、行距、图片及表格外观由本插件统一控制，不需要额外字体/行距 CSS 片段。若已有 `academic-font-override`、`line-spacing` 一类全局片段，请停用重叠规则，避免互相覆盖；本插件不会自动修改或删除这些文件。

不需要同时启用 **Pandoc Live Preview** 或 **Image Captions** 来提供图注。重复的图注插件可能产生双重图片或标题；建议保留一个图注提供者。未安装兼容补丁的旧 Pandoc Live Preview 存在时，本插件会暂停冲突渲染。高级兼容工具位于 `scripts/compatibility-patch.js`，不会在插件启动时修改其他插件。

## 命令

- 打开外观设置
- 刷新论文图注
- 补全缺失空行 / 补齐光标附近这一处空行
- 检查当前笔记图注
- 图表与公式导航
- 选择当前稿件语言
- 检查稿件语言与引用样式

## 开发与发布

```sh
npm ci
npm run check
npm test
npm run build
npm run validate
```

`src/main.js` 为 Obsidian 逻辑，`src/core.js` 为纯解析器；`scripts/build.js` 生成根目录单文件 `main.js` 和 `dist/paper-caption-preview/` 安装目录。运行时外部模块仅为 Obsidian 提供的 Obsidian/CodeMirror API，没有额外 Node 模块。

根目录的三个标准插件文件供 BRAT 使用。GitHub Actions 在主分支运行测试，纯版本号标签（例如 `0.9.0`）触发自动发布标准文件和安装 ZIP。发布前必须同步 `package.json`、`manifest.json`、`versions.json` 并重新构建。

Windows 本机已验证。代码未使用 Node 文件系统等桌面专用 API，因此保留移动端兼容声明，但尚未完成 macOS 或移动端实机验收。引用集成使用 Pandoc Reference List 的内部接口，该依赖升级后需要重新验证；移动端的可选 Pandoc 引用能力取决于该插件支持范围。

## 许可证

[MIT](LICENSE)。Obsidian、CodeMirror 与可选引用插件由各自项目提供，本仓库不打包其实现。
