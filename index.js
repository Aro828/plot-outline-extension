// ============================================================
// 爽文大纲助手 (Plot Outline Assistant) for SillyTavern
// ============================================================
// 架构说明: 所有交互一律使用"事件委托"绑定在 document 上,
// 不对具体渲染出来的节点单独 addEventListener,避免弹窗组件
// 复制/重建 DOM 导致监听器失效的问题。
// ============================================================

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const MODULE_NAME = "plot_outline_assistant";
const EXT_FOLDER = "third-party/plot-outline-extension";

const defaultSettings = {
    enabled: true,
    floatingWindow: false,
    apiProvider: "claude",
    apiKey: "",
    apiBaseUrl: "",
    apiModel: "claude-sonnet-4-6",
    maxTagsTotal: 10,
    maxMainTags: 2,
    pacingMode: "manual",
    manualAffectionStep: 5,
    characters: {},
    outlines: {},
    tagLibrary: null,
};

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extension_settings[MODULE_NAME];
}

async function loadTagLibrary() {
    const settings = ensureSettings();
    if (settings.tagLibrary) return settings.tagLibrary;
    const base = `/scripts/extensions/${EXT_FOLDER}/lib`;
    try {
        const [archetypes, plots, shuangDian] = await Promise.all([
            fetch(`${base}/archetypes.json`).then(r => r.json()),
            fetch(`${base}/plots.json`).then(r => r.json()),
            fetch(`${base}/shuang_dian.json`).then(r => r.json()),
        ]);
        settings.tagLibrary = { archetypes, plots, shuangDian };
        saveSettingsDebounced();
        return settings.tagLibrary;
    } catch (err) {
        console.error("[爽文大纲助手] 标签库加载失败:", err);
        toastr.error("标签库加载失败,请检查扩展文件是否完整安装。");
        return { archetypes: { main_archetypes: [], custom_tags: [] }, plots: { plots: [], custom_plots: [] }, shuangDian: { shuang_dian: [], custom_shuang_dian: [] } };
    }
}

function getCurrentCharId() {
    const context = getContext();
    return context.characterId ?? "unknown";
}

function getCurrentCharCard() {
    const context = getContext();
    const id = context.characterId;
    if (id === undefined || id === null || !context.characters?.[id]) return null;
    return context.characters[id];
}

function getCharProfile(charId) {
    const settings = ensureSettings();
    if (!settings.characters[charId]) {
        settings.characters[charId] = { mainTags: [], expTags: [], customTags: [], rules: [], values: {} };
    }
    return settings.characters[charId];
}

function getOutlineStore(charId) {
    const settings = ensureSettings();
    if (!settings.outlines[charId]) {
        settings.outlines[charId] = { rough: [], detailed: [] };
    }
    return settings.outlines[charId];
}

const RULE_KEYWORDS = ["规则", "设定", "人设", "必须", "禁止", "不能", "ooc", "OOC", "性格随", "变化为", "务必", "严格"];
const VALUE_KEYWORDS = ["好感度", "仇恨值", "信任度", "亲密度", "忠诚度", "怒气值", "MVU", "数值"];
const VALUE_PATTERN = /([\u4e00-\u9fa5A-Za-z]{2,6}(?:好感度|仇恨值|信任度|亲密度|忠诚度|怒气值))[^\d\n]{0,10}(-?\d+)/g;

function scanTextForRulesAndValues(text) {
    if (!text) return { rules: [], values: {} };
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const rules = [];
    const values = {};
    for (const line of lines) {
        const lower = line.toLowerCase();
        if (RULE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) rules.push(line);
    }
    let match;
    const pattern = new RegExp(VALUE_PATTERN);
    while ((match = pattern.exec(text)) !== null) {
        const [, name, num] = match;
        values[name] = { current: parseInt(num, 10), min: null, max: null, notes: "自动扫描,建议人工核对" };
    }
    for (const kw of VALUE_KEYWORDS) {
        if (text.includes(kw) && !Object.keys(values).some(v => v.includes(kw))) {
            if (kw !== "MVU" && kw !== "数值") {
                values[kw] = { current: null, min: null, max: null, notes: "检测到关键词但未解析出具体数值,请手动填写" };
            }
        }
    }
    return { rules, values };
}

async function scanCurrentCharacter() {
    const context = getContext();
    const char = getCurrentCharCard();
    const charId = getCurrentCharId();
    if (!char) { toastr.warning("当前没有选中角色卡。"); return null; }
    const fieldsToScan = [
        char.description, char.personality, char.scenario, char.mes_example,
        char.data?.creator_notes, char.data?.system_prompt, char.data?.post_history_instructions,
    ].filter(Boolean);
    let worldInfoEntries = [];
    try {
        const charBook = char.data?.character_book?.entries;
        if (Array.isArray(charBook)) worldInfoEntries = charBook.map(e => e.content).filter(Boolean);
    } catch (err) { console.warn("[爽文大纲助手] 角色内嵌世界书读取失败:", err); }
    try {
        if (context.world_info?.entries) {
            const globalEntries = Object.values(context.world_info.entries).map(e => e.content).filter(Boolean);
            worldInfoEntries = worldInfoEntries.concat(globalEntries);
        }
    } catch (err) { console.warn("[爽文大纲助手] 全局世界书读取失败:", err); }
    const fullText = [...fieldsToScan, ...worldInfoEntries].join("\n");
    const { rules, values } = scanTextForRulesAndValues(fullText);
    const profile = getCharProfile(charId);
    profile.rules = rules;
    for (const [k, v] of Object.entries(values)) profile.values[k] = { ...(profile.values[k] || {}), ...v };
    saveSettingsDebounced();
    return { rules, values, worldInfoEntriesCount: worldInfoEntries.length };
}

async function callIndependentApi(prompt, systemPrompt = "") {
    const settings = ensureSettings();
    if (!settings.apiKey) { toastr.error("请先在设置里填写独立API的密钥。"); throw new Error("缺少API密钥"); }
    if (settings.apiProvider === "claude") {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
            body: JSON.stringify({ model: settings.apiModel || "claude-sonnet-4-6", max_tokens: 4000, system: systemPrompt || undefined, messages: [{ role: "user", content: prompt }] }),
        });
        if (!res.ok) throw new Error(`Claude API 错误 ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return data.content?.map(b => b.text || "").join("\n") || "";
    } else {
        const base = settings.apiBaseUrl || "https://api.openai.com/v1";
        const res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.apiKey}` },
            body: JSON.stringify({ model: settings.apiModel || "gpt-4o", messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: prompt }], max_tokens: 4000 }),
        });
        if (!res.ok) throw new Error(`OpenAI兼容 API 错误 ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return data.choices?.[0]?.message?.content || "";
    }
}

async function inferCharacterTags(charId) {
    const char = getCurrentCharCard();
    if (!char) return null;
    const lib = await loadTagLibrary();
    const settings = ensureSettings();
    const archetypeNames = lib.archetypes.main_archetypes.map(a => `${a.name}(${a.light || ""}${a.shadow ? "/" + a.shadow : ""})`).join("、");
    const systemPrompt = `你是资深小说人物分析师。你会拿到一份人物设定,和一份原型标签库。请:
1. 从标签库中选出1-${settings.maxMainTags}个最贴合的"主标签"(直接用库里的原型名)。
2. 基于人物的具体背景经历,推断2-6条"经历标签"(简短短语,不在库里,是你根据背景推断出来的心理/行为倾向),经历标签+主标签总数不超过${settings.maxTagsTotal}个。
3. 只输出JSON,格式:{"mainTags":["..."],"expTags":["..."]},不要输出其他任何文字。`;
    const userPrompt = `原型标签库:${archetypeNames}\n\n人物设定原文:\n${[char.description, char.personality, char.scenario].filter(Boolean).join("\n")}`;
    const raw = await callIndependentApi(userPrompt, systemPrompt);
    let parsed;
    try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (err) {
        console.error("[爽文大纲助手] 标签解析失败,原始返回:", raw);
        toastr.error("AI返回格式无法解析,请查看控制台或重试。");
        return null;
    }
    const profile = getCharProfile(charId);
    profile.mainTags = parsed.mainTags || [];
    profile.expTags = parsed.expTags || [];
    saveSettingsDebounced();
    return profile;
}

function buildOutlineContextBlock(charId) {
    const profile = getCharProfile(charId);
    const settings = ensureSettings();
    const tagLine = `主标签: ${profile.mainTags.join("、") || "(未提取)"}\n经历标签: ${profile.expTags.join("、") || "(无)"}\n自定义标签: ${profile.customTags.join("、") || "(无)"}`;
    const ruleLine = profile.rules.length ? `规则句(不可违反):\n- ${profile.rules.join("\n- ")}` : "规则句: (未扫描到,建议先运行世界书扫描)";
    const valueLines = Object.entries(profile.values).map(([k, v]) => `${k}: 当前${v.current ?? "未知"}${v.notes ? " (" + v.notes + ")" : ""}`).join("\n");
    const pacingLine = settings.pacingMode === "manual" ? `情感推进: 手动模式,每个关键场景默认变化量为 ${settings.manualAffectionStep}` : `情感推进: 动态模式,由AI根据当前场景张力自行判断增减幅度`;
    return `${tagLine}\n\n${ruleLine}\n\n数值状态:\n${valueLines || "(暂无数值记录)"}\n\n${pacingLine}`;
}

async function generateRoughOutline(charId, userBrief, selectedPlots, selectedShuangDian) {
    const contextBlock = buildOutlineContextBlock(charId);
    const systemPrompt = `你是专业网络小说策划,擅长写"可执行大纲"。粗纲只需要给出骨架:分幕(3-6幕),每幕包含目标、核心转折、结尾状态。
必须让人物的每一个关键行动都能用他的性格标签解释,不能只是为了推进情节而让人物行动。严格遵守人物规则句。
只输出JSON数组,每个元素: {"act": 幕序号, "title": "幕标题", "goal": "目标", "turn": "核心转折", "endState": "结尾状态"}。不要输出其他文字。`;
    const userPrompt = `人物档案:\n${contextBlock}\n\n情节类型: ${selectedPlots.join("、") || "(未指定,你可自行判断)"}\n爽点要求: ${selectedShuangDian.join("、") || "(未指定)"}\n\n用户的剧情构想/要求:\n${userBrief || "(无特别要求,请基于人物档案自由发挥)"}`;
    const raw = await callIndependentApi(userPrompt, systemPrompt);
    let parsed;
    try {
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (err) {
        console.error("[爽文大纲助手] 粗纲解析失败:", raw);
        toastr.error("粗纲生成返回格式异常,请重试。");
        return null;
    }
    const store = getOutlineStore(charId);
    store.rough = parsed;
    store.detailed = [];
    saveSettingsDebounced();
    return parsed;
}

async function generateDetailedOutline(charId, actIndex) {
    const store = getOutlineStore(charId);
    const act = store.rough[actIndex];
    if (!act) { toastr.error("找不到对应的粗纲幕,请先生成粗纲。"); return null; }
    const contextBlock = buildOutlineContextBlock(charId);
    const settings = ensureSettings();
    const systemPrompt = `你是专业网络小说策划。现在要把一幕粗纲展开成"细纲"——具体到每个场景/章节。
每个场景必须包含7个字段:goal(目标) obstacle(阻碍) action(人物具体行动,必须由其性格标签驱动) result(结果/转折) valueChange(数值变化) foreshadow(伏笔) hook(钩子)。
情感推进模式为: ${settings.pacingMode === "manual" ? `手动,每场景默认变化量${settings.manualAffectionStep}` : "动态,由你判断"}
只输出JSON数组,每个元素包含上述7个字段加"scene"(场景序号)。不要输出其他文字。`;
    const userPrompt = `人物档案:\n${contextBlock}\n\n当前幕: ${act.title}\n目标: ${act.goal}\n核心转折: ${act.turn}\n结尾状态: ${act.endState}\n\n请把这一幕拆成4-8个场景的细纲。`;
    const raw = await callIndependentApi(userPrompt, systemPrompt);
    let parsed;
    try {
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (err) {
        console.error("[爽文大纲助手] 细纲解析失败:", raw);
        toastr.error("细纲生成返回格式异常,请重试。");
        return null;
    }
    if (!store.detailed) store.detailed = [];
    store.detailed[actIndex] = parsed;
    saveSettingsDebounced();
    return parsed;
}

function injectOutlineIntoContext(charId) {
    const context = getContext();
    const store = getOutlineStore(charId);
    if (!store.rough.length) { toastr.warning("还没有大纲可以注入,先生成粗纲。"); return; }
    const summary = store.rough.map(a => `【${a.title}】目标:${a.goal} 转折:${a.turn}`).join("\n");
    try {
        context.setExtensionPrompt("PLOT_OUTLINE_ASSISTANT", `[剧情大纲参考,请据此推进剧情,不要偏离人物性格与规则]\n${summary}`, 1, 4, false, 0);
    } catch (err) {
        console.warn("[爽文大纲助手] 注入上下文失败:", err);
        toastr.error("注入失败,可能是酒馆版本API差异,请截图控制台报错反馈。");
    }
}

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderTagChips(tags, removable) {
    if (!tags || !tags.length) return `<span class="poa-muted">无</span>`;
    return tags.map((t, i) => `<span class="poa-chip">${escapeHtml(t)}${removable ? `<span class="poa-chip-x" data-idx="${i}">×</span>` : ""}</span>`).join("");
}

function renderDetailedTable(scenes, actIdx) {
    if (!scenes || !scenes.length) return "";
    const rows = scenes.map((s, i) => `
        <tr>
            <td>${s.scene}</td>
            <td class="poa-editable" contenteditable="true" data-field="goal" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.goal)}</td>
            <td class="poa-editable" contenteditable="true" data-field="obstacle" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.obstacle)}</td>
            <td class="poa-editable" contenteditable="true" data-field="action" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.action)}</td>
            <td class="poa-editable" contenteditable="true" data-field="result" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.result)}</td>
            <td class="poa-editable" contenteditable="true" data-field="valueChange" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.valueChange)}</td>
            <td class="poa-editable" contenteditable="true" data-field="foreshadow" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.foreshadow)}</td>
            <td class="poa-editable" contenteditable="true" data-field="hook" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.hook)}</td>
        </tr>`).join("");
    return `<table class="poa-detail-table"><thead><tr><th>#</th><th>目标</th><th>阻碍</th><th>行动</th><th>结果</th><th>数值变化</th><th>伏笔</th><th>钩子</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function renderPopupInner() {
    const charId = getCurrentCharId();
    const profile = getCharProfile(charId);
    const store = getOutlineStore(charId);
    const settings = ensureSettings();
    const lib = await loadTagLibrary();
    const plotOptions = lib.plots.plots.concat(lib.plots.custom_plots || []).map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
    const shuangOptions = lib.shuangDian.shuang_dian.concat(lib.shuangDian.custom_shuang_dian || []).map(s => `<label class="poa-check"><input type="checkbox" value="${escapeHtml(s.name)}" class="poa-shuang-cb"> ${escapeHtml(s.name)}</label>`).join("");
    const roughRows = store.rough.map((a, i) => `
        <div class="poa-rough-node" data-idx="${i}">
            <div class="poa-rough-head">
                <b>第${a.act}幕: <span class="poa-editable" contenteditable="true" data-field="title" data-idx="${i}">${escapeHtml(a.title)}</span></b>
                <button class="menu_button poa-gen-detail" data-idx="${i}">展开细纲</button>
            </div>
            <div>目标: <span class="poa-editable" contenteditable="true" data-field="goal" data-idx="${i}">${escapeHtml(a.goal)}</span></div>
            <div>转折: <span class="poa-editable" contenteditable="true" data-field="turn" data-idx="${i}">${escapeHtml(a.turn)}</span></div>
            <div>结尾状态: <span class="poa-editable" contenteditable="true" data-field="endState" data-idx="${i}">${escapeHtml(a.endState)}</span></div>
            ${renderDetailedTable(store.detailed?.[i], i)}
        </div>`).join("") || `<div class="poa-muted">还没有粗纲,填写下面的构想后点击"生成粗纲"。</div>`;
    return `
        <div class="poa-tabs">
            <button class="poa-tab-btn active" data-tab="tags">人物标签</button>
            <button class="poa-tab-btn" data-tab="scan">世界书扫描</button>
            <button class="poa-tab-btn" data-tab="plot">情节工具箱</button>
            <button class="poa-tab-btn" data-tab="outline">大纲</button>
            <button class="poa-tab-btn" data-tab="settings">API设置</button>
        </div>
        <div class="poa-tab-panel" data-panel="tags">
            <p>当前角色: <b>${escapeHtml(getCurrentCharCard()?.name || "未选中")}</b></p>
            <button class="menu_button" id="poa-infer-tags">用AI提取标签</button>
            <div class="poa-field"><label>主标签</label><div id="poa-main-tags">${renderTagChips(profile.mainTags)}</div></div>
            <div class="poa-field"><label>经历标签</label><div id="poa-exp-tags">${renderTagChips(profile.expTags)}</div></div>
            <div class="poa-field">
                <label>自定义标签(最多凑够${settings.maxTagsTotal}个总数)</label>
                <div id="poa-custom-tags">${renderTagChips(profile.customTags, true)}</div>
                <input type="text" id="poa-custom-tag-input" placeholder="输入后回车添加" class="text_pole">
            </div>
        </div>
        <div class="poa-tab-panel" data-panel="scan" style="display:none">
            <p>扫描当前角色卡 + 世界书,识别规则句(防OOC)与数值。</p>
            <button class="menu_button" id="poa-scan-btn">开始扫描</button>
            <div class="poa-field"><label>规则句</label><ul id="poa-rules-list">${profile.rules.map(r => `<li>${escapeHtml(r)}</li>`).join("") || "<li class='poa-muted'>暂无</li>"}</ul></div>
            <div class="poa-field"><label>数值</label><div id="poa-values-list">${Object.entries(profile.values).map(([k, v]) => `<div class="poa-value-row"><span>${escapeHtml(k)}</span><input type="number" class="text_pole poa-value-input" data-key="${escapeHtml(k)}" value="${v.current ?? ""}" style="width:80px"><span class="poa-muted">${escapeHtml(v.notes || "")}</span></div>`).join("") || "<span class='poa-muted'>暂无</span>"}</div>
        </div>
        <div class="poa-tab-panel" data-panel="plot" style="display:none">
            <div class="poa-field"><label>情节类型(可多选)</label><select id="poa-plot-select" multiple size="6">${plotOptions}</select></div>
            <div class="poa-field"><label>爽点勾选</label><div class="poa-shuang-grid">${shuangOptions}</div></div>
        </div>
        <div class="poa-tab-panel" data-panel="outline" style="display:none">
            <div class="poa-field"><label>剧情构想/要求</label><textarea id="poa-outline-brief" class="text_pole" rows="3" placeholder="留空则AI自由发挥"></textarea></div>
            <div class="poa-field">
                <label>情感推进节奏</label>
                <select id="poa-pacing-mode" class="text_pole">
                    <option value="manual" ${settings.pacingMode === "manual" ? "selected" : ""}>手动固定增量</option>
                    <option value="dynamic" ${settings.pacingMode === "dynamic" ? "selected" : ""}>AI动态判断</option>
                </select>
                <input type="number" id="poa-manual-step" class="text_pole" style="width:80px" value="${settings.manualAffectionStep}" ${settings.pacingMode !== "manual" ? "disabled" : ""}>
            </div>
            <button class="menu_button" id="poa-gen-rough">生成粗纲</button>
            <button class="menu_button" id="poa-inject-outline">注入到对话上下文</button>
            <div id="poa-rough-container">${roughRows}</div>
        </div>
        <div class="poa-tab-panel" data-panel="settings" style="display:none">
            <div class="poa-field"><label>API提供方</label>
                <select id="poa-api-provider" class="text_pole">
                    <option value="claude" ${settings.apiProvider === "claude" ? "selected" : ""}>Claude API</option>
                    <option value="openai_compatible" ${settings.apiProvider === "openai_compatible" ? "selected" : ""}>OpenAI兼容接口(含DeepSeek等)</option>
                </select>
            </div>
            <div class="poa-field"><label>API Key</label><input type="password" id="poa-api-key" class="text_pole" value="${escapeHtml(settings.apiKey)}"></div>
            <div class="poa-field poa-openai-only" style="${settings.apiProvider === "openai_compatible" ? "" : "display:none"}"><label>Base URL</label><input type="text" id="poa-api-base" class="text_pole" value="${escapeHtml(settings.apiBaseUrl)}" placeholder="https://api.deepseek.com/v1"></div>
            <div class="poa-field"><label>模型名</label><input type="text" id="poa-api-model" class="text_pole" value="${escapeHtml(settings.apiModel)}"></div>
            <div class="poa-field"><label><input type="checkbox" id="poa-floating-toggle" ${settings.floatingWindow ? "checked" : ""}> 启用悬浮窗</label></div>
        </div>`;
}

async function refreshPopup() {
    const container = document.getElementById("poa-popup");
    if (!container) return;
    container.innerHTML = await renderPopupInner();
}

let floatingWindowEl = null;

function toggleFloatingWindow(show) {
    if (show) {
        if (floatingWindowEl) return;
        floatingWindowEl = document.createElement("div");
        floatingWindowEl.id = "poa-floating-window";
        floatingWindowEl.innerHTML = `<div id="poa-floating-header">爽文大纲助手 <span id="poa-floating-close">×</span></div><div id="poa-popup"></div>`;
        document.body.appendChild(floatingWindowEl);
        refreshPopup();
        makeDraggable(floatingWindowEl, floatingWindowEl.querySelector("#poa-floating-header"));
    } else {
        floatingWindowEl?.remove();
        floatingWindowEl = null;
    }
}

function makeDraggable(el, handle) {
    let offsetX = 0, offsetY = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => { dragging = true; offsetX = e.clientX - el.offsetLeft; offsetY = e.clientY - el.offsetTop; });
    handle.addEventListener("touchstart", (e) => { dragging = true; const t = e.touches[0]; offsetX = t.clientX - el.offsetLeft; offsetY = t.clientY - el.offsetTop; }, { passive: true });
    document.addEventListener("mousemove", (e) => { if (!dragging) return; el.style.left = `${e.clientX - offsetX}px`; el.style.top = `${e.clientY - offsetY}px`; });
    document.addEventListener("touchmove", (e) => { if (!dragging) return; const t = e.touches[0]; el.style.left = `${t.clientX - offsetX}px`; el.style.top = `${t.clientY - offsetY}px`; }, { passive: true });
    document.addEventListener("mouseup", () => { dragging = false; });
    document.addEventListener("touchend", () => { dragging = false; });
}

async function openMainPopup() {
    const context = getContext();
    const inner = await renderPopupInner();
    if (context.callGenericPopup) {
        const wrapper = document.createElement("div");
        wrapper.id = "poa-popup";
        wrapper.innerHTML = inner;
        await context.callGenericPopup(wrapper, context.POPUP_TYPE?.DISPLAY ?? 0, "", { wide: true, large: true, okButton: "关闭" });
    } else {
        const wrapper = document.createElement("div");
        wrapper.id = "poa-fallback-modal-wrapper";
        wrapper.style.cssText = "position:fixed;top:5%;left:5%;width:90%;height:88%;overflow:auto;background:var(--SmartThemeBlurTintColor,#222);z-index:9999;padding:16px;border-radius:8px;";
        const closeBtn = document.createElement("button");
        closeBtn.textContent = "关闭";
        closeBtn.className = "menu_button";
        closeBtn.style.cssText = "position:sticky;top:0;float:right;z-index:1;";
        closeBtn.addEventListener("click", () => wrapper.remove());
        const innerDiv = document.createElement("div");
        innerDiv.id = "poa-popup";
        innerDiv.innerHTML = inner;
        wrapper.appendChild(closeBtn);
        wrapper.appendChild(innerDiv);
        document.body.appendChild(wrapper);
    }
}

function setupGlobalDelegation() {
    document.addEventListener("click", async (e) => {
        const charId = getCurrentCharId();
        const tabBtn = e.target.closest(".poa-tab-btn");
        if (tabBtn) {
            const popup = tabBtn.closest("#poa-popup");
            if (!popup) return;
            popup.querySelectorAll(".poa-tab-btn").forEach(b => b.classList.remove("active"));
            tabBtn.classList.add("active");
            const tab = tabBtn.dataset.tab;
            popup.querySelectorAll(".poa-tab-panel").forEach(p => { p.style.display = p.dataset.panel === tab ? "" : "none"; });
            return;
        }
        if (e.target.id === "poa-infer-tags") {
            toastr.info("正在用AI提取人物标签...");
            try {
                const profile = await inferCharacterTags(charId);
                if (profile) { toastr.success("标签提取完成"); await refreshPopup(); }
            } catch (err) { console.error(err); toastr.error("提取失败: " + err.message); }
            return;
        }
        const chipX = e.target.closest(".poa-chip-x");
        if (chipX && chipX.closest("#poa-custom-tags")) {
            const profile = getCharProfile(charId);
            profile.customTags.splice(parseInt(chipX.dataset.idx, 10), 1);
            saveSettingsDebounced();
            await refreshPopup();
            return;
        }
        if (e.target.id === "poa-scan-btn") {
            toastr.info("正在扫描角色卡与世界书...");
            try {
                const result = await scanCurrentCharacter();
                if (result) { toastr.success(`扫描完成,找到${result.rules.length}条规则句,${Object.keys(result.values).length}个数值`); await refreshPopup(); }
            } catch (err) { console.error(err); toastr.error("扫描失败: " + err.message); }
            return;
        }
        if (e.target.id === "poa-gen-rough") {
            const popup = e.target.closest("#poa-popup");
            const brief = popup.querySelector("#poa-outline-brief")?.value || "";
            const selectedPlots = Array.from(popup.querySelector("#poa-plot-select")?.selectedOptions || []).map(o => o.value);
            const selectedShuang = Array.from(popup.querySelectorAll(".poa-shuang-cb:checked")).map(cb => cb.value);
            toastr.info("正在生成粗纲...");
            try {
                const result = await generateRoughOutline(charId, brief, selectedPlots, selectedShuang);
                if (result) { toastr.success("粗纲生成完成"); await refreshPopup(); }
            } catch (err) { console.error(err); toastr.error("生成失败: " + err.message); }
            return;
        }
        if (e.target.id === "poa-inject-outline") { injectOutlineIntoContext(charId); toastr.success("已注入到对话上下文"); return; }
        const detailBtn = e.target.closest(".poa-gen-detail");
        if (detailBtn) {
            const idx = parseInt(detailBtn.dataset.idx, 10);
            toastr.info("正在展开细纲...");
            try {
                const result = await generateDetailedOutline(charId, idx);
                if (result) { toastr.success("细纲生成完成"); await refreshPopup(); }
            } catch (err) { console.error(err); toastr.error("生成失败: " + err.message); }
            return;
        }
        if (e.target.id === "poa-floating-close") {
            toggleFloatingWindow(false);
            ensureSettings().floatingWindow = false;
            saveSettingsDebounced();
            return;
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.target.id !== "poa-custom-tag-input") return;
        e.preventDefault();
        const charId = getCurrentCharId();
        const profile = getCharProfile(charId);
        const settings = ensureSettings();
        const total = profile.mainTags.length + profile.expTags.length + profile.customTags.length;
        if (total >= settings.maxTagsTotal) { toastr.warning(`标签总数已达上限(${settings.maxTagsTotal})`); return; }
        const val = e.target.value.trim();
        if (val) { profile.customTags.push(val); saveSettingsDebounced(); refreshPopup(); }
    });

    document.addEventListener("change", (e) => {
        const charId = getCurrentCharId();
        const settings = ensureSettings();
        if (e.target.classList.contains("poa-value-input")) {
            const profile = getCharProfile(charId);
            const key = e.target.dataset.key;
            if (!profile.values[key]) profile.values[key] = {};
            profile.values[key].current = parseInt(e.target.value, 10) || 0;
            saveSettingsDebounced();
            return;
        }
        if (e.target.id === "poa-pacing-mode") {
            settings.pacingMode = e.target.value;
            saveSettingsDebounced();
            const popup = e.target.closest("#poa-popup");
            const stepInput = popup?.querySelector("#poa-manual-step");
            if (stepInput) stepInput.disabled = e.target.value !== "manual";
            return;
        }
        if (e.target.id === "poa-manual-step") { settings.manualAffectionStep = parseInt(e.target.value, 10) || 5; saveSettingsDebounced(); return; }
        if (e.target.id === "poa-api-provider") {
            settings.apiProvider = e.target.value;
            saveSettingsDebounced();
            const popup = e.target.closest("#poa-popup");
            const openaiField = popup?.querySelector(".poa-openai-only");
            if (openaiField) openaiField.style.display = e.target.value === "openai_compatible" ? "" : "none";
            return;
        }
        if (e.target.id === "poa-api-key") { settings.apiKey = e.target.value; saveSettingsDebounced(); return; }
        if (e.target.id === "poa-api-base") { settings.apiBaseUrl = e.target.value; saveSettingsDebounced(); return; }
        if (e.target.id === "poa-api-model") { settings.apiModel = e.target.value; saveSettingsDebounced(); return; }
        if (e.target.id === "poa-floating-toggle") { settings.floatingWindow = e.target.checked; saveSettingsDebounced(); toggleFloatingWindow(e.target.checked); return; }
    });

    document.addEventListener("blur", (e) => {
        if (!e.target.classList?.contains("poa-editable")) return;
        const charId = getCurrentCharId();
        const store = getOutlineStore(charId);
        const field = e.target.dataset.field;
        if (e.target.dataset.act !== undefined && e.target.dataset.scene !== undefined) {
            const actIdx = parseInt(e.target.dataset.act, 10);
            const sceneIdx = parseInt(e.target.dataset.scene, 10);
            if (store.detailed?.[actIdx]?.[sceneIdx]) store.detailed[actIdx][sceneIdx][field] = e.target.textContent;
        } else if (e.target.dataset.idx !== undefined) {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (store.rough[idx]) store.rough[idx][field] = e.target.textContent;
        }
        saveSettingsDebounced();
    }, true);
}

jQuery(async () => {
    ensureSettings();
    await loadTagLibrary();
    setupGlobalDelegation();
    const menuButton = document.createElement("div");
    menuButton.id = "poa-menu-entry";
    menuButton.className = "list-group-item flex-container flexGap5 interactable";
    menuButton.innerHTML = `<i class="fa-solid fa-book-sparkles"></i><span>爽文大纲助手</span>`;
    menuButton.addEventListener("click", openMainPopup);
    const extensionsMenu = document.getElementById("extensionsMenu");
    if (extensionsMenu) { extensionsMenu.appendChild(menuButton); }
    else { setTimeout(() => { document.getElementById("extensionsMenu")?.appendChild(menuButton); }, 2000); }
    if (ensureSettings().floatingWindow) toggleFloatingWindow(true);
    console.log("[爽文大纲助手] 扩展已加载(事件委托版)");
});
