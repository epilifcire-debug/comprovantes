const $ = (id) => document.getElementById(id);

let photoFile = null;
let srcCanvas = null;   // foto já girada (entrada do scanner)
let cantos = null;      // 4 cantos da página, na escala de srcCanvas
let scanned = null;     // { b64, w, h } da página escaneada

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

// ---------- Scanner: detectar página, ajustar cantos, gerar ----------
const editor = $('editor');
const ctxEd = editor.getContext('2d');
let escala = 1;       // escala de exibição (tela / srcCanvas)
let arrastando = -1;  // índice do canto sendo arrastado
let redesenhaAgendado = false;

function desenhaEditor() {
  if (!srcCanvas || !cantos) return;
  const largura = Math.min(560, editor.parentElement.clientWidth || 560);
  escala = largura / srcCanvas.width;
  editor.width = largura;
  editor.height = Math.round(srcCanvas.height * escala);
  ctxEd.drawImage(srcCanvas, 0, 0, editor.width, editor.height);
  ctxEd.lineWidth = 3;
  ctxEd.strokeStyle = '#38bdf8';
  ctxEd.beginPath();
  cantos.forEach((p, i) => {
    const x = p.x * escala, y = p.y * escala;
    if (i === 0) ctxEd.moveTo(x, y); else ctxEd.lineTo(x, y);
  });
  ctxEd.closePath();
  ctxEd.stroke();
  cantos.forEach((p) => {
    ctxEd.beginPath();
    ctxEd.arc(p.x * escala, p.y * escala, 12, 0, Math.PI * 2);
    ctxEd.fillStyle = '#38bdf8';
    ctxEd.fill();
    ctxEd.lineWidth = 2;
    ctxEd.strokeStyle = '#0b1222';
    ctxEd.stroke();
  });
}

function posicaoNoEditor(e) {
  const r = editor.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (editor.width / r.width) / escala,
    y: (e.clientY - r.top) * (editor.height / r.height) / escala,
  };
}

editor.addEventListener('pointerdown', (e) => {
  if (!cantos) return;
  const p = posicaoNoEditor(e);
  let melhor = -1, dist = Infinity;
  cantos.forEach((c, i) => {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < dist) { dist = d; melhor = i; }
  });
  if (dist * escala <= 40) {
    arrastando = melhor;
    editor.setPointerCapture(e.pointerId);
  }
});

editor.addEventListener('pointermove', (e) => {
  if (arrastando < 0) return;
  const p = posicaoNoEditor(e);
  cantos[arrastando] = {
    x: Math.max(0, Math.min(srcCanvas.width, p.x)),
    y: Math.max(0, Math.min(srcCanvas.height, p.y)),
  };
  if (!redesenhaAgendado) {
    redesenhaAgendado = true;
    requestAnimationFrame(() => { redesenhaAgendado = false; desenhaEditor(); });
  }
});

editor.addEventListener('pointerup', () => { arrastando = -1; });
editor.addEventListener('pointercancel', () => { arrastando = -1; });

function habilitaBotoes(on) {
  $('btnDetect').disabled = !on;
  $('btnGerar').disabled = !on;
  $('btnOcr').disabled = !on;
}

async function preparaFoto() {
  if (!photoFile) return;
  $('ajusteBox').hidden = false;
  habilitaBotoes(false);
  show($('ocrStatus'), 'Preparando o scanner (a primeira vez pode demorar)...', '');
  try {
    srcCanvas = await imageToCanvas(photoFile, Number($('rotate').value));
    // Mostra a foto logo, com cantos padrão, antes do trabalho pesado (evita a tela travar).
    cantos = cantosPadrao(srcCanvas.width, srcCanvas.height);
    scanned = null;
    $('preview').style.display = 'none';
    desenhaEditor();
    show($('ocrStatus'), 'Procurando a página...', '');
    await new Promise((r) => setTimeout(r, 60)); // deixa o navegador desenhar antes
    const achado = await detectaPagina(srcCanvas);
    if (achado) cantos = achado;
    desenhaEditor();
    show($('ocrStatus'), achado
      ? 'Página detectada. Confira os cantos e clique em "Gerar página escaneada".'
      : 'Não achei a página sozinho. Arraste os cantos e clique em "Gerar página escaneada".', achado ? 'ok' : 'err');
  } catch (err) {
    show($('ocrStatus'), 'Erro no scanner: ' + err.message, 'err');
  } finally {
    habilitaBotoes(true);
  }
}

async function geraPagina() {
  if (!srcCanvas || !cantos) return null;
  const r = await geraPaginaEscaneada(srcCanvas, cantos);
  scanned = { b64: r.b64, w: r.w, h: r.h };
  $('preview').src = 'data:image/jpeg;base64,' + r.b64;
  $('preview').style.display = 'block';
  return scanned;
}

// Garante a página escaneada antes de OCR ou envio.
async function garantePagina() {
  if (!scanned && photoFile) await geraPagina();
  return scanned;
}

$('photo').onchange = (e) => {
  photoFile = e.target.files[0] || null;
  scanned = null;
  srcCanvas = null;
  cantos = null;
  habilitaBotoes(false);
  $('ajusteBox').hidden = !photoFile;
  if (photoFile) preparaFoto();
  else show($('ocrStatus'), '', '');
};

$('rotate').onchange = () => { if (photoFile) preparaFoto(); };
$('btnDetect').onclick = () => preparaFoto();
$('btnGerar').onclick = async () => {
  try {
    show($('ocrStatus'), 'Gerando página escaneada...', '');
    await geraPagina();
    show($('ocrStatus'), 'Página pronta. Confira a prévia.', 'ok');
  } catch (err) {
    show($('ocrStatus'), 'Erro ao gerar: ' + err.message, 'err');
  }
};

// ---------- OCR (opcional, pelo servidor) ----------
$('btnOcr').onclick = async () => {
  try {
    show($('ocrStatus'), 'Lendo os nomes...', '');
    const pag = await garantePagina();
    if (!pag) throw new Error('gere a página escaneada primeiro');
    const resp = await api('/api/scan', { method: 'POST', body: { imagem_b64: pag.b64 } });
    if (typeof resp.texto !== 'string') throw new Error('o servidor não devolveu o texto da folha');
    const rows = parseReceipts(resp.texto, $('eventName').value.trim());
    if (!rows.length) {
      const trecho = resp.texto.replace(/\s+/g, ' ').trim().slice(0, 400) || '(nenhum texto)';
      show($('ocrStatus'), 'Nenhum recibo reconhecido. Texto lido: ' + trecho, 'err');
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
    return show($('driveStatus'), 'Há pessoas sem setor. Preencha o evento no campo acima.', 'err');
  }
  $('btnCreate').disabled = true;
  show($('driveStatus'), 'Preparando a página e enviando...', '');
  try {
    const pag = await garantePagina();
    const r = await api('/api/pastas', {
      method: 'POST',
      body: {
        rows,
        evento_padrao: evento,
        imagem_b64: pag?.b64 || null,
        largura: pag?.w,
        altura: pag?.h,
      },
    });
    const extra = r.pdf ? ' PDF enviado em cada pasta.' : ' Sem foto: nenhum PDF foi enviado.';
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
