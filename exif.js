// JPEG の中の記録（EXIF）から、撮った日時を読む。
// Android は、ギャラリーから選んだ写真のファイル日時を「選んだ時刻」にして渡すことがあるので、写真そのものの記録を先に見る。
// 返すのは携帯の時計の時刻（その土地の時刻）。読めなければ null。

const DATE_TIME_ORIGINAL = 0x9003; // 撮った日時（Exif IFD）
const EXIF_IFD = 0x8769; // IFD0 から Exif IFD への道しるべ
const DATE_TIME = 0x0132; // ファイルの日時（IFD0）。撮った日時が無いときだけ使う

export function exifDate(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null; // JPEG ではない
  let p = 2;
  while (p + 4 <= v.byteLength) {
    const marker = v.getUint16(p);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda || marker === 0xffd9) return null; // 画像の本体まで来た
    const len = v.getUint16(p + 2);
    // APP1 の「Exif\0\0」。同じ APP1 でも XMP などは飛ばす
    if (marker === 0xffe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
      return fromTiff(v, p + 10, Math.min(v.byteLength, p + 2 + len));
    }
    p += 2 + len;
  }
  return null;
}

function fromTiff(v, t, end) {
  if (t + 8 > end) return null;
  const order = v.getUint16(t);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);

  // ifd の中から tag の項目を探し、その位置を返す（無ければ -1）
  const find = (ifd, tag) => {
    const o = t + ifd;
    if (ifd <= 0 || o + 2 > end) return -1;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > end) return -1;
      if (u16(e) === tag) return e;
    }
    return -1;
  };
  const text = (e) => {
    if (e < 0 || u16(e + 2) !== 2) return null; // 2 = 文字
    const count = u32(e + 4);
    const at = count <= 4 ? e + 8 : t + u32(e + 8);
    if (at + count > end) return null;
    let s = '';
    for (let i = 0; i < count; i++) {
      const c = v.getUint8(at + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const ifd0 = u32(t + 4);
  const ptr = find(ifd0, EXIF_IFD);
  const exif = ptr >= 0 ? u32(ptr + 8) : -1;
  return parse(text(find(exif, DATE_TIME_ORIGINAL))) || parse(text(find(ifd0, DATE_TIME)));
}

// 「2026:11:26 12:05:36」を日時に。ありえない値（2000 年より前、明日より先）は捨てる
function parse(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const t = d.getTime();
  return Number.isFinite(t) && d.getFullYear() >= 2000 && t < Date.now() + 86400000 ? d : null;
}
