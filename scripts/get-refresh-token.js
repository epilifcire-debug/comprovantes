// Gera o GOOGLE_REFRESH_TOKEN da conta Gmail que vai receber os arquivos.
// Rode uma vez na sua máquina (ou no Shard Cloud, pelo terminal):
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.js
// Abra o link impresso, entre com a conta Gmail e autorize.
// Copie o refresh_token que aparecer aqui e guarde como variável de ambiente.

const http = require('http');
const { URL } = require('url');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.');
  process.exit(1);
}

const REDIRECT = 'http://localhost:8080/callback';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const link = new URL('https://accounts.google.com/o/oauth2/v2/auth');
link.search = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
}).toString();

console.log('\nAbra este link no navegador e autorize a conta Gmail:\n\n' + link.toString() + '\n');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8080');
  if (url.pathname !== '/callback') { res.end(); return; }
  const code = url.searchParams.get('code');
  if (!code) { res.end('Sem código.'); return; }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT, grant_type: 'authorization_code',
    }),
  });
  const data = await r.json();
  res.end(data.refresh_token ? 'Pronto. Pode fechar esta aba.' : 'Falhou. Veja o terminal.');
  if (data.refresh_token) {
    console.log('GOOGLE_REFRESH_TOKEN=' + data.refresh_token);
  } else {
    console.error('Erro:', data);
  }
  process.exit(0);
}).listen(8080, () => console.log('Aguardando a autorização na porta 8080...'));
