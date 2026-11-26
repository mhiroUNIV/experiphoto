// Dropbox とのやり取り。ログインは PKCE（App secret を使わない、ブラウザ用の手順）。
// App folder 型のアプリなので、パスの「/」は Dropbox の アプリ/<アプリ名>/ を指す。
const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

const K = { refresh: 'ep.refresh', access: 'ep.access', expires: 'ep.expires', verifier: 'ep.verifier', state: 'ep.state' };

// 通信そのものが失敗した（電波が無いなど）。キューに残して後で送り直す
export class OfflineError extends Error {}
// つなぎ直しが要る（許可を取り消された、トークンが切れて更新できない）
export class AuthError extends Error {}

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(len) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return b64url(a).slice(0, len);
}

// Dropbox-API-Arg ヘッダーの JSON は ASCII でなければならない。日本語などは \uXXXX にする
export function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    throw new OfflineError('通信できませんでした。電波が戻ったら送り直します');
  }
}

async function errorText(res) {
  const t = await res.text().catch(() => '');
  try {
    const j = JSON.parse(t);
    return j.error_summary || j.error_description || j.error || t;
  } catch {
    return t || `HTTP ${res.status}`;
  }
}

export function createDropbox({ appKey, redirectUri, storage = localStorage }) {
  const saveAccess = (j) => {
    storage.setItem(K.access, j.access_token);
    storage.setItem(K.expires, String(Date.now() + (Number(j.expires_in) || 14400) * 1000));
  };

  async function refresh() {
    const rt = storage.getItem(K.refresh);
    if (!rt) throw new AuthError('Dropbox につながっていません');
    const res = await request(TOKEN_URL, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: appKey }) });
    if (res.status === 400 || res.status === 401) {
      clear();
      throw new AuthError('Dropbox の許可が切れました。つなぎ直してください');
    }
    if (!res.ok) throw new Error(`Dropbox のログインを更新できませんでした（${await errorText(res)}）`);
    saveAccess(await res.json());
  }

  async function accessToken() {
    const exp = Number(storage.getItem(K.expires) || 0);
    if (!storage.getItem(K.access) || Date.now() > exp - 60_000) await refresh();
    return storage.getItem(K.access);
  }

  // 401 なら1回だけトークンを更新して送り直す
  async function authed(url, init) {
    let res = await request(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401) {
      await refresh();
      res = await request(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${storage.getItem(K.access)}` } });
    }
    if (res.status === 401) {
      clear();
      throw new AuthError('Dropbox の許可が切れました。つなぎ直してください');
    }
    return res;
  }

  function clear() {
    for (const k of Object.values(K)) storage.removeItem(k);
  }

  return {
    demo: false,
    configured: Boolean(appKey),
    connected: () => Boolean(storage.getItem(K.refresh)),

    async startLogin() {
      const verifier = randomString(64);
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const state = randomString(24);
      storage.setItem(K.verifier, verifier);
      storage.setItem(K.state, state);
      const u = new URL(AUTH_URL);
      u.search = new URLSearchParams({
        client_id: appKey,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        token_access_type: 'offline', // 長く使える更新用トークンをもらう（毎回ログインしなくてよい）
        redirect_uri: redirectUri,
        state,
      }).toString();
      location.assign(u.toString());
    },

    // Dropbox から戻ってきたとき（?code=…）。扱ったら true
    async finishLogin(params) {
      if (params.get('error')) throw new Error(params.get('error_description') || 'Dropbox で許可されませんでした');
      const code = params.get('code');
      if (!code) return false;
      if (params.get('state') !== storage.getItem(K.state)) throw new Error('ログインの確認に失敗しました。もう一度つないでください');
      const res = await request(TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: storage.getItem(K.verifier) || '', client_id: appKey, redirect_uri: redirectUri }),
      });
      if (!res.ok) throw new Error(`Dropbox につなげませんでした（${await errorText(res)}）`);
      const j = await res.json();
      storage.setItem(K.refresh, j.refresh_token);
      saveAccess(j);
      storage.removeItem(K.verifier);
      storage.removeItem(K.state);
      return true;
    },

    // 同じ名前があれば Dropbox が「名前 (1).jpg」に変える。返り値の name が実際の名前
    async upload(path, blob) {
      const res = await authed(`${CONTENT}/files/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ path, mode: 'add', autorename: true, mute: true }) },
        body: blob,
      });
      if (res.status === 429) throw new OfflineError('Dropbox が混んでいます。少しして送り直します');
      if (!res.ok) throw new Error(`送れませんでした（${await errorText(res)}）`);
      return res.json();
    },

    // 文字のファイルを読む。無ければ null
    async download(path) {
      const res = await authed(`${CONTENT}/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': headerJson({ path }) } });
      if (res.status === 409) return null;
      if (!res.ok) throw new Error(`読めませんでした（${await errorText(res)}）`);
      return res.text();
    },

    async account() {
      const res = await authed(`${API}/users/get_current_account`, { method: 'POST' });
      if (!res.ok) return null;
      const j = await res.json();
      return j.name?.display_name || null;
    },

    async disconnect() {
      try {
        await authed(`${API}/auth/token/revoke`, { method: 'POST' });
      } catch {
        // 取り消せなくても、この携帯からは消す
      }
      clear();
    },
  };
}

// お試し（?demo=1）。Dropbox には送らず、この携帯の中だけで動く
export function createMockDropbox({ storage = localStorage } = {}) {
  const files = new Map([['/projects.json', JSON.stringify(SAMPLE_PROJECTS)]]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__experiphotoUploads = [];
  return {
    demo: true,
    configured: true,
    connected: () => storage.getItem('ep.demo.connected') === '1',
    async startLogin() {
      storage.setItem('ep.demo.connected', '1');
      location.reload();
    },
    finishLogin: async () => false,
    async upload(path, blob) {
      await sleep(500);
      if (storage.getItem('ep.demo.offline') === '1') throw new OfflineError('通信できませんでした（お試し）');
      let name = path.split('/').pop();
      const dir = path.slice(0, path.length - name.length);
      for (let i = 1; files.has(dir + name); i++) name = name.replace(/( \(\d+\))?(\.[^.]+)$/, ` (${i})$2`);
      files.set(dir + name, blob);
      window.__experiphotoUploads.push({ path: dir + name, size: blob.size, type: blob.type });
      return { name, path_display: dir + name };
    },
    async download(path) {
      await sleep(200);
      const f = files.get(path);
      return f == null ? null : String(f);
    },
    account: async () => 'お試し',
    async disconnect() {
      storage.removeItem('ep.demo.connected');
    },
  };
}

const SAMPLE_PROJECTS = {
  v: 1,
  projects: [
    {
      id: 'サンプル実験A',
      name: 'サンプル実験A',
      color: '#1D9E75',
      experiments: [
        { title: '20261126 ウェスタンブロット', path: 'ResearchHub/サンプル実験A/Experiments/20261126 ウェスタンブロット.md', created: '2026-11-26' },
        { title: '20261120 PCR 条件検討', path: 'ResearchHub/サンプル実験A/Experiments/20261120 PCR 条件検討.md', created: '2026-11-20' },
      ],
    },
    { id: 'サンプル実験B', name: 'サンプル実験B', color: '#378ADD', experiments: [] },
    { id: '未分類', name: '未分類', color: '#B4B2A9', experiments: [] },
  ],
};
