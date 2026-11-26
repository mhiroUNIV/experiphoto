// ExperiPhoto：実験中に撮った写真を、プロジェクトを選んで Dropbox の受け箱へ送る。
// Mac の Research Hub がその受け箱を読み、実験ノートに貼る。
//   Dropbox（App folder）の中：
//     projects.json                     … Research Hub が置く、プロジェクトと最近の実験ノートの一覧
//     受け箱/<プロジェクト>/<撮った時刻> <メモ>.jpg  … この携帯が送る写真
//     受け箱/<プロジェクト>/<写真の名前>.json      … 実験ノートを選んだときだけ添える（どのノート向けか）
import { DROPBOX_APP_KEY } from './config.js';
import { createDropbox, createMockDropbox, OfflineError, AuthError } from './dropbox.js';
import * as queue from './queue.js';

const VERSION = '0.1.0';
const INBOX = '/受け箱';
const UNSORTED = { id: '未分類', name: '未分類', color: '#8a8a85', experiments: [] };
const SHRINK_TO = 2048;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // 容量がいっぱいなら、一覧の小さな絵を減らして保存し直す
      if (k === 'ep.app.log') {
        try {
          localStorage.setItem(k, JSON.stringify(v.map((e, i) => (i < 10 ? e : { ...e, thumb: null }))));
        } catch {
          // あきらめる（写真の送信には影響しない）
        }
      }
    }
  },
};

// ---- お試し（?demo=1 で入り、?demo=0 で出る） ----
const params = new URLSearchParams(location.search);
if (params.get('demo') === '1') localStorage.setItem('ep.demo', '1');
if (params.get('demo') === '0') localStorage.removeItem('ep.demo');
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
const dbx = localStorage.getItem('ep.demo') === '1' ? createMockDropbox() : createDropbox({ appKey: DROPBOX_APP_KEY, redirectUri: REDIRECT_URI });

const S = {
  list: store.get('ep.app.projects', null), // projects.json の中身（電波が無くても使えるように覚えておく）
  listMissing: false,
  project: store.get('ep.app.project', null),
  expByProject: store.get('ep.app.exp', {}),
  memo: store.get('ep.app.memo', ''),
  memos: store.get('ep.app.memos', []),
  log: store.get('ep.app.log', []),
  shrink: store.get('ep.app.shrink', false),
  sending: false,
  authLost: null,
  lastListLoad: 0,
};

// ---- 名前 ----
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// Obsidian のリンクやファイル名で困る文字を空白にする
export const cleanMemo = (s) =>
  String(s || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 40);
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'image/gif': '.gif' };
const extOf = (f) => EXT[f.type] || (/\.[a-z0-9]{2,5}$/i.exec(f.name || '')?.[0] || '.jpg').toLowerCase().replace('.jpeg', '.jpg');
const photoName = (d, memo, ext) => `${stamp(d)}${memo ? ` ${memo}` : ''}${ext}`;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
// 撮った時刻。おかしな値（0 や未来）なら今
function takenAt(f) {
  const t = Number(f.lastModified);
  return new Date(t > 946684800000 && t < Date.now() + 86400000 ? t : Date.now());
}

// ---- プロジェクトと実験ノート ----
function projects() {
  const list = (S.list?.projects || []).filter((p) => p && p.id);
  return list.some((p) => p.id === UNSORTED.id) ? list : [...list, UNSORTED];
}
function currentProject() {
  const ps = projects();
  return ps.find((p) => p.id === S.project) || ps[0];
}
function currentExperiment() {
  const p = currentProject();
  const path = S.expByProject[p.id];
  return (p.experiments || []).find((e) => e.path === path) || null;
}

// ---- 画像 ----
async function bitmap(file) {
  return createImageBitmap(file); // 向き（EXIF）は既定で反映される
}
async function drawScaled(file, maxSide, type, quality) {
  const bmp = await bitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return { canvas: c, type, quality };
}
async function makeThumb(file) {
  const { canvas } = await drawScaled(file, 160, 'image/jpeg', 0.7);
  return canvas.toDataURL('image/jpeg', 0.7);
}
async function shrink(file) {
  const { canvas } = await drawScaled(file, SHRINK_TO, 'image/jpeg', 0.9);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('縮小できませんでした'))), 'image/jpeg', 0.9));
}

// ---- 写真を受け取って、キューに入れる ----
async function onFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const p = currentProject();
  const exp = currentExperiment();
  const memo = cleanMemo(S.memo);
  for (const f of files) {
    const at = takenAt(f);
    let blob = f;
    let ext = extOf(f);
    if (S.shrink && /^image\/(jpeg|png|webp)$/.test(f.type)) {
      try {
        blob = await shrink(f);
        ext = '.jpg';
      } catch {
        // 縮小できなければ原寸で送る
      }
    }
    const thumb = await makeThumb(f).catch(() => null);
    const id = newId();
    const job = {
      id,
      addedAt: Date.now(),
      dir: `${INBOX}/${p.id}`,
      name: photoName(at, memo, ext),
      blob,
      uploadedName: null,
      // どの実験ノート向けか。ノートを選んだときだけ、写真の横に置く
      sidecar: exp ? { v: 1, project: p.id, experiment: { title: exp.title, path: exp.path }, memo, takenAt: at.toISOString() } : null,
    };
    await queue.put(job);
    S.log.unshift({ id, name: job.name, project: p.name, color: p.color, memo, experiment: exp?.title || null, at: at.toISOString(), status: 'waiting', thumb });
  }
  rememberMemo(memo);
  saveLog();
  render();
  processQueue();
}

function rememberMemo(memo) {
  if (!memo) return;
  S.memos = [memo, ...S.memos.filter((m) => m !== memo)].slice(0, 8);
  store.set('ep.app.memos', S.memos);
}

function saveLog() {
  S.log = S.log.slice(0, 60).map((e, i) => (i < 30 ? e : { ...e, thumb: null }));
  store.set('ep.app.log', S.log);
}

function setStatus(id, status, extra = {}) {
  const e = S.log.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, { status, error: null }, extra);
  saveLog();
  renderSent();
}

// ---- 送る（1枚ずつ、古い順に） ----
let retryTimer = null;
async function processQueue() {
  if (S.sending || !dbx.connected()) return;
  S.sending = true;
  clearTimeout(retryTimer);
  renderQueueState();
  let offline = false;
  try {
    for (const job of await queue.all()) {
      setStatus(job.id, 'sending');
      try {
        if (!job.uploadedName) {
          const r = await dbx.upload(`${job.dir}/${job.name}`, job.blob);
          job.uploadedName = r.name || job.name;
          await queue.put(job); // 写真は届いた。添え書きで失敗しても、写真を二重に送らない
        }
        if (job.sidecar) {
          const meta = new Blob([JSON.stringify({ ...job.sidecar, name: job.uploadedName }, null, 2)], { type: 'application/json' });
          await dbx.upload(`${job.dir}/${job.uploadedName}.json`, meta);
        }
        await queue.remove(job.id);
        setStatus(job.id, 'done', { name: job.uploadedName });
      } catch (e) {
        if (e instanceof AuthError) {
          setStatus(job.id, 'waiting', { error: e.message });
          S.authLost = e.message;
          break;
        }
        if (e instanceof OfflineError) {
          setStatus(job.id, 'waiting', { error: e.message });
          offline = true;
          break;
        }
        setStatus(job.id, 'error', { error: e.message });
      }
    }
  } finally {
    S.sending = false;
    render();
  }
  if (offline) retryTimer = setTimeout(processQueue, 30_000);
}

async function retry(id) {
  setStatus(id, 'waiting');
  processQueue();
}

async function cancel(id) {
  if (!confirm('この写真を送るのをやめますか？（この携帯の中の送信待ちから消します。カメラのアルバムの写真は消えません）')) return;
  await queue.remove(id);
  S.log = S.log.filter((e) => e.id !== id);
  saveLog();
  render();
}

// 開き直したとき：送信中のまま閉じたものは送信待ちへ戻す。キューに無いのに未完了のものは確かめられない
async function reconcile() {
  const ids = new Set((await queue.all()).map((j) => j.id));
  for (const e of S.log) {
    if (ids.has(e.id)) {
      if (e.status === 'sending') e.status = 'waiting';
    } else if (e.status === 'waiting' || e.status === 'sending') {
      e.status = 'error';
      e.error = '送れたか確かめられません。Mac の受け箱を見てください';
    }
  }
  saveLog();
}

// ---- プロジェクトの一覧（Mac の Research Hub が置く） ----
async function loadProjects(manual = false) {
  if (!dbx.connected()) return;
  S.lastListLoad = Date.now();
  try {
    const text = await dbx.download('/projects.json');
    if (text == null) S.listMissing = true;
    else {
      S.list = JSON.parse(text);
      S.listMissing = false;
      store.set('ep.app.projects', S.list);
    }
    render();
    if (manual) toast(S.listMissing ? '一覧はまだありません' : 'プロジェクトの一覧を読み直しました');
  } catch (e) {
    if (e instanceof AuthError) {
      S.authLost = e.message;
      render();
    } else if (manual) toast(e.message, true);
  }
}

// ---- 画面 ----
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

function render() {
  const connected = dbx.connected() && !S.authLost;
  $('view-connect').hidden = connected;
  $('view-main').hidden = !connected;
  $('btn-refresh').hidden = !connected;
  $('demo-badge').hidden = !dbx.demo;
  if (!connected) return renderConnect();
  renderProjects();
  renderExperiment();
  renderMemo();
  renderTarget();
  renderSent();
  renderQueueState();
}

function renderConnect() {
  const note = $('connect-note');
  const btn = $('btn-connect');
  btn.disabled = !dbx.configured;
  if (S.authLost) note.textContent = S.authLost;
  else if (!dbx.configured) note.textContent = 'Dropbox の App key がまだ設定されていません（config.js）。お試しは、URL の最後に ?demo=1 を付けて開きます。';
  else note.textContent = '';
}

function renderProjects() {
  const box = $('projects');
  const cur = currentProject();
  box.replaceChildren(
    ...projects().map((p) =>
      el(
        'button',
        {
          class: `chip${p.id === cur.id ? ' on' : ''}`,
          style: p.id === cur.id ? { background: p.color || '#0F6E56', borderColor: p.color || '#0F6E56' } : { borderColor: p.color || '' },
          onclick: () => {
            S.project = p.id;
            store.set('ep.app.project', p.id);
            render();
          },
        },
        p.name || p.id,
      ),
    ),
  );
  const note = $('projects-note');
  note.textContent = S.listMissing
    ? 'Mac の Research Hub がまだプロジェクトの一覧を置いていません。いまは「未分類」に送れます（Mac で振り分けられます）。'
    : !S.list
      ? 'プロジェクトの一覧を読んでいます…'
      : '';
}

function renderExperiment() {
  const sel = $('experiment');
  const p = currentProject();
  const exps = p.experiments || [];
  const cur = currentExperiment();
  sel.replaceChildren(
    el('option', { value: '' }, exps.length ? '選ばない（プロジェクトの写真として送る）' : 'このプロジェクトには最近の実験ノートがありません'),
    ...exps.map((e) => el('option', { value: e.path, selected: cur?.path === e.path }, e.title)),
  );
  sel.value = cur?.path || '';
  sel.disabled = !exps.length;
}

function renderMemo() {
  const input = $('memo');
  if (document.activeElement !== input) input.value = S.memo;
  $('btn-memo-clear').hidden = !S.memo;
  $('memo-recent').replaceChildren(
    ...S.memos.map((m) =>
      el(
        'button',
        {
          class: `chip${cleanMemo(S.memo) === m ? ' on' : ''}`,
          onclick: () => {
            S.memo = cleanMemo(S.memo) === m ? '' : m;
            store.set('ep.app.memo', S.memo);
            render();
          },
        },
        m,
      ),
    ),
  );
}

function renderTarget() {
  const p = currentProject();
  const exp = currentExperiment();
  const memo = cleanMemo(S.memo);
  $('shoot-target').textContent = `→ ${p.name || p.id}${exp ? ` ／ ${exp.title}` : ''}${memo ? ` ／ 「${memo}」` : ''}`;
}

const STATUS = {
  waiting: ['⏳', '送信待ち'],
  sending: ['⇡', '送信中…'],
  done: ['✓', '送りました'],
  error: ['⚠', '送れませんでした'],
};

function renderSent() {
  const ul = $('sent');
  $('sent-empty').hidden = S.log.length > 0;
  ul.replaceChildren(
    ...S.log.slice(0, 40).map((e) => {
      const d = new Date(e.at);
      const [icon, label] = STATUS[e.status] || STATUS.waiting;
      return el(
        'li',
        { class: `sent-item ${e.status}` },
        e.thumb ? el('img', { src: e.thumb, alt: '' }) : el('div', { class: 'nothumb' }, '📷'),
        el(
          'div',
          { class: 'sent-text' },
          el('div', { class: 'sent-line' }, el('span', { class: 'dot', style: { background: e.color || '#888' } }), `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}　${e.project}${e.memo ? `　${e.memo}` : ''}`),
          e.experiment ? el('div', { class: 'muted small ellipsis' }, `📓 ${e.experiment}`) : null,
          el('div', { class: `status small ${e.status}` }, `${icon} ${label}`, e.error && e.status !== 'done' ? el('span', { class: 'muted' }, `　${e.error}`) : null),
          e.status === 'error' || (e.status === 'waiting' && e.error)
            ? el(
                'div',
                { class: 'sent-actions' },
                el('button', { class: 'small', onclick: () => retry(e.id) }, '送り直す'),
                el('button', { class: 'small', onclick: () => cancel(e.id) }, 'やめる'),
              )
            : null,
        ),
      );
    }),
  );
}

async function renderQueueState() {
  const n = (await queue.all().catch(() => [])).length;
  $('queue-state').textContent = n ? (S.sending ? `送信中（残り ${n} 枚）` : `送信待ち ${n} 枚`) : '';
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2500);
}

// ---- 操作 ----
function wire() {
  $('btn-connect').addEventListener('click', async () => {
    S.authLost = null;
    try {
      await dbx.startLogin();
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('btn-refresh').addEventListener('click', () => (loadProjects(true), processQueue()));
  $('experiment').addEventListener('change', (e) => {
    S.expByProject[currentProject().id] = e.target.value || null;
    store.set('ep.app.exp', S.expByProject);
    renderTarget();
  });
  $('memo').addEventListener('input', (e) => {
    S.memo = e.target.value;
    store.set('ep.app.memo', S.memo);
    $('btn-memo-clear').hidden = !S.memo;
    renderTarget();
  });
  // 打ち終わったら、名前に使えない文字を空白にした形を見せる（送る名前と同じ）
  $('memo').addEventListener('change', (e) => {
    S.memo = cleanMemo(e.target.value);
    store.set('ep.app.memo', S.memo);
    e.target.value = S.memo;
    render();
  });
  $('btn-memo-clear').addEventListener('click', () => {
    S.memo = '';
    store.set('ep.app.memo', '');
    render();
  });
  for (const id of ['in-camera', 'in-library']) {
    $(id).addEventListener('change', async (e) => {
      const files = e.target.files;
      try {
        await onFiles(files);
      } catch (ex) {
        toast(ex.message || '写真を受け取れませんでした', true);
      }
      e.target.value = ''; // 同じ写真をもう一度選んでも動くように
    });
  }

  const dlg = $('settings');
  $('btn-settings').addEventListener('click', async () => {
    $('opt-shrink').checked = S.shrink;
    $('version').textContent = `ExperiPhoto ${VERSION}${dbx.demo ? '（お試し：Dropbox には送りません。?demo=0 で終わる）' : ''}`;
    $('btn-disconnect').hidden = !dbx.connected();
    $('account').textContent = dbx.connected() ? 'Dropbox：確かめています…' : 'Dropbox：つながっていません';
    dlg.showModal();
    if (dbx.connected()) {
      const name = await dbx.account().catch(() => null);
      $('account').textContent = name ? `Dropbox：${name} でつながっています` : 'Dropbox：つながっています（名前は読めませんでした）';
    }
  });
  $('opt-shrink').addEventListener('change', (e) => {
    S.shrink = e.target.checked;
    store.set('ep.app.shrink', S.shrink);
  });
  $('btn-disconnect').addEventListener('click', async () => {
    const n = (await queue.all()).length;
    if (!confirm(`Dropbox との接続を外しますか？${n ? `\n送っていない写真 ${n} 枚は、この携帯に残ります（つなぎ直すと送ります）。` : ''}`)) return;
    await dbx.disconnect();
    dlg.close();
    render();
  });
  $('btn-clear-log').addEventListener('click', async () => {
    const pending = new Set((await queue.all()).map((j) => j.id));
    S.log = S.log.filter((e) => pending.has(e.id));
    saveLog();
    render();
  });

  window.addEventListener('online', () => processQueue());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    newDay();
    render();
    processQueue();
    if (Date.now() - S.lastListLoad > 60_000) loadProjects();
  });
}

// 日が変わったらメモを空にする（前の日の「WBサンプル」が今日の写真に付かないように）。プロジェクトと実験ノートは残す
function newDay() {
  const today = new Date().toDateString();
  if (store.get('ep.app.day', null) === today) return;
  store.set('ep.app.day', today);
  S.memo = '';
  store.set('ep.app.memo', '');
}

async function init() {
  newDay();
  wire();
  // Dropbox から戻ってきた（?code=…）
  if (params.has('code') || params.has('error')) {
    try {
      if (await dbx.finishLogin(params)) toast('Dropbox につなぎました');
    } catch (e) {
      toast(e.message, true);
    }
  }
  if ([...params.keys()].length) history.replaceState(null, '', location.pathname);
  await reconcile().catch(() => {});
  render();
  if (dbx.connected()) {
    loadProjects();
    processQueue();
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
