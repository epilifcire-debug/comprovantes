// Scanner de página: encontra a FOLHA (o papel inteiro), não o conteúdo dentro dela,
// corrige a perspectiva e aplica filtro de scanner. Tudo roda no navegador (OpenCV.js).

const MAX_SIDE = 2200;     // px da saída: lê texto pequeno sem pesar o envio
const DETECT_SIDE = 640;   // px usados só para achar as bordas (mais rápido)

let cvPromise = null;

// Carrega o OpenCV.js uma vez, quando for preciso.
function loadOpenCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/opencv.js';
    s.async = true;
    s.onerror = () => reject(new Error('não consegui carregar o scanner (OpenCV)'));
    s.onload = () => {
      const pronto = () => {
        if (window.cv && cv.Mat) return resolve(cv);
        if (window.cv) cv['onRuntimeInitialized'] = () => resolve(cv);
        else setTimeout(pronto, 50);
      };
      pronto();
    };
    document.head.appendChild(s);
  });
  return cvPromise;
}

// Arquivo → canvas, já girado e limitado a MAX_SIDE.
function imageToCanvas(file, angle) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const swap = angle === 90 || angle === 270;
      const w = swap ? img.height : img.width;
      const h = swap ? img.width : img.height;
      const k = Math.min(1, MAX_SIDE / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.drawImage(img, -(img.width * k) / 2, -(img.height * k) / 2, img.width * k, img.height * k);
      resolve(c);
    };
    img.onerror = reject;
    img.src = url;
  });
}

// Ordena os 4 cantos: topo-esquerda, topo-direita, base-direita, base-esquerda.
function ordenaCantos(p) {
  const soma = p.map((q) => q.x + q.y);
  const dif = p.map((q) => q.x - q.y);
  const idx = (arr, fn) => arr.indexOf(fn(arr));
  return [
    p[idx(soma, Math.min)],
    p[idx(dif, Math.max)],
    p[idx(soma, Math.max)],
    p[idx(dif, Math.min)],
  ];
}

// Cantos padrão (um pouco para dentro da imagem), para ajuste manual.
function cantosPadrao(w, h) {
  const mx = w * 0.05, my = h * 0.05;
  return [
    { x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my },
  ];
}

// Acha o maior contorno de 4 lados que ocupe boa parte da imagem = a página.
// Retorna os cantos na escala do canvas de entrada, ou null.
async function detectaPagina(canvas) {
  const cv = await loadOpenCV();
  const k = Math.min(1, DETECT_SIDE / Math.max(canvas.width, canvas.height));
  const src = cv.imread(canvas);
  const small = new cv.Mat();
  cv.resize(src, small, new cv.Size(Math.round(src.cols * k), Math.round(src.rows * k)));
  const gray = new cv.Mat();
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 60, 160);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, kernel);
  const contornos = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(edges, contornos, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const areaImg = small.rows * small.cols;
  let melhor = null, melhorArea = 0;
  for (let i = 0; i < contornos.size(); i++) {
    const c = contornos.get(i);
    const area = cv.contourArea(c);
    if (area > areaImg * 0.2) {
      const peri = cv.arcLength(c, true);
      const aprox = new cv.Mat();
      cv.approxPolyDP(c, aprox, 0.02 * peri, true);
      if (aprox.rows === 4 && cv.isContourConvex(aprox) && area > melhorArea) {
        melhorArea = area;
        melhor = Array.from(aprox.data32S);
      }
      aprox.delete();
    }
    c.delete();
  }

  [src, small, gray, edges, kernel, contornos, hier].forEach((m) => m.delete && m.delete());

  if (!melhor) return null;
  const pontos = [0, 2, 4, 6].map((i) => ({ x: melhor[i] / k, y: melhor[i + 1] / k }));
  return ordenaCantos(pontos);
}

// Corrige a perspectiva usando os 4 cantos e aplica filtro de scanner (preto e branco).
// Retorna { b64, w, h } em JPEG.
async function geraPaginaEscaneada(canvas, cantos) {
  const cv = await loadOpenCV();
  const [tl, tr, br, bl] = cantos;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const largura = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  const altura = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  const k = Math.min(1, MAX_SIDE / Math.max(largura, altura));
  const W = Math.round(largura * k), H = Math.round(altura * k);

  const src = cv.imread(canvas);
  const origem = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const destino = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = cv.getPerspectiveTransform(origem, destino);
  const warp = new cv.Mat();
  cv.warpPerspective(src, warp, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

  const gray = new cv.Mat();
  cv.cvtColor(warp, gray, cv.COLOR_RGBA2GRAY);
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
  const bw = new cv.Mat();
  cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 15);

  const out = document.createElement('canvas');
  cv.imshow(out, bw);
  [src, origem, destino, M, warp, gray, bw].forEach((m) => m.delete && m.delete());

  return { b64: out.toDataURL('image/jpeg', 0.9).split(',')[1], w: out.width, h: out.height, canvas: out };
}
