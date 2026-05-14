# 智慧树学习辅助讲解助手

本项目包含一个 Tampermonkey 用户脚本：

- [zhihuishu-study-helper.user.js](zhihuishu-study-helper.user.js)

脚本运行在智慧树（`*.zhihuishu.com`）的作业、练习和考试作答页面上，主要做三件事：

1. 解除作答界面对**复制、粘贴、右键、文字选择**的禁用。
2. 提取题干、选项以及题目区域的图片公式，调用 OpenAI 兼容多模态模型生成 Markdown 学习讲解。
3. 直接调用模型自动作答、翻页并提交（支持 `examloop.zhihuishu.com` 答题卡模式、单题翻页模式和整页批量模式）。

当前脚本版本：`0.5.0`

## 功能概览

### 解除复制粘贴限制（0.5.0 新增）

脚本启动时会自动：

- 用 `!important` 覆盖站点的 `user-select: none`，恢复文字可选中。
- 在 `window` 与 `document` 的捕获阶段拦截 `copy / cut / paste / beforecopy / beforecut / beforepaste / contextmenu / selectstart / dragstart` 事件，调用 `stopImmediatePropagation()` 阻断站点处理器，但保留浏览器自身的复制粘贴默认行为。
- 仅在按下 `Ctrl/Cmd + C/V/X/A` 时拦截 `keydown / keypress / keyup`，避免影响其它输入。
- 清理 `document / documentElement / body` 上 `oncopy`、`oncontextmenu`、`onselectstart` 等内联拦截属性，并在 1.5 秒、4 秒后再清一次以应对延迟注入。

刷新页面后即可在作答界面正常选中、复制、粘贴和右键菜单。

### 解析当前页

点击面板中的“解析当前页”：

- 识别页面中的题目和选项。
- 提取题干和每个选项区域的图片，压缩为 base64 后随请求发送。
- 输出 Markdown 学习讲解，固定保留以下栏目：
  - `第 N 题`
  - `题干/公式识别`
  - `选项图片识别`
  - `思路`
- 通过 MathJax 渲染 LaTeX，并对常见输出问题做兜底修正。

### 自动作答

点击面板中的“自动作答”，脚本会按页面类型选择不同流程：

- **`examloop.zhihuishu.com` 答题卡模式**：通过右侧答题卡导航逐题切换，提取题目、请求模型答案、点击对应选项；全部作答后自动定位提交按钮，并尝试关闭确认弹窗。仍存在未答题时会自动重试一轮，重试后仍未完成则不自动提交，提示在控制台和状态栏。
- **单题翻页模式**：每页一题、有“下一题”按钮的页面，逐题作答后翻页，到末页尝试提交。
- **整页批量模式**：一页多题的练习/作业页面，一次性请求所有答案后批量勾选并提交。

模型答案以 JSON 形式返回（`{"answers":[{"questionIndex":1,"answer":["A"]}, ...]}`），脚本会自动重试解析失败或缺答的情况，必要时兜底点选第一项以保证页面进入“已作答”状态。

### 公式与显示处理

脚本会尽量要求模型使用标准 LaTeX 分隔符：

- 行内公式 `\(...\)`
- 块级公式 `\[...\]`

渲染前会做以下修正：

- 修正 `\\int`、`\\[` 之类的重复反斜杠。
- 把 `∫_Γ f(x,y,z) ds ≤ 0` 这种裸公式转成块级 LaTeX。
- 对 `\boxed{A}` ~ `\boxed{H}` 单字母方框做专门渲染，避免字母偏移。
- 调整 MathJax 容器行高和对齐，减少行内公式下沉、块级公式裁切和滚动条问题。

### 面板与交互

- 右下角“学”按钮可以打开/收起主面板。
- 拖动绿色标题栏移动面板。
- 单击标题栏或右上角箭头按钮折叠/展开内容。
- “设置”面板内可配置 `Base URL` / `API Key` / `Model` / `请求超时`。
- “测试连接”按钮发送一次最小请求，验证模型服务是否可用。
- Tampermonkey 菜单中也注册了“打开/收起智慧树学习助手”入口。
- SPA 路由切换时会自动重新识别题目数量。

## 安装方式

1. 在浏览器中安装 Tampermonkey 扩展。
2. 打开 Tampermonkey 控制面板，选择“添加新脚本”。
3. 将 [zhihuishu-study-helper.user.js](zhihuishu-study-helper.user.js) 的全部内容粘贴进去并保存。
4. 打开或刷新 `*.zhihuishu.com` 任一作答页面，右下角会出现“学”按钮，点击即可展开主面板。

脚本顶部声明了：

```javascript
// @require https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js
// @grant   GM_xmlhttpRequest
// @grant   GM_setValue
// @grant   GM_getValue
// @grant   GM_registerMenuCommand
// @grant   unsafeWindow
// @connect *
```

如果公式无法渲染，请确认 Tampermonkey 能正常加载 `@require` 资源；如果模型接口请求被拦截，请确认 Tampermonkey 在“跨域”相关设置中允许了对应域名。

## 模型配置

脚本默认调用 OpenAI 兼容的 `/v1/chat/completions` 接口，请求带上 `Authorization: Bearer <API Key>`（API Key 留空时不带）。

点击“设置”，填写：

- `Base URL`：模型服务地址。默认 `http://127.0.0.1:11434/v1`。脚本会自动在末尾补全 `/v1/chat/completions`。
- `API Key`：本地服务（如 Ollama）通常留空。
- `Model`：模型名称。默认 `qwen2.5:7b`。
- `请求超时（毫秒）`：默认 `45000`。

> 文本模型只能处理识别到的题干文本。如果题目或选项以**图片形式**呈现公式，请使用支持视觉输入的模型（OpenAI `gpt-4o`、`gpt-4o-mini`，或本地的 `qwen2.5-vl`、`llava`、`minicpm-v` 等）。

Ollama 本地示例：

```powershell
ollama serve
ollama pull qwen2.5:7b
```

面板配置：

```text
Base URL: http://127.0.0.1:11434/v1
Model:    qwen2.5:7b
API Key:  留空
```

## 使用方式

1. 登录智慧树并进入具体课程的作业、练习或考试作答页面。
2. 等待“学”按钮出现，点击展开面板。
3. 选择操作：
   - **解析当前页**：生成 Markdown 学习讲解，仅供参考，不会自动作答。
   - **自动作答**：调用模型直接作答；`examloop` 考试页会按答题卡顺序逐题处理，作答完成后尝试自动提交。
4. 复制粘贴、右键菜单、文字选择已被自动恢复，可在题目区域直接 `Ctrl + C` / `Ctrl + V`。

## 选择器维护

智慧树页面会改版。如果面板提示“没有识别到题目”，可以调整脚本中的：

- `QUESTION_BLOCK_SELECTORS`：题目外层容器选择器。
- `OPTION_SELECTORS`：选项元素选择器。
- `NEXT_BUTTON_TEXTS` / `SUBMIT_BUTTON_TEXTS`：翻页和提交按钮的匹配文案。

`examloop.zhihuishu.com` 的处理走单独逻辑（`extractExamLoopQuestion` / `getExamLoopNavigator`），依赖：

- `.question-area-content` 题目容器。
- 答题卡按钮上的 `size-[...]`、`aspect-square`、`bg-mainBg`、`bg-mainBg/10`、`border-mainBg`、`text-white` 等 Tailwind 类。

如果智慧树调整了上述类名或结构，需要同步更新这部分选择器。

## 已知限制

- 自动作答的正确率取决于所选模型，建议先在“解析当前页”中确认模型识别效果，再使用“自动作答”。
- 模型返回的答案缺失或不合法时，脚本会兜底点选第一项以避免空白；这种题在控制台日志和状态栏会标注。
- 题目区域以独立 iframe 嵌入时，本脚本可能无法注入；如遇到此情况请提供页面 URL 以便针对性处理。
- 解除复制粘贴依赖捕获阶段拦截，对极少数在 `window` 之前注册（理论上不可能）或位于 iframe 内的拦截器无效。

## 备注

本脚本绝大部分内容为 AI 生成，prompt 文件夹含有初版提示词和 AI 润色版提示词，仅供参考。

欢迎提出 issue 或 pr。
