// ==UserScript==
// @name         智慧树学习辅助讲解助手
// @namespace    https://local.codex/zhihuishu-study-helper
// @version      0.5.0
// @description  提取智慧树作业/考试页面题目，调用 OpenAI 兼容模型自动作答、翻页、提交。
// @author       Codex
// @match        *://*.zhihuishu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "zhihuishu_study_helper_config_v1";
  const PANEL_ID = "zh-study-helper-panel";
  const TOGGLE_ID = "zh-study-helper-toggle";
  const MAX_QUESTIONS = 30;
  const MAX_QUESTION_TEXT = 1600;
  const MAX_OPTION_TEXT = 600;
  const MAX_IMAGES_PER_QUESTION = 32;
  const MAX_IMAGE_SIDE = 1200;
  const IMAGE_JPEG_QUALITY = 0.9;
  const MATHJAX_CONFIG_ID = "zh-study-helper-mathjax-config";
  const MATHJAX_SCRIPT_ID = "zh-study-helper-mathjax-script";
  const MATHJAX_SRC = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js";

  const DEFAULT_CONFIG = {
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    model: "qwen2.5:7b",
    temperature: 0.2,
    maxTokens: 1800,
    requestTimeoutMs: 45000
  };

  const QUESTION_BLOCK_SELECTORS = [
    "[data-question-id]",
    "[data-qid]",
    ".question-item",
    ".questionItem",
    ".question-box",
    ".questionBox",
    ".question-wrap",
    ".questionWrap",
    ".subject-item",
    ".subjectItem",
    ".topic-item",
    ".topicItem",
    ".exam-question",
    ".examQuestion",
    ".answer-question",
    ".answerQuestion",
    "[class*='question']",
    "[class*='Question']",
    "[class*='subject']",
    "[class*='Subject']",
    "[class*='topic']",
    "[class*='Topic']"
  ];

  const OPTION_SELECTORS = [
    "label",
    "li",
    ".option",
    ".option-item",
    ".optionItem",
    ".answer-option",
    ".answerOption",
    ".el-radio",
    ".el-checkbox",
    "[class*='option']",
    "[class*='Option']",
    "[class*='radio']",
    "[class*='checkbox']"
  ];

  const OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const NEXT_BUTTON_TEXTS = ["下一题", "下一步", "Next", "next"];
  const SUBMIT_BUTTON_TEXTS = ["提交", "交卷", "提交答案", "提交作业", "Submit", "完成答题"];

  const state = {
    config: loadConfig(),
    busy: false,
    configOpen: false,
    panelCollapsed: false,
    panelCompact: false,
    lastQuestions: [],
    lastAdvice: null,
    route: location.href,
    domDebounceTimer: null,
    drag: null,
    suppressHeaderClick: false,
    autoAnswerProgress: null
  };

  let mathJaxReadyPromise = null;

  boot();

  function boot() {
    unlockCopyPaste();
    onReady(() => {
      injectStyles();
      createPanel();
      createToggleButton();
      installRouteListener();
      installDomObserver();
      registerMenu();
      refreshQuestionCount();
    });
  }

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function unlockCopyPaste() {
    injectUnlockStyles();
    installEventStoppers();
    clearInlineBlockers();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", clearInlineBlockers, { once: true });
    }
    window.setTimeout(clearInlineBlockers, 1500);
    window.setTimeout(clearInlineBlockers, 4000);
  }

  function injectUnlockStyles() {
    const id = "zh-study-helper-unlock-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      *, *::before, *::after {
        -webkit-user-select: text !important;
        -moz-user-select: text !important;
        -ms-user-select: text !important;
        user-select: text !important;
        -webkit-touch-callout: default !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function installEventStoppers() {
    const blockedEvents = [
      "copy", "cut", "paste",
      "beforecopy", "beforecut", "beforepaste",
      "contextmenu", "selectstart", "dragstart"
    ];
    const stopEvent = (event) => {
      event.stopImmediatePropagation();
    };
    for (const type of blockedEvents) {
      window.addEventListener(type, stopEvent, { capture: true });
      document.addEventListener(type, stopEvent, { capture: true });
    }

    const stopShortcut = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = (event.key || "").toLowerCase();
      if (key === "c" || key === "v" || key === "x" || key === "a") {
        event.stopImmediatePropagation();
      }
    };
    for (const type of ["keydown", "keypress", "keyup"]) {
      window.addEventListener(type, stopShortcut, { capture: true });
      document.addEventListener(type, stopShortcut, { capture: true });
    }
  }

  function clearInlineBlockers() {
    const inlineProps = [
      "oncopy", "oncut", "onpaste",
      "onbeforecopy", "onbeforecut", "onbeforepaste",
      "oncontextmenu", "onselectstart", "ondragstart"
    ];
    const targets = [document, document.documentElement, document.body];
    for (const target of targets) {
      if (!target) continue;
      for (const prop of inlineProps) {
        try {
          target[prop] = null;
        } catch (error) {
          // Some hosts mark these read-only — safe to ignore.
        }
      }
    }
  }

  function loadConfig() {
    try {
      const raw = GM_getValue(STORE_KEY, "");
      if (!raw) return { ...DEFAULT_CONFIG };
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (error) {
      console.warn("[智慧树学习助手] 配置读取失败，已使用默认配置。", error);
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(config) {
    state.config = { ...DEFAULT_CONFIG, ...config };
    GM_setValue(STORE_KEY, JSON.stringify(state.config));
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;
    GM_registerMenuCommand("打开/收起智慧树学习助手", () => {
      state.panelCollapsed = !state.panelCollapsed;
      renderPanel();
    });
  }

  function injectStyles() {
    if (document.getElementById("zh-study-helper-style")) return;
    const style = document.createElement("style");
    style.id = "zh-study-helper-style";
    style.textContent = `
      #${PANEL_ID}, #${TOGGLE_ID} {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        color: #1f2937;
      }
      #${PANEL_ID} * {
        box-sizing: border-box;
      }
      #${PANEL_ID} {
        position: fixed;
        z-index: 2147483647;
        top: 72px;
        right: 18px;
        width: min(560px, calc(100vw - 28px));
        max-height: calc(100vh - 96px);
        border: 1px solid rgba(31, 41, 55, 0.16);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.18);
        overflow: hidden;
      }
      #${PANEL_ID}.zsh-collapsed {
        display: none;
      }
      #${PANEL_ID}.zsh-dragging {
        user-select: none;
      }
      #${PANEL_ID}.zsh-compact {
        max-height: none;
      }
      #${PANEL_ID}.zsh-compact .zsh-body {
        display: none;
      }
      #${TOGGLE_ID} {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        bottom: 28px;
        width: 48px;
        height: 48px;
        border: 0;
        border-radius: 8px;
        background: #0f766e;
        color: #fff;
        cursor: pointer;
        box-shadow: 0 12px 30px rgba(15, 118, 110, 0.28);
        font-size: 18px;
        font-weight: 700;
      }
      .zsh-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: #0f766e;
        color: #fff;
        cursor: move;
        touch-action: none;
      }
      .zsh-header:active {
        cursor: grabbing;
      }
      .zsh-title {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        pointer-events: none;
      }
      .zsh-title strong {
        font-size: 15px;
        line-height: 20px;
      }
      .zsh-title span {
        color: rgba(255, 255, 255, 0.84);
        font-size: 12px;
        line-height: 16px;
      }
      .zsh-icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      .zsh-icon-button[data-zsh-action="toggle-compact"] {
        font-size: 14px;
        font-weight: 700;
      }
      .zsh-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-height: calc(100vh - 160px);
        padding: 14px;
        overflow: auto;
      }
      .zsh-actions {
        display: grid;
        grid-template-columns: 1fr 1fr 72px;
        gap: 8px;
      }
      .zsh-button {
        min-height: 36px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #fff;
        color: #1f2937;
        cursor: pointer;
        font-size: 13px;
      }
      .zsh-button:hover {
        border-color: #0f766e;
      }
      .zsh-button-primary {
        border-color: #0f766e;
        background: #0f766e;
        color: #fff;
        font-weight: 600;
      }
      .zsh-button:disabled {
        cursor: not-allowed;
        opacity: 0.62;
      }
      .zsh-status {
        min-height: 28px;
        border-radius: 6px;
        padding: 8px 10px;
        background: #f8fafc;
        color: #475569;
        font-size: 13px;
        line-height: 20px;
      }
      .zsh-status.zsh-error {
        background: #fef2f2;
        color: #b91c1c;
      }
      .zsh-status.zsh-success {
        background: #ecfdf5;
        color: #047857;
      }
      .zsh-status.zsh-warn {
        background: #fffbeb;
        color: #b45309;
      }
      .zsh-config {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 10px;
        background: #f8fafc;
      }
      .zsh-config.zsh-hidden {
        display: none;
      }
      .zsh-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .zsh-field label {
        color: #334155;
        font-size: 12px;
      }
      .zsh-field input {
        width: 100%;
        min-height: 32px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 6px 8px;
        background: #fff;
        color: #111827;
        font-size: 12px;
      }
      .zsh-config-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .zsh-results {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .zsh-empty {
        border: 1px dashed #cbd5e1;
        border-radius: 8px;
        padding: 14px;
        color: #64748b;
        font-size: 14px;
        line-height: 22px;
        background: #f8fafc;
      }
      .zsh-advice-summary,
      .zsh-advice-item {
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 14px;
        background: #fff;
      }
      .zsh-advice-summary {
        color: #334155;
        font-size: 15px;
        line-height: 1.55;
      }
      .zsh-advice-item h3 {
        margin: 0 0 7px;
        color: #0f766e;
        font-size: 13px;
        line-height: 19px;
      }
      .zsh-advice-item p,
      .zsh-advice-item li {
        color: #374151;
        font-size: 12px;
        line-height: 19px;
      }
      .zsh-advice-item p {
        margin: 5px 0;
      }
      .zsh-advice-item ul {
        margin: 5px 0 0 18px;
        padding: 0;
      }
      .zsh-tag-row {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin: 6px 0;
      }
      .zsh-tag {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        border-radius: 999px;
        padding: 2px 7px;
        background: #ccfbf1;
        color: #115e59;
        font-size: 12px;
      }
      .zsh-raw {
        white-space: pre-wrap;
        overflow-wrap: break-word;
        word-break: normal;
        color: #374151;
        font-size: 15px;
        line-height: 1.55;
      }
      .zsh-markdown {
        color: #334155;
        font-size: 15px;
        line-height: 1.55;
        overflow-wrap: break-word;
        word-break: normal;
      }
      .zsh-markdown h1,
      .zsh-markdown h2,
      .zsh-markdown h3 {
        margin: 6px 0 3px;
        color: #0f766e;
        line-height: 1.35;
      }
      .zsh-markdown h1 {
        font-size: 20px;
      }
      .zsh-markdown h2 {
        font-size: 18px;
      }
      .zsh-markdown h3 {
        font-size: 16px;
      }
      .zsh-markdown p {
        margin: 3px 0;
      }
      .zsh-markdown ul,
      .zsh-markdown ol {
        margin: 4px 0 4px 22px;
        padding: 0;
      }
      .zsh-markdown li {
        margin: 2px 0;
      }
      .zsh-markdown strong {
        color: #1f2937;
        font-weight: 700;
      }
      .zsh-markdown code {
        border-radius: 4px;
        padding: 1px 4px;
        background: #f1f5f9;
        color: #0f172a;
        font-family: Consolas, Monaco, monospace;
        font-size: 0.95em;
      }
      .zsh-markdown pre {
        overflow: auto;
        border-radius: 6px;
        padding: 8px;
        background: #f8fafc;
      }
      .zsh-markdown blockquote {
        margin: 5px 0;
        border-left: 3px solid #99f6e4;
        padding: 2px 0 2px 9px;
        color: #475569;
      }
      .zsh-math-block {
        overflow: visible;
        max-width: 100%;
        margin: 3px 0 4px;
        padding: 0 0 3px;
        line-height: normal;
        text-align: center;
      }
      .zsh-markdown mjx-container {
        overflow: visible !important;
        max-width: 100%;
        padding: 0;
        color: #111827;
        font-size: 1.08em;
        line-height: normal;
        vertical-align: baseline;
      }
      .zsh-markdown mjx-container:not([display="true"]) {
        display: inline-block !important;
        margin: 0 0.04em;
        padding: 0 !important;
        vertical-align: -0.06em;
      }
      .zsh-markdown mjx-container[display="true"] {
        display: block !important;
        margin: 0 auto;
        padding: 0.04em 0 0.16em;
        font-size: 1.18em;
        text-align: center;
      }
      .zsh-markdown mjx-container *,
      .zsh-markdown mjx-container mjx-math,
      .zsh-markdown mjx-container mjx-mi,
      .zsh-markdown mjx-container mjx-mtext {
        line-height: normal !important;
      }
      .zsh-boxed-choice {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.72em;
        height: 1.42em;
        border: 1.6px solid #111827;
        color: #111827;
        font-family: "Cambria Math", "Times New Roman", serif;
        font-size: 1.05em;
        line-height: 1;
        vertical-align: middle;
      }
      .zsh-math-block .zsh-boxed-choice {
        margin: 0 auto;
        font-size: 1.18em;
      }
      .zsh-markdown mjx-merror {
        border: 0 !important;
        background: transparent !important;
        color: #111827 !important;
      }
      .zsh-markdown mjx-merror * {
        color: inherit !important;
      }
      .zsh-math-block > .zsh-math-placeholder,
      .zsh-math-block > .zsh-math-placeholder > mjx-container {
        min-width: 0;
      }
      .zsh-math-inline {
        display: inline-block;
        padding: 0;
        line-height: normal;
        vertical-align: baseline;
      }
      .zsh-math-fallback {
        white-space: pre-wrap;
        font-family: "Cambria Math", "Times New Roman", serif;
      }
      .zsh-math-placeholder {
        display: inline-block;
        overflow-y: visible;
        max-width: 100%;
        padding: 0;
        line-height: normal;
        vertical-align: baseline;
      }
      .zsh-math-placeholder[data-display="true"] {
        display: block;
        overflow: visible;
        padding: 0.04em 0 0.18em;
        text-align: center;
      }
      @media (max-width: 520px) {
        #${PANEL_ID} {
          top: 12px;
          right: 10px;
          width: calc(100vw - 20px);
          max-height: calc(100vh - 82px);
        }
        .zsh-actions,
        .zsh-config-actions {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function createPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      document.documentElement.appendChild(panel);
    }
    panel.addEventListener("click", handlePanelClick);
    panel.addEventListener("pointerdown", handlePanelPointerDown);
    renderPanel();
  }

  function createToggleButton() {
    if (document.getElementById(TOGGLE_ID)) return;
    const button = document.createElement("button");
    button.id = TOGGLE_ID;
    button.type = "button";
    button.title = "打开/收起学习助手";
    button.textContent = "学";
    button.addEventListener("click", () => {
      state.panelCollapsed = !state.panelCollapsed;
      renderPanel();
    });
    document.documentElement.appendChild(button);
  }

  function handlePanelPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (!event.target.closest("[data-zsh-role='header']")) return;
    if (event.target.closest("[data-zsh-action]")) return;

    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false
    };

    panel.classList.add("zsh-dragging");
    panel.setPointerCapture?.(event.pointerId);
    panel.addEventListener("pointermove", handlePanelPointerMove);
    panel.addEventListener("pointerup", handlePanelPointerEnd);
    panel.addEventListener("pointercancel", handlePanelPointerEnd);
  }

  function handlePanelPointerMove(event) {
    const drag = state.drag;
    const panel = document.getElementById(PANEL_ID);
    if (!drag || !panel || event.pointerId !== drag.pointerId) return;

    const deltaX = Math.abs(event.clientX - drag.startX);
    const deltaY = Math.abs(event.clientY - drag.startY);
    if (deltaX + deltaY > 4) drag.moved = true;

    const rect = panel.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const left = clamp(event.clientX - drag.offsetX, margin, maxLeft);
    const top = clamp(event.clientY - drag.offsetY, margin, maxTop);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    event.preventDefault();
  }

  function handlePanelPointerEnd(event) {
    const drag = state.drag;
    const panel = document.getElementById(PANEL_ID);
    if (!drag || !panel || event.pointerId !== drag.pointerId) return;

    state.suppressHeaderClick = drag.moved;
    state.drag = null;
    panel.classList.remove("zsh-dragging");
    panel.releasePointerCapture?.(event.pointerId);
    panel.removeEventListener("pointermove", handlePanelPointerMove);
    panel.removeEventListener("pointerup", handlePanelPointerEnd);
    panel.removeEventListener("pointercancel", handlePanelPointerEnd);
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.toggle("zsh-collapsed", state.panelCollapsed);
    panel.classList.toggle("zsh-compact", state.panelCompact);
    panel.innerHTML = `
      <div class="zsh-header" data-zsh-role="header" title="拖动移动；单击展开/收起">
        <div class="zsh-title">
          <strong>智慧树学习助手</strong>
          <span>提取题目和公式图片，生成讲解与思路</span>
        </div>
        <button class="zsh-icon-button" type="button" data-zsh-action="toggle-compact" title="展开/收起">${state.panelCompact ? "▾" : "▴"}</button>
      </div>
      <div class="zsh-body">
        <div class="zsh-actions">
          <button class="zsh-button zsh-button-primary" type="button" data-zsh-action="analyze"${state.busy ? " disabled" : ""}>解析当前页</button>
          <button class="zsh-button zsh-button-primary" type="button" data-zsh-action="auto-answer"${state.busy ? " disabled" : ""}>自动作答</button>
          <button class="zsh-button" type="button" data-zsh-action="toggle-config">设置</button>
        </div>
        <div class="zsh-status" data-zsh-role="status"></div>
        <div class="zsh-config ${state.configOpen ? "" : "zsh-hidden"}" data-zsh-role="config">
          <div class="zsh-field">
            <label for="zsh-base-url">Base URL</label>
            <input id="zsh-base-url" data-zsh-field="baseUrl" autocomplete="off">
          </div>
          <div class="zsh-field">
            <label for="zsh-api-key">API Key</label>
            <input id="zsh-api-key" data-zsh-field="apiKey" type="password" autocomplete="off">
          </div>
          <div class="zsh-field">
            <label for="zsh-model">Model</label>
            <input id="zsh-model" data-zsh-field="model" autocomplete="off">
          </div>
          <div class="zsh-field">
            <label for="zsh-timeout">请求超时（毫秒）</label>
            <input id="zsh-timeout" data-zsh-field="requestTimeoutMs" type="number" min="5000" step="1000">
          </div>
          <div class="zsh-config-actions">
            <button class="zsh-button zsh-button-primary" type="button" data-zsh-action="save-config">保存设置</button>
            <button class="zsh-button" type="button" data-zsh-action="test-connection"${state.busy ? " disabled" : ""}>测试连接</button>
          </div>
        </div>
        <div class="zsh-results" data-zsh-role="results"></div>
      </div>
    `;
    fillConfigFields(panel);
    renderStatus();
    renderResults();
  }

  function fillConfigFields(panel) {
    for (const [key, value] of Object.entries(state.config)) {
      const input = panel.querySelector(`[data-zsh-field="${key}"]`);
      if (input) input.value = String(value ?? "");
    }
  }

  function handlePanelClick(event) {
    const button = event.target.closest("[data-zsh-action]");
    const header = event.target.closest("[data-zsh-role='header']");
    if (header && !button) {
      if (state.suppressHeaderClick) {
        state.suppressHeaderClick = false;
        return;
      }
      state.panelCompact = !state.panelCompact;
      renderPanel();
      return;
    }
    if (!button) return;
    const action = button.getAttribute("data-zsh-action");
    if (action === "toggle-compact") {
      state.panelCompact = !state.panelCompact;
      renderPanel();
    } else if (action === "toggle-config") {
      state.configOpen = !state.configOpen;
      renderPanel();
    } else if (action === "save-config") {
      saveConfig(readConfigFields());
      setStatus("设置已保存。", "success");
      renderPanel();
    } else if (action === "test-connection") {
      testConnection();
    } else if (action === "analyze") {
      analyzeCurrentPage();
    } else if (action === "auto-answer") {
      autoAnswerCurrentPage();
    }
  }

  function readConfigFields() {
    const panel = document.getElementById(PANEL_ID);
    const config = { ...state.config };
    if (!panel) return config;
    panel.querySelectorAll("[data-zsh-field]").forEach((input) => {
      const key = input.getAttribute("data-zsh-field");
      if (key === "requestTimeoutMs" || key === "maxTokens") {
        config[key] = Math.max(1000, Number(input.value || DEFAULT_CONFIG[key]));
      } else if (key === "temperature") {
        config[key] = Number(input.value || DEFAULT_CONFIG[key]);
      } else {
        config[key] = input.value.trim();
      }
    });
    return config;
  }

  function setStatus(message, type = "") {
    state.status = { message, type };
    renderStatus();
  }

  function renderStatus() {
    const status = document.querySelector(`#${PANEL_ID} [data-zsh-role="status"]`);
    if (!status) return;
    const current = state.status || {};
    status.className = `zsh-status ${current.type ? `zsh-${current.type}` : ""}`;
    if (current.message) {
      status.textContent = current.message;
      return;
    }
    const count = state.lastQuestions.length;
    status.textContent = count
      ? `当前页识别到 ${count} 道疑似题目。点击“解析当前页”获取学习提示。`
      : "请先进入作业或练习的作答页面，再点击“解析当前页”。";
  }

  function renderResults() {
    const container = document.querySelector(`#${PANEL_ID} [data-zsh-role="results"]`);
    if (!container) return;

    if (!state.lastAdvice) {
      container.innerHTML = `
        <div class="zsh-empty">
          这里会显示模型生成的题干识别、选项识别和解题思路。
        </div>
      `;
      return;
    }

    container.innerHTML = `<div class="zsh-advice-summary zsh-markdown">${renderMarkdown(normalizeAdviceMarkdown(state.lastAdvice))}</div>`;
    typesetMath(container);
  }

  function renderAdviceItem(item) {
    const index = escapeHtml(String(item.questionIndex ?? item.index ?? ""));
    const type = escapeHtml(String(item.questionType ?? item.type ?? "题目"));
    const concepts = normalizeArray(item.concepts ?? item.keyConcepts ?? item.knowledgePoints);
    const steps = normalizeArray(item.analysisSteps ?? item.steps ?? item.approach);
    const formula = item.recognizedFormula ?? item.formula ?? item.imageFormula ?? item.mathExpression;

    return `
      <article class="zsh-advice-item">
        <h3>第 ${index || "?"} 题 · ${type}</h3>
        ${concepts.length ? `<div class="zsh-tag-row">${concepts.map((text) => `<span class="zsh-tag">${escapeHtml(text)}</span>`).join("")}</div>` : ""}
        ${formula ? `<p><strong>公式识别：</strong>${escapeHtml(String(formula))}</p>` : ""}
        ${item.hint ? `<p><strong>提示：</strong>${escapeHtml(String(item.hint))}</p>` : ""}
        ${steps.length ? `<p><strong>思路：</strong></p><ul>${steps.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : ""}
      </article>
    `;
  }

  function normalizeArray(value) {
    if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
    if (!value) return [];
    return [String(value)];
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let listType = "";
    let inFence = false;
    let fenceLines = [];
    let inDisplayMath = false;
    let displayMathLines = [];

    const closeList = () => {
      if (!listType) return;
      html.push(`</${listType}>`);
      listType = "";
    };

    const openList = (type) => {
      if (listType === type) return;
      closeList();
      listType = type;
      html.push(`<${type}>`);
    };

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inFence) {
          html.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
          fenceLines = [];
          inFence = false;
        } else {
          closeList();
          inFence = true;
        }
        continue;
      }

      if (inFence) {
        fenceLines.push(line);
        continue;
      }

      if (inDisplayMath) {
        displayMathLines.push(line);
        if (/\\\]\s*$/.test(line) || /\$\$\s*$/.test(line)) {
          html.push(renderMathBlock(displayMathLines.join("\n")));
          displayMathLines = [];
          inDisplayMath = false;
        }
        continue;
      }

      if (!line.trim()) {
        closeList();
        continue;
      }

      if (/^\s*(\\\[|\$\$)/.test(line) && !/(\\\]\s*$|\$\$\s*$)/.test(line.replace(/^\s*(\\\[|\$\$)/, ""))) {
        closeList();
        inDisplayMath = true;
        displayMathLines = [line];
        continue;
      }

      if (/^\s*(\\\[|\$\$)[\s\S]*(\\\]|\$\$)\s*$/.test(line)) {
        closeList();
        html.push(renderMathBlock(line));
        continue;
      }

      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        closeList();
        const level = heading[1].length;
        html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }

      const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
      if (unordered) {
        openList("ul");
        html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
        continue;
      }

      const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      if (ordered) {
        openList("ol");
        html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
        continue;
      }

      const quote = /^\s*>\s+(.+)$/.exec(line);
      if (quote) {
        closeList();
        html.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }

      closeList();
      html.push(`<p>${renderInlineMarkdown(line)}</p>`);
    }

    if (inFence) html.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
    if (inDisplayMath) html.push(renderMathBlock(displayMathLines.join("\n")));
    closeList();
    return html.join("");
  }

  function renderInlineMarkdown(text) {
    const protectedMath = protectMathSegments(text);
    return escapeHtml(protectedMath.text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/@@ZSH_MATH_(\d+)@@/g, (_, index) => renderInlineMath(protectedMath.segments[Number(index)] || ""));
  }

  function renderInlineMath(rawMath) {
    const tex = stripMathDelimiters(rawMath);
    const boxedChoice = renderBoxedChoice(tex);
    if (boxedChoice) return boxedChoice;
    return [
      `<span class="zsh-math-inline">`,
      `<span class="zsh-math-placeholder" data-display="false" data-tex="${escapeHtml(tex)}">`,
      `<span class="zsh-math-fallback">\\(${escapeHtml(tex)}\\)</span>`,
      `</span>`,
      `</span>`
    ].join("");
  }

  function renderMathBlock(rawMath) {
    const tex = stripMathDelimiters(rawMath);
    const boxedChoice = renderBoxedChoice(tex, true);
    if (boxedChoice) return `<div class="zsh-math-block">${boxedChoice}</div>`;
    return [
      `<div class="zsh-math-block">`,
      `<div class="zsh-math-placeholder" data-display="true" data-tex="${escapeHtml(tex)}">`,
      `<span class="zsh-math-fallback">\\[${escapeHtml(tex)}\\]</span>`,
      `</div>`,
      `</div>`
    ].join("");
  }

  function renderBoxedChoice(tex, display = false) {
    const match = /^\\boxed\s*\{\s*([A-HＡ-Ｈ])\s*\}$/.exec(String(tex || "").trim());
    if (!match) return "";
    const label = normalizeOptionLabel(match[1]);
    const className = `zsh-boxed-choice${display ? " zsh-boxed-choice-display" : ""}`;
    return `<span class="${className}">${escapeHtml(label)}</span>`;
  }

  function stripMathDelimiters(rawMath) {
    let tex = String(rawMath || "").trim();
    for (let i = 0; i < 3; i += 1) {
      const next = tex
        .replace(/^\\\[\s*/, "")
        .replace(/\s*\\\]$/, "")
        .replace(/^\\\(\s*/, "")
        .replace(/\s*\\\)$/, "")
        .replace(/^\$\$\s*/, "")
        .replace(/\s*\$\$$/, "")
        .replace(/^\$\s*/, "")
        .replace(/\s*\$$/, "")
        .trim();
      if (next === tex) break;
      tex = next;
    }
    return tex;
  }

  function protectMathSegments(text) {
    const segments = [];
    const source = String(text || "");
    const pattern = /(\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?!\s)[\s\S]*?\S\$)/g;
    return {
      text: source.replace(pattern, (match) => {
        const index = segments.push(match) - 1;
        return `@@ZSH_MATH_${index}@@`;
      }),
      segments
    };
  }

  function typesetMath(container) {
    ensureMathJax()
      .then(() => renderMathPlaceholders(container))
      .catch((error) => {
        showMathFallbacks(container);
        console.warn("[智慧树学习助手] MathJax 渲染失败：", error);
      });
  }

  async function renderMathPlaceholders(container) {
    const mathJax = getMathJax();
    if (!mathJax || typeof mathJax.tex2chtmlPromise !== "function") {
      throw new Error("MathJax tex2chtmlPromise 不可用。");
    }
    const placeholders = Array.from(container.querySelectorAll(".zsh-math-placeholder"));
    for (const placeholder of placeholders) {
      const tex = placeholder.getAttribute("data-tex") || "";
      const display = placeholder.getAttribute("data-display") === "true";
      if (!tex.trim()) continue;
      try {
        const node = await mathJax.tex2chtmlPromise(tex, { display });
        mathJax.startup?.document?.clear?.();
        mathJax.startup?.document?.updateDocument?.();
        placeholder.replaceChildren(node);
      } catch (error) {
        placeholder.querySelectorAll(".zsh-math-fallback").forEach((fallback) => {
          fallback.style.display = "";
        });
        console.warn("[智慧树学习助手] 单个公式渲染失败：", tex, error);
      }
    }
  }

  function hideMathFallbacks(container) {
    container.querySelectorAll(".zsh-math-fallback").forEach((node) => {
      node.style.display = "none";
    });
  }

  function showMathFallbacks(container) {
    container.querySelectorAll(".zsh-math-fallback").forEach((node) => {
      node.style.display = "";
    });
  }

  function ensureMathJax() {
    if (getMathJax() && typeof getMathJax().tex2chtmlPromise === "function") {
      return Promise.resolve();
    }
    if (mathJaxReadyPromise) return mathJaxReadyPromise;

    if (!document.getElementById(MATHJAX_CONFIG_ID)) {
      const targetWindow = getUnsafeWindow();
      targetWindow.MathJax = {
        ...(targetWindow.MathJax || {}),
        tex: {
          inlineMath: [["\\(", "\\)"], ["$", "$"]],
          displayMath: [["\\[", "\\]"], ["$$", "$$"]],
          processEscapes: true,
          processEnvironments: true
        },
        options: {
          skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"]
        },
        startup: {
          typeset: false
        }
      };
      const marker = document.createElement("meta");
      marker.id = MATHJAX_CONFIG_ID;
      document.documentElement.appendChild(marker);
    }

    mathJaxReadyPromise = new Promise((resolve, reject) => {
      const existing = document.getElementById(MATHJAX_SCRIPT_ID);
      if (existing) {
        if (getMathJax() && typeof getMathJax().tex2chtmlPromise === "function") resolve();
        else existing.addEventListener("load", () => resolve(), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.id = MATHJAX_SCRIPT_ID;
      script.src = MATHJAX_SRC;
      script.async = true;
      script.onload = () => waitForMathJaxReady(resolve, reject);
      script.onerror = () => reject(new Error("MathJax 加载失败。"));
      document.head.appendChild(script);
    });

    return mathJaxReadyPromise;
  }

  function waitForMathJaxReady(resolve, reject) {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const mathJax = getMathJax();
      if (mathJax && typeof mathJax.tex2chtmlPromise === "function") {
        window.clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 10000) {
        window.clearInterval(timer);
        reject(new Error("MathJax 初始化超时。"));
      }
    }, 100);
  }

  function getMathJax() {
    const targetWindow = getUnsafeWindow();
    return targetWindow.MathJax || window.MathJax;
  }

  function getUnsafeWindow() {
    try {
      if (typeof unsafeWindow !== "undefined") return unsafeWindow;
    } catch (error) {
      // Ignore sandbox access issues and fall back to window.
    }
    return window;
  }

  async function testConnection() {
    saveConfig(readConfigFields());
    state.busy = true;
    setStatus("正在测试模型连接...", "warn");
    renderPanel();
    try {
      const payload = {
        model: state.config.model,
        stream: false,
        temperature: 0,
        messages: [
          { role: "system", content: "请用 Markdown 简短回答。" },
          { role: "user", content: "请返回：**ready**" }
        ]
      };
      const data = await postChatCompletions(payload, state.config);
      const text = extractAssistantText(data);
      if (!text.trim()) throw new Error("模型响应为空。");
      setStatus("连接测试通过。", "success");
    } catch (error) {
      setStatus(`连接测试失败：${error.message}`, "error");
    } finally {
      state.busy = false;
      renderPanel();
    }
  }

  async function analyzeCurrentPage() {
    saveConfig(readConfigFields());
    state.busy = true;
    state.lastAdvice = null;
    setStatus("正在提取当前页面题目...", "warn");
    renderPanel();

    try {
      await waitForElement("body", 10000);
      const questions = await extractQuestions();
      state.lastQuestions = questions;
      if (!questions.length) {
        setStatus("没有识别到题目。请进入具体作答页面后再试，或按 README 调整选择器。", "error");
        return;
      }
      const imageCount = questions.reduce((total, question) => total + question.images.length, 0);
      const imageTip = imageCount ? "请确认当前模型支持视觉输入。" : "当前未发现题目图片。";
      setStatus(`识别到 ${questions.length} 道题、${imageCount} 张图片，正在请求模型生成讲解。${imageTip}`, "warn");
      const advice = await requestStudyAdvice(questions, state.config);
      state.lastAdvice = advice;
      setStatus("讲解已生成。请根据思路自行完成作答。", "success");
    } catch (error) {
      setStatus(`解析失败：${error.message}`, "error");
    } finally {
      state.busy = false;
      renderPanel();
    }
  }

  function installDomObserver() {
    const observer = new MutationObserver(() => {
      window.clearTimeout(state.domDebounceTimer);
      state.domDebounceTimer = window.setTimeout(refreshQuestionCount, 450);
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function installRouteListener() {
    const notify = () => {
      if (state.route === location.href) return;
      state.route = location.href;
      state.lastAdvice = null;
      setStatus("页面已切换，正在重新识别题目...", "warn");
      window.setTimeout(refreshQuestionCount, 150);
    };

    ["pushState", "replaceState"].forEach((method) => {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event("zh-study-helper-route-change"));
        return result;
      };
    });

    window.addEventListener("popstate", () => window.dispatchEvent(new Event("zh-study-helper-route-change")));
    window.addEventListener("zh-study-helper-route-change", notify);
  }

  function refreshQuestionCount() {
    if (state.busy) return;
    const questions = extractQuestionsSync();
    const changed = questions.length !== state.lastQuestions.length;
    state.lastQuestions = questions;
    if (changed && !state.lastAdvice) {
      state.status = null;
      renderStatus();
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function waitForElement(selector, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const found = document.querySelector(selector);
      if (found) {
        resolve(found);
        return;
      }

      const observer = new MutationObserver(() => {
        const node = document.querySelector(selector);
        if (!node) return;
        cleanup();
        resolve(node);
      });

      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`等待元素超时：${selector}`));
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timer);
        observer.disconnect();
      };

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    });
  }

  async function extractQuestions(options = {}) {
    const includeImages = options.includeImages !== false;
    const nodes = collectQuestionNodes();
    const seen = new Set();
    const questions = [];

    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const fullText = cleanText(node.innerText || node.textContent || "");
      if (!looksLikeQuestion(node, fullText)) continue;

      const options = extractOptions(node);
      const stem = extractQuestionStem(node, options);
      if (stem.length < 6) continue;

      const fingerprint = compactText(stem).slice(0, 220);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      questions.push({
        questionIndex: questions.length + 1,
        questionType: inferQuestionType(node, fullText, options),
        question: clipText(stem, MAX_QUESTION_TEXT),
        options: options.slice(0, 10).map((option, index) => ({
          optionIndex: index + 1,
          label: option.label || OPTION_LABELS[index] || String(index + 1),
          text: clipText(option.text, MAX_OPTION_TEXT)
        })),
        images: includeImages ? await extractQuestionImages(node, options) : [],
        pageUrl: location.href
      });

      if (questions.length >= MAX_QUESTIONS) break;
    }

    return questions;
  }

  function extractQuestionsSync(options = {}) {
    const includeImages = options.includeImages === true;
    const nodes = collectQuestionNodes();
    const seen = new Set();
    const questions = [];

    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const fullText = cleanText(node.innerText || node.textContent || "");
      if (!looksLikeQuestion(node, fullText)) continue;

      const questionOptions = extractOptions(node);
      const stem = extractQuestionStem(node, questionOptions);
      if (stem.length < 6) continue;

      const fingerprint = compactText(stem).slice(0, 220);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      questions.push({
        questionIndex: questions.length + 1,
        questionType: inferQuestionType(node, fullText, questionOptions),
        question: clipText(stem, MAX_QUESTION_TEXT),
        options: questionOptions.slice(0, 10).map((option, index) => ({
          optionIndex: index + 1,
          label: option.label || OPTION_LABELS[index] || String(index + 1),
          text: clipText(option.text, MAX_OPTION_TEXT)
        })),
        images: includeImages ? [] : [],
        pageUrl: location.href
      });

      if (questions.length >= MAX_QUESTIONS) break;
    }

    return questions;
  }

  function collectQuestionNodes() {
    const nodes = new Set();
    document.querySelectorAll(QUESTION_BLOCK_SELECTORS.join(",")).forEach((node) => {
      if (node instanceof HTMLElement) nodes.add(node);
    });

    document.querySelectorAll("input[type='radio'], input[type='checkbox']").forEach((input) => {
      const block = closestQuestionBlock(input);
      if (block) nodes.add(block);
    });

    const compactNodes = [...nodes].filter((node) => {
      const text = compactText(node.innerText || node.textContent || "");
      if (text.length < 20 || text.length > 12000) return false;
      return ![...nodes].some((other) => {
        if (other === node || !node.contains(other)) return false;
        const otherText = compactText(other.innerText || other.textContent || "");
        return otherText.length >= 20 && otherText.length < text.length * 0.72;
      });
    });

    if (compactNodes.length) return sortByDocumentOrder(compactNodes);

    const fallback = document.body ? [document.body] : [];
    return fallback;
  }

  function closestQuestionBlock(input) {
    let current = input instanceof HTMLElement ? input : input.parentElement;
    let best = null;

    for (let depth = 0; current && depth < 8; depth += 1) {
      const text = compactText(current.innerText || current.textContent || "");
      const inputCount = current.querySelectorAll("input[type='radio'], input[type='checkbox']").length;
      if (text.length >= 30 && inputCount >= 2 && text.length <= 5000) {
        best = current;
      }
      current = current.parentElement;
    }

    return best || input.closest("li, section, article, div");
  }

  function sortByDocumentOrder(nodes) {
    return nodes.sort((a, b) => {
      if (a === b) return 0;
      const position = a.compareDocumentPosition(b);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function looksLikeQuestion(node, text) {
    if (!text) return false;
    if (node.querySelectorAll("input[type='radio'], input[type='checkbox']").length >= 2) return true;
    const options = extractOptions(node);
    if (options.length >= 2 && /[?？。]|单选|多选|判断|题/.test(text)) return true;
    return /(^|\s|[（(])(单选|多选|判断|不定项|题目|第\s*\d+\s*题)/.test(text) && text.length >= 20;
  }

  function extractOptions(block) {
    const options = [];
    const seen = new Set();

    block.querySelectorAll("input[type='radio'], input[type='checkbox']").forEach((input, index) => {
      const container = optionContainerFromInput(input);
      const rawText = cleanText(container ? container.innerText || container.textContent || "" : input.value || "");
      addOptionFromElement(options, seen, rawText, index, container);
    });

    block.querySelectorAll(OPTION_SELECTORS.join(",")).forEach((node, index) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) return;
      const rawText = cleanText(node.innerText || node.textContent || "");
      const hasImage = collectImageCandidates(node).length > 0;
      if ((!rawText && !hasImage) || rawText.length > 900) return;
      const hasOptionClass = /option|radio|checkbox|answer/i.test(node.className || "");
      const startsLikeOption = /^[A-HＡ-Ｈ]\s*[.、．:：)）]/.test(rawText);
      const judgeOption = /^(正确|错误|对|错|True|False)$/i.test(compactText(rawText));
      if (hasOptionClass || startsLikeOption || judgeOption || hasImage) {
        addOptionFromElement(options, seen, rawText, index, node);
      }
    });

    return options;
  }

  function optionContainerFromInput(input) {
    if (!(input instanceof HTMLElement)) return null;
    if (input.id) {
      const label = document.querySelector(`label[for="${cssEscape(input.id)}"]`);
      if (label) return label;
    }
    return input.closest("label, li, .option, .option-item, .optionItem, .el-radio, .el-checkbox")
      || closestVisualOptionBlock(input)
      || input.parentElement;
  }

  function closestVisualOptionBlock(input) {
    let current = input instanceof HTMLElement ? input.parentElement : null;
    let best = null;
    for (let depth = 0; current && depth < 6; depth += 1) {
      const text = compactText(current.innerText || current.textContent || "");
      const imageCount = current.querySelectorAll("img, [style*='background-image']").length;
      const inputCount = current.querySelectorAll("input[type='radio'], input[type='checkbox']").length;
      if (imageCount > 0 && inputCount <= 1 && text.length < 1200) best = current;
      if (inputCount > 1) break;
      current = current.parentElement;
    }
    return best;
  }

  function addOption(options, seen, rawText, fallbackIndex) {
    const text = cleanOptionText(rawText);
    const labelMatch = /^[A-HＡ-Ｈ]\s*[.、．:：)）]/i.exec(cleanText(rawText));
    const label = labelMatch ? normalizeOptionLabel(labelMatch[0]) : OPTION_LABELS[options.length] || String(options.length + 1);
    const optionText = text || `[选项 ${label} 为图片内容]`;
    const key = compactText(optionText).slice(0, 180);
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push({
      optionIndex: fallbackIndex + 1,
      label,
      text: optionText,
      rawText,
      element: null
    });
  }

  function addOptionFromElement(options, seen, rawText, fallbackIndex, element) {
    const beforeLength = options.length;
    addOption(options, seen, rawText, fallbackIndex);
    if (options.length > beforeLength) {
      options[options.length - 1].element = element instanceof HTMLElement ? element : null;
    }
  }

  function normalizeOptionLabel(label) {
    const first = String(label || "").trim().charAt(0);
    const fullWidthIndex = "ＡＢＣＤＥＦＧＨ".indexOf(first);
    if (fullWidthIndex >= 0) return OPTION_LABELS[fullWidthIndex];
    return first ? first.toUpperCase() : "";
  }

  function cleanOptionText(text) {
    return cleanText(text)
      .replace(/^[A-HＡ-Ｈ]\s*[.、．:：)）]\s*/i, "")
      .replace(/^(选项|答案)\s*[A-HＡ-Ｈ]?\s*[.、．:：)）]?\s*/i, "")
      .trim();
  }

  async function extractQuestionImages(block, options) {
    const labeledCandidates = [];
    const optionElements = new Set(options.map((option) => option.element).filter(Boolean));
    const stemCandidates = collectImageCandidates(block)
      .filter((candidate) => !isInsideAny(candidate.element, optionElements))
      .map((candidate) => ({
        ...candidate,
        role: "题干",
        label: "stem"
      }));
    labeledCandidates.push(...stemCandidates);

    options.forEach((option, index) => {
      if (!option.element) return;
      const label = option.label || OPTION_LABELS[index] || String(index + 1);
      collectImageCandidates(option.element).forEach((candidate) => {
        labeledCandidates.push({
          ...candidate,
          role: `选项 ${label}`,
          label: `option-${label}`
        });
      });
    });

    if (!labeledCandidates.length) {
      labeledCandidates.push(...collectImageCandidates(block).map((candidate) => ({
        ...candidate,
        role: "题目区域",
        label: "question"
      })));
    }

    return materializeImages(labeledCandidates);
  }

  async function materializeImages(candidates) {
    const images = [];
    const seen = new Set();

    for (const candidate of candidates) {
      if (images.length >= MAX_IMAGES_PER_QUESTION) break;
      const source = absoluteUrl(candidate.url);
      const dedupeKey = `${candidate.label || ""}::${source}`;
      if (!source || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      try {
        const dataUrl = await imageUrlToDataUrl(source, candidate.element);
        if (!dataUrl) continue;
        images.push({
          imageIndex: images.length + 1,
          role: candidate.role || "题目图片",
          label: candidate.label || "",
          alt: clipText(candidate.alt || "", 160),
          source,
          dataUrl
        });
      } catch (error) {
        console.warn("[智慧树学习助手] 图片读取失败：", source, error);
      }
    }

    return images;
  }

  function isInsideAny(element, containers) {
    if (!element || !containers.size) return false;
    for (const container of containers) {
      if (container && container !== element && container.contains(element)) return true;
      if (container === element) return true;
    }
    return false;
  }

  function collectImageCandidates(block) {
    const candidates = [];

    block.querySelectorAll("img").forEach((img) => {
      if (!(img instanceof HTMLImageElement) || !isVisible(img)) return;
      const url = getImageUrl(img);
      if (!url || isDecorativeImage(img, url)) return;
      candidates.push({
        url,
        alt: img.alt || img.title || "",
        element: img
      });
    });

    block.querySelectorAll("[style*='background-image']").forEach((element) => {
      if (!(element instanceof HTMLElement) || !isVisible(element)) return;
      const url = getBackgroundImageUrl(element);
      if (!url || isDecorativeImage(element, url)) return;
      candidates.push({
        url,
        alt: element.getAttribute("aria-label") || element.title || "",
        element
      });
    });

    return candidates;
  }

  function getImageUrl(img) {
    const attrs = [
      "currentSrc",
      "src",
      "data-src",
      "data-original",
      "data-actualsrc",
      "data-lazy-src",
      "data-url",
      "lazy-src"
    ];

    for (const attr of attrs) {
      const value = attr === "currentSrc" ? img.currentSrc : img.getAttribute(attr);
      if (value && !value.startsWith("data:image/gif")) return value;
    }

    const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset");
    if (srcset) return srcset.split(",").map((item) => item.trim().split(/\s+/)[0]).filter(Boolean).pop() || "";
    return "";
  }

  function getBackgroundImageUrl(element) {
    const image = window.getComputedStyle(element).backgroundImage;
    const match = /url\((['"]?)(.*?)\1\)/.exec(image || "");
    return match ? match[2] : "";
  }

  function isDecorativeImage(element, url) {
    const rect = element.getBoundingClientRect();
    const compactUrl = String(url).toLowerCase();
    if (rect.width < 16 || rect.height < 12) return true;
    if (/sprite|icon|avatar|logo|loading|blank|placeholder|transparent/.test(compactUrl)) return true;
    if (element.closest(`#${PANEL_ID}, #${TOGGLE_ID}`)) return true;
    return false;
  }

  async function imageUrlToDataUrl(url, element) {
    if (url.startsWith("data:image/")) return normalizeImageDataUrl(url);
    if (url.startsWith("blob:")) return element ? imageElementToDataUrl(element) : "";

    try {
      return await fetchImageAsDataUrl(url);
    } catch (error) {
      if (element) return imageElementToDataUrl(element);
      throw error;
    }
  }

  function fetchImageAsDataUrl(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout: 20000,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`图片 HTTP ${response.status}`));
            return;
          }
          const blob = response.response;
          if (!(blob instanceof Blob)) {
            reject(new Error("图片响应不是 Blob。"));
            return;
          }
          blobToDataUrl(blob).then(normalizeImageDataUrl).then(resolve).catch(reject);
        },
        onerror: () => reject(new Error("图片网络请求失败。")),
        ontimeout: () => reject(new Error("图片请求超时。"))
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("图片 Blob 转换失败。"));
      reader.readAsDataURL(blob);
    });
  }

  async function imageElementToDataUrl(element) {
    if (!(element instanceof HTMLImageElement)) return "";
    if (!element.complete) {
      await new Promise((resolve) => {
        element.addEventListener("load", resolve, { once: true });
        element.addEventListener("error", resolve, { once: true });
        window.setTimeout(resolve, 2000);
      });
    }
    const canvas = document.createElement("canvas");
    const ratio = Math.min(1, MAX_IMAGE_SIDE / Math.max(element.naturalWidth || element.width, element.naturalHeight || element.height, 1));
    canvas.width = Math.max(1, Math.round((element.naturalWidth || element.width || 1) * ratio));
    canvas.height = Math.max(1, Math.round((element.naturalHeight || element.height || 1) * ratio));
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
  }

  function normalizeImageDataUrl(dataUrl) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const maxSide = Math.max(image.naturalWidth, image.naturalHeight);
        if (!maxSide) {
          resolve(dataUrl);
          return;
        }
        const ratio = Math.min(1, MAX_IMAGE_SIDE / maxSide);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(dataUrl);
          return;
        }
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY));
      };
      image.onerror = () => resolve(dataUrl);
      image.src = dataUrl;
    });
  }

  function absoluteUrl(url) {
    if (!url) return "";
    try {
      return new URL(url, location.href).href;
    } catch (error) {
      return "";
    }
  }

  function extractQuestionStem(block, options) {
    const text = cleanText(block.innerText || block.textContent || "");
    const lines = text.split(/\n+/).map((line) => cleanText(line)).filter(Boolean);
    const optionLineIndex = lines.findIndex((line) => /^[A-HＡ-Ｈ]\s*[.、．:：)）]/.test(line));
    if (optionLineIndex > 0) {
      return cleanText(lines.slice(0, optionLineIndex).join("\n"));
    }

    let stem = text;
    for (const option of options) {
      if (option.rawText) stem = replaceOnce(stem, option.rawText, " ");
      if (option.text) stem = replaceOnce(stem, option.text, " ");
    }
    stem = cleanText(stem);
    if (stem.length >= 6 && stem.length < text.length) return stem;

    return cleanText(lines.slice(0, Math.min(lines.length, 4)).join("\n")) || text;
  }

  function inferQuestionType(block, text, options) {
    if (/多选|不定项|multiple/i.test(text)) return "多选题";
    if (/判断|正确|错误|对错|true|false/i.test(text) && options.length <= 3) return "判断题";
    if (block.querySelector("input[type='checkbox']")) return "多选题";
    if (block.querySelector("input[type='radio']")) return "单选题";
    if (options.length === 2 && options.every((option) => /^(正确|错误|对|错|true|false)$/i.test(compactText(option.text)))) return "判断题";
    return "题目";
  }

  async function requestStudyAdvice(questions, config) {
    const messages = buildMessages(questions);
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const payload = {
          model: config.model,
          stream: false,
          temperature: Number(config.temperature ?? DEFAULT_CONFIG.temperature),
          max_tokens: Number(config.maxTokens ?? DEFAULT_CONFIG.maxTokens),
          messages
        };
        const data = await postChatCompletions(payload, config);
        const text = extractAssistantText(data);
        return sanitizeMarkdown(text);
      } catch (error) {
        lastError = error;
        messages.push({
          role: "user",
          content: `第 ${attempt} 次请求失败或输出不符合要求。请直接输出 Markdown，不要使用 JSON，不要使用代码块包裹全文；请完整转写题干图片和每个选项图片里的公式。`
        });
      }
    }

    throw lastError || new Error("模型请求失败。");
  }

  function buildMessages(questions) {
    const safeQuestions = questions.map((question) => ({
      questionIndex: question.questionIndex,
      questionType: question.questionType,
      question: imageAwareQuestionText(question),
      options: question.options,
      images: question.images.map((image) => ({
        imageIndex: image.imageIndex,
        role: image.role,
        label: image.label,
        alt: image.alt,
        note: `图片 ${image.imageIndex} 属于${image.role || "题目区域"}，可能包含题干、选项或数学公式，请逐张完整识别。`
      }))
    }));
    const userContent = [
      {
        type: "text",
        text: JSON.stringify({
          task: "请基于以下题目和图片生成 Markdown 学习讲解。图片中可能包含数学公式、积分上下限、矩阵、图形或选项内容。请完整转写题干图片和每个选项图片中的公式，尤其不要遗漏 A/B/C/D 任一选项。",
          questions: safeQuestions
        })
      }
    ];

    for (const question of questions) {
      for (const image of question.images) {
        userContent.push({
          type: "text",
          text: `第 ${question.questionIndex} 题的图片 ${image.imageIndex}（${image.role || "题目区域"}）：请先完整识别其中的数学公式或图形信息。若它是选项图片，请明确写出对应选项的公式。`
        });
        userContent.push({
          type: "image_url",
          image_url: {
            url: image.dataUrl,
            detail: "high"
          }
        });
      }
    }

    return [
      {
        role: "system",
        content: [
          "你是一名严谨的学习辅导助手，帮助学生理解题目。",
          "请直接返回 Markdown，不要返回 JSON，不要用代码块包裹全文。",
          "数学公式必须使用标准 LaTeX 分隔符：短行内公式用 \\(...\\)，积分、求和、分式、矩阵、上下限明显的公式用块级 \\[...\\]；不要把反斜杠重复写成 \\\\，不要把公式写成普通文本。",
          "选项中的公式请逐项单独用块级 LaTeX 展示，尽量保留原题图片中的排版效果，例如积分号、上下限和函数参数。",
          "若需要表示选项字母被框住，请只写 \\boxed{A}、\\boxed{B}、\\boxed{C} 或 \\boxed{D}，不要手动画方框。",
          "题目可能包含图片形式的数学公式；你需要从图片中识别公式、符号、上下限、图形关系，并在讲解中用 LaTeX 或文字转写关键表达式。",
          "必须逐张图片识别：先写题干图片转写，再按选项 A、B、C、D 分别写出选项图片里的完整公式；如果某个选项没有图片，也要说明。",
          "请按以下 Markdown 结构输出；不要输出“本页复习方向”“知识点”“自检”“易错点”这些栏目：",
          "## 第 N 题",
          "- **题干/公式识别**：...",
          "- **选项图片识别**：A: ...；B: ...；C: ...；D: ...",
          "- **思路**：..."
        ].join("\n")
      },
      {
        role: "user",
        content: userContent
      }
    ];
  }

  function postChatCompletions(payload, config) {
    return new Promise((resolve, reject) => {
      const headers = {
        "Content-Type": "application/json"
      };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

      GM_xmlhttpRequest({
        method: "POST",
        url: chatCompletionsUrl(config.baseUrl),
        headers,
        data: JSON.stringify(payload),
        timeout: Number(config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs),
        onload: (response) => {
          const body = response.responseText || "";
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}: ${clipText(body, 240)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`接口返回不是 JSON：${error.message}`));
          }
        },
        onerror: () => reject(new Error("网络请求失败。")),
        ontimeout: () => reject(new Error("模型接口请求超时。"))
      });
    });
  }

  function chatCompletionsUrl(baseUrl) {
    const normalized = String(baseUrl || DEFAULT_CONFIG.baseUrl).trim().replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(normalized)) return normalized;
    if (/\/v1$/i.test(normalized)) return `${normalized}/chat/completions`;
    return `${normalized}/v1/chat/completions`;
  }

  function extractAssistantText(data) {
    const content = data?.choices?.[0]?.message?.content
      ?? data?.choices?.[0]?.text
      ?? data?.message?.content
      ?? data?.response;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("模型响应中没有可读取的文本。");
    }
    return content.trim();
  }

  function sanitizeMarkdown(text) {
    return normalizeLatexEscapes(String(text || "")
      .replace(/^```(?:markdown|md)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim());
  }

  function normalizeAdviceMarkdown(markdown) {
    return removeUnwantedAdviceSections(normalizeBareMathLines(normalizeLatexEscapes(markdown)));
  }

  function normalizeLatexDelimiters(markdown) {
    return normalizeAdviceMarkdown(markdown);
  }

  function removeUnwantedAdviceSections(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    let skippingSection = false;
    let skipListContinuation = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const heading = /^(#{1,6})\s*(.+?)\s*$/.exec(trimmed);
      const listHeading = /^\s*[-*]\s*\*\*(本页复习方向|知识点|自检|易错点)\*\*\s*[：:]/.exec(line);
      const boldParagraph = /^\s*\*\*(本页复习方向|知识点|自检|易错点)\*\*\s*[：:]?/.exec(line);

      if (heading) {
        const title = heading[2].replace(/[：:]\s*$/, "").trim();
        skippingSection = /^(本页复习方向|知识点|自检|易错点)$/.test(title);
        skipListContinuation = false;
        if (skippingSection) continue;
      }

      if (listHeading || boldParagraph) {
        skipListContinuation = true;
        continue;
      }

      if (skipListContinuation) {
        if (!trimmed) {
          skipListContinuation = false;
          continue;
        }
        if (/^\s*[-*]\s+\*\*/.test(line) || /^#{1,6}\s+/.test(trimmed)) {
          skipListContinuation = false;
        } else if (/^\s{2,}\S/.test(line)) {
          continue;
        } else {
          continue;
        }
      }

      if (skippingSection) continue;
      output.push(line);
    }

    return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function normalizeBareMathLines(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const output = [];
    let inFence = false;
    let inDisplayMath = false;

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        output.push(line);
        continue;
      }

      if (inFence) {
        output.push(line);
        continue;
      }

      if (inDisplayMath) {
        output.push(line);
        if (/(\\\]|\$\$)\s*$/.test(line)) inDisplayMath = false;
        continue;
      }

      if (/^\s*(\\\[|\$\$)/.test(line)) {
        output.push(line);
        const rest = line.replace(/^\s*(\\\[|\$\$)/, "");
        if (!/(\\\]|\$\$)\s*$/.test(rest)) inDisplayMath = true;
        continue;
      }

      if (hasInlineMathDelimiter(line)) {
        output.push(line);
        continue;
      }

      const optionFormula = /^(\s*(?:[-*]\s*)?[A-HＡ-Ｈ]\s*[.、．:：)）])\s*(.+?)\s*[;；]?\s*$/.exec(line);
      if (optionFormula && looksLikeBareMath(optionFormula[2])) {
        output.push(`${optionFormula[1]}`);
        output.push(`\\[${normalizeLooseMathTex(optionFormula[2])}\\]`);
        continue;
      }

      if (looksLikeBareMath(line)) {
        output.push(`\\[${normalizeLooseMathTex(line)}\\]`);
        continue;
      }

      output.push(line);
    }

    return output.join("\n");
  }

  function hasInlineMathDelimiter(line) {
    return /(\\\(|\\\)|\$(?!\s).+\S\$)/.test(String(line || ""));
  }

  function looksLikeBareMath(line) {
    const text = String(line || "").trim();
    if (!text || text.length > 180 || /[\u4e00-\u9fff]/.test(text)) return false;
    if (!/[=<>≤≥≠≈∫∑√]|\\(?:int|iint|iiint|oint|frac|dfrac|sqrt|sum|prod|lim|le|ge|leq|geq)\b/.test(text)) return false;
    const mathChars = (text.match(/[A-Za-z0-9\\_^{}()[\],.+\-*/=<>≤≥≠≈∫∑√Γγπθαβλμσ∞| ]/g) || []).length;
    return mathChars / Math.max(text.length, 1) > 0.78;
  }

  function normalizeLooseMathTex(text) {
    return String(text || "")
      .trim()
      .replace(/[。；;]\s*$/, "")
      .replace(/∫/g, "\\int ")
      .replace(/∑/g, "\\sum ")
      .replace(/√/g, "\\sqrt ")
      .replace(/Γ/g, "\\Gamma")
      .replace(/γ/g, "\\gamma")
      .replace(/π/g, "\\pi")
      .replace(/θ/g, "\\theta")
      .replace(/α/g, "\\alpha")
      .replace(/β/g, "\\beta")
      .replace(/λ/g, "\\lambda")
      .replace(/μ/g, "\\mu")
      .replace(/σ/g, "\\sigma")
      .replace(/∞/g, "\\infty ")
      .replace(/≤/g, "\\le ")
      .replace(/≥/g, "\\ge ")
      .replace(/≠/g, "\\ne ")
      .replace(/≈/g, "\\approx ")
      .replace(/×/g, "\\times ")
      .replace(/·/g, "\\cdot ")
      .replace(/<\s*=/g, "\\le ")
      .replace(/>\s*=/g, "\\ge ")
      .replace(/!\s*=/g, "\\ne ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function normalizeLatexEscapes(text) {
    return String(text || "")
      .replace(/\\\\([[\]()])/g, "\\$1")
      .replace(/\\\\(int|frac|sqrt|sum|prod|lim|theta|pi|alpha|beta|gamma|delta|lambda|mu|sigma|cos|sin|tan|ln|log|cdot|times|le|ge|neq|infty|quad|qquad|left|right|mathbf|mathrm|text|begin|end|overline|vec|hat|bar|partial|nabla|iint|iiint|oint|rightarrow|to|in|notin|subset|subseteq|cup|cap|forall|exists|pm|mp|approx|equiv|because|therefore|leq|geq)\b/g, "\\$1");
  }

  function imageAwareQuestionText(question) {
    const imageHint = question.images.length
      ? `\n[本题包含 ${question.images.length} 张图片，可能有公式或图形，已随请求发送给视觉模型。]`
      : "";
    return `${question.question}${imageHint}`;
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function compactText(text) {
    return cleanText(text).replace(/\s+/g, " ");
  }

  function clipText(text, limit) {
    const clean = cleanText(text);
    return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
  }

  function replaceOnce(source, target, replacement) {
    if (!target) return source;
    const index = source.indexOf(target);
    if (index < 0) return source;
    return source.slice(0, index) + replacement + source.slice(index + target.length);
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ─── 自动作答核心逻辑 ───

  async function autoAnswerCurrentPage() {
    saveConfig(readConfigFields());
    state.busy = true;
    state.autoAnswerProgress = null;
    state.lastAdvice = null;
    setStatus("正在检测作答模式...", "warn");
    renderPanel();

    try {
      if (isExamLoopPage()) {
        await autoAnswerExamLoop();
      } else {
        const mode = detectPageMode();
        if (mode === "paginated") {
          await autoAnswerPaginated();
        } else {
          await autoAnswerBatch();
        }
      }
    } catch (error) {
      setStatus(`自动作答失败：${error.message}`, "error");
    } finally {
      state.busy = false;
      state.autoAnswerProgress = null;
      renderPanel();
    }
  }

  function detectPageMode() {
    const questions = extractQuestionsSync();
    if (questions.length > 1) return "batch";
    const nextBtn = findButtonByText(NEXT_BUTTON_TEXTS);
    if (questions.length === 1 && nextBtn) return "paginated";
    return "batch";
  }

  async function autoAnswerBatch() {
    setStatus("正在提取当前页所有题目...", "warn");
    const questions = await extractQuestionsForAutoAnswer();
    state.lastQuestions = questions;
    if (!questions.length) {
      throw new Error("没有识别到题目，请进入作答页面后再试。");
    }
    state.autoAnswerProgress = { current: 0, total: questions.length, phase: "answering" };
    setStatus(`识别到 ${questions.length} 道题，正在请求答案...`, "warn");
    renderPanel();

    const answers = await requestAutoAnswers(questions);
    setStatus("正在选择答案...", "warn");
    await applyAnswers(questions, answers);
    await delay(500);

    setStatus("正在提交...", "warn");
    renderPanel();
    const submitted = await clickSubmitButton();
    if (submitted) {
      setStatus("自动作答完成，已提交。", "success");
    } else {
      setStatus("答案已全部选择，但未找到提交按钮，请手动提交。", "warn");
    }
  }

  async function autoAnswerPaginated() {
    let questionIndex = 0;
    let prevStem = "";

    for (;;) {
      questionIndex += 1;
      state.autoAnswerProgress = { current: questionIndex, total: "?", phase: "answering" };
      setStatus(`正在处理第 ${questionIndex} 题...`, "warn");
      renderPanel();

      const questions = await extractQuestionsForAutoAnswer();
      if (!questions.length) {
        throw new Error(`第 ${questionIndex} 题未识别到，可能页面尚未加载。`);
      }
      const question = questions[0];
      if (compactText(question.question) === prevStem && questionIndex > 1) {
        break;
      }
      prevStem = compactText(question.question);

      const answers = await requestAutoAnswers(questions);
      const skipped = await applyAnswers(questions, answers);
      if (skipped.length) {
        console.warn("[智慧树学习助手] 该页存在兜底处理：", skipped.join("；"));
      }
      await delay(300);

      const nextBtn = findButtonByText(NEXT_BUTTON_TEXTS);
      if (!nextBtn || nextBtn.disabled) break;

      dispatchFullClick(nextBtn);
      const navigated = await waitForQuestionChange(prevStem, 5000);
      if (!navigated) break;
    }

    await delay(500);
    setStatus("正在提交...", "warn");
    renderPanel();
    const submitted = await clickSubmitButton();
    if (submitted) {
      setStatus(`自动作答完成，共 ${questionIndex} 题，已提交。`, "success");
    } else {
      setStatus(`答案已全部选择（共 ${questionIndex} 题），但未找到提交按钮，请手动提交。`, "warn");
    }
  }

  async function extractQuestionsForAutoAnswer() {
    const nodes = collectQuestionNodes();
    const seen = new Set();
    const questions = [];

    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const fullText = cleanText(node.innerText || node.textContent || "");
      if (!looksLikeQuestion(node, fullText)) continue;

      const rawOptions = extractOptions(node);
      const stem = extractQuestionStem(node, rawOptions);
      if (stem.length < 6) continue;

      const fingerprint = compactText(stem).slice(0, 220);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      questions.push({
        questionIndex: questions.length + 1,
        questionType: inferQuestionType(node, fullText, rawOptions),
        question: clipText(stem, MAX_QUESTION_TEXT),
        options: rawOptions.slice(0, 10).map((option, index) => ({
          optionIndex: index + 1,
          label: option.label || OPTION_LABELS[index] || String(index + 1),
          text: clipText(option.text, MAX_OPTION_TEXT),
          element: option.element
        })),
        images: await extractQuestionImages(node, rawOptions),
        blockElement: node,
        pageUrl: location.href
      });

      if (questions.length >= MAX_QUESTIONS) break;
    }

    return questions;
  }

  async function requestAutoAnswers(questions) {
    const messages = buildAutoAnswerMessages(questions);
    const expectedIndexes = questions.map((q) => q.questionIndex);
    let lastError = null;
    let lastPartial = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const payload = {
          model: state.config.model,
          stream: false,
          temperature: 0.1,
          max_tokens: 1024,
          messages
        };
        const data = await postChatCompletions(payload, state.config);
        const text = extractAssistantText(data);
        const parsed = parseAutoAnswerResponse(text);
        const covered = new Set(parsed.map((a) => a.questionIndex));
        const missing = expectedIndexes.filter((i) => !covered.has(i));
        if (!missing.length) return parsed;
        lastPartial = parsed;
        if (attempt < 3) {
          messages.push({
            role: "user",
            content: `第 ${missing.join("、")} 题缺少答案或字母不在 A-H 之间。请重新输出完整 JSON：每个 questionIndex 都必须有 answer 数组，至少包含一个 A/B/C/D 字母。只返回 JSON。`
          });
        }
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          messages.push({
            role: "user",
            content: `上一次返回无法解析为 JSON。请严格按 {"answers":[{"questionIndex":N,"answer":["A"]}, ...]} 格式重新输出，不要添加任何解释。`
          });
        }
      }
    }

    if (lastPartial && lastPartial.length) return lastPartial;
    throw lastError || new Error("获取答案失败。");
  }

  function buildAutoAnswerMessages(questions) {
    const safeQuestions = questions.map((q) => ({
      questionIndex: q.questionIndex,
      questionType: q.questionType,
      question: imageAwareQuestionText(q),
      options: q.options.map((o) => ({ label: o.label, text: o.text }))
    }));

    const userContent = [
      {
        type: "text",
        text: JSON.stringify({ questions: safeQuestions })
      }
    ];

    for (const q of questions) {
      for (const img of q.images) {
        userContent.push({
          type: "text",
          text: `第 ${q.questionIndex} 题图片（${img.role || "题目区域"}）`
        });
        userContent.push({
          type: "image_url",
          image_url: { url: img.dataUrl, detail: "high" }
        });
      }
    }

    return [
      {
        role: "system",
        content: [
          "你是一个答题助手。根据题目和选项返回正确答案。",
          "你必须严格按照以下 JSON 格式返回，不要包含任何其他文字、解释或代码块标记：",
          '{"answers":[{"questionIndex":1,"answer":["A"]},{"questionIndex":2,"answer":["B","D"]}]}',
          "规则：",
          "- answer 数组中填写正确选项的字母（如 A、B、C、D）",
          "- 单选题和判断题只填一个字母",
          "- 多选题填写所有正确选项的字母",
          "- 判断题：选项「正确/对」对应 A，「错误/错」对应 B",
          "- 只返回 JSON，不要有任何其他内容"
        ].join("\n")
      },
      { role: "user", content: userContent }
    ];
  }

  function parseAutoAnswerResponse(text) {
    let raw = String(text || "").trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const jsonMatch = raw.match(/\{[\s\S]*"answers"[\s\S]*\}/);
      if (!jsonMatch) throw new Error("无法从模型响应中解析 JSON 答案。");
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (e2) {
        throw new Error("模型返回的 JSON 格式不正确。");
      }
    }

    if (!Array.isArray(parsed.answers)) throw new Error("模型返回的 JSON 缺少 answers 数组。");

    return parsed.answers.map((item) => {
      let answer = Array.isArray(item.answer) ? item.answer : [String(item.answer || "")];
      answer = answer.flatMap((a) => {
        const s = String(a).trim().toUpperCase().replace(/^[.、．:：)）]\s*/, "");
        if (s.length > 1 && /^[A-H]+$/.test(s)) return s.split("");
        return [s];
      }).filter((a) => /^[A-H]$/.test(a));
      return {
        questionIndex: Number(item.questionIndex) || 0,
        answer
      };
    }).filter((item) => item.answer.length > 0);
  }

  async function applyAnswers(questions, answers) {
    const skipped = [];
    for (const question of questions) {
      const ans = answers.find((a) => a.questionIndex === question.questionIndex);
      let labels = ans && ans.answer.length ? ans.answer.slice() : [];

      if (!labels.length && question.options.length) {
        const fallback = question.options[0].label || "A";
        labels = [fallback];
        skipped.push(`第 ${question.questionIndex} 题（已兜底选 ${fallback}）`);
        console.warn("[智慧树学习助手] 模型未给出有效答案，兜底点选首项：", question.questionIndex, fallback);
      }

      let clicked = 0;
      for (const label of labels) {
        const option = question.options.find((o) => o.label === label);
        if (!option || !option.element) continue;
        clickOption(option.element);
        clicked += 1;
        await delay(120);
      }

      if (!clicked && question.options.length) {
        const first = question.options[0];
        if (first && first.element) {
          clickOption(first.element);
          skipped.push(`第 ${question.questionIndex} 题（标签未匹配，兜底点首项）`);
          await delay(120);
        }
      }

      await delay(120);
    }
    return skipped;
  }

  function clickOption(optionElement) {
    if (!optionElement) return;

    const input = optionElement.querySelector
      ? optionElement.querySelector("input[type='radio'], input[type='checkbox']")
      : null;

    if (input && !input.checked) {
      input.click();
      return;
    }

    const inner = optionElement.querySelector
      ? optionElement.querySelector(".el-radio__input, .el-checkbox__input, .el-radio__original, .el-checkbox__original")
      : null;

    if (inner) {
      inner.click();
      return;
    }

    if (input && input.checked) return;

    if (typeof optionElement.click === "function") {
      try {
        optionElement.click();
        return;
      } catch (error) {
        // Fall through to synthesized event sequence.
      }
    }

    dispatchFullClick(optionElement);
  }

  function dispatchFullClick(element) {
    const win = getUnsafeWindow();
    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const type of eventTypes) {
      const init = { bubbles: true, cancelable: true };
      let event = null;
      try {
        event = new MouseEvent(type, { ...init, view: win });
      } catch (error) {
        try {
          event = new MouseEvent(type, init);
        } catch (innerError) {
          event = document.createEvent("MouseEvents");
          event.initMouseEvent(type, true, true, win, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
        }
      }
      element.dispatchEvent(event);
    }
  }

  function findButtonByText(targetTexts) {
    const candidates = document.querySelectorAll(
      "button, [role='button'], input[type='submit'], input[type='button'], a[class*='btn'], [class*='submit'], [class*='next'], [class*='Submit'], [class*='Next']"
    );
    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      if (el.disabled) continue;
      const text = cleanText(el.innerText || el.value || el.getAttribute("aria-label") || "");
      if (targetTexts.some((t) => text === t || text.includes(t))) return el;
    }
    return null;
  }

  async function clickSubmitButton() {
    const btn = findButtonByText(SUBMIT_BUTTON_TEXTS);
    if (!btn) return false;
    dispatchFullClick(btn);
    await delay(500);
    return true;
  }

  function waitForQuestionChange(prevStem, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        const nodes = collectQuestionNodes();
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = cleanText(node.innerText || node.textContent || "");
          const stem = compactText(text).slice(0, 220);
          if (stem !== prevStem) {
            resolve(true);
            return;
          }
        }
        if (Date.now() - startTime > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 200);
      };
      setTimeout(check, 300);
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── 智慧树 examloop 专用作答流程 ───

  function isExamLoopPage() {
    if (/examloop\.zhihuishu\.com/i.test(location.hostname)) return true;
    return Boolean(document.querySelector(".question-area-content")) && Boolean(getExamLoopNavigatorPanel());
  }

  function getExamLoopNavigatorPanel() {
    const candidates = document.querySelectorAll("[class*='col-span-4']");
    for (const el of candidates) {
      if ((el.innerText || "").indexOf("答题卡") >= 0 && el.querySelectorAll("button").length >= 2) {
        return el;
      }
    }
    const all = document.querySelectorAll("div");
    for (const el of all) {
      const text = el.innerText || "";
      if (text.indexOf("答题卡") < 0 || text.indexOf("当前题目") < 0) continue;
      if (el.querySelectorAll("button").length < 2) continue;
      return el;
    }
    return null;
  }

  function getExamLoopNavigator() {
    const panel = getExamLoopNavigatorPanel();
    if (!panel) return [];
    const buttons = panel.querySelectorAll("button");
    const result = [];
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const num = (btn.innerText || "").trim();
      if (!/^\d+$/.test(num)) continue;
      const tokens = (btn.className || "").split(/\s+/).filter(Boolean);
      const looksLikeNavBtn = tokens.some((t) => /^size-\[?\d/i.test(t)) || tokens.some((t) => /aspect-square/i.test(t));
      if (!looksLikeNavBtn) continue;
      let state = "unanswered";
      if (tokens.includes("bg-mainBg") && tokens.includes("text-white")) {
        state = "current";
      } else if (tokens.includes("bg-mainBg/10") || tokens.includes("border-mainBg")) {
        state = "answered";
      }
      result.push({ num: Number(num), state, button: btn });
    }
    result.sort((a, b) => a.num - b.num);
    return result;
  }

  function extractExamLoopQuestion(navigatorEntry = null) {
    const area = document.querySelector(".question-area-content");
    if (!area) return null;

    const labelNodes = Array.from(area.querySelectorAll("label")).filter((label) => {
      if (!isVisible(label)) return false;
      const letterDiv = label.querySelector('div[translate="no"]');
      if (!letterDiv) return false;
      const letter = (letterDiv.innerText || letterDiv.textContent || "").trim();
      return /^[A-H]$/i.test(letter);
    });

    const options = [];
    const seen = new Set();
    labelNodes.forEach((label) => {
      const letterDiv = label.querySelector('div[translate="no"]');
      const letter = (letterDiv.innerText || letterDiv.textContent || "").trim().toUpperCase();
      const textSpan = label.querySelector(":scope > span") || label.querySelector("span:not([translate])");
      const rawText = textSpan ? cleanText(textSpan.innerText || textSpan.textContent || "") : "";
      const hasImage = label.querySelectorAll("img").length > 0;
      const optionText = rawText || (hasImage ? `[选项 ${letter} 为图片]` : "");
      const key = `${letter}::${compactText(optionText).slice(0, 120)}`;
      if (seen.has(key)) return;
      seen.add(key);
      options.push({
        optionIndex: options.length + 1,
        label: letter,
        text: clipText(optionText, MAX_OPTION_TEXT),
        rawText,
        element: label,
        letterElement: letterDiv
      });
    });

    const stem = extractExamLoopStem(area, options);
    const questionType = inferExamLoopQuestionType(area, options);
    const questionIndex = navigatorEntry ? navigatorEntry.num : 1;

    return {
      questionIndex,
      questionType,
      question: clipText(stem, MAX_QUESTION_TEXT),
      options,
      blockElement: area,
      pageUrl: location.href
    };
  }

  function extractExamLoopStem(area, options) {
    const clone = area.cloneNode(true);
    clone.querySelectorAll("label").forEach((label) => {
      const letterDiv = label.querySelector('div[translate="no"]');
      if (letterDiv && /^[A-H]$/i.test((letterDiv.innerText || letterDiv.textContent || "").trim())) {
        label.remove();
      }
    });
    clone.querySelectorAll("h1, h2, h3, h4").forEach((h) => h.remove());
    const headerRows = clone.querySelectorAll("div");
    headerRows.forEach((row) => {
      const text = compactText(row.innerText || row.textContent || "");
      if (!text) return;
      if (/^\d+\s*、\s*(单选题|多选题|判断题|不定项|阅读题|填空题|简答题)?\s*[（(]\s*\d+\s*分\s*[)）]\s*$/.test(text) && text.length < 60) {
        row.remove();
      }
    });
    let stem = cleanText(clone.innerText || clone.textContent || "");
    stem = stem.replace(/^[一二三四五六七八九十、\s]*(单选题|多选题|判断题|不定项|阅读题|填空题|简答题)\s*/, "");
    stem = stem.replace(/^\d+\s*、\s*(单选题|多选题|判断题|不定项|阅读题|填空题|简答题)?\s*[（(]?\s*\d*\s*分?\s*[)）]?\s*/, "");
    return cleanText(stem);
  }

  function inferExamLoopQuestionType(area, options) {
    const text = compactText(area.innerText || area.textContent || "");
    if (/多选题|不定项/.test(text)) return "多选题";
    if (/判断题/.test(text)) return "判断题";
    if (options.length === 2 && options.every((o) => /^(对|错|正确|错误|true|false)$/i.test(compactText(o.text)))) return "判断题";
    return "单选题";
  }

  async function extractExamLoopQuestionWithImages(navigatorEntry = null) {
    const question = extractExamLoopQuestion(navigatorEntry);
    if (!question) return null;
    question.images = await extractQuestionImages(question.blockElement, question.options);
    return question;
  }

  async function waitForExamLoopQuestion(targetNum, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const nav = getExamLoopNavigator();
      const current = nav.find((q) => q.state === "current");
      if (current && current.num === targetNum) {
        await delay(380);
        return true;
      }
      await delay(120);
    }
    return false;
  }

  async function clickExamLoopNavigator(targetNum) {
    const nav = getExamLoopNavigator();
    const target = nav.find((q) => q.num === targetNum);
    if (!target) return false;
    if (target.state === "current") {
      await delay(180);
      return true;
    }
    target.button.click();
    return waitForExamLoopQuestion(targetNum, 4000);
  }

  function isExamLoopOptionSelected(option) {
    if (!option || !option.letterElement) return false;
    const tokens = (option.letterElement.className || "").split(/\s+/);
    return tokens.includes("bg-mainBg") && tokens.includes("text-white");
  }

  async function autoAnswerExamLoop() {
    let nav = getExamLoopNavigator();
    if (!nav.length) {
      throw new Error("找不到答题卡导航，请确认页面已加载完成。");
    }

    const total = nav.length;
    const failureLog = [];
    state.autoAnswerProgress = { current: 0, total, phase: "answering" };

    for (let i = 0; i < total; i++) {
      const targetNum = i + 1;
      state.autoAnswerProgress = { current: targetNum, total, phase: "answering" };
      setStatus(`正在处理第 ${targetNum}/${total} 题...`, "warn");
      renderPanel();

      const navigated = await clickExamLoopNavigator(targetNum);
      if (!navigated) {
        failureLog.push(`第 ${targetNum} 题导航失败`);
        continue;
      }

      let question = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        question = await extractExamLoopQuestionWithImages({ num: targetNum });
        if (question && question.options.length > 0) break;
        await delay(300);
      }

      if (!question || !question.options.length) {
        failureLog.push(`第 ${targetNum} 题题目提取失败`);
        continue;
      }

      state.lastQuestions = [question];

      try {
        const answers = await requestAutoAnswers([question]);
        const skipped = await applyAnswers([question], answers);
        if (skipped.length) failureLog.push(...skipped);
      } catch (error) {
        failureLog.push(`第 ${targetNum} 题作答失败：${error.message}`);
      }

      await delay(450);
    }

    await commitLastExamLoopAnswer();

    let finalNav = getExamLoopNavigator();
    let stillUnanswered = finalNav.filter((q) => q.state === "unanswered");

    if (stillUnanswered.length > 0) {
      setStatus(`检测到 ${stillUnanswered.length} 题未作答，正在重试...`, "warn");
      renderPanel();
      for (const entry of stillUnanswered) {
        await clickExamLoopNavigator(entry.num);
        let question = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          question = await extractExamLoopQuestionWithImages({ num: entry.num });
          if (question && question.options.length > 0) break;
          await delay(300);
        }
        if (!question || !question.options.length) {
          failureLog.push(`第 ${entry.num} 题重试时仍无法提取`);
          continue;
        }
        try {
          const answers = await requestAutoAnswers([question]);
          await applyAnswers([question], answers);
        } catch (error) {
          failureLog.push(`第 ${entry.num} 题重试失败：${error.message}`);
        }
        await delay(450);
      }
      await commitLastExamLoopAnswer();
      finalNav = getExamLoopNavigator();
      stillUnanswered = finalNav.filter((q) => q.state === "unanswered");
    }

    if (stillUnanswered.length > 0) {
      const nums = stillUnanswered.map((q) => q.num).join("、");
      setStatus(`仍有 ${stillUnanswered.length} 题未作答（题号：${nums}），未自动提交，请检查后手动提交。`, "warn");
      console.warn("[智慧树学习助手] 未答题：", nums, "失败日志：", failureLog);
      return;
    }

    setStatus("所有题目已作答，正在提交...", "warn");
    renderPanel();
    await delay(500);

    const submitted = await clickExamLoopSubmit();
    if (submitted) {
      setStatus(`自动作答完成，共 ${total} 题，已提交。`, "success");
    } else {
      setStatus(`所有题目已作答（共 ${total} 题），未找到提交按钮，请手动提交。`, "warn");
    }
    if (failureLog.length) {
      console.warn("[智慧树学习助手] 作答日志：", failureLog);
    }
  }

  async function commitLastExamLoopAnswer() {
    const nav = getExamLoopNavigator();
    if (!nav.length) return;
    const current = nav.find((q) => q.state === "current");
    if (!current) return;
    const other = nav.find((q) => q.num !== current.num);
    if (!other) return;
    other.button.click();
    await waitForExamLoopQuestion(other.num, 3000);
    await delay(300);
  }

  async function clickExamLoopSubmit() {
    const btn = findButtonByText(SUBMIT_BUTTON_TEXTS);
    if (!btn) return false;
    btn.click();
    await delay(800);
    await confirmExamLoopSubmitDialog();
    return true;
  }

  async function confirmExamLoopSubmitDialog() {
    const start = Date.now();
    while (Date.now() - start < 3500) {
      const dialogs = document.querySelectorAll(
        ".el-message-box, .el-dialog, [role='dialog'], [class*='dialog'], [class*='Dialog'], [class*='modal'], [class*='Modal']"
      );
      for (const dialog of dialogs) {
        if (!isVisible(dialog)) continue;
        if (dialog.id === PANEL_ID || dialog.closest(`#${PANEL_ID}`)) continue;
        const buttons = dialog.querySelectorAll("button");
        for (const candidate of buttons) {
          if (!isVisible(candidate) || candidate.disabled) continue;
          const t = cleanText(candidate.innerText || candidate.textContent || "");
          if (/^(确定|确认|提交|是|继续|确认提交|确定提交)$/i.test(t)) {
            candidate.click();
            await delay(500);
            return true;
          }
        }
      }
      await delay(150);
    }
    return false;
  }
})();
