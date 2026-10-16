---
date modified: 2026.10.16 15:34:16
---

# 0.10.1 · Paper Writing View

- 新增默认开启的 Unicode 虚假上下标检查：状态栏计数、设置开关和检查命令。
- 修复预览支持定位、逐处修复、勾选修复及全部修复，转换为 HTML 上下标，更新时间字段，一次撤销。
- 保护代码、LaTeX 公式、链接地址、citekey、图表标签和已有 HTML 上下标；不猜测普通数字。
- 修复前检查笔记内容和路径，拒绝对已经变化的笔记应用旧预览。

# 0.10.0 · Paper Writing View

- 插件显示名统一为英文 Paper Writing View，保留插件 ID、命令 ID 与个人设置。
- 设置顶部新增 Zotero 与引用配置入口：检查引用插件、Pandoc、文献库、CSL、YAML 字段类型和跨系统路径。
- 支持打开引用设置、重新检查、重试引用及主动测试 Zotero Connector 连接；不后台反复弹窗。
- 文库或样式文件不存在时提供路径提示，引用渲染失败可在诊断中查看；不自动修改用户引用配置。
- 同一个 BRAT 插件包支持 Windows 与 macOS，增加三系统 CI；Mac 字体增加宋体回退。

BRAT：`2891892831z-ship-it/obsidian-paper-writing-view`。
作者—年份引用可选接入 Pandoc Reference List；基础排版与 Word 导出插件独立。
自动测试不代表完成 macOS Obsidian 图形界面实机验收。
