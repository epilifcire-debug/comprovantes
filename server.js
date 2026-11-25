// Servidor do Folha → Drive.
// Login por usuário ou e-mail + senha, administração de contas (só admin_master),
// OCR com a Cloud Vision e envio das pastas e do PDF ao Google Drive.
// Todas as chaves ficam em variáveis de ambiente, nunca no código.

const express = require('express');
const crypto = require('crypto');
const { createWorker } = require('tesseract.js');
const { createClient } = require('@supabase/supabase-js');

const env = (k, def) => {
  const v = process.env[k] ?? def;
  if (v === undefined) throw new Error(`Variável de ambiente ausente: ${k}`);
  return v;
};

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = env('SUPABASE_SERVICE_KEY');
const SESSION_SECRET = env('SESSION_SECRET');
const GOOGLE_CLIENT_ID = env('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = env('GOOGLE_CLIENT_SECRET');
const GOOGLE_REFRESH_TOKEN = env('GOOGLE_REFRESH_TOKEN');
const ROOT_FOLDER = 'Comprovante de pagamentos';
const SESSION_HOURS = 12;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static('public'));

// ---------- Senhas (scrypt, sem dependências extras) ----------
function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function confereSenha(senha, guardado) {
  const [alg, salt, hash] = guardado.split('$');
  if (alg !== 'scrypt') return false;
  const teste = crypto.scryptSync(senha, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === teste.length && crypto.timingSafeEqual(ref, teste);
}

// ---------- Sessão assinada (HMAC) ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function criaToken(usuario) {
  const payload = b64u(JSON.stringify({ uid: usuario.id, papel: usuario.papel, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function leToken(token) {
  const [payload, sig] = (token || '').split('.');
  if (!payload || !sig) return null;
  const ok = crypto.timingSafeEqual(
    Buffer.from(sig),
    Buffer.from(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'))
  );
  if (!ok) return null;
  const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return dados.exp > Date.now() ? dados : null;
}
function autenticado(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const dados = leToken(token);
  if (!dados) return res.status(401).json({ erro: 'Faça login novamente.' });
  req.user = dados;
  next();
}
function somenteAdmin(req, res, next) {
  if (req.user?.papel !== 'admin_master') return res.status(403).json({ erro: 'Apenas o administrador master.' });
  next();
}

// ---------- Administrador master (criado no primeiro início) ----------
async function garanteAdmin() {
  const { data } = await db.from('usuarios').select('id').eq('papel', 'admin_master').limit(1);
  if (data && data.length) return;
  const username = env('ADMIN_USERNAME', '');
  const senha = env('ADMIN_PASSWORD', '');
  if (!username || !senha) {
    console.warn('Nenhum admin_master. Defina ADMIN_USERNAME e ADMIN_PASSWORD no primeiro início.');
    return;
  }
  const { error } = await db.from('usuarios').insert({
    username: username.toLowerCase(), senha_hash: hashSenha(senha), papel: 'admin_master',
  });
  if (error) console.error('Falha ao criar o admin:', error.message);
  else console.log('Admin master criado. Remova ADMIN_PASSWORD do ambiente.');
}

// ---------- Rotas ----------
app.post('/api/login', async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  if (!login || !senha) return res.status(400).json({ erro: 'Informe usuário ou e-mail e senha.' });

  const campo = login.includes('@') ? 'email' : 'username';
  const { data } = await db.from('usuarios').select('*').eq(campo, login).maybeSingle();
  if (!data || !data.ativo || !confereSenha(senha, data.senha_hash)) {
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  }
  res.json({ token: criaToken(data), usuario: { username: data.username, papel: data.papel } });
});

app.get('/api/me', autenticado, (req, res) => res.json({ uid: req.user.uid, papel: req.user.papel }));

app.get('/api/admin/usuarios', autenticado, somenteAdmin, async (_req, res) => {
  const { data, error } = await db.from('usuarios').select('id, username, email, papel, ativo, criado_em').order('criado_em');
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

app.post('/api/admin/usuarios', autenticado, somenteAdmin, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const senha = String(req.body.senha || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ erro: 'Usuário: 3 a 30 letras, números, ponto, traço ou underline.' });
  if (senha.length < 8) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
  const { error } = await db.from('usuarios').insert({ username, email, senha_hash: hashSenha(senha), papel: 'membro' });
  if (error) return res.status(400).json({ erro: error.message.includes('duplicate') ? 'Usuário ou e-mail já existe.' : error.message });
  res.status(201).json({ ok: true });
});

app.patch('/api/admin/usuarios/:id', autenticado, somenteAdmin, async (req, res) => {
  const { data: alvo } = await db.from('usuarios').select('papel').eq('id', req.params.id).maybeSingle();
  if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  if (alvo.papel === 'admin_master') return res.status(400).json({ erro: 'O administrador master não pode ser desativado.' });
  const { error } = await db.from('usuarios').update({ ativo: !!req.body.ativo }).eq('id', req.params.id);
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

// OCR com tesseract.js (roda só com Node, sem instalar nada no sistema). Idioma: português.
let ocrWorker = null;
async function ocr(buffer) {
  if (!ocrWorker) ocrWorker = await createWorker('por');
  const { data } = await ocrWorker.recognize(buffer);
  return data?.text;
}

app.post('/api/scan', autenticado, async (req, res) => {
  try {
    const content = String(req.body.imagem_b64 || '');
    if (!content) return res.status(400).json({ erro: 'Envie a imagem.' });
    const texto = await ocr(Buffer.from(content, 'base64'));
    if (typeof texto !== 'string') throw new Error('o OCR não devolveu texto');
    res.json({ texto });
  } catch (e) {
    console.error('Erro no OCR:', e.message);
    res.status(500).json({ erro: 'OCR: ' + e.message });
  }
});

// Captura erros não tratados das rotas async (Express 4), para devolver JSON em vez de travar.
app.use((err, _req, res, _next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ erro: 'Erro no servidor: ' + (err.message || 'desconhecido') });
});

// Cria as pastas "NOME - SETOR" e envia o PDF da folha em cada uma.
app.post('/api/pastas', autenticado, async (req, res) => {
  const { rows = [], imagem_b64, largura, altura, evento_padrao = '' } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ erro: 'Nenhuma pessoa na lista.' });

  let token;
  try { token = await tokenGoogle(); }
  catch (e) { return res.status(502).json({ erro: 'Falha ao autenticar no Google: ' + e.message }); }

  const drive = driveApi(token);
  const raiz = await drive.achaOuCria(ROOT_FOLDER, null);
  const pdf = imagem_b64 ? montaPdf(Buffer.from(imagem_b64, 'base64'), largura, altura) : null;

  const feitas = [];
  for (const { name, setor } of rows) {
    const nome = `${name} - ${setor || evento_padrao}`;
    const pasta = await drive.achaOuCria(nome, raiz);
    if (pdf) await drive.enviaPdf('Folha escaneada.pdf', pasta, pdf);
    feitas.push(nome);
  }
  res.json({ pastas: feitas.length, pdf: !!pdf });
});

// ---------- Google Drive ----------
async function tokenGoogle() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(data.error_description || data.error || 'sem token');
  return data.access_token;
}

function driveApi(token) {
  const H = { Authorization: 'Bearer ' + token };
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return {
    async achaOuCria(nome, pai) {
      const q = `name = '${esc(nome)}' and mimeType = 'application/vnd.google-apps.folder' and ${pai ? `'${pai}'` : "'root'"} in parents and trashed = false`;
      const achou = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: H }).then((r) => r.json());
      if (achou.files?.length) return achou.files[0].id;
      const body = { name: nome, mimeType: 'application/vnd.google-apps.folder', ...(pai ? { parents: [pai] } : {}) };
      const criada = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then((r) => r.json());
      if (!criada.id) throw new Error(criada.error?.message || 'falha ao criar pasta');
      return criada.id;
    },
    async enviaPdf(nome, pasta, bytes) {
      const q = `name = '${esc(nome)}' and '${pasta}' in parents and trashed = false`;
      const achou = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: H }).then((r) => r.json());
      if (achou.files?.length) return 'já existia';
      const boundary = 'folha' + crypto.randomBytes(8).toString('hex');
      const meta = JSON.stringify({ name: nome, parents: [pasta], mimeType: 'application/pdf' });
      const corpo = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST', headers: { ...H, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: corpo,
      });
      const data = await r.json();
      if (!data.id) throw new Error(data.error?.message || 'falha ao enviar PDF');
      return 'enviado';
    },
  };
}

// PDF mínimo com o JPEG embutido (mesma estrutura do app.js).
function montaPdf(jpeg, w, h) {
  const partes = [];
  const offsets = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? Buffer.from(x, 'latin1') : x; partes.push(b); len += b.length; };
  const obj = (n, corpo) => { offsets[n] = len; push(`${n} 0 obj\n${corpo}\nendobj\n`); };

  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const conteudo = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`);

  const xref = len;
  let x = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  x += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(x);
  return Buffer.concat(partes);
}

const PORT = Number(process.env.PORT || 3000);
garanteAdmin()
  .catch((e) => console.error('Erro ao verificar admin:', e.message))
  .finally(() => app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`)));
