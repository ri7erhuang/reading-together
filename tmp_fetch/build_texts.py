# -*- coding: utf-8 -*-
"""把 tmp_fetch/*.txt 的维基文库 wikitext 清洗为简体分段文本，输出 texts.js"""
import re, json, io, os
from zhconv import convert

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "texts.js")

ORDER = [
    ("wuchanghui", "五猖会", "开局推荐 · 写家长扫兴，共鸣拉满"),
    ("baicaoyuan", "从百草园到三味书屋", "必考名篇 · 童年乐园"),
    ("achang", "阿长与《山海经》", "人物形象题大户 · 欲扬先抑"),
    ("wuchang", "无常", "戏文里的鬼 · 人间百态"),
    ("fudebing", "父亲的病", "批判与自省"),
    ("suoji", "琐记", "离家出走式成长"),
    ("tengye", "藤野先生", "必考 · 一位改变他的老师"),
    ("fanainong", "范爱农", "知识分子群像"),
    ("xiaoyin", "小引", "全书的说明书"),
    ("ershisi", "二十四孝图", "难啃预警 · 讽刺火力最猛"),
    ("goumaoshu", "狗·猫·鼠", "全书最难 · 压轴啃"),
    ("houji", "后记", "考证癖的狂欢 · 选读"),
]

ENTITIES = {
    "&nbsp;": " ", "&emsp;": "", "&ensp;": " ", "&mdash;": "——", "&ndash;": "—",
    "&hellip;": "……", "&ldquo;": "\u201c", "&rdquo;": "\u201d", "&lsquo;": "\u2018",
    "&rsquo;": "\u2019", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
}

def clean(raw):
    s = raw
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"\{\{header.*?\}\}", "", s, flags=re.S | re.I)
    s = re.sub(r"\{\{[Pp]d/.*?\}\}", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<ref[^>]*/>", "", s)

    def conv_tag(m):
        body = m.group(1)
        parts = dict()
        for seg in body.split(";"):
            if ":" in seg:
                k, v = seg.split(":", 1)
                parts[k.strip()] = v.strip()
        for key in ("zh-hans", "zh-cn", "zh"):
            if key in parts:
                return parts[key]
        return list(parts.values())[-1] if parts else ""
    s = re.sub(r"-\{(.*?)\}-", conv_tag, s, flags=re.S)

    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]", r"\1", s)
    s = re.sub(r"'''?", "", s)

    paras = []
    # <p ...>X</p> 整段（含右对齐落款）
    for m in re.finditer(r'<p[^>]*>(.*?)</p>', s, flags=re.S):
        paras.append((m.group(1), "text-align" in (m.group(0) or "")))
    # 段内 <br> 保留为换行
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    for k, v in ENTITIES.items():
        s = s.replace(k, v)
    s = re.sub(r"&[a-zA-Z]+;", "", s)

    out = []
    for block in re.split(r"\n\s*\n", s):
        t = block.strip("\n ").strip()
        if not t:
            continue
        out.append({"t": t})
    # 把 <p> 抽出的段落合并（它们也在 s 里出现过，会重复）——改为：先不抽取，直接统一处理
    result = []
    # 重新处理：sign 落款
    s2 = raw
    return out, s2

def strip_templates(s):
    out, i = [], 0
    while i < len(s):
        if s.startswith("{{", i):
            depth, j = 0, i
            while j < len(s):
                if s.startswith("{{", j):
                    depth += 1; j += 2
                elif s.startswith("}}", j):
                    depth -= 1; j += 2
                else:
                    j += 1
                if depth == 0:
                    break
            out.append(""); i = j
        else:
            out.append(s[i]); i += 1
    return "".join(out)

VARIANT = {"囘": "回", "厛": "听", "叄": "叁", "椶": "棕"}

def clean2(raw):
    s = raw
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    # 先把 right/lang 模板内容保留出来
    s = re.sub(r"\{\{right\|(.*?)\}\}", lambda m: "\n\nSIGNMARK\x01" + m.group(1) + "\n\n", s, flags=re.S)
    s = re.sub(r"\{\{lang\|[^|]*\|([^|}]*)\}\}", r"\1", s, flags=re.S)
    # 计数法删除全部模板（含嵌套的 header/Textquality/Pd/gap 等）
    s = strip_templates(s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<ref[^>]*/>", "", s)

    def conv_tag(m):
        body = m.group(1)
        parts = dict()
        for seg in body.split(";"):
            if ":" in seg:
                k, v = seg.split(":", 1)
                parts[k.strip()] = v.strip()
        for key in ("zh-hans", "zh-cn", "zh"):
            if key in parts:
                return parts[key]
        return list(parts.values())[-1] if parts else ""
    s = re.sub(r"-\{(.*?)\}-", conv_tag, s, flags=re.S)
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]", r"\1", s)
    s = re.sub(r"'''?", "", s)

    # 右对齐落款段先标记
    signs = set()
    def mark_sign(m):
        inner = m.group(2).strip()
        idx = "SIGNPLACEHOLDER%d" % len(signs)
        signs.add(idx)
        return "\n\n" + idx + "\x01" + inner + "\n\n"
    s = re.sub(r"(<p[^>]*text-align[^>]*>)(.*?)(</p>)", mark_sign, s, flags=re.S)
    # SIGNMARK（来自 {{right|...}}）同样处理为落款
    def mark_right(m):
        inner = m.group(1).strip()
        idx = "SIGNPLACEHOLDER%d" % len(signs)
        signs.add(idx)
        return "\n\n" + idx + "\x01" + inner + "\n\n"
    s = re.sub(r"SIGNMARK\x01(.*?)(?=\n\s*\n|$)", mark_right, s, flags=re.S)
    s = re.sub(r"<[^>]+>", "", s)
    for k, v in ENTITIES.items():
        s = s.replace(k, v)
    s = re.sub(r"&[a-zA-Z]+;", "", s)

    paras = []
    for block in re.split(r"\n\s*\n", s):
        t = block.strip("\n").strip()
        if not t:
            continue
        sign = False
        if "\x01" in t:
            head, _, body = t.partition("\x01")
            if head.strip() in signs:
                t, sign = body.strip(), True
        t = "\n".join(re.sub(r"^:\s*", "", line).strip() for line in t.split("\n"))
        t = re.sub(r"(?<=[\u4e00-\u9fff。，、；：？！“”‘’—…《》（）])\s+(?=[\u4e00-\u9fff。，、；：？！“”‘’—…《》（）])", "", t)
        t = convert(t, "zh-hans")
        # 著: 助词 zhe 转为 着，名词 zhuó 词语白名单保留
        ZHU_KEEP = ["著作", "著名", "显著", "名著", "巨著", "专著", "原著", "译著",
                    "著述", "昭著", "土著", "编著", "著称", "卓著", "著者", "著书",
                    "论著", "遗著", "新著", "执著"]
        for i, w in enumerate(ZHU_KEEP):
            t = t.replace(w, "\x02%d\x02" % i)
        t = t.replace("著", "着")
        for i, w in enumerate(ZHU_KEEP):
            t = t.replace("\x02%d\x02" % i, w)
        for k, v in VARIANT.items():
            t = t.replace(k, v)
        paras.append({"t": t, **({"sign": True} if sign else {})})
    return paras

data = {}
for key, title, _tag in ORDER:
    with io.open(os.path.join(HERE, key + ".txt"), encoding="utf-8") as f:
        raw = f.read()
    paras = clean2(raw)
    data[key] = {"title": title, "paras": paras}
    print(key, title, len(paras), "段", sum(len(p["t"]) for p in paras), "字")

js = "// 朝花夕拾 原文数据（源自维基文库公版文本，繁体转简体，段落结构化）\n"
js += "// paras: [{t: 段落文本, sign?: true=落款右对齐}]\n"
js += "window.ESSAY_TEXTS = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
with io.open(OUT, "w", encoding="utf-8") as f:
    f.write(js)
print("written:", os.path.abspath(OUT), len(js), "bytes")
