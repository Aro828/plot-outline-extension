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
    pacingMode: "dynamic", // "manual" | "dynamic" —— 默认让AI自己判断节奏,这样最不容易生硬
    manualAffectionStep: 5,
    actCount: 8, // 粗纲幕数,网文一般比传统小说的"起承转合"要拉长,默认给够
    characters: {}, // { charId: { mainTags: [], expTags: [], customTags: [], rules: [], values: {} } }
    outlines: {}, // { charId: { rough: [...], detailed: [...] } }
    tagLibrary: null, // 懒加载自 lib/*.json,可在运行时被用户扩充
    customShuangDian: [], // 用户自定义爽点,持久保存,跨角色可复用
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
        settings.outlines[charId] = { rough: [], detailed: [], meta: {} };
    }
    if (!settings.outlines[charId].meta) settings.outlines[charId].meta = {};
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

// 拉取当前API提供方支持的模型列表(供设置页"拉取模型"按钮使用)
async function fetchAvailableModels() {
    const settings = ensureSettings();
    if (!settings.apiKey) {
        toastr.error("请先填写API Key再拉取模型列表。");
        return [];
    }
    if (settings.apiProvider === "claude") {
        const res = await fetch("https://api.anthropic.com/v1/models", {
            headers: {
                "x-api-key": settings.apiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true",
            },
        });
        if (!res.ok) throw new Error(`拉取模型失败 ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return (data.data || []).map(m => m.id);
    } else {
        const base = settings.apiBaseUrl || "https://api.openai.com/v1";
        const res = await fetch(`${base}/models`, {
            headers: { "Authorization": `Bearer ${settings.apiKey}` },
        });
        if (!res.ok) throw new Error(`拉取模型失败 ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return (data.data || []).map(m => m.id);
    }
}

// ---------- 故事体裁 / 结局 标签定义(生成大纲时会把选中标签的具体定义喂给AI,避免AI按字面猜) ----------
const GENRE_TAGS = ["正剧", "悲剧", "喜剧", "甜剧", "狗血", "雷文", "酸涩"];
const GENRE_DEFINITIONS = {
    "雷文": "人物不忠诚、善变,只在意当下不考虑后果,可能出现NTR式背叛,会做出让user完全意想不到、直接伤害user感情的行为。",
    "酸涩": "程度比狗血浅,重点描写感情关系中处于弱势/单方付出一方的心理活动,常伴随阴差阳错的巧合。",
};
const ENDING_TAGS = ["HE", "BE", "OE", "TE"];
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

// 读取开场白(不同角色的开场白基调差异很大,决定了大纲的画风该冷峻还是甜宠)
function getOpeningToneText() {
    const char = getCurrentCharCard();
    if (!char) return "";
    return char.first_mes || (Array.isArray(char.data?.alternate_greetings) ? char.data.alternate_greetings[0] : "") || "";
}

// 读取最近的聊天记录(如果是中途开始用插件,大纲要接得上已经发生的剧情,不能当从零开始)
function getRecentChatSummaryText(maxMessages = 12) {
    try {
        const context = getContext();
        const chat = context.chat || [];
        if (!chat.length) return "";
        const recent = chat.slice(-maxMessages);
        return recent.map(m => `${m.is_user ? "{{user}}" : (m.name || "角色")}: ${(m.mes || "").slice(0, 300)}`).join("\n");
    } catch (err) {
        console.warn("[爽文大纲助手] 读取聊天记录失败:", err);
        return "";
    }
}

// 读取酒馆里配置的user人设(Persona),不用你手动贴给我,插件自己去读
async function getUserPersonaText() {
    const context = getContext();
    const name = context.name1 || "{{user}}";
    let description = "";
    try {
        // power-user.js 是酒馆内部存放Persona设置的文件,不同版本字段可能有差异,
        // 这里做多重兜底尝试,任何一步失败都不影响其他功能(用户人设读不到就留空,不报错)。
        const puModule = await import("../../../power-user.js");
        const power_user = puModule.power_user;
        const avatar = context.userAvatar || power_user?.default_avatar;
        description = power_user?.persona_description
            || power_user?.persona_descriptions?.[avatar]?.description
            || "";
    } catch (err) {
        console.warn("[爽文大纲助手] 读取user人设失败(不影响其他功能,可能是酒馆版本字段差异):", err);
    }
    return { name, description };
}

function buildOutlineContextBlock(charId, userPersona) {
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
        : `情感推进: 动态模式——由你(AI)自己判断整个故事里数值该怎么涨跌最耐人寻味、最抓人,不必匀速,可以先抑后扬、可以中途大幅回落制造危机,只要最终走向合理。`;

    const openingTone = getOpeningToneText();
    const openingLine = openingTone
        ? `开场白基调参考(大纲的整体氛围要和这个基调一致,不要跑偏):\n${openingTone.slice(0, 600)}`
        : "开场白: (未读取到)";

    const recentChat = getRecentChatSummaryText();
    const chatLine = recentChat
        ? `最近的对话记录(如果这不是全新对话,大纲要衔接这里已经发生的剧情,不能无视既成事实重新开始):\n${recentChat}`
        : "对话记录: (当前是全新对话,或还没有历史消息)";

    const userLine = userPersona?.description
        ? `user(${userPersona.name})的人设:\n${userPersona.description.slice(0, 500)}\n注意: 关系的推进逻辑要同时考虑这个人物和角色两边的性格,不能只顾角色单方面的心理,双方互动要合理。`
        : `user(${userPersona?.name || "{{user}}"})的人设: (未配置或读取不到,按普通身份处理)`;

    return `${tagLine}\n\n${ruleLine}\n\n数值状态:\n${valueLines || "(暂无数值记录)"}\n\n${pacingLine}\n\n${openingLine}\n\n${chatLine}\n\n${userLine}`;
}

async function generateRoughOutline(charId, userBrief, selectedPlots, selectedShuangDian, selectedGenres, selectedEnding) {
    const userPersona = await getUserPersonaText();
    const contextBlock = buildOutlineContextBlock(charId, userPersona);
    const settings = ensureSettings();
    const actCount = settings.actCount || 8;

    const systemPrompt = `你是资深网络小说策划,深谙"开端-发展-高潮-结局"的经典网文结构和读者心理。
粗纲只是骨架,分成${actCount}幕左右(允许±2幕的浮动,以故事需要为准),每幕只需要用简短的几句话说清楚:目标、核心转折、结尾状态——不要写细节,细节留给细纲阶段。

【构建每一幕必须遵循这个三层顺序,不能跳步或颠倒】
第一层-情节骨架:先确定这一幕用的是"经典情节20种"里的哪一种或哪几种组合(比如复仇+落魄之人),这是这一幕的事件框架,决定"发生了什么类型的事"。
第二层-叠加爽点:在情节骨架之上,把勾选的爽点(比如信息差、扮猪吃虎、当众打脸)安插进这个框架里的具体节点,决定"爽感从哪个环节释放"。
第三层-性格微调:最后用人物的核心性格标签,决定"这个人物在这个情节+爽点组合下具体会怎么做、说什么话、用什么方式"——同样的情节骨架配不同性格标签的人物,应该演出完全不同的戏。人物的每一个关键行动都必须能用他的性格标签解释,不能是为了推进情节而让人物行动。关系推进的具体方式(比如靠信任建立、还是靠互相试探/利用、还是靠博弈)必须从人物的核心性格标签反推,不能默认套用"并肩作战建立信任"这类俗套走向——如果标签写的是"极端利己""控制狂""多重面具"这种,关系大概率是靠试探、交易、博弈来推进的,不是靠温情。同时要考虑user人设的性格,关系是双向的,不能只从角色一方的心理出发。

整体节奏必须有张有弛:不能全程日常,也不能全程高强度冲突,压抑与释放要交替出现,前期埋的伏笔要在后面的幕里回收。
措辞要具体、有戏剧张力,不要写"确立XX之间的界限与默契"这类抽象空洞的模板化描述,每一幕的目标/转折都要能让人一眼看出具体发生了什么冲突。
严格遵守人物规则句,不能写出违反规则的行为。若提供了最近的对话记录,大纲要衔接已经发生的剧情,不能无视既成事实重新开始。
只输出JSON数组,每个元素: {"act": 幕序号, "title": "幕标题", "plotType": "这一幕用的情节类型(第一层)", "goal": "目标(一句话,具体)", "turn": "核心转折(一句话,具体)", "endState": "结尾状态(一句话,具体)"}。不要输出其他文字。`;

    const genreDefLines = (selectedGenres || []).filter(g => GENRE_DEFINITIONS[g]).map(g => `${g}: ${GENRE_DEFINITIONS[g]}`).join("\n");

    const userPrompt = `人物档案:\n${contextBlock}\n\n情节类型: ${selectedPlots.join("、") || "(未指定,你可自行判断)"}\n爽点要求: ${selectedShuangDian.join("、") || "(未指定)"}\n故事体裁: ${selectedGenres?.join("、") || "(未指定)"}${genreDefLines ? `\n体裁定义(严格按此理解,不要按字面猜):\n${genreDefLines}` : ""}\n结局要求: ${selectedEnding || "(未指定)"}\n\n用户的剧情构想/要求:\n${userBrief || "(无特别要求,请基于人物档案自由发挥)"}`;

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
    // 记住这次生成用的选项,细纲阶段(尤其是"一键生成完整细纲")复用,不用重新勾选
    store.meta = { selectedPlots, selectedShuangDian, selectedGenres, selectedEnding, userBrief };
    saveSettingsDebounced();
    return parsed;
}

function buildValueTrendLine(settings) {
    if (settings.pacingMode === "manual") {
        return `手动模式,每场景默认变化量${settings.manualAffectionStep}`;
    }
    return "动态模式——完全由你自己判断整部故事里数值该怎么起伏最抓人、最耐人寻味、最好读,不必匀速上涨,允许先抑后扬、允许中途大幅回落制造危机,只要最终走向和结局要求一致。";
}

async function generateDetailedOutline(charId, actIndex, priorForeshadows = []) {
    const store = getOutlineStore(charId);
    const act = store.rough[actIndex];
    if (!act) {
        toastr.error("找不到对应的粗纲幕,请先生成粗纲。");
        return null;
    }
    const userPersona = await getUserPersonaText();
    const contextBlock = buildOutlineContextBlock(charId, userPersona);
    const settings = ensureSettings();
    const meta = store.meta || {};

    const genreDefLines = (meta.selectedGenres || []).filter(g => GENRE_DEFINITIONS[g]).map(g => `${g}: ${GENRE_DEFINITIONS[g]}`).join("\n");
    const foreshadowLine = priorForeshadows.length
        ? `前面幕里已经埋下、还没回收的伏笔(如果合适,在这一幕里回收至少一个):\n- ${priorForeshadows.join("\n- ")}`
        : "";

    const systemPrompt = `你是资深网络小说策划。现在要把一幕粗纲展开成"细纲"——具体到每个场景/章节,这是整个大纲里最重要的部分,必须写详细,不能敷衍。

【构建每个场景必须遵循这个三层顺序,不能跳步或颠倒】
第一层-情节骨架:这一幕定的情节类型是"${act.plotType || meta.selectedPlots?.join("、") || "不限,你自行判断"}",场景的事件走向要落在这个骨架里(比如骨架是"复仇",场景就该围绕查真相、布局、动手这类节点展开,不能跑去写风花雪月的日常)。
第二层-叠加爽点:勾选的爽点是"${meta.selectedShuangDian?.join("、") || "未指定"}",把这些爽点安插进上面的情节节点里,决定"这一步的爽感具体从哪里释放"(比如骨架走到"布局"这一步时,用信息差或扮猪吃虎来实现)。
第三层-性格微调:最后用人物性格标签决定人物具体怎么做、说什么话。同样的情节+爽点组合,配不同性格的人物,行为方式必须不同。

每个场景必须包含8个字段,不能省略:
- goal(目标) - obstacle(阻碍) - action(人物具体行动,必须由其性格标签驱动,不是为了情节而行动,关系推进方式要符合人物性格,不要默认套用俗套走向)
- result(结果/转折) - valueChange(数值变化,格式如"好感度+5"或直接写"好感度: 具体判断理由") - foreshadow(这个场景埋下的新伏笔,或回收了哪个旧伏笔,写清楚是"埋"还是"收") - hook(结尾钩子/爽点落点)
- intimacyStage(亲密关系推进到哪一步,只标阶段不写具体内容,取值:"无"/"暧昧"/"肢体接触"/"更进一步"/"回落"之一,推进要循序渐进符合当前关系阶段,不要跳步)
情感数值节奏: ${buildValueTrendLine(settings)}
体裁要求: ${meta.selectedGenres?.join("、") || "(未指定)"}${genreDefLines ? `\n体裁定义(严格按此理解):\n${genreDefLines}` : ""}
${foreshadowLine}
这一幕内部的节奏也要有张弛(不能从头到尾都是同一种强度)。
措辞要具体,不要写抽象空洞的模板化描述。
只输出JSON数组,每个元素包含上述8个字段加"scene"(场景序号)。不要输出其他文字。`;

    const userPrompt = `人物档案:\n${contextBlock}\n\n当前幕: ${act.title}\n这一幕的情节类型: ${act.plotType || "(未指定)"}\n目标: ${act.goal}\n核心转折: ${act.turn}\n结尾状态: ${act.endState}\n\n请把这一幕拆成4-8个场景的细纲,场景之间要有起伏,不要匀速平铺直叙。`;

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

// 一键把所有幕的细纲依次生成完(不用一幕一幕点),后面的幕会知道前面埋了什么伏笔,方便回收
async function generateFullDetailedOutline(charId, onProgress) {
    const store = getOutlineStore(charId);
    if (!store.rough.length) {
        toastr.error("还没有粗纲,先生成粗纲。");
        return null;
    }
    const collectedForeshadows = [];
    for (let i = 0; i < store.rough.length; i++) {
        onProgress?.(i + 1, store.rough.length);
        const scenes = await generateDetailedOutline(charId, i, collectedForeshadows);
        if (!scenes) return null; // 某一幕失败就停下,已生成的部分保留
        for (const s of scenes) {
            if (s.foreshadow && /埋|新增|种下/.test(s.foreshadow)) {
                collectedForeshadows.push(s.foreshadow);
            }
        }
    }
    return store.detailed;
}

// 剧情偏离检测 + 最小代价重新对齐("蝴蝶效应"处理):
// 拿最近实际发生的对话,跟当前大纲比对,如果user的选择让走向偏离了,
// 只让AI修改从偏离点往后受影响的部分,已经吻合的内容原样保留,不做整体重写。
async function realignOutlineWithChat(charId) {
    const store = getOutlineStore(charId);
    if (!store.rough.length) {
        toastr.warning("还没有大纲,无法对齐,先生成粗纲。");
        return null;
    }
    const recentChat = getRecentChatSummaryText(30);
    if (!recentChat) {
        toastr.warning("还没有对话记录可供比对。");
        return null;
    }
    const currentOutlineJson = JSON.stringify({ rough: store.rough, detailed: store.detailed || [] });

    const systemPrompt = `你是网络小说编辑,负责比对"计划大纲"和"实际已经发生的剧情",判断是否出现偏离(比如user做出了大纲没预料到的选择、关系走向变了、某个安排好的事件没发生反而发生了别的事)。
如果实际剧情和大纲基本一致(哪怕有些小出入但不影响后续走向),输出: {"diverged": false}
如果确实偏离了,遵循"改动最小代价"原则:只修改从偏离点开始、往后受影响的幕和场景,已经发生且和实际剧情吻合的部分原样保留,一个字都不要改。
输出格式: {"diverged": true, "rough": [...完整的粗纲数组,结构和输入一致...], "detailed": [[...第一幕的场景数组...], [...第二幕...], ...], "changeSummary": "用2-3句话说清楚具体改了哪里、为什么改,方便user快速了解发生了什么"}
只输出JSON,不要输出其他文字。`;

    const userPrompt = `当前大纲(JSON,rough是幕,detailed是每幕对应的场景数组):\n${currentOutlineJson}\n\n最近实际发生的对话(倒序看时间线):\n${recentChat}`;

    const raw = await callIndependentApi(userPrompt, systemPrompt);
    let parsed;
    try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (err) {
        console.error("[爽文大纲助手] 对齐检测解析失败:", raw);
        toastr.error("对齐检测返回格式异常,请重试。");
        return null;
    }

    if (!parsed.diverged) {
        return { diverged: false };
    }

    if (Array.isArray(parsed.rough)) store.rough = parsed.rough;
    if (Array.isArray(parsed.detailed)) store.detailed = parsed.detailed;
    saveSettingsDebounced();
    return { diverged: true, changeSummary: parsed.changeSummary || "(未提供具体说明)" };
}

function clearOutline(charId) {
    const settings = ensureSettings();
    settings.outlines[charId] = { rough: [], detailed: [], meta: {} };
    saveSettingsDebounced();
}

function deleteRoughAct(charId, idx) {
    const store = getOutlineStore(charId);
    store.rough.splice(idx, 1);
    if (store.detailed) store.detailed.splice(idx, 1);
    saveSettingsDebounced();
}

function deleteDetailedScene(charId, actIdx, sceneIdx) {
    const store = getOutlineStore(charId);
    if (store.detailed?.[actIdx]) {
        store.detailed[actIdx].splice(sceneIdx, 1);
        saveSettingsDebounced();
    }
}

// 构造要注入对话上下文的摘要文本(供"注入"和"预览/复制"两处共用,保证所见即所注入)
function buildInjectionSummaryText(charId) {
    const store = getOutlineStore(charId);
    if (!store.rough.length) return "";
    return store.rough.map(a => `【${a.title}】目标:${a.goal} 转折:${a.turn}`).join("\n");
}

function injectOutlineIntoContext(charId) {
    const context = getContext();
    const summary = buildInjectionSummaryText(charId);
    if (!summary) {
        toastr.warning("还没有大纲可以注入,先生成粗纲。");
        return false;
    }
    try {
        context.setExtensionPrompt(
            "PLOT_OUTLINE_ASSISTANT",
            `[剧情大纲参考,请据此推进剧情,不要偏离人物性格与规则]\n${summary}`,
            1,
            4,
            false,
            0
        );
        return true;
    } catch (err) {
        console.warn("[爽文大纲助手] 注入上下文失败(可能是ST版本API差异):", err);
        toastr.error("注入失败,可能是酒馆版本API差异,请截图控制台报错反馈。");
        return false;
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

// 按钮式多选/单选标签网格。mode="multi"(默认,无限多选) 或 "single"(单选,选一个自动取消其他)
function renderToggleGrid(groupId, options, mode = "multi") {
    const buttons = options.map(opt =>
        `<span class="poa-toggle-btn" data-value="${escapeHtml(opt)}">${escapeHtml(opt)}</span>`
    ).join("");
    return `<div class="poa-toggle-grid" id="${groupId}" data-mode="${mode}">${buttons}</div>`;
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
            <td class="poa-editable" contenteditable="true" data-field="intimacyStage" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.intimacyStage || "无")}</td>
            <td class="poa-editable" contenteditable="true" data-field="foreshadow" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.foreshadow)}</td>
            <td class="poa-editable" contenteditable="true" data-field="hook" data-act="${actIdx}" data-scene="${i}">${escapeHtml(s.hook)}</td>
            <td><span class="poa-delete-scene" data-act="${actIdx}" data-scene="${i}" title="删除这一场景">🗑</span></td>
        </tr>
    `).join("");
    return `
        <table class="poa-detail-table">
            <thead><tr><th>#</th><th>目标</th><th>阻碍</th><th>行动</th><th>结果</th><th>数值变化</th><th>亲密阶段</th><th>伏笔</th><th>钩子</th><th></th></tr></thead>
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

    const plotNames = lib.plots.plots.concat(lib.plots.custom_plots || []).map(p => p.name);
    const shuangNames = lib.shuangDian.shuang_dian.concat(lib.shuangDian.custom_shuang_dian || []).map(s => s.name).concat(settings.customShuangDian || []);

    const roughRows = store.rough.map((a, i) => `
        <div class="poa-rough-node" data-idx="${i}">
            <div class="poa-rough-head">
                <b>第${a.act}幕: <span class="poa-editable" contenteditable="true" data-field="title" data-idx="${i}">${escapeHtml(a.title)}</span></b>
                <span>
                    <button class="menu_button poa-gen-detail" data-idx="${i}">展开/重生成细纲</button>
                    <button class="menu_button poa-delete-act" data-idx="${i}" title="删除这一幕">🗑</button>
                </span>
            </div>
            <div>情节类型: <span class="poa-editable" contenteditable="true" data-field="plotType" data-idx="${i}">${escapeHtml(a.plotType || "(未指定)")}</span></div>
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
            <div class="poa-field"><label>情节类型(可多选)</label>${renderToggleGrid("poa-plot-toggle", plotNames, "multi")}</div>
            <div class="poa-field"><label>故事体裁(可多选)</label>${renderToggleGrid("poa-genre-toggle", GENRE_TAGS, "multi")}</div>
            <div class="poa-field"><label>结局(单选)</label>${renderToggleGrid("poa-ending-toggle", ENDING_TAGS, "single")}</div>
            <div class="poa-field">
                <label>爽点(可多选,可无限自定义)</label>
                ${renderToggleGrid("poa-shuang-toggle", shuangNames, "multi")}
                <input type="text" id="poa-add-shuangdian-input" placeholder="＋ 输入新爽点后回车添加" class="text_pole" style="margin-top:6px">
            </div>
        </div>

        <div class="poa-tab-panel" data-panel="outline" style="display:none">
            <div class="poa-field">
                <label>剧情构想/要求(粗纲生成依据,留空则AI基于人物档案+开场白+聊天记录自由发挥)</label>
                <textarea id="poa-outline-brief" class="text_pole" rows="3" placeholder="描述你想要的剧情方向,留空则AI自由发挥"></textarea>
            </div>
            <div class="poa-field">
                <label>幕数(粗纲分几幕,网文建议6-10)</label>
                <input type="number" id="poa-act-count" class="text_pole" style="width:80px" value="${settings.actCount}" min="3" max="20">
            </div>
            <div class="poa-field">
                <label>情感推进节奏</label>
                <select id="poa-pacing-mode" class="text_pole">
                    <option value="dynamic" ${settings.pacingMode === "dynamic" ? "selected" : ""}>AI动态判断(推荐,自动找最抓人的起伏节奏)</option>
                    <option value="manual" ${settings.pacingMode === "manual" ? "selected" : ""}>手动固定增量</option>
                </select>
                <input type="number" id="poa-manual-step" class="text_pole" style="width:80px" value="${settings.manualAffectionStep}" ${settings.pacingMode !== "manual" ? "disabled" : ""}>
            </div>
            <button class="menu_button" id="poa-gen-rough">① 生成粗纲</button>
            <button class="menu_button" id="poa-gen-full-detail">② 一键生成完整细纲(所有幕)</button>
            <button class="menu_button" id="poa-realign-outline">③ 检测剧情偏离/对齐大纲</button>
            <button class="menu_button" id="poa-inject-outline">注入到对话上下文</button>
            <button class="menu_button" id="poa-preview-inject">预览/复制注入内容</button>
            <button class="menu_button" id="poa-clear-outline" style="background:#a33">清空大纲</button>
            <div id="poa-inject-preview" class="poa-muted" style="white-space:pre-wrap;margin-top:6px"></div>
            <div id="poa-gen-progress" class="poa-muted"></div>
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
            <div class="poa-field">
                <label>模型名</label>
                <input type="text" id="poa-api-model" class="text_pole" value="${escapeHtml(settings.apiModel)}">
                <button class="menu_button" id="poa-fetch-models">拉取模型列表</button>
                <div id="poa-model-list-container"></div>
            </div>
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

// 悬浮窗默认是个小圆图标(折叠态),点一下展开成完整面板,再点一下收回去。
// dragMoved 用来区分"拖动"和"点击"——拖动过就不触发展开/收起。
function toggleFloatingWindow(show) {
    if (show) {
        if (floatingWindowEl) return;
        floatingWindowEl = document.createElement("div");
        floatingWindowEl.id = "poa-floating-window";
        floatingWindowEl.className = "collapsed";
        floatingWindowEl.innerHTML = `
            <div id="poa-floating-icon">🔮</div>
            <div id="poa-floating-panel" style="display:none">
                <div id="poa-floating-header">爽文大纲助手 <span id="poa-floating-close">─</span></div>
                <div id="poa-popup"></div>
            </div>
        `;
        document.body.appendChild(floatingWindowEl);
        makeDraggable(floatingWindowEl, floatingWindowEl);
    } else {
        floatingWindowEl?.remove();
        floatingWindowEl = null;
    }
}

function expandFloatingWindow() {
    if (!floatingWindowEl) return;
    floatingWindowEl.classList.remove("collapsed");
    floatingWindowEl.classList.add("expanded");
    floatingWindowEl.querySelector("#poa-floating-icon").style.display = "none";
    floatingWindowEl.querySelector("#poa-floating-panel").style.display = "";
    refreshPopup();
}

function collapseFloatingWindow() {
    if (!floatingWindowEl) return;
    floatingWindowEl.classList.remove("expanded");
    floatingWindowEl.classList.add("collapsed");
    floatingWindowEl.querySelector("#poa-floating-icon").style.display = "";
    floatingWindowEl.querySelector("#poa-floating-panel").style.display = "none";
}

function makeDraggable(el, handle) {
    let offsetX = 0, offsetY = 0, dragging = false, startX = 0, startY = 0, moved = false;
    const DRAG_THRESHOLD = 6; // 移动超过这个像素才算"拖动",否则算"点击"

    // 只有点在图标(折叠态)或标题栏(展开态)上才允许发起拖动,
    // 避免和展开面板内部的滚动/按钮点击冲突。
    function isDragHandle(target) {
        return !!(target.closest("#poa-floating-icon") || target.closest("#poa-floating-header"));
    }

    function onDragStart(clientX, clientY, target) {
        if (!isDragHandle(target)) return;
        dragging = true;
        moved = false;
        startX = clientX;
        startY = clientY;
        offsetX = clientX - el.offsetLeft;
        offsetY = clientY - el.offsetTop;
    }
    function onDragMove(clientX, clientY) {
        if (!dragging) return;
        if (Math.abs(clientX - startX) > DRAG_THRESHOLD || Math.abs(clientY - startY) > DRAG_THRESHOLD) {
            moved = true;
        }
        el.style.left = `${clientX - offsetX}px`;
        el.style.top = `${clientY - offsetY}px`;
        el.style.right = "auto";
    }
    function onDragEnd(target) {
        if (!dragging) return;
        dragging = false;
        // 没有真的拖动 = 视为点击:折叠态点图标展开,展开态点收起按钮收回
        if (!moved) {
            if (target?.id === "poa-floating-icon" || target?.closest?.("#poa-floating-icon")) {
                expandFloatingWindow();
            } else if (target?.id === "poa-floating-close" || target?.closest?.("#poa-floating-close")) {
                collapseFloatingWindow();
            }
        }
    }

    handle.addEventListener("mousedown", (e) => onDragStart(e.clientX, e.clientY, e.target));
    handle.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        onDragStart(t.clientX, t.clientY, e.target);
    }, { passive: true });

    document.addEventListener("mousemove", (e) => onDragMove(e.clientX, e.clientY));
    document.addEventListener("touchmove", (e) => onDragMove(e.touches[0]?.clientX, e.touches[0]?.clientY), { passive: true });

    document.addEventListener("mouseup", (e) => onDragEnd(e.target));
    document.addEventListener("touchend", (e) => onDragEnd(e.changedTouches[0] ? document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY) : null));
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

        // 按钮式标签选择(情节类型/故事体裁/结局/爽点 通用)
        const toggleBtn = e.target.closest(".poa-toggle-btn");
        if (toggleBtn) {
            const grid = toggleBtn.closest(".poa-toggle-grid");
            if (grid.dataset.mode === "single") {
                grid.querySelectorAll(".poa-toggle-btn").forEach(b => b.classList.remove("selected"));
                toggleBtn.classList.add("selected");
            } else {
                toggleBtn.classList.toggle("selected");
            }
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
            const actCountInput = parseInt(popup.querySelector("#poa-act-count")?.value, 10);
            if (actCountInput) { ensureSettings().actCount = actCountInput; saveSettingsDebounced(); }
            const getSelected = (gridId) => Array.from(popup.querySelectorAll(`#${gridId} .poa-toggle-btn.selected`)).map(b => b.dataset.value);
            const selectedPlots = getSelected("poa-plot-toggle");
            const selectedShuang = getSelected("poa-shuang-toggle");
            const selectedGenres = getSelected("poa-genre-toggle");
            const selectedEndingArr = getSelected("poa-ending-toggle");
            const selectedEnding = selectedEndingArr[0] || "";
            toastr.info("正在生成粗纲...");
            try {
                const result = await generateRoughOutline(charId, brief, selectedPlots, selectedShuang, selectedGenres, selectedEnding);
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

        // 一键生成完整细纲(所有幕依次生成,后面的幕能感知前面埋的伏笔)
        if (e.target.id === "poa-gen-full-detail") {
            const popup = e.target.closest("#poa-popup");
            const progressEl = popup.querySelector("#poa-gen-progress");
            toastr.info("正在生成完整细纲,幕数多的话会花一点时间...");
            try {
                await generateFullDetailedOutline(charId, (cur, total) => {
                    if (progressEl) progressEl.textContent = `正在生成第 ${cur}/${total} 幕的细纲...`;
                });
                if (progressEl) progressEl.textContent = "";
                toastr.success("完整细纲生成完成");
                await refreshPopup();
            } catch (err) {
                console.error(err);
                toastr.error("生成失败: " + err.message);
            }
            return;
        }

        // 注入大纲到上下文
        if (e.target.id === "poa-inject-outline") {
            const ok = injectOutlineIntoContext(charId);
            if (ok) toastr.success("已注入到对话上下文(可以点旁边'预览/复制'确认具体内容)");
            return;
        }

        // 预览/复制即将注入的内容(所见即所注入,方便确认是否真的生效,以及手动粘贴到作者注释兜底)
        if (e.target.id === "poa-preview-inject") {
            const popup = e.target.closest("#poa-popup");
            const text = buildInjectionSummaryText(charId);
            const previewEl = popup.querySelector("#poa-inject-preview");
            if (!text) {
                if (previewEl) previewEl.textContent = "还没有大纲,先生成粗纲。";
                return;
            }
            if (previewEl) previewEl.textContent = text;
            navigator.clipboard?.writeText(text).then(() => {
                toastr.success("已复制到剪贴板,可以手动粘贴到作者注释/世界书里兜底");
            }).catch(() => {
                toastr.info("内容已显示在下方,手动复制即可(自动复制到剪贴板失败)");
            });
            return;
        }

        // 清空大纲
        if (e.target.id === "poa-clear-outline") {
            if (!window.confirm("确定要清空当前角色的整个大纲(粗纲+细纲)吗?这个操作无法撤销。")) return;
            clearOutline(charId);
            toastr.success("大纲已清空");
            await refreshPopup();
            return;
        }

        // 检测剧情偏离 / 最小代价对齐大纲("蝴蝶效应"处理)
        if (e.target.id === "poa-realign-outline") {
            toastr.info("正在比对实际剧情和大纲...");
            try {
                const result = await realignOutlineWithChat(charId);
                if (result?.diverged === false) {
                    toastr.success("剧情和大纲基本吻合,不需要改动");
                } else if (result?.diverged === true) {
                    toastr.success("检测到偏离,已用最小改动重新对齐");
                    window.alert(`大纲已调整:\n\n${result.changeSummary}`);
                    await refreshPopup();
                }
            } catch (err) {
                console.error(err);
                toastr.error("对齐失败: " + err.message);
            }
            return;
        }

        // 删除某一幕
        const deleteActBtn = e.target.closest(".poa-delete-act");
        if (deleteActBtn) {
            const idx = parseInt(deleteActBtn.dataset.idx, 10);
            deleteRoughAct(charId, idx);
            await refreshPopup();
            return;
        }

        // 删除细纲里的某个场景
        const deleteSceneBtn = e.target.closest(".poa-delete-scene");
        if (deleteSceneBtn) {
            const actIdx = parseInt(deleteSceneBtn.dataset.act, 10);
            const sceneIdx = parseInt(deleteSceneBtn.dataset.scene, 10);
            deleteDetailedScene(charId, actIdx, sceneIdx);
            await refreshPopup();
            return;
        }

        // 展开细纲(单独重新生成某一幕)
        const detailBtn = e.target.closest(".poa-gen-detail");
        if (detailBtn) {
            const idx = parseInt(detailBtn.dataset.idx, 10);
            toastr.info("正在生成这一幕的细纲...");
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

        // 悬浮窗收起按钮(缩回小圆图标,不是彻底关闭——彻底关闭走设置页的悬浮窗开关)
        if (e.target.id === "poa-floating-close") {
            collapseFloatingWindow();
            return;
        }

        // 拉取模型列表
        if (e.target.id === "poa-fetch-models") {
            toastr.info("正在拉取模型列表...");
            try {
                const models = await fetchAvailableModels();
                const popup = e.target.closest("#poa-popup");
                const container = popup.querySelector("#poa-model-list-container");
                if (!models.length) {
                    container.innerHTML = `<span class="poa-muted">没拉到模型,检查Key是否正确</span>`;
                    return;
                }
                container.innerHTML = `<select id="poa-model-select" class="text_pole" style="margin-top:6px">${models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}</select>`;
                toastr.success(`拉取到${models.length}个模型,选一个`);
            } catch (err) {
                console.error(err);
                toastr.error("拉取失败: " + err.message);
            }
            return;
        }
    });

    // ---- 回车添加自定义标签 ----
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;

        if (e.target.id === "poa-custom-tag-input") {
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
            return;
        }

        // 自定义爽点(无上限,持久保存,添加后自动勾选)
        if (e.target.id === "poa-add-shuangdian-input") {
            e.preventDefault();
            const val = e.target.value.trim();
            if (!val) return;
            const settings = ensureSettings();
            if (!settings.customShuangDian.includes(val)) {
                settings.customShuangDian.push(val);
                saveSettingsDebounced();
            }
            refreshPopup().then(() => {
                const btn = document.querySelector(`#poa-shuang-toggle .poa-toggle-btn[data-value="${CSS.escape(val)}"]`);
                btn?.classList.add("selected");
            });
            return;
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

        if (e.target.id === "poa-act-count") {
            settings.actCount = parseInt(e.target.value, 10) || 8;
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

        // 从拉取到的模型列表里选中一个,写回模型名输入框
        if (e.target.id === "poa-model-select") {
            settings.apiModel = e.target.value;
            saveSettingsDebounced();
            const popup = e.target.closest("#poa-popup");
            const modelInput = popup?.querySelector("#poa-api-model");
            if (modelInput) modelInput.value = e.target.value;
            toastr.success("已选择模型: " + e.target.value);
            return;
        }

        if (e.target.id === "poa-floating-toggle") {
            settings.floatingWindow = e.target.checked;
            saveSettingsDebounced();
            toggleFloatingWindow(e.target.checked);
            return;
        }
    });

    // ---- input 事件(输入即保存,防止change/blur没触发导致"填了但没存住") ----
    document.addEventListener("input", (e) => {
        const settings = ensureSettings();
        if (e.target.id === "poa-api-key") { settings.apiKey = e.target.value; saveSettingsDebounced(); }
        else if (e.target.id === "poa-api-base") { settings.apiBaseUrl = e.target.value; saveSettingsDebounced(); }
        else if (e.target.id === "poa-api-model") { settings.apiModel = e.target.value; saveSettingsDebounced(); }
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

    // 新对话检测:切换/新建对话时,如果当前角色已经有大纲内容,弹窗问是否保留。
    // 用动态import,万一这个酒馆版本导出方式不一样,失败了也只是这一个小功能不生效,
    // 不会拖累整个扩展加载失败。
    try {
        const scriptModule = await import("../../../../script.js");
        const { eventSource, event_types } = scriptModule;
        if (eventSource && event_types?.CHAT_CHANGED) {
            let lastChatKey = null;
            eventSource.on(event_types.CHAT_CHANGED, () => {
                const charId = getCurrentCharId();
                const chatId = getContext().chatId;
                const key = `${charId}::${chatId}`;
                if (key === lastChatKey) return;
                lastChatKey = key;
                const store = getOutlineStore(charId);
                if (store.rough?.length) {
                    setTimeout(() => {
                        const keep = window.confirm(
                            `检测到「${getCurrentCharCard()?.name || "当前角色"}」已有大纲内容。\n\n点"确定"保留现有大纲,点"取消"清空后重新开始。`
                        );
                        if (!keep) {
                            clearOutline(charId);
                            toastr.info("已清空该角色的大纲");
                        }
                    }, 300);
                }
            });
        }
    } catch (err) {
        console.warn("[爽文大纲助手] 新对话检测功能加载失败(不影响其他功能):", err);
    }

    console.log("[爽文大纲助手] 扩展已加载(事件委托版)");
});
