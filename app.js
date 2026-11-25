const $ = (id) => document.getElementById(id);
const ROOT_FOLDER = 'Comprovante de pagamentos';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MAX_SIDE = 2200; // px: suficiente para ler texto pequeno sem pesar o envio

let accessToken = null;
let tokenClient = null;
let photoFile = null;
let scanned = null; // { b64, w, h } da folha já tratada (usada no OCR e no PDF)

const cfg = {
  get clientId() { return localStorage.getItem('clientId') || ''; },
  get visionKey() { return localStorage.getItem('visionKey') || ''; },
  get gmail() { return (localStorage.getItem('gmail') || '').trim().toLowerCase(); },
};

function show(el, text, cls) {
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

// ---------- Configuração ----------
$('cfgClientId').value = cfg.clientId;
$('cfgVisionKey').value = cfg.visionKey;
$('cfgGmail').value = cfg.gmail;

$('btnSaveCfg').onclick = () => {
  localStorage.setItem('clientId', $('cfgClientId').value.trim());
  localStorage.setItem('visionKey', $('cfgVisionKey').value.trim());
  localStorage.setItem('gmail', $('cfgGmail').value.trim().toLowerCase());
  accessToken = null;
  updateCreateButton();
  show($('loginStatus'), 'Configuração salva.', 'ok');
  tokenClient = null;
  $('btnOcr').disabled = !photoFile || !cfg.visionKey;
};

// ---------- Google Identity Services (OAuth) ----------
function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  if (!window.google || !cfg.clientId) throw new Error('Salve o Client ID e recarregue a página.');
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cfg.clientId,
    scope: SCOPE,
    callback: async (resp) => {
      if (resp.error) return show($('loginStatus'), 'Erro no login: ' + resp.error, 'err');
      // Confere se a conta conectada é a configurada
      const who = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
        headers: { Authorization: 'Bearer ' + resp.access_token },
      }).then((r) => r.json()).catch(() => ({}));
      const email = (who.user?.emailAddress || '').toLowerCase();
      if (cfg.gmail && email !== cfg.gmail) {
        accessToken = null;
        show($('loginStatus'), `Entrou como ${email}, mas a conta configurada é ${cfg.gmail}. Entre com a conta configurada.`, 'err');
        return updateCreateButton();
      }
      accessToken = resp.access_token;
      show($('loginStatus'), `Conectado ao Google Drive como ${email} ✔`, 'ok');
      updateCreateButton();
    },
  });
  return tokenClient;
}

$('btnLogin').onclick = () => {
  try {
    const opts = { prompt: 'consent' };
    if (cfg.gmail) opts.login_hint = cfg.gmail; // já sugere essa conta na tela do Google
    ensureTokenClient().requestAccessToken(opts);
  }
  catch (e) { show($('loginStatus'), e.message, 'err'); }
};

// ---------- Foto → "escaneada" (giro + tons de cinza + contraste) ----------
$('photo').onchange = (e) => {
  photoFile = e.target.files[0] || null;
  scanned = null;
  $('btnOcr').disabled = !photoFile || !cfg.visionKey;
  show($('ocrStatus'), photoFile ? 'Foto selecionada. Clique em "Escanear recibos".' : '', '');
};

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

async function preprocess(file, angle) {
  const img = await loadImage(file);
  const swap = angle === 90 || angle === 270;
  let w = swap ? img.height : img.width;
  let h = swap ? img.width : img.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(img, -(img.width * scale) / 2, -(img.height * scale) / 2,
    img.width * scale, img.height * scale);

  // Cinza + contraste: estica os níveis entre os percentis 2% e 98%
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < px.length; i += 4) {
    const g = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
    px[i] = px[i + 1] = px[i + 2] = g;
    hist[g]++;
  }
  const total = canvas.width * canvas.height;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.min(255, Math.max(0, ((px[i] - lo) * 255) / range));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);

  return { b64: canvas.toDataURL('image/jpeg', 0.9).split(',')[1], w: canvas.width, h: canvas.height };
}

// ---------- Cloud Vision (OCR) ----------
$('btnOcr').onclick = async () => {
  if (!photoFile) return;
  $('btnOcr').disabled = true;
  show($('ocrStatus'), 'Preparando a imagem...', '');
  try {
    scanned = await preprocess(photoFile, Number($('rotate').value));
    const content = scanned.b64;
    show($('ocrStatus'), 'Lendo os recibos...', '');
    const res = await fetch(
      'https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(cfg.visionKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            imageContext: { languageHints: ['pt'] },
          }],
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    const text = data.responses?.[0]?.fullTextAnnotation?.text || '';
    const rows = parseReceipts(text, $('eventName').value.trim());

    if (!rows.length) {
      show($('ocrStatus'), 'Nenhum recibo reconhecido. Tente girar a foto ou fotografar mais reto.', 'err');
    } else {
      $('names').value = rows.map((r) => `${r.name} | ${r.setor}`).join('\n');
      show($('ocrStatus'), `${rows.length} pessoa(s) encontrada(s). Confira antes de criar.`, 'ok');
    }
    updateCreateButton();
  } catch (err) {
    show($('ocrStatus'), 'Falha na leitura: ' + err.message, 'err');
  } finally {
    $('btnOcr').disabled = !photoFile || !cfg.visionKey;
  }
};

// Extrai NOME e SETOR de cada recibo ("Recibo de entrega"). Pessoas repetidas
// (vários ingressos da mesma pessoa no mesmo setor) viram uma linha só.
function parseReceipts(text, fallbackEvent) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const names = [];
  const setores = [];
  const eventos = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const up = line.toUpperCase();
    const inline = (label) => {
      const m = line.match(new RegExp('^' + label + '\\s*[:\\-]?\\s+(.+)$', 'i'));
      return m ? m[1].trim() : null;
    };

    if (/^NOME\b/i.test(up) && !/^NOME\s+DO/i.test(up)) {
      const v = inline('NOME') || lines[i + 1];
      if (v && /[A-ZÀ-Ý]{2,}/.test(v)) names.push(v.trim());
    } else if (/^SETOR\b/i.test(up)) {
      let v = inline('SETOR');
      if (!v) {
        v = lines[i + 1] || '';
        // "(13/11)" costuma vir em uma linha separada
        if (/^\(.*\)$/.test(lines[i + 2] || '')) v += ' ' + lines[i + 2];
      }
      setores.push(v.trim());
    } else if (/^EVENTO\b/i.test(up)) {
      const v = inline('EVENTO') || lines[i + 1];
      if (v) eventos.push(v.trim());
    }
  }

  const seen = new Set();
  const rows = [];
  names.forEach((name, i) => {
    const setor = setores[i] || fallbackEvent || eventos[i] || '';
    const key = (name + '|' + setor).toLowerCase();
    if (!name || !setor || seen.has(key)) return;
    seen.add(key);
    rows.push({ name, setor });
  });
  return rows;
}

// ---------- Lista de pessoas ----------
function parseRows(textarea) {
  const out = [];
  for (const line of textarea.value.split('\n')) {
    const [name, setor] = line.split('|').map((s) => (s || '').trim());
    if (name) out.push({ name, setor: setor || '' });
  }
  return out;
}

function updateCreateButton() {
  $('btnCreate').disabled = !accessToken || !parseRows($('names')).length;
}
$('names').oninput = updateCreateButton;

// ---------- PDF (sem bibliotecas): folha escaneada como imagem JPEG ----------
function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function makePdf(jpeg, w, h) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    parts.push(b);
    len += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xref = len;
  let x = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  x += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(x);

  const out = new Uint8Array(len);
  let pos = 0;
  for (const b of parts) { out.set(b, pos); pos += b.length; }
  return out;
}

async function uploadPdf(name, parentId, bytes) {
  const q = `name = '${esc(name)}' and '${parentId}' in parents and trashed = false`;
  const found = await fetch(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: headers() }).then((r) => r.json());
  if (found.files?.length) return 'já existia';

  const boundary = 'folha' + Date.now();
  const meta = JSON.stringify({ name, parents: [parentId], mimeType: 'application/pdf' });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  if (!data.id) throw new Error(data.error?.message || 'falha ao enviar o PDF');
  return 'enviado';
}

// ---------- Google Drive ----------
const headers = () => ({ Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' });
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function findOrCreateFolder(name, parentId) {
  const parentQ = parentId ? `'${parentId}' in parents` : `'root' in parents`;
  const q = `name = '${esc(name)}' and mimeType = 'application/vnd.google-apps.folder' and ${parentQ} and trashed = false`;
  const found = await fetch(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name)`, { headers: headers() }).then((r) => r.json());
  if (found.files?.length) return found.files[0].id;

  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const created = await fetch(DRIVE + '?fields=id', { method: 'POST', headers: headers(), body: JSON.stringify(body) }).then((r) => r.json());
  if (!created.id) throw new Error(created.error?.message || 'não foi possível criar a pasta');
  return created.id;
}

$('btnCreate').onclick = async () => {
  const rows = parseRows($('names'));
  const fallbackEvent = $('eventName').value.trim();
  if (!accessToken) return show($('driveStatus'), 'Conecte ao Google Drive primeiro.', 'err');
  if (rows.some((r) => !r.setor && !fallbackEvent)) {
    return show($('driveStatus'), 'Há pessoas sem setor. Preencha o setor ou o campo Evento.', 'err');
  }

  $('btnCreate').disabled = true;
  try {
    show($('driveStatus'), 'Criando pasta raiz...', '');
    const rootId = await findOrCreateFolder(ROOT_FOLDER, null);
    const pdf = scanned ? makePdf(base64ToBytes(scanned.b64), scanned.w, scanned.h) : null;
    let done = 0;
    let uploads = 0;
    for (const { name, setor } of rows) {
      const folderId = await findOrCreateFolder(`${name} - ${setor || fallbackEvent}`, rootId);
      if (pdf) {
        const r = await uploadPdf('Folha escaneada.pdf', folderId, pdf);
        if (r === 'enviado') uploads++;
      }
      done++;
      show($('driveStatus'), `Pastas ${done}/${rows.length}...`, '');
    }
    const extra = pdf ? ` PDF enviado em ${uploads} pasta(s).` : ' Sem foto escaneada: nenhum PDF foi enviado.';
    show($('driveStatus'), `✔ ${done} pasta(s) em "${ROOT_FOLDER}".${extra}`, 'ok');
  } catch (err) {
    show($('driveStatus'), 'Erro: ' + err.message, 'err');
  } finally {
    updateCreateButton();
  }
};
