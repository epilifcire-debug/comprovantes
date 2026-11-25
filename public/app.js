const $ = (id) => document.getElementById(id);
const MAX_SIDE = 2200; // px: suficiente para ler texto pequeno sem pesar o envio

let photoFile = null;
let scanned = null; // { b64, w, h } da folha já tratada

function show(el, text, cls) {
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

// ---------- API ----------
const token = () => localStorage.getItem('token') || '';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { sair(); throw new Error('Sessão expirada. Entre de novo.'); }
  if (!res.ok) throw new Error(data.erro || 'Erro ' + res.status);
  return data;
}

// ---------- Login ----------
function mostraArea(papel) {
  $('secLogin').hidden = true;
  $('area').hidden = false;
  $('secAdmin').hidden = papel !== 'admin_master';
  $('quem').textContent = 'Conectado' + (papel === 'admin_master' ? ' como administrador' : '');
  if (papel === 'admin_master') carregaUsuarios();
}

function sair() {
  localStorage.removeItem('token');
  $('area').hidden = true;
  $('secLogin').hidden = false;
}

$('btnLogin').onclick = async () => {
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: $('loginUser').value, senha: $('loginSenha').value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.erro);
    localStorage.setItem('token', data.token);
    $('loginSenha').value = '';
    show($('loginStatus'), '', '');
    mostraArea(data.usuario.papel);
  } catch (e) {
    show($('loginStatus'), e.message, 'err');
  }
};

$('btnSair').onclick = sair;

(async () => {
  if (!token()) return;
  try {
    const me = await api('/api/me');
    mostraArea(me.papel);
  } catch { sair(); }
})();

// ---------- Foto → "escaneada" (giro + tons de cinza + contraste) ----------
$('photo').onchange = (e) => {
  photoFile = e.target.files[0] || null;
  scanned = null;
  $('btnOcr').disabled = !photoFile;
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
  const w = swap ? img.height : img.width;
  const h = swap ? img.width : img.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(img, -(img.width * scale) / 2, -(img.height * scale) / 2, img.width * scale, img.height * scale);

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

// ---------- OCR (pelo servidor) ----------
$('btnOcr').onclick = async () => {
  if (!photoFile) return;
  $('btnOcr').disabled = true;
  show($('ocrStatus'), 'Preparando a imagem...', '');
  try {
    scanned = await preprocess(photoFile, Number($('rotate').value));
    show($('ocrStatus'), 'Lendo os recibos...', '');
    const { texto } = await api('/api/scan', { method: 'POST', body: { imagem_b64: scanned.b64 } });
    const rows = parseReceipts(texto, $('eventName').value.trim());
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
    $('btnOcr').disabled = !photoFile;
  }
};

// Extrai NOME e SETOR de cada recibo. Pessoas repetidas no mesmo setor viram uma linha só.
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
function parseRows() {
  const out = [];
  for (const line of $('names').value.split('\n')) {
    const [name, setor] = line.split('|').map((s) => (s || '').trim());
    if (name) out.push({ name, setor: setor || '' });
  }
  return out;
}

function updateCreateButton() {
  $('btnCreate').disabled = !parseRows().length;
}
$('names').oninput = updateCreateButton;

// ---------- Criar pastas e enviar (pelo servidor) ----------
$('btnCreate').onclick = async () => {
  const rows = parseRows();
  const evento = $('eventName').value.trim();
  if (rows.some((r) => !r.setor && !evento)) {
    return show($('driveStatus'), 'Há pessoas sem setor. Preencha o setor ou o campo Evento.', 'err');
  }
  $('btnCreate').disabled = true;
  show($('driveStatus'), 'Criando pastas e enviando...', '');
  try {
    const r = await api('/api/pastas', {
      method: 'POST',
      body: {
        rows,
        evento_padrao: evento,
        imagem_b64: scanned?.b64 || null,
        largura: scanned?.w,
        altura: scanned?.h,
      },
    });
    const extra = r.pdf ? ' PDF enviado em cada pasta.' : ' Sem foto escaneada: nenhum PDF foi enviado.';
    show($('driveStatus'), `✔ ${r.pastas} pasta(s) criada(s) no Drive.${extra}`, 'ok');
  } catch (err) {
    show($('driveStatus'), 'Erro: ' + err.message, 'err');
  } finally {
    updateCreateButton();
  }
};

// ---------- Administração de contas ----------
async function carregaUsuarios() {
  try {
    const lista = await api('/api/admin/usuarios');
    $('listaUsuarios').innerHTML = '';
    for (const u of lista) {
      const linha = document.createElement('div');
      linha.className = 'row';
      const info = document.createElement('span');
      info.textContent = `${u.username}${u.email ? ' · ' + u.email : ''}${u.papel === 'admin_master' ? ' (admin)' : ''}${u.ativo ? '' : ' · desativado'}`;
      linha.appendChild(info);
      if (u.papel !== 'admin_master') {
        const btn = document.createElement('button');
        btn.className = u.ativo ? 'danger' : 'secondary';
        btn.textContent = u.ativo ? 'Desativar' : 'Reativar';
        btn.onclick = async () => {
          try { await api('/api/admin/usuarios/' + u.id, { method: 'PATCH', body: { ativo: !u.ativo } }); carregaUsuarios(); }
          catch (e) { show($('adminStatus'), e.message, 'err'); }
        };
        linha.appendChild(btn);
      }
      $('listaUsuarios').appendChild(linha);
    }
  } catch (e) {
    show($('adminStatus'), e.message, 'err');
  }
}

$('btnNovo').onclick = async () => {
  try {
    await api('/api/admin/usuarios', {
      method: 'POST',
      body: { username: $('novoUser').value, email: $('novoEmail').value, senha: $('novaSenha').value },
    });
    show($('adminStatus'), 'Conta criada.', 'ok');
    $('novoUser').value = ''; $('novoEmail').value = ''; $('novaSenha').value = '';
    carregaUsuarios();
  } catch (e) {
    show($('adminStatus'), e.message, 'err');
  }
};
