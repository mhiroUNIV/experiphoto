// 撮ったあとの確認：切り取り・90° 回転・撮り直し。
// 何も変えなければ元のファイルをそのまま送る（保存し直さないので、画質も写真の中の記録も残る）。
// 変えたときだけ、切り取った部分を JPEG に保存し直す。

const $ = (id) => document.getElementById(id);
const MIN = 0.05; // 枠の最小（写真の幅・高さに対する割合）
const QUALITY = 0.95; // 保存し直すときの画質（ブロットやゲルの細部を残すため高め）
const full = () => ({ x: 0, y: 0, w: 1, h: 1 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let wired = false;
let cur = null; // 確かめている写真：{ bmp, rot, crop, maxSide, quality, onRetake, resolve, finishing }
let drag = null;

// 写真を見せて、どうするかを待つ。返すのは { action: 'send' | 'skip' | 'retake' | 'rest', edited: Blob | null, error? }
//   rest は「この写真を送り、残りは確かめずに送る」
export async function review(file, { index = 0, total = 1, source = 'camera', target = '', maxSide = 0, quality = QUALITY, onRetake } = {}) {
  let bmp;
  try {
    bmp = await createImageBitmap(file); // 向き（EXIF）は既定で反映される
  } catch {
    return { action: 'send', edited: null }; // 読めない形式（HEIC など）は、確かめずにそのまま送る
  }
  wire();
  $('rv-count').textContent = total > 1 ? `${index + 1} / ${total} 枚目` : '';
  $('rv-target').textContent = target;
  $('rv-retake').hidden = source !== 'camera';
  const rest = total - index - 1;
  $('rv-rest').hidden = rest < 1;
  $('rv-rest').textContent = `この写真を送り、残り ${rest} 枚は確かめずに送る`;
  setBusy(false);
  return new Promise((resolve) => {
    cur = { bmp, rot: 0, crop: full(), maxSide, quality, onRetake, resolve, finishing: false };
    $('review').showModal();
    draw();
  });
}

// 枠を動かす。which は動かす所（nw・n・ne・e・se・s・sw・w の角と辺、または move で枠ごと）。dx・dy は写真の幅・高さに対する割合
export function moveCrop(c, which, dx, dy) {
  if (which === 'move') return { x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h), w: c.w, h: c.h };
  let L = c.x;
  let T = c.y;
  let R = c.x + c.w;
  let B = c.y + c.h;
  if (which.includes('w')) L = clamp(L + dx, 0, R - MIN);
  if (which.includes('e')) R = clamp(R + dx, L + MIN, 1);
  if (which.includes('n')) T = clamp(T + dy, 0, B - MIN);
  if (which.includes('s')) B = clamp(B + dy, T + MIN, 1);
  return { x: L, y: T, w: R - L, h: B - T };
}

// 写真を右に 90° 回したとき、枠がどこへ移るか
export const rotateCrop = (c) => ({ x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w });

const isFull = (c) => c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999;
const changed = (s) => s.rot !== 0 || !isFull(s.crop);
const rotatedSize = (bmp, rot) => (rot % 180 ? [bmp.height, bmp.width] : [bmp.width, bmp.height]);

// 回した写真を、横 RW・縦 RH の広さに描く
function paintRotated(g, bmp, rot, RW, RH) {
  g.translate(RW / 2, RH / 2);
  g.rotate((rot * Math.PI) / 180);
  g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
}

// 切り取って回した写真を JPEG にする。maxSide を与えると、長い辺をそこまで縮める
export function renderEdited(bmp, rot, crop, maxSide = 0, quality = QUALITY) {
  const [RW, RH] = rotatedSize(bmp, rot);
  const cx = Math.round(crop.x * RW);
  const cy = Math.round(crop.y * RH);
  const cw = Math.max(1, Math.round(crop.w * RW));
  const ch = Math.max(1, Math.round(crop.h * RH));
  const k = maxSide ? Math.min(1, maxSide / Math.max(cw, ch)) : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw * k));
  c.height = Math.max(1, Math.round(ch * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.scale(k, k);
  g.translate(-cx, -cy);
  paintRotated(g, bmp, rot, RW, RH);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('切り取った写真を保存できませんでした'))), 'image/jpeg', quality),
  );
}

// ---- 画面 ----
function draw() {
  const { bmp, rot } = cur;
  const [RW, RH] = rotatedSize(bmp, rot);
  const stage = $('rv-stage');
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = Math.max(0.01, Math.min(aw / RW, ah / RH));
  const dw = Math.max(1, Math.floor(RW * s));
  const dh = Math.max(1, Math.floor(RH * s));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = $('rv-canvas');
  cv.width = Math.round(dw * dpr);
  cv.height = Math.round(dh * dpr);
  cv.style.width = `${dw}px`;
  cv.style.height = `${dh}px`;
  Object.assign($('rv-frame').style, { width: `${dw}px`, height: `${dh}px` });
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.scale(cv.width / RW, cv.height / RH);
  paintRotated(g, bmp, rot, RW, RH);
  placeCrop();
}

function placeCrop() {
  const { x, y, w, h } = cur.crop;
  Object.assign($('rv-crop').style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
  $('rv-reset').disabled = !changed(cur);
}

function setBusy(on) {
  for (const id of ['rv-send', 'rv-skip', 'rv-retake', 'rv-rest', 'rv-rotate', 'rv-reset']) $(id).disabled = on;
  $('rv-send').textContent = on ? '保存しています…' : '送る';
  if (!on && cur) $('rv-reset').disabled = !changed(cur);
}

async function finish(action) {
  const s = cur;
  if (!s || s.finishing) return;
  s.finishing = true;
  let edited = null;
  let error = null;
  if ((action === 'send' || action === 'rest') && changed(s)) {
    setBusy(true);
    try {
      edited = await renderEdited(s.bmp, s.rot, s.crop, s.maxSide, s.quality);
    } catch (e) {
      error = e.message || '切り取った写真を保存できませんでした'; // 元の写真を送る（写真をなくさない）
    }
  }
  cur = null;
  s.bmp.close?.();
  if ($('review').open) $('review').close();
  s.resolve({ action, edited, error });
}

function wire() {
  if (wired) return;
  wired = true;
  $('rv-send').addEventListener('click', () => finish('send'));
  $('rv-skip').addEventListener('click', () => finish('skip'));
  $('rv-rest').addEventListener('click', () => finish('rest'));
  // カメラは、押した操作の中で開かないと開けないので、ここで開く
  $('rv-retake').addEventListener('click', () => {
    const go = cur?.onRetake;
    finish('retake');
    go?.();
  });
  $('rv-rotate').addEventListener('click', () => {
    if (!cur) return;
    cur.crop = rotateCrop(cur.crop);
    cur.rot = (cur.rot + 90) % 360;
    draw();
  });
  $('rv-reset').addEventListener('click', () => {
    if (!cur) return;
    cur.rot = 0;
    cur.crop = full();
    draw();
  });
  // 戻る操作でうっかり閉じない。閉じてしまったら、写真をなくさないように、そのまま送る
  $('review').addEventListener('cancel', (e) => e.preventDefault());
  $('review').addEventListener('close', () => finish('send'));
  window.addEventListener('resize', () => cur && !cur.finishing && draw());

  const box = $('rv-crop');
  box.addEventListener('pointerdown', (e) => {
    if (!cur || cur.finishing) return;
    e.preventDefault();
    const fr = $('rv-frame').getBoundingClientRect();
    drag = { id: e.pointerId, which: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, fw: fr.width, fh: fr.height, c0: { ...cur.crop } };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || !cur || e.pointerId !== drag.id) return;
    cur.crop = moveCrop(drag.c0, drag.which, (e.clientX - drag.sx) / drag.fw, (e.clientY - drag.sy) / drag.fh);
    placeCrop();
  });
  const end = (e) => {
    if (drag && e.pointerId === drag.id) drag = null;
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}
