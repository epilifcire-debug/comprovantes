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
- Antes do OCR, a foto é girada, convertida em tons de cinza e recebe contraste, para ficar parecida com um scan. Não há correção de perspectiva. Por isso, fotografe a folha reta e bem iluminada.
- Sempre confira a lista antes de criar as pastas.
