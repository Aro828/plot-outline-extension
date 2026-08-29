// ============================================================
// 爽文大纲助手 (Plot Outline Assistant) for SillyTavern
// ============================================================
// 功能:
//  1. 人物标签提取(主标签1-2个 + 经历/自定义标签,最多10个)
//  2. 世界书/人物卡/MVU 规则句与数值扫描(防OOC + 好感度/仇恨值追踪)
//  3. 情节工具箱(20种经典情节 + 可勾选爽点清单)
//  4. 独立API大纲生成(粗纲树 + 细纲表,均可手动编辑)
//  5. 情感值推进节奏(手动增量 / AI动态判断)
//  6. 悬浮窗开关 + 魔法棒菜单入口
//
// 架构说明: 所有交互一律使用"事件委托"绑定在 document 上,
// 不对具体渲染出来的节点单独 addEventListener。
// 原因: SillyTavern 的弹窗组件(callGenericPopup)在显示内容时会
// 复制/重建 DOM 节点,任何直接绑定在原始节点上的监听器都会失效。
// 用事件委托可以彻底绕开这个问题——不管内容被复制多少次、渲染在哪个
// 容器里,只要最终 DOM 里有匹配的 id/class,委托监听就能生效。
// ============================================================

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const MODULE_NAME = "plot_outline_assistant";
const EXT_FOLDER = "third-party/plot-outline-extension";

// ---------- 默认设置 ----------
const defaultSettings = {
    enabled: true,
    floatingWindow: false,
    apiProvider: "claude", // "claude" | "openai_compatible"
    apiKey: "",
    apiBaseUrl: "", // openai兼容接口用,claude留空即用官方地址
    apiModel: "claude-sonnet-4-6",
    maxTagsTotal: 10,
    maxMainTags: 2,
    pacingMode: "manual", // "manual" | "dynamic"
    manualAffectionStep: 5,
    characters: {}, // { charId: { mainTags: [], expTags: [], customTags: [], rules: [], values: {} } }
    outlines: {}, // { charId: { rough: [...], detailed: [...] } }
    tagLibrary: null, // 懒加载自 lib/*.json,可在运行时被用户扩充
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

// ---------- 标签库加载 ----------
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

// ---------- 工具函数 ----------
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
        settings.characters[charId] = {
            mainTags: [],
            expTags: [],
            customTags: [],
            rules: [],
            values: {},
        };
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

// ---------- 世界书 / 人物卡 / MVU 扫描 ----------
// 优先级: 结构化人设/行为规则块(XML风格标签包裹的整块) > 单句指令性关键词行
// 这样才能抓到 <character_core_correction>、<psychological_profile>、
// <interaction_logic> 这类真正定义"人物该怎么做"的完整块,而不是把带
// "严格""禁止"字样的背景故事也当成规则。
const BLOCK_TAG_HINTS = [
    "correction", "profile", "logic", "persona", "rule", "ooc", "behavior",
    "人设", "规则", "设定", "性格", "心理", "互动", "逻辑",
];
const DIRECTIVE_VERBS = ["必须", "禁止", "不能", "绝不", "不会", "应该", "不应该", "拒绝", "永远", "从不", "严禁", "务必"];
const VALUE_KEYWORDS = ["好感度", "仇恨值", "信任度", "亲密度", "忠诚度", "怒气值", "MVU", "数值"];
const VALUE_PATTERN = /([\u4e00-\u9fa5A-Za-z]{2,6}(?:好感度|仇恨值|信任度|亲密度|忠诚度|怒气值))[^\d\n]{0,10}(-?\d+)/g;

// 提取形如 <tagName ...>...</tagName> 的整块(支持嵌套一层,取最外层)
function extractStructuredBlocks(text) {
    const blocks = [];
    const blockPattern = /<([a-zA-Z_][\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = blockPattern.exec(text)) !== null) {
        const [full, tagName] = match;
        const lowerTag = tagName.toLowerCase();
        const isRelevant = BLOCK_TAG_HINTS.some(hint => lowerTag.includes(hint.toLowerCase())) ||
            DIRECTIVE_VERBS.some(v => full.includes(v));
        if (isRelevant) {
            blocks.push(full.trim());
        }
    }
    return blocks;
}

function scanTextForRulesAndValues(text) {
    if (!text) return { rules: [], values: {} };

    const rules = [];

    // 第一优先级: 结构化整块
    const blocks = extractStructuredBlocks(text);
    rules.push(...blocks);

    // 第二优先级: 不在任何已提取块内、且包含指令动词的独立行
    let remainingText = text;
    for (const b of blocks) remainingText = remainingText.split(b).join("");
    const lines = remainingText.split(/\n+/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (DIRECTIVE_VERBS.some(v => line.includes(v)) && line.length < 200) {
            rules.push(line);
        }
    }

    const values = {};
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
    if (!char) {
        toastr.warning("当前没有选中角色卡。");
        return null;
    }

    const fieldsToScan = [
        char.description,
        char.personality,
        char.scenario,
        char.mes_example,
        char.data?.creator_notes,
        char.data?.system_prompt,
        char.data?.post_history_instructions,
    ].filter(Boolean);

    let worldInfoEntries = [];
    try {
        const charBook = char.data?.character_book?.entries;
        if (Array.isArray(charBook)) {
            worldInfoEntries = charBook.map(e => e.content).filter(Boolean);
        }
    } catch (err) {
        console.warn("[爽文大纲助手] 角色内嵌世界书读取失败,跳过:", err);
    }
    try {
        if (context.world_info?.entries) {
            const globalEntries = Object.values(context.world_info.entries).map(e => e.content).filter(Boolean);
            worldInfoEntries = worldInfoEntries.concat(globalEntries);
        }
    } catch (err) {
        console.warn("[爽文大纲助手] 全局世界书读取失败,跳过:", err);
    }

    const fullText = [...fieldsToScan, ...worldInfoEntries].join("\n");
    const { rules, values } = scanTextForRulesAndValues(fullText);

    const profile = getCharProfile(charId);
    profile.rules = dedupeRules(rules);
    for (const [k, v] of Object.entries(values)) {
        profile.values[k] = { ...(profile.values[k] || {}), ...v };
    }
    saveSettingsDebounced();

    return { rules, values, worldInfoEntriesCount: worldInfoEntries.length };
}

function dedupeRules(rules) {
    const seen = new Set();
    const out = [];
    for (const r of rules) {
        const key = r.replace(/\s+/g, "");
        if (!seen.has(key)) { seen.add(key); out.push(r); }
    }
    return out;
}

// 手动粘贴世界书/人设文本进行扫描(酒馆版本差异导致自动扫描读不到完整世界书时的兜底方案,
// 也适合你想单独扫描某一条具体的世界书条目,比如截图里那种手动指定绑定的条目)
function scanManualText(charId, text) {
    const { rules, values } = scanTextForRulesAndValues(text);
    const profile = getCharProfile(charId);
    profile.rules = dedupeRules([...profile.rules, ...rules]);
    for (const [k, v] of Object.entries(values)) {
        profile.values[k] = { ...(profile.values[k] || {}), ...v };
    }
    saveSettingsDebounced();
    return { rules, values };
}

// ---------- 独立 API 调用 ----------
async function callIndependentApi(prompt, systemPrompt = "") {
    const settings = ensureSettings();
    if (!settings.apiKey) {
        toastr.error("请先在设置里填写独立API的密钥。");
        throw new Error("缺少API密钥");
    }

    if (settings.apiProvider === "claude") {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": settings.apiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true",
            },
            body: JSON.stringify({
                model: settings.apiModel || "claude-sonnet-4-6",
                max_tokens: 4000,
                system: systemPrompt || undefined,
                messages: [{ role: "user", content: prompt }],
            }),
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Claude API 错误 ${res.status}: ${errText}`);
        }
        const data = await res.json();
        return data.content?.map(b => b.text || "").join("\n") || "";
    } else {
        const base = settings.apiBaseUrl || "https://api.openai.com/v1";
        const res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify({
                model: settings.apiModel || "gpt-4o",
                messages: [
                    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
                    { role: "user", content: prompt },
                ],
                max_tokens: 4000,
            }),
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`OpenAI兼容 API 错误 ${res.status}: ${errText}`);
        }
        const data = await res.json();
        return data.choices?.[0]?.message?.content || "";
    }
}

// ---------- 人物标签推断(调用独立API) ----------
async function inferCharacterTags(charId) {
    const char = getCurrentCharCard();
    if (!char) return null;
    const lib = await loadTagLibrary();
    const settings = ensureSettings();

    const archetypeNames = lib.archetypes.main_archetypes.map(a =>
        `${a.name}(${a.light || ""}${a.shadow ? "/" + a.shadow : ""})`
    ).join("、");

    const systemPrompt = `你是资深小说人物分析师。你会拿到一份人物设定,和一份原型标签库。请:
1. 从标签库中选出1-${settings.maxMainTags}个最贴合的"主标签"(直接用库里的原型名)。
2. 基于人物的具体背景经历,推断2-6条"经历标签"(简短短语,不在库里,是你根据背景推断出来的心理/行为倾向,例如"军旅创伤""过度警惕"),经历标签+主标签总数不超过${settings.maxTagsTotal}个。
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

// ---------- 大纲生成 ----------
function buildOutlineContextBlock(charId) {
    const profile = getCharProfile(charId);
    const settings = ensureSettings();
    const tagLine = `主标签: ${profile.mainTags.join("、") || "(未提取)"}\n经历标签: ${profile.expTags.join("、") || "(无)"}\n自定义标签: ${profile.customTags.join("、") || "(无)"}`;
    const ruleLine = profile.rules.length
        ? `规则句(不可违反):\n- ${profile.rules.join("\n- ")}`
        : "规则句: (未扫描到,建议先运行世界书扫描)";
    const valueLines = Object.entries(profile.values).map(([k, v]) =>
        `${k}: 当前${v.current ?? "未知"}${v.notes ? " (" + v.notes + ")" : ""}`
    ).join("\n");
    const pacingLine = settings.pacingMode === "manual"
        ? `情感推进: 手动模式,每个关键场景默认变化量为 ${settings.manualAffectionStep}`
        : `情感推进: 动态模式,由AI根据当前场景张力自行判断增减幅度`;

    return `${tagLine}\n\n${ruleLine}\n\n数值状态:\n${valueLines || "(暂无数值记录)"}\n\n${pacingLine}`;
}

async function generateRoughOutline(charId, userBrief, selectedPlots, selectedShuangDian) {
    const contextBlock = buildOutlineContextBlock(charId);
    const systemPrompt = `你是专业网络小说策划,擅长写"可执行大纲"。粗纲只需要给出骨架:分幕(3-6幕),每幕包含目标、核心转折、结尾状态。
必须让人物的每一个关键行动都能用他的性格标签解释,不能只是为了推进情节而让人物行动。
严格遵守人物规则句,不能写出违反规则的行为。
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
    if (!act) {
        toastr.error("找不到对应的粗纲幕,请先生成粗纲。");
        return null;
    }
    const contextBlock = buildOutlineContextBlock(charId);
    const settings = ensureSettings();

    const systemPrompt = `你是专业网络小说策划。现在要把一幕粗纲展开成"细纲"——具体到每个场景/章节。
每个场景必须包含7个字段,不能省略:
- goal(目标) - obstacle(阻碍) - action(人物具体行动,必须由其性格标签驱动)
- result(结果/转折) - valueChange(数值变化,格式如"好感度+5"或"好感度: AI动态判断") - foreshadow(伏笔埋下或回收) - hook(结尾钩子)
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
    if (!store.rough.length) {
        toastr.warning("还没有大纲可以注入,先生成粗纲。");
        return;
    }

    const summary = store.rough.map(a => `【${a.title}】目标:${a.goal} 转折:${a.turn}`).join("\n");
    try {
        context.setExtensionPrompt(
            "PLOT_OUTLINE_ASSISTANT",
            `[剧情大纲参考,请据此推进剧情,不要偏离人物性格与规则]\n${summary}`,
            1,
            4,
            false,
            0
        );
    } catch (err) {
        console.warn("[爽文大纲助手] 注入上下文失败(可能是ST版本API差异):", err);
        toastr.error("注入失败,可能是酒馆版本API差异,请截图控制台报错反馈。");
    }
}

// ============================================================
// UI 渲染(纯函数,只产出HTML字符串,不做任何事件绑定)
// ============================================================

function renderTagChips(tags, removable) {
    if (!tags || !tags.length) return `<span class="poa-muted">无</span>`;
    return tags.map((t, i) => `
        <span class="poa-chip">${escapeHtml(t)}${removable ? `<span class="poa-chip-x" data-idx="${i}">×</span>` : ""}</span>
    `).join("");
}

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
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
        </tr>
    `).join("");
    return `
        <table class="poa-detail-table">
            <thead><tr><th>#</th><th>目标</th><th>阻碍</th><th>行动</th><th>结果</th><th>数值变化</th><th>伏笔</th><th>钩子</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

async function renderPopupInner() {
    const charId = getCurrentCharId();
    const profile = getCharProfile(charId);
    const store = getOutlineStore(charId);
    const settings = ensureSettings();
    const lib = await loadTagLibrary();

    const plotOptions = lib.plots.plots.concat(lib.plots.custom_plots || [])
        .map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
    const shuangOptions = lib.shuangDian.shuang_dian.concat(lib.shuangDian.custom_shuang_dian || [])
        .map(s => `<label class="poa-check"><input type="checkbox" value="${escapeHtml(s.name)}" class="poa-shuang-cb"> ${escapeHtml(s.name)}</label>`).join("");

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
        </div>
    `).join("") || `<div class="poa-muted">还没有粗纲,填写下面的构想后点击"生成粗纲"。</div>`;

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
            <p>优先识别结构化人设规则块(如 &lt;character_core_correction&gt; 这类XML标签包裹的完整设定),同时识别好感度/仇恨值等数值。</p>
            <button class="menu_button" id="poa-scan-btn">扫描角色卡</button>
            <div class="poa-field">
                <label>手动粘贴世界书条目(推荐——酒馆能否自动读到完整世界书因版本而异,直接粘贴最准)</label>
                <textarea id="poa-manual-scan-text" class="text_pole" rows="6" placeholder="把具体的世界书条目内容粘贴进来,比如 &lt;character_core_correction&gt;...&lt;/character_core_correction&gt; 这种结构的人设块"></textarea>
                <button class="menu_button" id="poa-scan-manual-btn">扫描粘贴内容</button>
            </div>
            <div class="poa-field"><label>规则句(已去重)</label><ul id="poa-rules-list">${profile.rules.map(r => `<li style="white-space:pre-wrap">${escapeHtml(r)}</li>`).join("") || "<li class='poa-muted'>暂无</li>"}</ul></div>
            <div class="poa-field"><label>数值</label><div id="poa-values-list">${Object.entries(profile.values).map(([k, v]) => `
                <div class="poa-value-row">
                    <span>${escapeHtml(k)}</span>
                    <input type="number" class="text_pole poa-value-input" data-key="${escapeHtml(k)}" value="${v.current ?? ""}" style="width:80px">
                    <span class="poa-muted">${escapeHtml(v.notes || "")}</span>
                </div>`).join("") || "<span class='poa-muted'>暂无</span>"}</div>
            </div>
        </div>

        <div class="poa-tab-panel" data-panel="plot" style="display:none">
            <div class="poa-field"><label>情节类型(可多选)</label><select id="poa-plot-select" multiple size="6">${plotOptions}</select></div>
            <div class="poa-field"><label>爽点勾选</label><div class="poa-shuang-grid">${shuangOptions}</div></div>
        </div>

        <div class="poa-tab-panel" data-panel="outline" style="display:none">
            <div class="poa-field">
                <label>剧情构想/要求(粗纲生成依据)</label>
                <textarea id="poa-outline-brief" class="text_pole" rows="3" placeholder="描述你想要的剧情方向,留空则AI自由发挥"></textarea>
            </div>
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
            <div class="poa-field poa-openai-only" style="${settings.apiProvider === "openai_compatible" ? "" : "display:none"}">
                <label>Base URL(OpenAI兼容接口用)</label><input type="text" id="poa-api-base" class="text_pole" value="${escapeHtml(settings.apiBaseUrl)}" placeholder="https://api.deepseek.com/v1">
            </div>
            <div class="poa-field"><label>模型名</label><input type="text" id="poa-api-model" class="text_pole" value="${escapeHtml(settings.apiModel)}"></div>
            <div class="poa-field"><label><input type="checkbox" id="poa-floating-toggle" ${settings.floatingWindow ? "checked" : ""}> 启用悬浮窗</label></div>
        </div>
    `;
}

// ---------- 挂载点管理 ----------
// 不管弹窗渲染在哪(ST popup / 悬浮窗 / 兜底modal),外层容器统一用 id="poa-popup"
// 需要刷新时,只要 document 里还找得到 #poa-popup,就地更新它的 innerHTML 即可,
// 事件靠全局委托,不需要重新绑定。

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
        floatingWindowEl.innerHTML = `
            <div id="poa-floating-header">爽文大纲助手 <span id="poa-floating-close">×</span></div>
            <div id="poa-popup"></div>
        `;
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
    handle.addEventListener("mousedown", (e) => {
        dragging = true;
        offsetX = e.clientX - el.offsetLeft;
        offsetY = e.clientY - el.offsetTop;
    });
    handle.addEventListener("touchstart", (e) => {
        dragging = true;
        const t = e.touches[0];
        offsetX = t.clientX - el.offsetLeft;
        offsetY = t.clientY - el.offsetTop;
    }, { passive: true });
    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        el.style.left = `${e.clientX - offsetX}px`;
        el.style.top = `${e.clientY - offsetY}px`;
    });
    document.addEventListener("touchmove", (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        el.style.left = `${t.clientX - offsetX}px`;
        el.style.top = `${t.clientY - offsetY}px`;
    }, { passive: true });
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
        const inner_div = document.createElement("div");
        inner_div.id = "poa-popup";
        inner_div.innerHTML = inner;
        wrapper.appendChild(closeBtn);
        wrapper.appendChild(inner_div);
        document.body.appendChild(wrapper);
    }
}

// ============================================================
// 全局事件委托 —— 只设置一次,不管内容被重建多少次都能生效
// ============================================================

function setupGlobalDelegation() {
    // ---- 点击事件 ----
    document.addEventListener("click", async (e) => {
        const charId = getCurrentCharId();

        // 页签切换
        const tabBtn = e.target.closest(".poa-tab-btn");
        if (tabBtn) {
            const popup = tabBtn.closest("#poa-popup");
            if (!popup) return;
            popup.querySelectorAll(".poa-tab-btn").forEach(b => b.classList.remove("active"));
            tabBtn.classList.add("active");
            const tab = tabBtn.dataset.tab;
            popup.querySelectorAll(".poa-tab-panel").forEach(p => {
                p.style.display = p.dataset.panel === tab ? "" : "none";
            });
            return;
        }

        // AI提取标签
        if (e.target.id === "poa-infer-tags") {
            toastr.info("正在用AI提取人物标签...");
            try {
                const profile = await inferCharacterTags(charId);
                if (profile) {
                    toastr.success("标签提取完成");
                    await refreshPopup();
                }
            } catch (err) {
                console.error(err);
                toastr.error("提取失败: " + err.message);
            }
            return;
        }

        // 删除自定义标签
        const chipX = e.target.closest(".poa-chip-x");
        if (chipX && chipX.closest("#poa-custom-tags")) {
            const profile = getCharProfile(charId);
            profile.customTags.splice(parseInt(chipX.dataset.idx, 10), 1);
            saveSettingsDebounced();
            await refreshPopup();
            return;
        }

        // 世界书扫描
        if (e.target.id === "poa-scan-btn") {
            toastr.info("正在扫描角色卡...");
            try {
                const result = await scanCurrentCharacter();
                if (result) {
                    toastr.success(`扫描完成,找到${result.rules.length}条规则句,${Object.keys(result.values).length}个数值`);
                    await refreshPopup();
                }
            } catch (err) {
                console.error(err);
                toastr.error("扫描失败: " + err.message);
            }
            return;
        }

        // 手动粘贴内容扫描
        if (e.target.id === "poa-scan-manual-btn") {
            const popup = e.target.closest("#poa-popup");
            const text = popup?.querySelector("#poa-manual-scan-text")?.value || "";
            if (!text.trim()) { toastr.warning("先把内容粘贴进文本框。"); return; }
            const result = scanManualText(charId, text);
            toastr.success(`扫描完成,新增${result.rules.length}条规则句,${Object.keys(result.values).length}个数值`);
            await refreshPopup();
            return;
        }

        // 生成粗纲
        if (e.target.id === "poa-gen-rough") {
            const popup = e.target.closest("#poa-popup");
            const brief = popup.querySelector("#poa-outline-brief")?.value || "";
            const selectedPlots = Array.from(popup.querySelector("#poa-plot-select")?.selectedOptions || []).map(o => o.value);
            const selectedShuang = Array.from(popup.querySelectorAll(".poa-shuang-cb:checked")).map(cb => cb.value);
            toastr.info("正在生成粗纲...");
            try {
                const result = await generateRoughOutline(charId, brief, selectedPlots, selectedShuang);
                if (result) {
                    toastr.success("粗纲生成完成");
                    await refreshPopup();
                }
            } catch (err) {
                console.error(err);
                toastr.error("生成失败: " + err.message);
            }
            return;
        }

        // 注入大纲到上下文
        if (e.target.id === "poa-inject-outline") {
            injectOutlineIntoContext(charId);
            toastr.success("已注入到对话上下文");
            return;
        }

        // 展开细纲
        const detailBtn = e.target.closest(".poa-gen-detail");
        if (detailBtn) {
            const idx = parseInt(detailBtn.dataset.idx, 10);
            toastr.info("正在展开细纲...");
            try {
                const result = await generateDetailedOutline(charId, idx);
                if (result) {
                    toastr.success("细纲生成完成");
                    await refreshPopup();
                }
            } catch (err) {
                console.error(err);
                toastr.error("生成失败: " + err.message);
            }
            return;
        }

        // 悬浮窗关闭按钮
        if (e.target.id === "poa-floating-close") {
            toggleFloatingWindow(false);
            ensureSettings().floatingWindow = false;
            saveSettingsDebounced();
            return;
        }
    });

    // ---- 回车添加自定义标签 ----
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        if (e.target.id !== "poa-custom-tag-input") return;
        e.preventDefault();
        const charId = getCurrentCharId();
        const profile = getCharProfile(charId);
        const settings = ensureSettings();
        const total = profile.mainTags.length + profile.expTags.length + profile.customTags.length;
        if (total >= settings.maxTagsTotal) {
            toastr.warning(`标签总数已达上限(${settings.maxTagsTotal})`);
            return;
        }
        const val = e.target.value.trim();
        if (val) {
            profile.customTags.push(val);
            saveSettingsDebounced();
            refreshPopup();
        }
    });

    // ---- change 事件(下拉框/输入框/勾选框) ----
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

        if (e.target.id === "poa-manual-step") {
            settings.manualAffectionStep = parseInt(e.target.value, 10) || 5;
            saveSettingsDebounced();
            return;
        }

        if (e.target.id === "poa-api-provider") {
            settings.apiProvider = e.target.value;
            saveSettingsDebounced();
            const popup = e.target.closest("#poa-popup");
            const openaiField = popup?.querySelector(".poa-openai-only");
            if (openaiField) openaiField.style.display = e.target.value === "openai_compatible" ? "" : "none";
            return;
        }

        if (e.target.id === "poa-api-key") {
            settings.apiKey = e.target.value;
            saveSettingsDebounced();
            return;
        }

        if (e.target.id === "poa-api-base") {
            settings.apiBaseUrl = e.target.value;
            saveSettingsDebounced();
            return;
        }

        if (e.target.id === "poa-api-model") {
            settings.apiModel = e.target.value;
            saveSettingsDebounced();
            return;
        }

        if (e.target.id === "poa-floating-toggle") {
            settings.floatingWindow = e.target.checked;
            saveSettingsDebounced();
            toggleFloatingWindow(e.target.checked);
            return;
        }
    });

    // ---- blur 事件(可编辑字段保存,blur不冒泡,需要capture) ----
    document.addEventListener("blur", (e) => {
        if (!e.target.classList?.contains("poa-editable")) return;
        const charId = getCurrentCharId();
        const store = getOutlineStore(charId);
        const field = e.target.dataset.field;

        if (e.target.dataset.act !== undefined && e.target.dataset.scene !== undefined) {
            const actIdx = parseInt(e.target.dataset.act, 10);
            const sceneIdx = parseInt(e.target.dataset.scene, 10);
            if (store.detailed?.[actIdx]?.[sceneIdx]) {
                store.detailed[actIdx][sceneIdx][field] = e.target.textContent;
            }
        } else if (e.target.dataset.idx !== undefined) {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (store.rough[idx]) store.rough[idx][field] = e.target.textContent;
        }
        saveSettingsDebounced();
    }, true); // capture phase,因为 blur 不冒泡
}

// ---------- 初始化 ----------
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
    if (extensionsMenu) {
        extensionsMenu.appendChild(menuButton);
    } else {
        setTimeout(() => {
            document.getElementById("extensionsMenu")?.appendChild(menuButton);
        }, 2000);
    }

    if (ensureSettings().floatingWindow) {
        toggleFloatingWindow(true);
    }

    console.log("[爽文大纲助手] 扩展已加载(事件委托版)");
});
