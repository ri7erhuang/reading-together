import { api, downloadExport } from '../api.js';
import { store, userName } from '../store.js';
import { esc, fmtTime, toast, setLoading, TYPES } from '../ui.js';
import { importFiles } from './home.js';

let tab = 'books';
let notesFilter = { bookId: '', author: '' };

export async function renderAdmin() {
  const [boot, settings] = await Promise.all([api('/api/bootstrap'), api('/api/settings')]);
  store.users = boot.users;
  store.books = boot.books;
  store.llm = settings.llm;

  const root = document.getElementById('admin');
  root.innerHTML =
    '<div class="admin-head"><h2>管理</h2>' +
    '<span class="sub" style="color:var(--ink3);font-size:12px">书库、批注、模型与备份</span></div>' +
    '<div class="tabs" id="adminTabs">' +
    ['books:书籍', 'notes:批注', 'settings:设置', 'backup:备份'].map((x) => {
      const [k, label] = x.split(':');
      return '<button data-tab="' + k + '"' + (tab === k ? ' class="on"' : '') + '>' + label + '</button>';
    }).join('') +
    '</div>' +
    '<div class="panel" id="panel-books"></div>' +
    '<div class="panel" id="panel-notes"></div>' +
    '<div class="panel" id="panel-settings"></div>' +
    '<div class="panel" id="panel-backup"></div>';

  root.querySelectorAll('#adminTabs button').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab;
      root.querySelectorAll('#adminTabs button').forEach((x) => x.classList.toggle('on', x === b));
      paintTab();
    };
  });

  paintBooks();
  paintNotes();
  paintSettings(settings);
  paintBackup(settings);
  paintTab();

  function paintTab() {
    root.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + tab));
  }
}

/* ---------------- 书籍 ---------------- */

function paintBooks() {
  const panel = document.getElementById('panel-books');
  if (!panel) return;
  let h = '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">' +
    '<button class="tbtn" id="adminImport">＋ 导入 txt / epub</button>' +
    '<span class="sub" style="margin:0">导入会把书解析成章节和段落，之后就能像内置书一样批注</span></div>';

  h += '<div class="tbl-wrap"><table><thead><tr>' +
    '<th>书名</th><th>来源</th><th>结构</th><th>批注</th><th>操作</th></tr></thead><tbody>';
  if (!store.books.length) h += '<tr><td colspan="5" class="empty">书架还是空的</td></tr>';
  store.books.forEach((b) => {
    const meta = [b.author, b.tag].filter(Boolean).join(' · ');
    h += '<tr><td><b>' + esc(b.title) + '</b><div class="mini">' + esc(meta || '—') + '</div></td>' +
      '<td>' + esc(b.sourceType === 'builtin' ? '内置' : (b.sourceType || '').toUpperCase()) +
      '<div class="mini">' + esc(b.fileName || '—') + '</div></td>' +
      '<td>' + b.chapterCount + ' 章 · ' + b.paraCount + ' 段</td>' +
      '<td>' + b.noteCount + '</td>' +
      '<td><div class="row-actions">' +
      '<a class="tbtn" href="#/book/' + esc(b.id) + '">阅读</a>' +
      '<button class="tbtn danger" data-del-book="' + esc(b.id) + '">删除</button>' +
      '</div></td></tr>';
  });
  h += '</tbody></table></div>';
  panel.innerHTML = h;

  panel.querySelector('#adminImport').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.epub,text/plain,application/epub+zip';
    input.multiple = true;
    input.onchange = async () => {
      setLoading(true, '正在解析并导入…');
      try {
        const files = [...input.files];
        for (const f of files) {
          try {
            const out = await importOne(f);
            toast('《' + (out.title || f.name) + '》导入完成，共 ' + out.paraCount + ' 段');
          } catch (e) { toast(f.name + '：' + e.message, true); }
        }
        await renderAdmin();
      } finally { setLoading(false); }
    };
    input.click();
  };

  panel.querySelectorAll('[data-del-book]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.delBook;
      const book = store.books.find((x) => x.id === id);
      if (!confirm('删除《' + (book ? book.title : id) + '》？这本书的所有批注会一起删除，无法在网页里恢复。')) return;
      try {
        await api('/api/books/' + id, { method: 'DELETE' });
        toast('已删除');
        await renderAdmin();
      } catch (e) { toast(e.message, true); }
    };
  });
}

async function importOne(file) {
  const { uploadBook } = await import('../api.js');
  return uploadBook(file);
}

/* ---------------- 批注 ---------------- */

async function paintNotes() {
  const panel = document.getElementById('panel-notes');
  if (!panel) return;
  let h = '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">' +
    '<select class="tbtn" id="fBook"><option value="">全部书</option>' +
    store.books.map((b) => '<option value="' + esc(b.id) + '"' + (notesFilter.bookId === b.id ? ' selected' : '') + '>' +
      esc(b.title) + '</option>').join('') + '</select>' +
    '<select class="tbtn" id="fAuthor"><option value="">全部作者</option>' +
    '<option value="dad"' + (notesFilter.author === 'dad' ? ' selected' : '') + '>' + esc(userName('dad')) + '</option>' +
    '<option value="son"' + (notesFilter.author === 'son' ? ' selected' : '') + '>' + esc(userName('son')) + '</option>' +
    '<option value="ai"' + (notesFilter.author === 'ai' ? ' selected' : '') + '>AI</option>' +
    '</select><span class="sub" style="margin:0">批注档案正本在数据库里，这里是最全的视图</span></div>' +
    '<div id="notesList"><div class="empty">加载中…</div></div>';
  panel.innerHTML = h;

  panel.querySelector('#fBook').onchange = (e) => { notesFilter.bookId = e.target.value; loadNotes(); };
  panel.querySelector('#fAuthor').onchange = (e) => { notesFilter.author = e.target.value; loadNotes(); };
  await loadNotes();

  async function loadNotes() {
    const qs = new URLSearchParams();
    if (notesFilter.bookId) qs.set('bookId', notesFilter.bookId);
    if (notesFilter.author) qs.set('author', notesFilter.author);
    const out = await api('/api/admin/notes?' + qs.toString());
    const list = panel.querySelector('#notesList');
    if (!out.notes.length) { list.innerHTML = '<div class="empty">没有符合条件的批注</div>'; return; }
    let t = '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>书 / 段落</th><th>作者</th><th>摘录与内容</th><th>时间</th><th>操作</th></tr></thead><tbody>';
    out.notes.forEach((n) => {
      t += '<tr><td>' + esc(n.bookTitle) + '<div class="mini">第 ' + (n.paraIdx + 1) + ' 段</div></td>' +
        '<td><span class="tag-' + n.author + '">' + esc(userName(n.author)) + '</span>' +
        '<div class="mini">' + esc(TYPES[n.type] || n.type) + (n.author === 'ai' ? ' · AI' : '') + '</div></td>' +
        '<td style="max-width:420px">' +
        (n.quote ? '<div class="mini">「' + esc(n.quote) + '」' + (n.anchorOk ? '' : ' <span style="color:var(--accent)">未定位</span>') + '</div>' : '') +
        esc(n.text.slice(0, 160)) + (n.text.length > 160 ? '…' : '') +
        (n.answer ? '<div class="mini">答：' + esc(String(n.answer).slice(0, 100)) + '…</div>' : '') +
        '</td>' +
        '<td class="mini">' + fmtTime(n.time) + '</td>' +
        '<td><div class="row-actions">' +
        '<a class="tbtn" href="#/book/' + esc(n.bookId) + '">去这本书</a>' +
        '<button class="tbtn danger" data-del-note="' + esc(n.id) + '">删除</button></div></td></tr>';
    });
    t += '</tbody></table></div>';
    list.innerHTML = t;
    list.querySelectorAll('[data-del-note]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('删除这条批注？')) return;
        try {
          await api('/api/notes/' + b.dataset.delNote, { method: 'DELETE' });
          toast('已删除');
          await loadNotes();
        } catch (e) { toast(e.message, true); }
      };
    });
  }
}

/* ---------------- 设置 ---------------- */

function paintSettings(settings) {
  const panel = document.getElementById('panel-settings');
  if (!panel) return;
  const llm = settings.llm;
  let h = '<div class="form-card"><h3>大模型</h3>' +
    '<div class="sub">' + (llm.enabled
      ? '已接通：' + esc(llm.model) + '（key 来源：' + esc(llm.keySource === 'env' ? '环境变量' : '后台设置') + '）'
      : '还没配置 key，问 AI 和查字词会走示例回答') + '</div>' +
    '<label>接口地址（OpenAI 兼容）</label><input id="llmBase" value="' + esc(llm.base) + '" placeholder="https://api.z.ai/api/paas/v4">' +
    '<label>模型名</label><input id="llmModel" value="' + esc(llm.model) + '" placeholder="glm-4-flash">' +
    '<label>API Key</label><input id="llmKey" type="password" placeholder="' + (llm.enabled ? '已配置，留空则不修改' : '粘贴 key，只存在这台机器的数据库里') + '">' +
    '<div class="row"><button class="tbtn" id="llmSave">保存</button>' +
    '<button class="tbtn" id="llmTest">测试连通</button>' +
    (llm.enabled ? '<button class="tbtn danger" id="llmClear">清除后台 key</button>' : '') +
    '</div><div class="msg" id="llmMsg"></div></div>';

  h += '<div class="form-card"><h3>称呼</h3>' +
    '<div class="sub">显示在每条批注上，存在数据库里，所有设备一致</div>' +
    '<div class="two-input"><div><label>' + esc(userName('dad')) + ' · 爸爸</label><input id="uDad" value="' + esc(userName('dad')) + '"></div>' +
    '<div><label>' + esc(userName('son')) + ' · 孩子</label><input id="uSon" value="' + esc(userName('son')) + '"></div></div>' +
    '<div class="row"><button class="tbtn" id="userSave">保存称呼</button></div><div class="msg" id="userMsg"></div></div>';

  h += '<div class="form-card"><h3>从旧版网页迁移</h3>' +
    '<div class="sub">把以前存在这个浏览器 localStorage 里的批注、回复、删除记录和昵称导入数据库。' +
    '同一台电脑、同一个浏览器打开过旧版才有数据。</div>' +
    '<div class="row"><button class="tbtn" id="migrateBtn">读取本机旧数据并导入</button></div>' +
    '<div class="msg" id="migrateMsg"></div></div>';

  panel.innerHTML = h;

  const msg = panel.querySelector('#llmMsg');
  const showMsg = (t, ok) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'ok' : 'bad'); };

  panel.querySelector('#llmSave').onclick = async () => {
    try {
      const out = await api('/api/settings', {
        method: 'PATCH',
        body: {
          llm_base: panel.querySelector('#llmBase').value.trim(),
          llm_model: panel.querySelector('#llmModel').value.trim(),
          llm_key: panel.querySelector('#llmKey').value.trim()
        }
      });
      store.llm = out.llm;
      showMsg('已保存', true);
      setTimeout(() => renderAdmin(), 400);
    } catch (e) { showMsg('保存失败：' + e.message, false); }
  };
  panel.querySelector('#llmTest').onclick = async () => {
    showMsg('测试中…', true);
    try {
      const out = await api('/api/llm/test', { method: 'POST' });
      showMsg((out.ok ? '通了（' + (out.ms || 0) + 'ms，模型：' + out.model + '）：' : '失败：') + out.message, out.ok);
    } catch (e) { showMsg('失败：' + e.message, false); }
  };
  const clearBtn = panel.querySelector('#llmClear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('清除后台保存的 key？会回退到环境变量或示例回答。')) return;
    await api('/api/settings', { method: 'PATCH', body: { clearKey: true } });
    toast('已清除');
    await renderAdmin();
  };

  const uMsg = panel.querySelector('#userMsg');
  panel.querySelector('#userSave').onclick = async () => {
    try {
      await api('/api/users/dad', { method: 'PATCH', body: { name: panel.querySelector('#uDad').value.trim() } });
      const out = await api('/api/users/son', { method: 'PATCH', body: { name: panel.querySelector('#uSon').value.trim() } });
      store.users = out.users;
      window.dispatchEvent(new CustomEvent('rtz:users'));
      uMsg.textContent = '已保存';
      uMsg.className = 'msg ok';
    } catch (e) { uMsg.textContent = e.message; uMsg.className = 'msg bad'; }
  };

  const mMsg = panel.querySelector('#migrateMsg');
  panel.querySelector('#migrateBtn').onclick = async () => {
    let local = [], replies = {}, hidden = [], names = null;
    try {
      local = JSON.parse(localStorage.getItem('rtz_local_v1') || '[]');
      replies = JSON.parse(localStorage.getItem('rtz_replies_v1') || '{}');
      hidden = JSON.parse(localStorage.getItem('rtz_hidden_v1') || '[]');
      names = JSON.parse(localStorage.getItem('rtz_names_v1') || 'null');
    } catch {}
    if (!local.length && !Object.keys(replies).length && !hidden.length) {
      mMsg.textContent = '这个浏览器里没有找到旧版数据。';
      mMsg.className = 'msg bad';
      return;
    }
    try {
      const out = await api('/api/migrate-local', {
        method: 'POST',
        body: { local, replies, hidden, names }
      });
      mMsg.textContent = '完成：新增批注 ' + out.notes + ' 条，回复 ' + out.replies + ' 条，删除记录 ' +
        out.hidden + ' 条，跳过 ' + out.skipped + ' 条' + (out.names ? '，昵称已更新' : '') + '。';
      mMsg.className = 'msg ok';
    } catch (e) { mMsg.textContent = '导入失败：' + e.message; mMsg.className = 'msg bad'; }
  };
}

/* ---------------- 备份 ---------------- */

function paintBackup(settings) {
  const panel = document.getElementById('panel-backup');
  if (!panel) return;
  let h = '<div class="form-card"><h3>归档</h3>' +
    '<div class="sub">数据正本在数据库里；每天会自动导出一次完整 JSON（书全文 + 批注 + 回复）到 ' +
    esc(settings.dataDir) + '，保留最近 30 天。想留很多年，建议把这个目录也同步到 git 远端或另一台机器。</div>' +
    '<div class="row"><button class="tbtn" id="bkNow">立即生成今日备份</button>' +
    '<button class="tbtn" id="bkExport">导出完整 JSON</button></div>' +
    '<div class="msg" id="bkMsg"></div></div>' +
    '<div class="form-card"><h3>最近的备份文件</h3>' +
    (settings.backups.length
      ? '<div class="kv"><b>' + settings.backups.map(esc).join('</b></div><div class="kv"><b>') + '</b></div>'
      : '<div class="empty">还没有备份文件</div>') +
    '</div>';
  panel.innerHTML = h;

  const msg = panel.querySelector('#bkMsg');
  panel.querySelector('#bkNow').onclick = async () => {
    try {
      const out = await api('/api/backup/now', { method: 'POST' });
      msg.textContent = '已生成：' + out.file + '（今天的备份已存在时会直接返回）';
      msg.className = 'msg ok';
    } catch (e) { msg.textContent = e.message; msg.className = 'msg bad'; }
  };
  panel.querySelector('#bkExport').onclick = async () => {
    try {
      await downloadExport();
      toast('已开始下载');
    } catch (e) { toast(e.message, true); }
  };
}
