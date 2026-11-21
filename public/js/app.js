import { api, session, setUser, downloadExport } from './api.js';
import { store, userName } from './store.js';
import { esc, openModal, closeModal, toast, setLoading } from './ui.js';
import { renderHome, bindHomeDnD } from './views/home.js';
import { renderReader } from './views/reader.js';
import { renderAdmin } from './views/admin.js';

/* ================= 显示设置 ================= */

const LS_SETTINGS = 'rtz_settings_v1';
const FONTS = {
  song: { n: '宋体', v: '"Songti SC","STSong","SimSun",serif' },
  kai: { n: '楷体', v: '"Kaiti SC","STKaiti","KaiTi",serif' },
  hei: { n: '黑体', v: '"PingFang SC","Microsoft YaHei","Heiti SC",sans-serif' },
  sys: { n: '系统默认', v: '-apple-system,"PingFang SC","Microsoft YaHei",sans-serif' }
};
const FRANGE = { body: [14, 26], note: [11, 20], reply: [10, 18] };
const FLABEL = { body: '文章正文', note: '批注', reply: '批注的回复' };
const FDEF = { body: { font: 'song', size: 18 }, note: { font: 'song', size: 14 }, reply: { font: 'song', size: 13 } };

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
    if (raw && raw.body && raw.note && raw.reply) return raw;
  } catch {}
  return JSON.parse(JSON.stringify(FDEF));
}

let SETT = loadSettings();

function applySettings() {
  const r = document.documentElement.style;
  ['body', 'note', 'reply'].forEach((k) => {
    const f = FONTS[SETT[k].font] || FONTS.song;
    r.setProperty('--font-' + k, f.v);
    r.setProperty('--fs-' + k, SETT[k].size + 'px');
  });
}

function openSettings() {
  const d = JSON.parse(JSON.stringify(SETT));
  const box = openModal(
    '<h3>显示设置</h3><div class="mh">正文、批注、回复分开调，改动即时在下方预览，点保存才生效</div>' +
    ['body', 'note', 'reply'].map((k) =>
      '<label>' + FLABEL[k] + '</label><div class="setrow">' +
      '<select data-k="' + k + '" data-p="font">' +
      Object.keys(FONTS).map((f) =>
        '<option value="' + f + '"' + (d[k].font === f ? ' selected' : '') + '>' + FONTS[f].n + '</option>').join('') +
      '</select><input type="range" data-k="' + k + '" data-p="size" min="' + FRANGE[k][0] +
      '" max="' + FRANGE[k][1] + '" step="1" value="' + d[k].size + '">' +
      '<span class="sv" data-k="' + k + '">' + d[k].size + 'px</span></div>').join('') +
    '<div class="pv" id="pvBox">' +
    '<div class="para">我似乎从头上浇了一盆冷水。<span class="hl hl-dad">“给我读熟。背不出，就不准去看会。”</span>' +
    '<span class="mk dad">1</span>但是，有什么法子呢？</div>' +
    '<div class="note dad"><div class="nh"><span class="nnum dad">1</span><span class="who">' + esc(userName('dad')) + '</span>' +
    '<span class="badge kaodian">考点雷达</span><span class="when">11月15日 21:40</span></div>' +
    '<div class="q">「给我读熟。背不出，就不准去看会。」</div>' +
    '<div class="tx">先扬后抑：前一段还笑着跳着，这里一盆冷水浇下来。</div>' +
    '<div class="replies"><div class="reply son"><b>' + esc(userName('son')) + '</b>：所以扫兴这事，花多少钱都补不回来。' +
    '<span class="rt">11月16日 20:40</span></div></div></div></div>' +
    '<div class="btns"><button class="ok" id="sOk">保存并应用</button><button class="cc" id="sCc">取消</button></div>'
  );

  const pv = box.querySelector('#pvBox');
  const preview = () => {
    ['body', 'note', 'reply'].forEach((k) => {
      pv.style.setProperty('--font-' + k, FONTS[d[k].font].v);
      pv.style.setProperty('--fs-' + k, d[k].size + 'px');
    });
  };
  preview();
  box.querySelectorAll('select[data-p=font]').forEach((sel) => {
    sel.onchange = () => { d[sel.dataset.k].font = sel.value; preview(); };
  });
  box.querySelectorAll('input[data-p=size]').forEach((rg) => {
    rg.oninput = () => {
      const k = rg.dataset.k;
      d[k].size = +rg.value;
      box.querySelector('.sv[data-k="' + k + '"]').textContent = rg.value + 'px';
      preview();
    };
  });
  box.querySelector('#sCc').onclick = closeModal;
  box.querySelector('#sOk').onclick = () => {
    SETT = d;
    localStorage.setItem(LS_SETTINGS, JSON.stringify(SETT));
    applySettings();
    closeModal();
    toast('显示设置已应用');
  };
}

/* ================= 顶栏 ================= */

function paintHeader() {
  const who = document.getElementById('whoSel');
  who.innerHTML = store.users.map((u) =>
    '<button data-u="' + u.id + '" class="' + (session.userId === u.id ? 'on-' + u.id : '') + '">' +
    esc(u.name) + '</button>').join('');
  who.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      setUser(b.dataset.u);
      paintHeader();
      toast('现在以「' + userName(session.userId) + '」的身份写批注');
    };
  });
}

/* ================= 路由 ================= */

function show(which) {
  document.getElementById('home').style.display = which === 'home' ? 'block' : 'none';
  document.getElementById('reader').style.display = which === 'reader' ? 'block' : 'none';
  document.getElementById('admin').style.display = which === 'admin' ? 'block' : 'none';
}

async function route() {
  const hash = location.hash || '';
  const m = /^#\/book\/([A-Za-z0-9_-]+)/.exec(hash);
  hideSelectionBar();
  try {
    if (m) {
      show('reader');
      setLoading(true, '正在打开…');
      await renderReader(m[1], { restoreProgress: true });
    } else if (hash === '#/admin') {
      show('admin');
      setLoading(true);
      await renderAdmin();
      window.scrollTo(0, 0);
    } else {
      show('home');
      setLoading(true);
      await renderHome();
      window.scrollTo(0, 0);
    }
  } catch (e) {
    toast(e.message || '页面打不开了', true);
    if (m || hash === '#/admin') location.hash = '';
  } finally {
    setLoading(false);
  }
}

function hideSelectionBar() {
  const bar = document.getElementById('selBar');
  if (bar) bar.style.display = 'none';
}

/* ================= 启动 ================= */

async function boot() {
  applySettings();
  try {
    const d = await api('/api/bootstrap');
    store.users = d.users;
    store.books = d.books;
    store.totals = d.totals;
    store.llm = d.llm;
  } catch (e) {
    document.getElementById('home').innerHTML =
      '<div class="home-intro">连不上后端服务：' + esc(e.message) + '<br>确认 <code>node server/index.js</code> 还在运行。</div>';
    return;
  }
  paintHeader();
  bindHomeDnD();

  document.getElementById('brand').onclick = () => { location.hash = ''; };
  document.getElementById('btnDisplay').onclick = openSettings;
  document.getElementById('btnAdmin').onclick = () => { location.hash = '#/admin'; };
  document.getElementById('btnExport').onclick = async () => {
    try { await downloadExport(); toast('已开始下载备份'); } catch (e) { toast(e.message, true); }
  };
  document.getElementById('overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  window.addEventListener('rtz:users', paintHeader);
  window.addEventListener('hashchange', route);

  await route();
}

boot();
