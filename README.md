---
created: 2026-10-13 16:33
date modified: 2026.10.16 18:30:19
tags: [Obsidian, 插件开发, 图注]
---

# Paper Writing View

让 Obsidian 的论文写作界面接近 Word 的成稿排版：中文宋体、西文 Times New Roman、段落缩进与两端对齐、紧凑空行、图表公式预览及引用补全。字体、字号、颜色、行距、图片边框和表格外观都能在插件设置中调整。

插件 ID 保持 `paper-caption-preview`，当前版本 **0.16.1**。已有本机版本可直接升级，保留设置。这是显示与写作辅助插件；Word 导出由独立项目 [MD Export Word](https://github.com/2891892831z-ship-it/obsidian-md-export-word) 负责，两者可分别安装。

## 通过 BRAT 安装

1. 在 Obsidian 社区插件中安装并启用 **BRAT**。
2. 打开 BRAT 设置，点击 **Add Beta plugin**。
3. 输入 `2891892831z-ship-it/obsidian-paper-writing-view`。
4. 安装后启用 **Paper Writing View**。
5. 在插件设置中选择中文稿或英文稿外观，再调整字体、颜色和间距。

不需要安装 Node.js、Python、Pandoc 或导出插件来使用基础排版、图注、图片、表格及图表公式补全。默认字体需要本机已安装；缺少时由系统回退，也可以在设置中选择其他字体。

手动安装：下载 Release 中的 `paper-caption-preview.zip`，将其中的 `paper-caption-preview` 文件夹放到库的 `.obsidian/plugins/` 下。安装目录内只需要 `main.js`、`manifest.json`、`styles.css`。升级时保留自己的 `data.json`，不要用其他人的配置覆盖。

## 功能

- **中英文分别排版**：优先读取 `lang`，其次 `cssclasses: [en-doc]`，再判断正文；状态栏可手动切换。中文默认首行两汉字宽，英文默认两半角字符宽，两者正文均两端对齐。
- **统一外观设置**：中文/西文字体、屏幕字号、正文/图注/表格行距、段间距、缩进、文字和引用颜色；可保存自己的外观方案，并提供即时样例预览。
- **图片与图注**：Markdown 图片长图注、HTML 真上下标、百分号编码及括号路径、紧邻下一行的图标签、多图并排；统一放大预览和源码入口。图片默认红色虚线边框，可调颜色、线宽、线型和间距。
- **表格**：单元格水平与垂直居中、长文字换行、宽表滚动、表题编号。
- **图表公式交叉引用**：识别 `{#fig:id}`、`{#tbl:id}`、`{#eq:id}`；输入 `@fig:`、`@tbl:`、`@eq:` 可搜索当前稿件候选，并用普通半角空格显示“图 1 / 表 1 / 式 1”。
- **双语题注块**：实时预览识别 `::: {custom-style="Figure Caption EN"}`、`"Table Caption EN"` 等图注/表题 Pandoc 围栏块，隐藏围栏行并按题注样式排版；`Fig. [-@fig:id]` 显示为 `Fig. 3`，正文中的 `[-@fig:id]` 同样只显示编号。
- **写作辅助**：空行检查、修复预览、按选中项补空行、图表公式导航、缺图及重复标签诊断。日常预览不改正文；只有主动确认修复时才编辑源码，一次撤销可恢复。
- **虚假上下标检查**：默认在状态栏显示当前稿件的 Unicode 上下标问题数；点击预览转换结果，支持逐处定位、选择修复和全部修复，转换为真正的 HTML 上下标。跳过代码、公式、链接地址、citekey 和图表标签，不猜测普通基线数字；修复可一次撤销。可在设置中关闭提醒。
- **轻量写作**：自动 / 普通 / 轻量写作三种选择；自动达到约 8 万字符或 60 个图片标记时优先轻量。轻量写作保留字体、行距和原生图片与表格显示，暂停复杂图注、交叉引用显示替换、本插件的全文引用请求及自动全文检查；不在输入或停笔后重建全文。空行和上下标支持手动检查与修复。
- **稳定编辑**：重复使用已加载的图片，不因普通文字编辑重新载入；未变化的外观不反复触发布局测量。

屏幕字号是写作观感设置，并非精确的 Word 页面、纸张尺寸或打印分页预览。实时预览是主要功能模式；阅读模式支持排版、原生图片边框、居中和表格样式，复杂图注与交叉引用的完整替换主要在实时预览中实现。

## Bilingual captions

Caption rendering displays English captions already written in Markdown. Optional AI translation is a separate, explicit command (see below). In ordinary Live Preview, write the English caption below the image (or table) using a Pandoc custom-style block:

```markdown
![Chinese caption](image.png){#fig:example}

::: {custom-style="Figure Caption EN"}
Fig. [-@fig:example] English caption
:::
```

The English caption appears below the Chinese caption, with its number synchronized to the same label. Use `Table Caption EN` and `Table [-@tbl:example]` for tables. Click inside a caption to edit its source. English caption styles use the configured Latin font (Times New Roman by default). Missing labels retain their original reference text.

This rendering is available in ordinary Live Preview. Lightweight writing skips these replacements; Reading View does not provide the full caption replacement. The separate Word export plugin is unchanged.

## AI 英文题注翻译（本地试用）

### 无需 API：与现有 AI 对话协作

在中文稿运行“批量生成英文图表题”，勾选目标后点击“复制全文与翻译要求（无需 API）”。把剪贴板内容粘贴到正在使用的 AI 对话，AI 会收到全文文字、题名清单及结构化返回要求；图片文件不包含在内。此流程不要求填写 API 地址或密钥，不自动发送消息或打开外部应用。

取得 AI 返回的完整 JSON 后点击“导入 AI 译文”，粘贴并导入审阅列表。也可以先关闭窗口，取得译文后再打开；原中文题名必须仍与任务一致。每条译文可编辑、勾选，检查后点击“确认写入勾选项”才修改稿件，可一次撤销。若部分题名未返回，可以先导入已有条目，只有导入条目会被勾选。

返回结构为 `{"translations":[{"key":"fig:example","source":"中文原题","text":"English caption"}]}`，支持直接 JSON 或 JSON 代码块。标签和原题必须完全一致；允许数字因英文语法调序，但不允许改值、增减，井号及带上下标的表达式按整体核对，引用和公式保留顺序。导入和确认写入使用相同检查；数字核对不能判断每个数值在语义上是否仍对应正确对象，仍需人工审阅。外部 AI 对话仍受其上下文容量与使用额度约束；不要把原文截断后仍当作已阅读全文。

### 可选：直接调用 API

1. 在插件设置的“AI 英文题注翻译（按需）”中填写 Chat Completions 兼容 API 基础地址和模型名称。支持 HTTPS 在线服务，或 `http://localhost:端口/v1` 形式的本地模型。
2. 填写 API 密钥；本地无鉴权服务可留空。配置停止输入约 600 毫秒后自动保存，关闭窗口也会保存未完成修改。密钥写入 Obsidian 密钥存储，不写入笔记或 `data.json`；下次自动读取。旧版 Obsidian 不支持该存储时会提示保存失败。
3. 执行命令“翻译英文图题／表题”，或在“图表与公式导航”中选择“翻译英文题注”。
4. 选择题注与语境范围，展开“查看实际发送的请求正文”。默认发送全文，不设插件层字符上限；仍受服务商模型上下文与请求大小上限约束。超限时可手动选择正文标题、摘要、题注前后各约 3500 字符及最多六条已有英文题注。全文模式每次发送所选稿件的可见文字，不建立或缓存 AI 全文摘要。
5. 点击“发送并生成译文”，检查并编辑译文，再点击“确认写入英文题注”。若已有紧邻、标签匹配的英文题注块，将替换该块；否则新增。写入和时间字段更新可一次撤销。

代码、注释和 frontmatter 从语境中屏蔽；图片路径、引用和其他正文文字仍可能包含在发送内容中，不会读取图片文件或链接笔记。所选服务可能收取 API 费用。普通写作、打开笔记、移动光标时不发起翻译请求，也不在后台分析全文。

支持带唯一 `{#fig:id}` 的独立或同一行并排 Markdown 图片，以及带 `{#tbl:id}`、以 `|` 起始各行的标准管道表格。Wiki 图片暂不自动写入；重复标签、未闭合英文题注、稿件变化或数字/引用/上下标未保留时会阻止写入。保留检查不能替代对术语和原意的人工核对。译文写入后，轻量模式仍保留源码显示。

并排图片按各自标签独立翻译、编辑和勾选，图片源码行保持原样。英文题注以标准 `Figure Caption EN` 块放在整组图片后面；普通实时预览按标签将其放回对应图片下方，已有英文题注按标签更新，不重复新增。光标进入图组或英文题注时展开源码。本次未修改 Word 导出插件；题注使用既有 Pandoc 写法，Word 中并排图组的最终布局仍需单独导出验收。

### 中文稿批量生成英文图表题

在中文稿的“图表与公式导航”中点击“批量生成英文图表题”，或运行同名命令。英文稿隐藏翻译命令和导航入口；语言按笔记元数据、手动选择及正文识别结果判断。若识别有误，可通过状态栏指定稿件语言。

窗口列出全部支持的图题与表题，默认只勾选缺少英文题注的项目。已有英文题注默认保留，也可以勾选后修改或重新生成。列表每页 30 条，翻页保留草稿与勾选。

窗口直接显示可编辑的地址、模型、密钥和推理模式，修改后自动保存，不需要另点保存按钮。修改 API 地址时清空当前密钥输入，避免把旧服务的密钥发送给新地址；清空密钥会移除已存密钥。先点击“预览发送内容”，核对后点击“生成所选英文图表题”。整篇无总条数限制，内部队列每次请求处理一组题注，自动连续完成，无须手动分组。全文语境会随每次请求重复发送，预览中显示请求数量。关闭窗口后不再启动后续批次，已发送请求仍可能产生费用。

填写地址和密钥后，可点击“获取模型列表”，从服务商的 `/models` 接口读取模型 ID 后下拉选择。这不会下载模型，也不发送稿件；列表不代表账号实际调用权限，不支持列表的服务仍可手动填写模型。智谱根域名 `https://open.bigmodel.cn` 会补全为 `https://open.bigmodel.cn/api/paas/v4`，Coding 等专用接口须按服务商说明填写完整地址。

Effort 滑块默认不发送额外参数。智谱可选关闭思考、默认、开启深度思考，使用 `thinking.type`；其他兼容接口显示默认、Minimal、Low、Medium、High、XHigh、Max，按原值发送 `reasoning_effort`。这些档位不是模型能力排名，不代表服务商支持所有参数，特别是 XHigh 和 Max；接口拒绝时请选默认。可通过“保存为默认配置”记住选择。智谱地址依据：[官方 API 简介](https://docs.bigmodel.cn/cn/api/introduction)。

生成后可逐条编辑、取消勾选，再点击“确认写入勾选项”。所有勾选项须有有效译文；API 失败时保留已完成草稿，可取消勾选未完成项后写入。统一写入只更新时间字段一次，支持一次撤销；稿件或语言已变化则阻止写入。

表格整体居中与单元格文字居中均由“优化表格”控制。居中规则覆盖原生实时预览与阅读模式的表格容器，轻量模式也保留；超宽表格通过横向滚动显示，避免居中导致左侧内容不可访问。

## 大稿件模式

卡顿时先停用插件恢复写作，再通过 BRAT 更新至 0.11.1。重新启用后点击底部模式入口选择“轻量写作”，也可以运行命令“启用轻量写作（卡顿时使用）”。轻量写作适用于任意大小的稿件，模式选择应用到整个库。

默认自动模式达到 8 万字符或约 60 个图片标记时进入轻量路径；旧版手动“大稿件”选择也使用轻量路径。判断当前单个 Markdown 文件，字符数包括参考文献和 Markdown 标记；图片数量为 `![` 标记估算值，包含 Wiki 嵌入、部分非图片嵌入和代码示例。在本机判断，不上传稿件。

轻量写作取消本插件的图注、公式编号和交叉引用显示替换，交给 Obsidian 原生显示；保留基础字体、字号、行距和表格 CSS。复杂图注可能显示源码，首行缩进等依赖逐行装饰的效果也暂停。不会修改正文、citekey、图表标签或 Word 导出配置。其他引用插件仍有自己的运行开销，本插件无法控制。

轻量写作不在输入、移动光标或停笔后扫描全文，也不后台创建图表工具栏或表格引用替换。状态栏显示“待检查”；点击对应检查入口可以预览修复，或使用“全文检查与刷新”手动检查空行和上下标。手动检查大稿件本身仍可能耗时。修复结果每页最多显示 100 条，跨页保留选择。

0.11.0 的延迟预览仍有输入卡顿反馈，0.11.1 采用上述保守方案。自动测试覆盖完整编辑事件、输入法组合输入和计时器；不等于已验证所有电脑的大论文体验。普通模式保留完整排版功能，较大的稿件请优先使用轻量写作。

## 作者—年份引用（可选）

需要另行安装 **Pandoc Reference List**（ID：`obsidian-pandoc-reference-list`），并配置其文库、CSL 与 Pandoc。论文写作视图复用它的文献数据，为图注与表格补充显示；没有依赖或文献未找到时保留 citekey，不编造引用。

引用样式由使用者配置：笔记的 `csl` 优先于引用插件的全局默认；`bibliography`、`csl`、`lang` 请写为单字符串。此项目不附带维护者的文库、CSL 文件路径或个人默认样式，不联网同步 Zotero 偏好。

中英文排版选择与 CSL 样式不同：改变排版语言不自动改写 `lang`、`csl` 或期刊要求。可用“检查稿件语言与引用样式”核对配置。

## 与旧配置的关系

字体、行距、图片及表格外观由本插件统一控制，不需要额外字体/行距 CSS 片段。若已有 `academic-font-override`、`line-spacing` 一类全局片段，请停用重叠规则，避免互相覆盖；本插件不会自动修改或删除这些文件。

不需要同时启用 **Pandoc Live Preview** 或 **Image Captions** 来提供图注。重复的图注插件可能产生双重图片或标题；建议保留一个图注提供者。未安装兼容补丁的旧 Pandoc Live Preview 存在时，本插件会暂停冲突渲染。高级兼容工具位于 `scripts/compatibility-patch.js`，不会在插件启动时修改其他插件。

## 命令

- 启用轻量写作（卡顿时使用）
- 选择稿件性能模式
- 全文检查与刷新
- 打开外观设置
- 刷新论文图注
- 补全缺失空行 / 补齐光标附近这一处空行
- 检查并修复虚假上下标
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

## Windows 与 macOS 配置提示

两个系统使用同一份 BRAT 安装包，无需区分 Windows ZIP 与 Mac ZIP；自动测试覆盖 Windows、macOS 和 Linux 的解析、补全、排版及构建逻辑。CI 不等于 macOS Obsidian 窗口实机验收。

设置顶部的“Zotero 与引用配置”可以检查依赖、文库、CSL 和 Pandoc，打开引用插件设置、重试引用或按需检查 Zotero 连接。不会后台反复弹窗，也不自动修改文库和 CSL。

- Windows：选择本机 `pandoc.exe`，例如安装目录下的可执行文件。
- macOS：选择本机 `pandoc`，Homebrew 常见路径为 `/opt/homebrew/bin/pandoc`（Apple Silicon）或 `/usr/local/bin/pandoc`（Intel），以实际安装为准。
- 同步库建议将 `.bib` 和 `.csl` 放入库内并用相对路径；跨系统同步后需要重新配置本机 Pandoc 以及库外文件路径。
- Mac 缺少宋体时，可选择 STSong 或 Songti SC；字体列表包含华文宋体选项，默认字体栈增加 Mac 宋体回退。
- Zotero 连接检查只测试本机 Connector 响应，不证明 Better BibTeX 已安装或 citekey 完整；使用自动导出的本地 `.bib` 时，日常预览不要求 Zotero 始终运行。
