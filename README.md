# Folha → Google Drive (PWA)

Fotografe a folha, leia os nomes com o Google Cloud Vision e crie as pastas no Google Drive:

```
Meu Drive/
└── Comprovante de pagamentos/
    ├── Maria Silva - Show X/
    └── João Souza - Show X/
```

## Como publicar

1. Hospede a pasta em qualquer HTTPS (GitHub Pages, Shard Cloud, Netlify). A câmera e o PWA exigem HTTPS.
2. **Google Cloud Console**
   - Ative as APIs *Google Drive API* e *Cloud Vision API*.
   - Crie um **OAuth Client ID** (tipo "Aplicativo da Web") e adicione a URL do site em *Origens JavaScript autorizadas*.
   - Crie uma **chave de API** e restrinja-a à Cloud Vision API e ao domínio do site.
3. Abra o site no celular, informe o Client ID e a chave em *Configuração*, conecte ao Drive e instale na tela inicial.

## Observações

- Escopo `drive.file`: o app só enxerga pastas que ele mesmo criou. Se "Comprovante de pagamentos" já existir (criada manualmente), o app criará uma segunda pasta com o mesmo nome. Para reaproveitar a existente, é preciso usar o escopo `drive` completo.
- A chave da Vision fica no navegador. Por isso a restrição de domínio é obrigatória. Para mais segurança, o próximo passo é mover a chamada para um backend.
- A pasta de cada pessoa é `NOME - SETOR`, por exemplo `FLAVIO LUIS ROSA BEZERRA - CAMAROTE AJU SEXTA (13/11)`.
- A leitura lê os campos `NOME`, `SETOR` e `EVENTO` de cada recibo. Pessoas repetidas no mesmo setor (vários ingressos) viram uma pasta só. O `EVENTO` só é usado se o setor não for lido.
- Ao criar as pastas, a folha escaneada (tons de cinza, com contraste) é salva como `Folha escaneada.pdf` dentro da pasta de cada pessoa que aparece na lista. A folha inteira vai para cada uma, sem recorte. Se a pasta já tiver esse arquivo, ele não é enviado de novo.
- O scanner acha a página inteira (a folha), não o conteúdo dentro dela. Corrige a perspectiva e aplica filtro preto e branco. Roda no navegador com OpenCV.js (`public/vendor/opencv.js`), sem serviço pago. Se a detecção errar, arraste os cantos.
- Antes do OCR, a foto é girada, convertida em tons de cinza e recebe contraste, para ficar parecida com um scan. Não há correção de perspectiva. Por isso, fotografe a folha reta e bem iluminada.
- Sempre confira a lista antes de criar as pastas.

## Banco de dados (Supabase)

1. No projeto Supabase, abra **SQL Editor**, cole o conteúdo de `supabase/migrations/0001_usuarios.sql` e execute.
2. Não crie o administrador por SQL com senha em texto. O primeiro admin (`admin_master`) será criado pelo script do servidor, que grava o hash da senha.
3. Chaves: use só a **service_role** no servidor, como variável de ambiente no Shard Cloud. Nunca no navegador nem neste repositório.
4. Quando o projeto não for mais necessário, apague-o no Supabase. Os dados de usuários vão junto.

## Servidor (backend)

O OCR usa tesseract.js (pacote npm, em português). Não precisa de chave, de faturamento nem de instalar nada no sistema.

Variáveis de ambiente (configure no Shard Cloud, nunca no repositório):

| Variável | Para que serve |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | Chave `service_role` do Supabase |
| `SESSION_SECRET` | Texto longo e aleatório, para assinar os logins |
| `GOOGLE_CLIENT_ID` | Client ID do OAuth |
| `GOOGLE_CLIENT_SECRET` | Client Secret do OAuth |
| `GOOGLE_REFRESH_TOKEN` | Gerado uma vez pelo script `npm run token` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Só no primeiro início, para criar o admin master. Remova depois. |

Passos:
1. `npm run token` com `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` definidos. Autorize a conta Gmail e guarde o `GOOGLE_REFRESH_TOKEN`.
2. Suba o app no Shard Cloud com o Dockerfile, com as variáveis acima.
3. No primeiro início, o admin é criado. Depois, remova `ADMIN_PASSWORD` do ambiente.
