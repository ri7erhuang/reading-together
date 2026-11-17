# reading-together

Parent-child co-reading annotations for Lu Xun's *Dawn Blossoms Plucked at Dusk* (《朝花夕拾》).

A dependency-free single-page app: the full text sits in the centre, and every note is pinned to the exact sentence it was written on — one column of Lu Xun, one column of father and son.

## Background

The child reads the paper book (no electronic devices allowed at school); the parent reads a digital edition. Each annotates in their own way:

- the child's handwriting is photographed, OCR'd into structured notes;
- the parent's e-reader highlights are exported and merged in the same way;
- both streams land in one page, where every note keeps its author, type and timestamp.

Notes are meant to stay readable years later, so the archive layer (`danmaku_data.js`) is the source of truth and the browser layer is just a scratchpad on top of it.

## Features

- **Sentence-level margin notes** — select any sentence in the text, annotate it; the sentence is highlighted in place (father blue, son orange, both on the same sentence amber, AI violet), with a numbered marker matching the card in the side column.
- **Two-way hover sync** — hovering a highlighted sentence lights up its card, and vice versa.
- **Selection toolbar** — annotate / look up a word (pinyin + definition) / ask AI.
- **Threaded replies** — every note can be replied to, so the two readers can talk back and forth under the same sentence.
- **Auto-collapse** — a paragraph shows at most 2 notes by default; long note bodies are clipped to 120 characters. Keeps the text from being pushed apart.
- **Display settings** — font family and size are configurable independently for body text, notes and replies, with a live preview before saving.
- **Backup export** — everything (archive + local notes + replies) exports to JSON.

## Run

Open `index.html` in a browser. No build step, no server, no dependencies.

Data is persisted in `localStorage`; `texts.js` and `danmaku_data.js` are loaded as plain scripts (not fetched) so the app also works from `file://`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole app: layout, styles, state and interactions. |
| `texts.js` | Full text of the 12 pieces (preface, 10 essays, postscript), split into paragraphs. Public domain, sourced from Wikisource, converted to simplified Chinese. |
| `danmaku_data.js` | The note archive. This is the file AI/OCR imports are appended to. |
| `tmp_fetch/` | Raw wikitext and `build_texts.py`, the script that regenerates `texts.js`. |

## Data format

Every note is one object in `window.DANMAKU_ARCHIVE`. Fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique, e.g. `dm_20261116_201500_ab12`. |
| `essay` | string | Essay key — see the list below. |
| `para` | number | Index into that essay's `paras` array in `texts.js` (0-based). |
| `author` | `"dad"` \| `"son"` \| `"ai"` | `ai` entries are created in-app by the “ask AI” action. |
| `type` | `"tucao"` \| `"question"` \| `"kaodian"` \| `"brilliant"` \| `"aiask"` | Complaint / question / exam-point radar / stroke of genius / AI reading aid. |
| `quote` | string | **Must be a contiguous substring of that paragraph's text** — it is used to locate and highlight the sentence. Empty string means the note refers to the whole paragraph. |
| `text` | string | Note body. For `author: "ai"` this is the user's question. |
| `answer` | string | Only for `author: "ai"`. The model's answer; `null` renders a pending state. |
| `time` | string | `YYYY-MM-DD HH:mm`. |
| `source` | string | e.g. `纸质手写OCR`, `电子阅读器`, `网页录入`, `AI`. |
| `replies` | array | Optional. `{ id, author, text, time }`, oldest first. |

```js
{
  "id": "dm_ex_003",
  "essay": "wuchanghui",
  "para": 10,
  "author": "dad",
  "type": "kaodian",
  "quote": "“给我读熟。背不出，就不准去看会。”",
  "text": "Note how Lu Xun never complains outright — the mood collapses through contrast alone.",
  "time": "2026-11-15 21:40",
  "source": "示例批注",
  "replies": [
    { "id": "rp_ex_001", "author": "son", "text": "So the love is real, the delivery is what stings?", "time": "2026-11-16 20:40" }
  ]
}
```

Essay keys: `xiaoyin`, `goumaoshu`, `achang`, `ershisi`, `wuchanghui`, `wuchang`, `baicaoyuan`, `fudebing`, `suoji`, `tengye`, `fanainong`, `houji`.

Because `quote` must match the source text exactly, always copy it from `texts.js` rather than retyping it. Notes whose `quote` cannot be located still render in the side column, but the sentence is not highlighted.

## Two data layers

| Layer | Where | Editable in-app |
| --- | --- | --- |
| Archive | `danmaku_data.js` (committed) | No — deletions are recorded as hidden IDs |
| Local | `localStorage` under `rtz_local_v1`, `rtz_replies_v1`, `rtz_hidden_v1`, `rtz_settings_v1`, `rtz_names_v1` | Yes |

Imported notes go into the archive layer; anything created in the browser stays local until it is exported and merged.

## Connecting a real LLM

`mockAnswer()` in `index.html` is the only integration point. It currently fills `note.answer` with canned text after a short delay; replace the body with a real request (inputs: the user's question `q` and the selected sentence `quote`) and the rest — pending state, storage, rendering, resume-on-reload — keeps working unchanged.

Do not put an API key in this repository: the app is fully client-side, so any key shipped here is public. Use a server-side proxy or a hosted function instead.

## Status

Working MVP: reading, notes, replies, word lookup (32 built-in entries), mock AI, display settings, export.

Not yet: real LLM, handwritten note images attached to cards, side-by-side father/son comparison view, JSON import, per-essay progress tracking.

## Text source

Lu Xun (1881–1936). The text is in the public domain; it was retrieved from Chinese Wikisource and cleaned by `tmp_fetch/build_texts.py` (template stripping, traditional → simplified conversion).
