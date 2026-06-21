import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

const canvas = document.getElementById('c');

// MODO "SÓ CONFIGURAÇÕES": esta mesma página vira a janela dedicada de settings
// (?settings=1) — sem carregar o avatar 3D. Zero duplicação de formulário/lógica.
const SETTINGS_ONLY = new URLSearchParams(location.search).has('settings');
if (SETTINGS_ONLY) document.body.classList.add('settings-only');

// ---------- renderer / cena ----------
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

// ---------- qualidade grafica (presets) ----------
const QUALITY = {
  performance: { pr: 0.7, fps: 30, tex: 256 }, // leve
  balanced: { pr: 1.0, fps: 60, tex: 512 }, // padrao
  quality: { pr: Math.min(window.devicePixelRatio || 1, 2), fps: 60, tex: 1024 }, // bonito
};
let maxFps = 60;
function applyGraphics(q) {
  const p = QUALITY[q] || QUALITY.balanced;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pr));
  renderer.setSize(window.innerWidth, window.innerHeight);
  maxFps = p.fps;
}
applyGraphics('balanced'); // padrao ate carregar a config

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  0.1,
  20
);
camera.position.set(0, 1.25, 2.0);
camera.lookAt(new THREE.Vector3(0, 1.15, 0));

scene.add(new THREE.AmbientLight(0xffffff, 1.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
dirLight.position.set(1, 2, 2);
scene.add(dirLight);

let currentVrm = null;
let placeholder = null;
let talking = false; // true enquanto a I.A. esta digitando a resposta (boca "fake")
let speaking = false; // true enquanto o audio do TTS toca (lip-sync real)
let ttsAnalyser = null; // analisador de amplitude do audio para o lip-sync

// performance: dados amostrados nos eventos (baratos) e processados no loop
let uiReady = false;
let mouseX = 0;
let mouseY = 0;
let lastHoverCheck = 0;
let lastFrameTime = 0;

// ---------- comportamento / vida (olhar, idle, reacoes) ----------
let hoveringBody = false; // mouse esta sobre o corpo dela
let happy = 0; // peso atual da expressao feliz (suavizado)
let reactionT = 0; // timer da reacao de "cutucada"
const REACTION_DUR = 0.5;
const HEAD_YAW_SIGN = 1; // inverter se a cabeca virar pro lado errado
const HEAD_PITCH_SIGN = 1; // inverter se a cabeca subir/descer ao contrario
const HEAD_PITCH_BASE = -0.40; // abaixa a cabeca (negativo = olhar mais pra baixo)
const lookTarget = new THREE.Object3D(); // para onde os olhos miram
scene.add(lookTarget);
const _tmp = new THREE.Vector3();

// ---------- animacoes (.vrma) ----------
let mixer = null;
let idleAction = null;
let gestureActions = [];
let activeGesture = null;
let hasAnim = false; // true se ha animacao .vrma tocando (desliga o idle procedural)
let idleMode = 'procedural'; // 'vrma' | 'unity' | 'procedural'
let unityIdle = null; // idle convertido de um .anim do Unity (experimental)
let sitAction = null; // animacao de sentar (se houver .vrma com "sit"/"squat" no nome)
let isSitting = false;
let animByName = {}; // nome do arquivo -> acao (para o testador de animacoes)
let currentPreview = null; // animacao em pre-visualizacao no testador
let emotionByName = {}; // 'angry'|'sad'|'blush'|'surprised' -> acao da emocao
let currentEmotion = null; // emocao atual (expressao facial)
let emotionT = 0; // timer da expressao de emocao
const EMOTION_DUR = 6; // segundos que a expressao de emocao dura
const EMOTION_EXPR = { happy: 'happy', sad: 'sad', angry: 'angry', surprised: 'surprised', blush: 'relaxed' };
let greetingAction = null; // toca ao abrir o programa
let queuedClip = null; // proxima animacao a tocar quando a atual terminar (encadeamento)
let boredAction = null; // toca quando fica muito tempo sem interacao
// regras de comportamento (tempos em ms, base performance.now())
let lastInteraction = 0;
let nextRandom = 0;
const BORED_MS = 45000; // tempo parado ate ficar "entediada"
const RANDOM_MIN = 16000; // intervalo minimo entre gestos aleatorios
const RANDOM_MAX = 32000;
let lastWantTrue = 0; // histerese do click-through (anti-flicker)
let useHook = false; // (legado) hook global de mouse
let lastOverBody = null; // ultimo estado enviado ao main (cursor sobre o corpo)
let lastCursorMove = 0; // ultima vez que o cursor se moveu (para "captura-quando-parado")

// "sentar na taskbar"
let footPixelY = 0; // posicao vertical dos pes, em pixels da janela
let taskbarTop = Infinity; // topo da barra de tarefas, em pixels de tela
let hasBottomBar = true; // false = painel em cima (Linux/GNOME) → senta na BORDA da tela
const SIT_SNAP_PX = 70; // distancia para "grudar" os pes na taskbar

// "sentar no fundo da tela" (Linux): a janela é tipo "dock" (escapa do clamp do KWin), com a
// base na borda FÍSICA da tela, e o BUMBUM é empurrado p/ a base DENTRO do canvas. As pernas
// ficam abaixo da borda (penduradas p/ fora). NÃO depende de detectar barra (workArea mente).
const IS_LINUX = window.api.platform === 'linux';
let screenBottom = Infinity; // base FÍSICA da tela (px), por monitor
let sitOffsetY = 0; // deslocamento atual do corpo no canvas (world Y, suavizado)
let sitOffsetTarget = 0; // alvo do deslocamento
const SIT_SEAT_LIFT_PX = 0; // folga acima da borda (0 = bumbum encostado na base da tela)

// capsula de colisao (aproxima o corpo) - hover/clique O(1) em vez de raycast na malha
let capsuleBottom = null;
let capsuleTop = null;
let capsuleR2 = 0;

// ---------- helpers ----------
function showHint(text, autoHideMs) {
  let h = document.getElementById('hint');
  if (!h) {
    // o elemento saiu do index.html num redesign — recria pra não derrubar o boot
    h = document.createElement('div');
    h.id = 'hint';
    h.style.cssText =
      'position:fixed;top:46px;left:50%;transform:translateX(-50%);max-width:80%;text-align:center;' +
      'background:rgba(20,20,30,.85);color:#eee;font:12px/1.5 "Segoe UI",sans-serif;padding:8px 14px;' +
      'border-radius:10px;z-index:50;transition:opacity .3s;pointer-events:none;';
    document.body.appendChild(h);
  }
  h.textContent = text;
  h.style.opacity = '1';
  if (autoHideMs) setTimeout(() => (h.style.opacity = '0'), autoHideMs);
}

function addPlaceholder() {
  const geo = new THREE.TorusKnotGeometry(0.25, 0.08, 120, 16);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8ab4ff,
    roughness: 0.3,
    metalness: 0.1,
  });
  placeholder = new THREE.Mesh(geo, mat);
  placeholder.position.set(0, 1.15, 0);
  scene.add(placeholder);
  showHint('Nenhum .vrm encontrado — coloque um arquivo na pasta assets/ e reinicie.');
}

// ---------- pose relaxada (sai do T-pose) ----------
function applyRelaxedPose(vrm) {
  const h = vrm.humanoid;
  if (!h) return;
  const set = (name, z) => {
    const b = h.getNormalizedBoneNode(name);
    if (b) b.rotation.z = z;
  };
  // braços para baixo, junto ao corpo
  set('leftUpperArm', 1.2);
  set('rightUpperArm', -1.2);
  set('leftLowerArm', 0.15);
  set('rightLowerArm', -0.15);
}

// ---------- enquadrar o avatar inteiro ----------
function fitCamera(vrm) {
  vrm.update(0);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (size.y / 2 / Math.tan(fov / 2)) * 1.25; // 1.25 = margem
  camera.position.set(center.x, center.y, center.z + dist);
  camera.near = Math.max(0.01, dist / 100);
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
  camera.lookAt(center);

  // posicao dos pes em pixels (para "sentar na taskbar")
  const foot = new THREE.Vector3(center.x, box.min.y, center.z).project(camera);
  footPixelY = ((1 - foot.y) / 2) * window.innerHeight;

  // capsula vertical aproximando o corpo (para hover/clique baratos)
  capsuleBottom = new THREE.Vector3(center.x, box.min.y, center.z);
  capsuleTop = new THREE.Vector3(center.x, box.max.y, center.z);
  const r = Math.max(size.x, size.z) * 0.5 * 0.6;
  capsuleR2 = r * r;
}

// ---------- otimizacao de texturas (reduz a RAM/VRAM) ----------
// Coleta texturas de um material (inclui as da MToon, que ficam em uniforms)
function collectTextures(material) {
  const out = [];
  const push = (v, key) => {
    if (v && v.isTexture && v.image) out.push([key, v]);
  };
  for (const k in material) push(material[k], k);
  if (material.uniforms) {
    for (const k in material.uniforms) {
      const u = material.uniforms[k];
      if (u) push(u.value, k);
    }
  }
  return out;
}

// Reduz texturas grandes para no maximo `max` px (avatar fica num quadradinho)
function downscaleTextures(root, max) {
  const seen = new Set();
  let count = 0;
  root.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    mats.forEach((m) => {
      collectTextures(m).forEach(([, tex]) => {
        if (seen.has(tex)) return;
        seen.add(tex);
        const img = tex.image;
        const w = img.width || 0;
        const h = img.height || 0;
        if (w > max || h > max) {
          const s = max / Math.max(w, h);
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w * s));
          cv.height = Math.max(1, Math.round(h * s));
          try {
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            tex.image = cv;
            tex.needsUpdate = true;
            count++;
          } catch (e) {
            /* texturas comprimidas nao desenham -> ignora */
          }
        }
      });
    });
  });
  return count;
}

// ---------- carregar VRM ----------
async function loadVrm() {
  const vrmUrl = await window.api.getVrmPath();
  if (!vrmUrl) {
    addPlaceholder();
    return;
  }

  // limite de textura conforme o preset de qualidade
  const cfg = await window.api.getConfig();
  const texCap = (QUALITY[cfg.gfxQuality] || QUALITY.balanced).tex;

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  loader.load(
    vrmUrl,
    (gltf) => {
      const vrm = gltf.userData.vrm;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      try {
        VRMUtils.combineSkeletons(gltf.scene);
      } catch (e) {
        /* ignora se a versao nao tiver esse util */
      }
      // VRM normalmente vem de costas para a camera; gira para nos encarar
      vrm.scene.rotation.y = Math.PI;
      scene.add(vrm.scene);
      currentVrm = vrm;

      const reduced = downscaleTextures(vrm.scene, texCap); // economiza VRAM
      console.log(`Texturas reduzidas para <=${texCap}px: ${reduced}`);

      applyRelaxedPose(vrm); // tira do T-pose (caso nao haja animacao)
      fitCamera(vrm); // enquadra o corpo inteiro automaticamente
      window.api.setFootPixel(footPixelY); // p/ o main saber onde "sentar" na taskbar
      if (vrm.lookAt) vrm.lookAt.target = lookTarget; // olhos seguem o cursor
      loadAnimations(vrm); // carrega .vrma da pasta animations/ (se houver)
      showHint(
        'Arraste a avatar para mover  •  Ctrl+Shift+C: atravessar cliques  •  Ctrl+Shift+Q: sair',
        7000
      );
    },
    undefined,
    (err) => {
      console.error('Erro ao carregar o VRM:', err);
      showHint('Erro ao carregar o .vrm (veja o console).');
      addPlaceholder();
    }
  );
}
if (!SETTINGS_ONLY) loadVrm(); // a janela de configurações não precisa do 3D

// ---------- piscar ----------
let nextBlink = 1 + Math.random() * 4;
let blinkT = -1;
const BLINK_DUR = 0.12;
function updateBlink(dt) {
  if (!currentVrm || !currentVrm.expressionManager) return;
  if (blinkT >= 0) {
    blinkT += dt;
    const half = BLINK_DUR / 2;
    const v = blinkT < half ? blinkT / half : 1 - (blinkT - half) / half;
    currentVrm.expressionManager.setValue('blink', Math.max(0, Math.min(1, v)));
    if (blinkT >= BLINK_DUR) {
      blinkT = -1;
      currentVrm.expressionManager.setValue('blink', 0);
    }
  } else {
    nextBlink -= dt;
    if (nextBlink <= 0) {
      blinkT = 0;
      nextBlink = 2 + Math.random() * 4;
    }
  }
}

// ---------- animacoes (.vrma) ----------
// Faz transicao suave de uma acao para outra
function fadeTo(from, to, dur) {
  to.enabled = true;
  to.reset();
  to.setEffectiveWeight(1);
  to.play();
  if (from && from !== to) from.crossFadeTo(to, dur, false);
}

async function loadAnimations(vrm) {
  const list = await window.api.getVrmaPaths(); // [{ name, url }]
  if (!list || !list.length) return; // sem animacoes -> mantem o comportamento procedural

  mixer = new THREE.AnimationMixer(vrm.scene);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const loaded = [];
  for (const item of list) {
    try {
      const gltf = await loader.loadAsync(item.url);
      const va = gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0];
      if (!va) continue;
      const clip = createVRMAnimationClip(va, vrm);
      loaded.push({ name: item.name, action: mixer.clipAction(clip), emotion: item.emotion });
    } catch (e) {
      console.error('Erro ao carregar animacao', item.name, e);
    }
  }
  if (!loaded.length) return;

  // Categoriza por palavra-chave no nome do arquivo:
  //  idle -> loop base | greeting/hello/wave -> ao abrir | bored/sleep -> entediada
  //  sit/squat -> sentar | o resto -> pool de gestos aleatorios (+ ao cutucar)
  // emocoes (pasta emotions/) ficam fora do pool; sao disparadas pelo humor
  emotionByName = {};
  loaded
    .filter((a) => a.emotion)
    .forEach((a) => (emotionByName[a.name.replace(/\.vrma$/i, '').toLowerCase()] = a.action));

  const pool = loaded.filter((a) => !a.emotion);
  const find = (re) => pool.find((a) => re.test(a.name));
  // idle: "waiting" tem prioridade sobre a antiga "idle"
  const idleEntry = find(/waiting/i) || find(/idle/i) || pool[0];
  const appearEntry = find(/appear|entrance|entrada/i); // animacao de ENTRADA (ao abrir)
  const greetEntry = find(/greet|hello|wave|intro|saudac|hi_|_hi/i);
  const boredEntry = find(/bored|sleep|tedio|entediad|yawn|relax/i);
  const sitEntry = find(/sit|squat|seiza/i);

  greetingAction = greetEntry ? greetEntry.action : null;
  boredAction = boredEntry ? boredEntry.action : null;
  sitAction = sitEntry ? sitEntry.action : null;

  const special = new Set([idleEntry, appearEntry, greetEntry, boredEntry, sitEntry].filter(Boolean));
  // tira do pool de aleatorias: as especiais E sobras com nome de idle/waiting (idle antiga nao usada)
  gestureActions = pool
    .filter((a) => !special.has(a) && !/idle|waiting/i.test(a.name))
    .map((a) => a.action);

  // IDLE: tenta o .anim do Unity convertido (experimental); senao usa o idle.vrma
  const uni = await window.api.getUnityIdle();
  if (uni && uni.text) {
    try {
      const parsed = parseUnityAnim(uni.text);
      if (parsed && parsed.curves.length) unityIdle = parsed;
    } catch (e) {
      console.error('Falha ao converter .anim do Unity:', e);
    }
  }
  if (unityIdle) {
    idleMode = 'unity';
    idleAction = null; // idle aplicado direto nos ossos (sem mixer)
    console.log(`Idle do Unity convertido: ${unityIdle.curves.length} curvas, ${unityIdle.duration.toFixed(1)}s`);
  } else if (idleEntry) {
    idleMode = 'vrma';
    idleAction = idleEntry.action;
    idleAction.play();
  } else {
    idleMode = 'procedural';
    idleAction = null;
  }
  hasAnim = true;

  animByName = {};
  loaded.forEach((a) => (animByName[a.name] = a.action)); // para o testador

  // ao terminar um gesto: encadeia a proxima (se houver) ou volta para o idle
  mixer.addEventListener('finished', (e) => {
    if (activeGesture && e.action === activeGesture) {
      const next = queuedClip;
      queuedClip = null;
      activeGesture = null;
      if (next) {
        playClipFrom(e.action, next); // encadeia (ex.: entrada -> saudacao)
      } else if (idleAction) {
        fadeTo(e.action, idleAction, 0.4);
      } else {
        e.action.stop(); // idle unity/procedural -> base reassume
      }
    }
  });

  // arma os timers e toca a abertura: entrada (appearing) e, logo apos, a saudacao
  lastInteraction = performance.now();
  nextRandom = performance.now() + RANDOM_MIN;
  if (appearEntry) {
    queuedClip = greetingAction; // saudacao toca logo apos a entrada terminar
    playClip(appearEntry.action);
  } else if (greetingAction) {
    playClip(greetingAction);
  }
}

// toca uma animacao uma vez (LoopOnce), partindo de "fromAction", e volta ao idle ao terminar
function playClipFrom(fromAction, action) {
  if (!mixer || !action) return;
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  activeGesture = action;
  fadeTo(fromAction || idleAction, action, 0.3);
}
// toca uma animacao uma vez (LoopOnce) e volta ao idle ao terminar
function playClip(action) {
  if (!mixer || !action || activeGesture || isSitting) return;
  playClipFrom(idleAction, action);
}

// toca um gesto aleatorio do pool (ao cutucar)
function playGesture() {
  if (!gestureActions.length) return;
  playClip(gestureActions[Math.floor(Math.random() * gestureActions.length)]);
}

// marca que houve interacao (reseta o timer de "entediada")
function touchInteraction() {
  lastInteraction = performance.now();
}

// Detecta o "humor" de uma resposta (heuristica: emojis + palavras pt/en)
function detectEmotion(text) {
  if (/[\u{1F620}\u{1F621}\u{1F624}\u{1F92C}]/u.test(text)) return 'angry';
  if (/[\u{1F622}\u{1F62D}\u{1F614}\u{1F61E}\u{1F494}]/u.test(text)) return 'sad';
  if (/[\u{1F633}\u{1F975}\u{1F60A}\u{1F60D}\u{1F970}]/u.test(text)) return 'blush';
  if (/[\u{1F632}\u{1F62E}\u{1F628}\u{1F631}]/u.test(text)) return 'surprised';
  if (/[\u{1F600}-\u{1F603}\u{1F604}\u{1F606}\u{1F60E}\u{1F923}\u{1F389}\u{2728}]/u.test(text)) return 'happy';
  const t = text.toLowerCase();
  if (/\b(raiva|irritad|idiota|odeio|angry|annoyed|mad)\b/.test(t)) return 'angry';
  if (/\b(desculpa|triste|sinto muito|que pena|infelizmente|sorry|sad|unfortunately)\b/.test(t)) return 'sad';
  if (/\b(haha|kk+|adorei|que ([ck])hique|incr[ií]vel|maravilh|feliz|amei|amo|love|awesome|great)\b/.test(t)) return 'happy';
  if (/\b(uau|nossa|s[eé]rio|caramba|wow|really|surpres|inacredit)\b/.test(t)) return 'surprised';
  if (/\b(fofo|t[ií]mid|vergonha|blush|obrigad)\b/.test(t)) return 'blush';
  return null;
}

// Dispara a emocao: expressao facial (decai) + animacao da emocao (se houver)
function triggerEmotion(name) {
  if (!name) return;
  currentEmotion = name;
  emotionT = EMOTION_DUR;
  if (emotionByName[name]) playClip(emotionByName[name]); // animacao da emocao
}

// testador: toca uma animacao especifica (por nome do arquivo) em loop
function previewAnim(name) {
  const a = animByName[name];
  if (!a || !mixer) return;
  a.setLoop(THREE.LoopRepeat, Infinity);
  a.clampWhenFinished = false;
  activeGesture = null;
  isSitting = false;
  fadeTo(currentPreview || idleAction, a, 0.3);
  currentPreview = a;
}

function stopPreview() {
  if (currentPreview) {
    if (idleAction) fadeTo(currentPreview, idleAction, 0.3);
    else currentPreview.fadeOut(0.3); // idle unity/procedural -> base reassume
    currentPreview = null;
  }
}

// ponto mais BAIXO do corpo POSADO, em pixels (sentada, o contato vira o quadril/pés
// da pose ATUAL — não os pés da pose em pé do bounding box, que causavam o "flutuar")
const _boneV = new THREE.Vector3();
function lowestBodyPixelY() {
  if (!currentVrm || !currentVrm.humanoid) return footPixelY;
  let maxY = 0;
  for (const b of ['hips', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes', 'leftLowerLeg', 'rightLowerLeg']) {
    const node = currentVrm.humanoid.getNormalizedBoneNode(b);
    if (!node) continue;
    node.getWorldPosition(_boneV).project(camera);
    const py = ((1 - _boneV.y) / 2) * window.innerHeight;
    if (py > maxY) maxY = py;
  }
  return maxY || footPixelY;
}

// ponto de ASSENTO: o bumbum (um pouco abaixo da junta do quadril) — é ele que toca a
// taskbar; as pernas ficam penduradas NA FRENTE da barra (janela fica acima dela)
function sitContactPixelY() {
  if (!currentVrm || !currentVrm.humanoid) return footPixelY;
  const hips = currentVrm.humanoid.getNormalizedBoneNode('hips');
  if (!hips) return lowestBodyPixelY();
  hips.getWorldPosition(_boneV).project(camera);
  const hipPx = ((1 - _boneV.y) / 2) * window.innerHeight;
  // o assento fica ~10% da altura do corpo abaixo da junta do quadril
  let bodyH = 0;
  if (capsuleTop && capsuleBottom) {
    const a = capsuleTop.clone().project(camera);
    const b = capsuleBottom.clone().project(camera);
    bodyH = Math.abs(((1 - b.y) / 2) * window.innerHeight - ((1 - a.y) / 2) * window.innerHeight);
  }
  return hipPx + (bodyH ? bodyH * 0.1 : 30);
}

// (Linux) empurra o corpo p/ baixo DENTRO do canvas até o BUMBUM (quadril + ~10%) encostar na
// base FÍSICA da tela → senta no fundo, pernas penduradas p/ fora da borda. Roda a CADA frame
// (sem IPC) → trava o assento sem "voar", mesmo com o bobbing da animação de sentar.
const _projA = new THREE.Vector3();
const _projB = new THREE.Vector3();
function anchorSitToCanvas() {
  if (!isSitting || !currentVrm) return;
  const z = capsuleBottom ? capsuleBottom.z : 0;
  // amostra a escala world↔px na profundidade do corpo (perspectiva)
  const aPx = ((1 - _projA.set(0, 0, z).project(camera).y) / 2) * window.innerHeight;
  const bPx = ((1 - _projB.set(0, 1, z).project(camera).y) / 2) * window.innerHeight;
  const denom = bPx - aPx; // < 0: +world Y sobe na tela. worldPerPx = 1/denom
  if (!denom) return;
  const seatPx = sitContactPixelY(); // BUMBUM atual (já reflete o offset deste frame)
  const targetPx = window.innerHeight - SIT_SEAT_LIFT_PX; // base FÍSICA da tela
  sitOffsetTarget = sitOffsetY + (targetPx - seatPx) / denom; // (targetPx-seatPx)*worldPerPx
  sitOffsetY += (sitOffsetTarget - sitOffsetY) * 0.25; // suaviza (sem "pulo")
}

// re-cola o corpo na base da tela usando a pose REAL (corrige o sentar flutuando)
let sitSnapTimer = null;
async function resnapToTaskbar() {
  if (!isSitting || !currentVrm) return;
  try {
    const w = await window.api.getWorkArea(); // fresco: monitor certo + painel atual
    if (w) {
      taskbarTop = w.taskbarTop;
      screenBottom = w.screenBottom != null ? w.screenBottom : w.taskbarTop;
      hasBottomBar = w.hasBottomBar !== false;
    }
  } catch (e) {
    /* mantém o cacheado */
  }
  // LINUX: a janela fica 100% on-screen (base = base FÍSICA da tela). NÃO movemos a janela p/
  // fora (o WM trava → "voa"); o bumbum é ancorado no canvas a cada frame (anchorSitToCanvas).
  if (IS_LINUX) {
    if (screenBottom === Infinity) return;
    const b = await window.api.getWindowBounds(); // [x,y,w,h] em DIPs
    winX = b[0];
    const targetY = Math.round(screenBottom - b[3]);
    if (Math.abs(targetY - b[1]) > 2) {
      winY = targetY;
      window.api.setWindowPos(winX, winY);
    } else {
      winY = b[1];
    }
    return;
  }
  if (taskbarTop === Infinity) return;
  // COM barra embaixo: bumbum na barra, pernas penduradas na frente dela.
  // SEM barra (painel em cima): os PÉS tocam a borda — corpo inteiro visível.
  const seat = hasBottomBar ? sitContactPixelY() : lowestBodyPixelY();
  if (!seat) return;
  const b = await window.api.getWindowBounds(); // [x,y,w,h] em DIPs (o main pode ter movido a janela)
  winX = b[0];
  winY = b[1];
  // escala DIP↔pixel CSS (Linux com scaling fracionário diverge; no Windows costuma ser 1)
  const scale = window.innerHeight ? b[3] / window.innerHeight : 1;
  const targetY = Math.round(taskbarTop - seat * scale);
  if (Math.abs(targetY - winY) > 2) {
    winY = targetY;
    window.api.setWindowPos(winX, winY);
  }
}

// (Linux) coloca a janela 100% on-screen com a base na base FÍSICA da tela e senta
async function sitToScreenBottom() {
  if (screenBottom === Infinity) return;
  const b = await window.api.getWindowBounds(); // [x,y,w,h] em DIPs
  winX = b[0];
  winY = Math.round(screenBottom - b[3]);
  window.api.setWindowPos(winX, winY);
  startSitting(); // anchorSitToCanvas() empurra o bumbum p/ a base, a cada frame
}

// senta (na taskbar): toca a animacao de sentar em loop, se houver
function startSitting() {
  if (isSitting) return;
  isSitting = true;
  if (activeGesture) {
    activeGesture.stop(); // cancela gesto em andamento (evita mistura de animacao)
    activeGesture = null;
  }
  if (sitAction) {
    sitAction.reset();
    sitAction.setLoop(THREE.LoopRepeat, Infinity);
    sitAction.clampWhenFinished = false;
    sitAction.setEffectiveWeight(1);
    sitAction.fadeIn(0.3);
    sitAction.play();
    if (idleAction) idleAction.fadeOut(0.3); // tira o idle de baixo (sem mistura)
  }
  // a animação leva ~0.3s pra assentar: re-cola algumas vezes e depois mantém colada
  clearInterval(sitSnapTimer);
  setTimeout(resnapToTaskbar, 450);
  setTimeout(resnapToTaskbar, 900);
  sitSnapTimer = setInterval(resnapToTaskbar, 1500);
}

function stopSitting() {
  if (!isSitting) return;
  isSitting = false;
  clearInterval(sitSnapTimer);
  sitSnapTimer = null;
  if (sitAction) sitAction.fadeOut(0.3);
  if (idleAction) {
    idleAction.reset();
    idleAction.fadeIn(0.3);
    idleAction.play();
  }
}

// ====================================================================
//  Conversor experimental: idle .anim (musculos do Unity) -> ossos VRM
//  Aplica SO no tronco/pescoco/ombros (confiavel). Bracos/pernas ficam
//  na pose relaxada. Pes (IK) sao ignorados.
// ====================================================================
// musculo do Unity -> { osso, eixo, amplitude(graus), sinal, modo }
//  abs = posicao absoluta (repouso 0) | add = repouso relaxado + delta do movimento
const MUSCLE_MAP = {
  'Spine Front-Back': { bone: 'spine', axis: 'x', range: 40, sign: 1, mode: 'abs' },
  'Spine Left-Right': { bone: 'spine', axis: 'z', range: 40, sign: 1, mode: 'abs' },
  'Spine Twist Left-Right': { bone: 'spine', axis: 'y', range: 40, sign: 1, mode: 'abs' },
  'Chest Front-Back': { bone: 'chest', axis: 'x', range: 30, sign: 1, mode: 'abs' },
  'Chest Left-Right': { bone: 'chest', axis: 'z', range: 30, sign: 1, mode: 'abs' },
  'Chest Twist Left-Right': { bone: 'chest', axis: 'y', range: 30, sign: 1, mode: 'abs' },
  'UpperChest Front-Back': { bone: 'upperChest', axis: 'x', range: 20, sign: 1, mode: 'abs' },
  'UpperChest Left-Right': { bone: 'upperChest', axis: 'z', range: 20, sign: 1, mode: 'abs' },
  'UpperChest Twist Left-Right': { bone: 'upperChest', axis: 'y', range: 20, sign: 1, mode: 'abs' },
  'Neck Nod Down-Up': { bone: 'neck', axis: 'x', range: 30, sign: 1, mode: 'abs' },
  'Neck Turn Left-Right': { bone: 'neck', axis: 'y', range: 30, sign: 1, mode: 'abs' },
  'Neck Tilt Left-Right': { bone: 'neck', axis: 'z', range: 30, sign: 1, mode: 'abs' },
  // bracos: aditivo (mantem baixados + adiciona o balanco do clip)
  'Left Arm Down-Up': { bone: 'leftUpperArm', axis: 'z', range: 60, sign: 1, mode: 'add' },
  'Left Arm Front-Back': { bone: 'leftUpperArm', axis: 'y', range: 60, sign: 1, mode: 'add' },
  'Right Arm Down-Up': { bone: 'rightUpperArm', axis: 'z', range: 60, sign: -1, mode: 'add' },
  'Right Arm Front-Back': { bone: 'rightUpperArm', axis: 'y', range: 60, sign: 1, mode: 'add' },
  'Left Forearm Stretch': { bone: 'leftLowerArm', axis: 'y', range: 60, sign: 1, mode: 'add' },
  'Right Forearm Stretch': { bone: 'rightLowerArm', axis: 'y', range: 60, sign: -1, mode: 'add' },
};
// pose de repouso dos bracos (modo add parte daqui)
const REST = {
  leftUpperArm: { x: 0, y: 0, z: 1.2 },
  rightUpperArm: { x: 0, y: 0, z: -1.2 },
  leftLowerArm: { x: 0, y: 0, z: 0.15 },
  rightLowerArm: { x: 0, y: 0, z: -0.15 },
};
const IDLE_BONES = ['spine', 'chest', 'upperChest', 'neck', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
const ZERO = { x: 0, y: 0, z: 0 };

function parseUnityAnim(text) {
  let start = text.indexOf('m_FloatCurves:');
  if (start < 0) return null;
  let end = text.indexOf('m_PPtrCurves:');
  if (end < 0) end = text.indexOf('m_EditorCurves:');
  if (end < 0) end = text.length;
  const lines = text.slice(start, end).split('\n');
  const curves = [];
  let times = [];
  let values = [];
  for (const line of lines) {
    const mt = line.match(/^\s*-?\s*time:\s*([-\d.eE]+)/);
    const mv = line.match(/^\s*value:\s*([-\d.eE]+)/);
    const ma = line.match(/^\s*attribute:\s*(.+?)\s*$/);
    if (mt) times.push(parseFloat(mt[1]));
    else if (mv) values.push(parseFloat(mv[1]));
    else if (ma) {
      const map = MUSCLE_MAP[ma[1]];
      if (map && times.length) {
        curves.push({ ...map, times, values, v0: values[0] });
      }
      times = [];
      values = [];
    }
  }
  let duration = 0;
  curves.forEach((c) => (duration = Math.max(duration, c.times[c.times.length - 1] || 0)));
  return { duration: duration || 2, curves };
}

function sampleCurve(c, time) {
  const ts = c.times;
  const vs = c.values;
  if (time <= ts[0]) return vs[0];
  if (time >= ts[ts.length - 1]) return vs[vs.length - 1];
  for (let i = 1; i < ts.length; i++) {
    if (time <= ts[i]) {
      const f = (time - ts[i - 1]) / (ts[i] - ts[i - 1] || 1);
      return vs[i - 1] + (vs[i] - vs[i - 1]) * f;
    }
  }
  return vs[vs.length - 1];
}

const DEG = Math.PI / 180;
function lerpToRest(name) {
  const b = currentVrm.humanoid.getNormalizedBoneNode(name);
  if (!b) return;
  b.rotation.x += (0 - b.rotation.x) * 0.12;
  b.rotation.y += (0 - b.rotation.y) * 0.12;
  b.rotation.z += (0 - b.rotation.z) * 0.12;
}

function applyUnityIdle(t) {
  if (!currentVrm || !currentVrm.humanoid || !unityIdle) return;
  const time = unityIdle.duration > 0 ? t % unityIdle.duration : 0;

  // acumula os angulos (abs = absoluto, add = delta a partir do frame 0)
  const acc = {};
  for (const c of unityIdle.curves) {
    const s = sampleCurve(c, time);
    const val = (c.mode === 'add' ? s - c.v0 : s) * c.range * DEG * c.sign;
    (acc[c.bone] = acc[c.bone] || { x: 0, y: 0, z: 0 })[c.axis] += val;
  }

  // alvo = repouso + acumulado; aproxima suave (sem trancos pos-gesto)
  for (const bone of IDLE_BONES) {
    const node = currentVrm.humanoid.getNormalizedBoneNode(bone);
    if (!node) continue;
    const rest = REST[bone] || ZERO;
    const a = acc[bone] || ZERO;
    const k = bone.indexOf('Arm') >= 0 ? 0.2 : 0.35;
    node.rotation.x += (rest.x + a.x - node.rotation.x) * k;
    node.rotation.y += (rest.y + a.y - node.rotation.y) * k;
    node.rotation.z += (rest.z + a.z - node.rotation.z) * k;
  }
  // pernas voltam ao repouso (apos gestos)
  ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'].forEach(lerpToRest);
}

// ---------- comportamento: olhar, idle, reacoes ----------
function setExpr(name, v) {
  const em = currentVrm && currentVrm.expressionManager;
  if (em) {
    try {
      em.setValue(name, v);
    } catch (e) {
      /* expressao nao existe nesse modelo -> ignora */
    }
  }
}

function updateLookAt() {
  if (!currentVrm) return;
  const lx = (mouseX / window.innerWidth) * 2 - 1;
  const ly = -(mouseY / window.innerHeight) * 2 + 1;
  // posiciona o alvo dos olhos no mundo, na direcao do cursor (com leve vies p/ baixo)
  _tmp.set(lx, ly, 0.5).unproject(camera);
  _tmp.y -= 0.1; // olhos olham um pouco mais para baixo
  lookTarget.position.lerp(_tmp, 0.25);
  // a cabeca tambem acompanha um pouco (suavizado)
  const head = currentVrm.humanoid && currentVrm.humanoid.getNormalizedBoneNode('head');
  if (head) {
    const yaw = THREE.MathUtils.clamp(lx, -1, 1) * 0.5 * HEAD_YAW_SIGN;
    const pitch = THREE.MathUtils.clamp(ly, -1, 1) * 0.3 * HEAD_PITCH_SIGN + HEAD_PITCH_BASE;
    head.rotation.y += (yaw - head.rotation.y) * 0.12;
    head.rotation.x += (pitch - head.rotation.x) * 0.12;
  }
}

function updateIdle(t) {
  if (!currentVrm || !currentVrm.humanoid) return;
  const spine = currentVrm.humanoid.getNormalizedBoneNode('spine');
  if (spine) {
    spine.rotation.z = Math.sin(t * 0.7) * 0.02; // balanco lateral sutil
    spine.rotation.x = Math.sin(t * 0.9) * 0.012; // leve para frente/tras
  }
}

function updateReactions(dt) {
  const targetHappy = hoveringBody ? 0.55 : 0; // sorri quando passa o mouse
  happy += (targetHappy - happy) * 0.1;
  setExpr('happy', happy);
  if (reactionT > 0) {
    reactionT -= dt;
    setExpr('surprised', Math.max(0, reactionT / REACTION_DUR)); // carinha de cutucada
  }
  // expressao da emocao detectada na resposta (mantem forte e decai no fim)
  if (emotionT > 0 && currentEmotion) {
    emotionT -= dt;
    const expr = EMOTION_EXPR[currentEmotion];
    if (expr) setExpr(expr, Math.min(0.85, emotionT / 1.5));
    if (emotionT <= 0) currentEmotion = null;
  }
}

// ---------- arrastar a janela pelo avatar ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// Teste barato O(1): o cursor (nx,ny em NDC) acerta a capsula do corpo?
// Substitui o raycast na malha inteira (que travava sobre o cabelo denso).
const _capB = new THREE.Vector3();
const _capT = new THREE.Vector3();
function hitsAvatar(nx, ny) {
  if (!capsuleTop) return false;
  ndc.x = nx;
  ndc.y = ny;
  raycaster.setFromCamera(ndc, camera);
  // o corpo pode estar empurrado p/ baixo no canvas (sentado) → desloca a cápsula junto
  const dy = currentVrm ? currentVrm.scene.position.y : 0;
  _capB.copy(capsuleBottom);
  _capB.y += dy;
  _capT.copy(capsuleTop);
  _capT.y += dy;
  return raycaster.ray.distanceSqToSegment(_capB, _capT) <= capsuleR2;
}
let dragging = false;
let startSX = 0;
let startSY = 0;
let startWX = 0;
let startWY = 0;
let dragPending = false;
let dragTargetX = 0;
let dragTargetY = 0;
let winX = 0; // posicao da janela rastreada localmente (evita await no arrasto)
let winY = 0;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // so o botao esquerdo arrasta (direito = menu)
  const nx = (e.clientX / window.innerWidth) * 2 - 1;
  const ny = -(e.clientY / window.innerHeight) * 2 + 1;
  if (hitsAvatar(nx, ny)) {
    dragging = true;
    touchInteraction();
    stopSitting(); // se estava sentada, levanta ao ser agarrada
    reactionT = REACTION_DUR; // reage ao ser "cutucada"/agarrada
    playGesture(); // se houver gestos .vrma, toca um
    startSX = e.screenX;
    startSY = e.screenY;
    startWX = winX; // usa a posicao ja conhecida (sem await -> sem salto)
    startWY = winY;
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  // so guarda o alvo; o reposicionamento real acontece 1x por frame no loop
  dragTargetX = startWX + (e.screenX - startSX);
  dragTargetY = startWY + (e.screenY - startSY);
  dragPending = true;
});

canvas.addEventListener('pointerup', async () => {
  if (!dragging) return;
  dragging = false;

  // área fresca (monitor onde ela está agora + mudanças de painel)
  try {
    const w = await window.api.getWorkArea();
    if (w) {
      taskbarTop = w.taskbarTop;
      screenBottom = w.screenBottom != null ? w.screenBottom : w.taskbarTop;
      hasBottomBar = w.hasBottomBar !== false;
    }
  } catch (e) {
    /* usa o cacheado */
  }
  // se soltou com os pes perto/abaixo da base, "senta" nela
  if (currentVrm) {
    if (IS_LINUX) {
      // Linux: senta na BASE FÍSICA da tela (janela on-screen; o bumbum desce no canvas)
      if (screenBottom !== Infinity && winY + footPixelY > screenBottom - SIT_SNAP_PX) {
        await sitToScreenBottom();
      }
    } else if (taskbarTop !== Infinity) {
      const footScreenY = winY + footPixelY;
      if (footScreenY > taskbarTop - SIT_SNAP_PX) {
        winY = Math.round(taskbarTop - footPixelY);
        window.api.setWindowPos(winX, winY);
        startSitting();
        setTimeout(resnapToTaskbar, 80); // corrige logo pro assento real (quadril)
      }
    }
  }

  // re-sincroniza com a posicao real (corrige arredondamentos), sem travar
  window.api.getWindowPos().then((p) => {
    winX = p[0];
    winY = p[1];
  });
});

// clique direito sobre o avatar abre o menu de contexto nativo
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const nx = (e.clientX / window.innerWidth) * 2 - 1;
  const ny = -(e.clientY / window.innerHeight) * 2 + 1;
  if (hitsAvatar(nx, ny)) window.api.showContextMenu();
});

// ---------- resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // recalcula a posição dos pés (o resize do avatar muda tudo em pixels)
  if (capsuleBottom) {
    const f = capsuleBottom.clone().project(camera);
    footPixelY = ((1 - f.y) / 2) * window.innerHeight;
    window.api.setFootPixel(footPixelY);
  }
  if (isSitting) setTimeout(resnapToTaskbar, 150); // sentada? re-cola na taskbar
});

// ---------- loop ----------
const clock = new THREE.Clock();
function animate(now) {
  requestAnimationFrame(animate);
  now = now || 0;

  // limite de FPS dinamico: 60 (preset) durante gesto/fala/arrasto; 30 no idle.
  // No idle render mais leve = cursor do Windows menos travado sobre a janela.
  const busy = activeGesture || speaking || isSitting || currentPreview;
  const targetFps = busy ? maxFps : Math.min(maxFps, 30);
  if (targetFps && now - lastFrameTime < 1000 / targetFps - 1) return;
  lastFrameTime = now;

  // reposiciona a janela no maximo 1x por frame (coalesce os eventos do mouse)
  if (dragging && dragPending) {
    window.api.setWindowPos(dragTargetX, dragTargetY);
    winX = dragTargetX; // mantem o rastreamento local em dia
    winY = dragTargetY;
    dragPending = false;
  }

  // click-through inteligente: ~25x/seg (mais responsivo) e nunca durante o arrasto
  if (uiReady && !dragging && now - lastHoverCheck > 40) {
    lastHoverCheck = now;
    reportHover(mouseX, mouseY);
  }

  // regras de comportamento: gestos aleatorios e "entediada"
  if (mixer && !activeGesture && !isSitting && !dragging) {
    if (gestureActions.length && now > nextRandom) {
      playGesture();
      nextRandom = now + RANDOM_MIN + Math.random() * (RANDOM_MAX - RANDOM_MIN);
    } else if (boredAction && now - lastInteraction > BORED_MS) {
      playClip(boredAction); // ficou muito tempo parada -> entediada
      lastInteraction = now; // re-arma
    }
  }

  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  if (currentVrm) {
    if (mixer) mixer.update(dt); // toca animacoes de mixer (gestos, sit, idle.vrma)
    // (Linux) sentada: empurra o bumbum p/ a base da tela; ao levantar, volta suave a 0
    if (isSitting && IS_LINUX) anchorSitToCanvas();
    else if (sitOffsetY) {
      sitOffsetY += (0 - sitOffsetY) * 0.25;
      if (Math.abs(sitOffsetY) < 1e-4) sitOffsetY = 0;
    }
    currentVrm.scene.position.y = Math.sin(t * 1.4) * 0.005 + sitOffsetY; // respirar (+ assento)
    // idle base direto nos ossos (so quando nao ha gesto/sentada/preview ativos)
    if (!activeGesture && !isSitting && !currentPreview) {
      if (idleMode === 'unity') applyUnityIdle(t);
      else if (idleMode === 'procedural') updateIdle(t);
    }
    updateLookAt(); // cabeca/olhos seguem o cursor (por cima do idle)
    updateReactions(dt); // sorriso ao passar o mouse / surpresa ao cutucar
    updateBlink(dt);
    if (currentVrm.expressionManager) {
      let mouth = 0;
      if (speaking && ttsAnalyser) {
        // lip-sync real: amplitude do audio do TTS controla a boca
        const arr = new Uint8Array(ttsAnalyser.fftSize);
        ttsAnalyser.getByteTimeDomainData(arr);
        let sum = 0;
        for (let i = 0; i < arr.length; i++) {
          const v = (arr[i] - 128) / 128;
          sum += v * v;
        }
        mouth = Math.min(1, Math.sqrt(sum / arr.length) * 3.5);
      } else if (talking) {
        // sem voz: movimento simples enquanto digita a resposta
        mouth = Math.sin(t * 18) * 0.35 + 0.4;
      }
      currentVrm.expressionManager.setValue('aa', Math.max(0, Math.min(1, mouth)));
    }
    currentVrm.update(dt);
  } else if (placeholder) {
    placeholder.rotation.y += dt * 0.8;
    placeholder.rotation.x += dt * 0.3;
  }

  renderer.render(scene, camera);
}
animate();

// ============================================================
//  Interface: chat + configuracoes
// ============================================================
const bubble = document.getElementById('bubble');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const gear = document.getElementById('gear');
const settings = document.getElementById('settings');

const presetSel = document.getElementById('preset');
const providerSel = document.getElementById('provider');
const baseUrlEl = document.getElementById('baseUrl');
const modelEl = document.getElementById('model');
const apiKeyEl = document.getElementById('apiKey');
const tempEl = document.getElementById('temperature');
const tempValEl = document.getElementById('tempVal');
const sysPromptEl = document.getElementById('systemPrompt');
const saveBtn = document.getElementById('save');
const closeBtn = document.getElementById('close');
const resetBtn = document.getElementById('reset');
const profileSelectEl = document.getElementById('profileSelect');
const profileNameEl = document.getElementById('profileName');
const profileLoadBtn = document.getElementById('profileLoad');
const profileSaveBtn = document.getElementById('profileSave');
const profileDelBtn = document.getElementById('profileDel');
const profileMsgEl = document.getElementById('profileMsg');

const skipVoiceBtn = document.getElementById('skipVoice');
const micBtn = document.getElementById('mic');
const gfxQualityEl = document.getElementById('gfxQuality');
const avatarScaleEl = document.getElementById('avatarScale');
const avatarScaleValEl = document.getElementById('avatarScaleVal');
const toolsEnabledEl = document.getElementById('toolsEnabled');
const memoryEnabledEl = document.getElementById('memoryEnabled');
const searchProviderEl = document.getElementById('searchProvider');
const searchApiKeyEl = document.getElementById('searchApiKey');
const searxUrlEl = document.getElementById('searxUrl');
const fallbackModelEl = document.getElementById('fallbackModel');
const proactivityEl = document.getElementById('proactivity');
const reactAppsEl = document.getElementById('reactApps');
const watchServerEl = document.getElementById('watchServer');
const maxStepsEl = document.getElementById('maxSteps');
const contextWindowEl = document.getElementById('contextWindow');
const compactAtPctEl = document.getElementById('compactAtPct');
const responseReserveTokensEl = document.getElementById('responseReserveTokens');
const recentLiteralTokensEl = document.getElementById('recentLiteralTokens');
const codeBudgetPctEl = document.getElementById('codeBudgetPct');
const clearFactsBtn = document.getElementById('clearFacts');
const permEls = {
  read: document.getElementById('permRead'),
  write: document.getElementById('permWrite'),
  delete: document.getElementById('permDelete'),
  exec: document.getElementById('permExec'),
  network: document.getElementById('permNetwork'),
  open: document.getElementById('permOpen'),
  mcp: document.getElementById('permMcp'),
  screen: document.getElementById('permScreen'),
  control: document.getElementById('permControl'),
};
const sttPresetEl = document.getElementById('sttPreset');
const sttHintEl = document.getElementById('sttHint');
const sttApiKeyEl = document.getElementById('sttApiKey');
const sttBaseUrlEl = document.getElementById('sttBaseUrl');
const sttModelEl = document.getElementById('sttModel');
const audioInputEl = document.getElementById('audioInput');
const audioOutputEl = document.getElementById('audioOutput');
const fetchModelsBtn = document.getElementById('fetchModels');
const modelsStatus = document.getElementById('modelsStatus');
const ttsProviderEl = document.getElementById('ttsProvider');
const ttsApiKeyEl = document.getElementById('ttsApiKey');
const ttsVoiceEl = document.getElementById('ttsVoice');
const ttsModelEl = document.getElementById('ttsModel');
const ttsBaseUrlEl = document.getElementById('ttsBaseUrl');
const testVoiceBtn = document.getElementById('testVoice');

let audioCtx = null;
let currentSource = null; // fonte de audio do TTS tocando agora (para poder parar)
let currentResponse = ''; // texto acumulado da resposta atual (para o TTS)
let audioOutputId = ''; // deviceId do alto-falante escolhido (vazio = padrao)
let recording = false; // gravando o microfone (STT)
let mediaRecorder = null;

// roteia a saida de audio para o dispositivo escolhido (VoiceMeeter, fone, etc.)
function applySink() {
  if (audioCtx && audioCtx.setSinkId) {
    audioCtx.setSinkId(audioOutputId || '').catch((e) => console.warn('setSinkId:', e));
  }
}

// Presets de provedores — endpoints pré-cadastrados (1 adaptador OpenAI-compatível
// cobre quase todos; Anthropic tem adaptador próprio). Escolher um preenche
// Tipo de API + Base URL + um modelo inicial (troque pelo 🔄 que lista os reais).
const PRESETS = {
  OpenAI: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  'Anthropic (Claude)': { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8' },
  'Google Gemini 🆓': { provider: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  'xAI (Grok)': { provider: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' },
  'Groq 🆓': { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  DeepSeek: { provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  Mistral: { provider: 'openai', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  OpenRouter: { provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  'Qwen (DashScope)': { provider: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  'Moonshot (Kimi)': { provider: 'openai', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2-turbo-preview' },
  'Z.ai (GLM)': { provider: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' },
  'Together AI': { provider: 'openai', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  'Fireworks AI': { provider: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  'Cerebras 🆓': { provider: 'openai', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
  'Blackbox 🆓': { provider: 'openai', baseUrl: 'https://api.blackbox.ai', model: 'blackboxai/x-ai/grok-code-fast-1:free' },
  Perplexity: { provider: 'openai', baseUrl: 'https://api.perplexity.ai', model: 'sonar' },
  Cohere: { provider: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', model: 'command-a-03-2025' },
  'Ollama (local)': { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  'LM Studio (local)': { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: '' },
  Personalizado: null,
};
Object.keys(PRESETS).forEach((name) => {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  presetSel.appendChild(opt);
});
// identifica qual preset corresponde à Base URL salva (pra mostrar o nome em vez de "Personalizado")
function presetForBaseUrl(url) {
  const norm = (u) => String(u || '').trim().toLowerCase().replace(/\/+$/, '');
  const u = norm(url);
  if (!u) return 'Personalizado';
  for (const [name, p] of Object.entries(PRESETS)) {
    if (p && norm(p.baseUrl) === u) return name;
  }
  return 'Personalizado';
}

// Presets de STT (transcricao): preenchem URL + modelo automaticamente
const STT_PRESETS = {
  Desligado: null,
  'Groq (grátis) 🆓': { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', hint: 'Groq é grátis: crie uma chave em console.groq.com e cole abaixo.' },
  OpenAI: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', hint: 'Usa sua chave da OpenAI (sk-...).' },
  Personalizado: 'custom',
};
Object.keys(STT_PRESETS).forEach((name) => {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name;
  sttPresetEl.appendChild(o);
});
sttPresetEl.addEventListener('change', () => {
  const p = STT_PRESETS[sttPresetEl.value];
  if (p && p !== 'custom') {
    sttBaseUrlEl.value = p.baseUrl;
    sttModelEl.value = p.model;
    sttHintEl.textContent = p.hint;
  } else if (sttPresetEl.value === 'Desligado') {
    sttHintEl.textContent = 'Escolha um serviço para falar com a I.A. pelo microfone.';
  } else {
    sttHintEl.textContent = 'Preencha a Base URL e o modelo do seu serviço Whisper-compatível.';
  }
});

let bubbleTimer = null;
function showBubble(text, autoHide) {
  bubble.textContent = text;
  bubble.classList.toggle('show', !!text);
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (text && autoHide) bubbleTimer = setTimeout(() => (bubble.classList.remove('show')), autoHide);
}

// ---- fala frase-a-frase: busca o audio em paralelo, toca em ordem ----
let ttsBuffer = ''; // texto ainda nao quebrado em frases
let ttsChain = Promise.resolve(); // corrente de reproducao (mantem a ordem)
let ttsGen = 0; // geracao; muda ao cortar/trocar de mensagem (cancela a fila)
let ttsProvider = 'off'; // cache do provedor de voz (define o modo: frase-a-frase x inteiro)

function stopSpeaking() {
  ttsGen++; // invalida frases enfileiradas que ainda nao tocaram
  ttsChain = Promise.resolve();
  ttsBuffer = '';
  if (currentSource) {
    try {
      currentSource.stop();
    } catch (e) {
      /* ja parou */
    }
    currentSource = null;
  }
  speaking = false;
  ttsAnalyser = null;
  if (currentVrm && currentVrm.expressionManager) currentVrm.expressionManager.setValue('aa', 0);
}

// Toca um audio e resolve quando termina (lip-sync pela amplitude)
function playAudio({ base64 }) {
  return new Promise((resolve) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      applySink(); // roteia para o alto-falante escolhido
    }
    audioCtx.decodeAudioData(
      bytes.buffer.slice(0),
      (buffer) => {
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
        ttsAnalyser = analyser;
        currentSource = src;
        speaking = true;
        src.onended = () => {
          if (currentSource === src) {
            currentSource = null;
            ttsAnalyser = null;
            speaking = false;
            if (currentVrm && currentVrm.expressionManager) currentVrm.expressionManager.setValue('aa', 0);
          }
          resolve();
        };
        src.start();
      },
      (err) => {
        console.error('Erro ao decodificar audio do TTS:', err);
        resolve();
      }
    );
  });
}

// Enfileira uma frase: ja dispara a sintese (paralela) e toca na ordem da corrente
function enqueueSentence(raw) {
  const text = raw
    .replace(/\[emo[cç][aã]o:[^\]]*\]/gi, '') // tag de emoção não é falada
    .replace(/\s*\[\s*[\p{L}]{2,20}\s*\]\s*$/u, '') // forma curta no fim: [feliz], [brava]...
    .trim();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return; // nada falavel (so pontuacao/espaco)
  const gen = ttsGen;
  const audioPromise = window.api.speak(text).catch((e) => {
    console.error('TTS:', e);
    return null;
  });
  ttsChain = ttsChain
    .then(() => audioPromise)
    .then((audio) => {
      if (audio && gen === ttsGen) return playAudio(audio);
    });
}

// Quebra o buffer em frases completas e enfileira; no final, manda o resto
function flushSentences(final) {
  let m;
  while ((m = ttsBuffer.match(/^[\s\S]*?[.!?…\n]+/))) {
    enqueueSentence(m[0]);
    ttsBuffer = ttsBuffer.slice(m[0].length);
  }
  if (final && ttsBuffer.trim()) {
    enqueueSentence(ttsBuffer);
    ttsBuffer = '';
  }
}

// Fala uma frase unica imediatamente (usado no "Testar voz")
async function speakOnce(text, override) {
  try {
    const audio = await window.api.speak(text, override);
    if (audio) {
      stopSpeaking();
      playAudio(audio);
    }
  } catch (e) {
    showBubble('⚠ Voz: ' + (e.message || e), 5000);
  }
}

// remove markdown para o balao mostrar texto limpo
function stripMd(t) {
  return t
    .replace(/\[emo[cç][aã]o:[^\]]*\]/gi, '') // tag de emoção: invisível (só anima o avatar)
    .replace(/\s*\[\s*[\p{L}]{2,20}\s*\]\s*$/u, '') // forma curta no fim: [feliz], [brava]...
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '');
}

// ---- streaming de resposta ----
// O balão NÃO acumula a resposta inteira: mostra a frase corrente (balão "novo" a cada
// frase) e se esconde sozinho quando a stream fica sem texto novo (ex.: ferramentas rodando).
let bubBuf = ''; // frase em construção (só pro balão; o TTS tem o buffer próprio)
function bubbleLive(text) {
  if (!bubble.classList.contains('show')) void bubble.offsetWidth; // re-dispara a animação (balão novo)
  bubble.textContent = text;
  bubble.classList.add('show');
  bubble.scrollTop = bubble.scrollHeight;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  const ttl = Math.min(9000, 2500 + 45 * text.length); // tempo de leitura proporcional
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ttl);
}
window.api.onToken((t) => {
  if (!talking) {
    talking = true;
    bubBuf = '';
    currentResponse = '';
    stopSpeaking(); // corta a fala anterior + zera a fila (nova mensagem)
  }
  currentResponse += t;
  bubBuf += t;
  // frase terminou e já começou outra? o balão recomeça mostrando só a frase nova
  let m;
  while ((m = bubBuf.match(/^[\s\S]*?[.!?…\n]+\s*(?=\S)/))) bubBuf = bubBuf.slice(m[0].length);
  const shown = stripMd(bubBuf);
  if (shown.trim()) bubbleLive(shown);
  // Edge (gratis): fala frase-a-frase (comeca rapido). Provedores com chave:
  // espera a resposta inteira (1 requisicao = menos consumo).
  if (ttsProvider === 'edge') {
    ttsBuffer += t;
    flushSentences(false);
  }
});
window.api.onDone(() => {
  talking = false;
  const tail = stripMd(bubBuf); // última frase ganha o tempo de leitura dela e some
  if (tail.trim()) bubbleLive(tail);
  bubBuf = '';
  if (ttsProvider === 'edge') {
    flushSentences(true); // fala o que sobrou (ultima frase sem pontuacao)
  } else if (ttsProvider !== 'off') {
    enqueueSentence(currentResponse); // resposta inteira numa unica requisicao
  }
  triggerEmotion(detectEmotion(currentResponse)); // expressao + animacao do humor
});
window.api.onError((msg) => {
  talking = false;
  showBubble('⚠ ' + msg);
});

// ---- enviar mensagem ----
// cresce o textarea conforme o texto (1 linha -> ate max-height do CSS) e quebra linha
function autoGrowInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 96) + 'px';
}
function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoGrowInput(); // volta a 1 linha
  talking = false;
  showBubble('…'); // espera ate o primeiro token
  window.api.sendChat(text);
}
sendBtn.addEventListener('click', send);
input.addEventListener('input', autoGrowInput);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); // Enter envia; Shift+Enter quebra linha
    send();
  }
});

// ---- configuracoes ----
async function openSettings() {
  const c = await window.api.getConfig();
  providerSel.value = c.provider;
  baseUrlEl.value = c.baseUrl;
  modelEl.value = c.model;
  apiKeyEl.value = c.apiKey;
  tempEl.value = c.temperature;
  tempValEl.textContent = c.temperature;
  sysPromptEl.value = c.systemPrompt;
  ttsProviderEl.value = c.ttsProvider || 'off';
  ttsApiKeyEl.value = c.ttsApiKey || '';
  ttsVoiceEl.value = c.ttsVoice || '';
  ttsModelEl.value = c.ttsModel || '';
  ttsBaseUrlEl.value = c.ttsBaseUrl || '';
  gfxQualityEl.value = c.gfxQuality || 'balanced';
  const scalePct = Math.round((c.avatarScale || 1) * 100);
  avatarScaleEl.value = scalePct;
  avatarScaleValEl.textContent = scalePct;
  fillThemeInputs(c.theme); // editor de tema (aba Tema)
  toolsEnabledEl.checked = c.toolsEnabled !== false;
  memoryEnabledEl.checked = c.memoryEnabled !== false;
  searchProviderEl.value = c.searchProvider || 'duckduckgo';
  searchApiKeyEl.value = c.searchApiKey || '';
  searxUrlEl.value = c.searxUrl || '';
  fallbackModelEl.value = c.fallbackModel || '';
  proactivityEl.value = c.proactivity || 'normal';
  reactAppsEl.checked = !!c.reactApps;
  watchServerEl.checked = !!c.watchServer;
  maxStepsEl.value = c.maxSteps || 48;
  contextWindowEl.value = c.contextWindow || 128000;
  compactAtPctEl.value = c.compactAtPct || 80;
  responseReserveTokensEl.value = c.responseReserveTokens || 8192;
  recentLiteralTokensEl.value = c.recentLiteralTokens || 24000;
  codeBudgetPctEl.value = c.codeBudgetPct || 35;
  const perms = c.perms || {};
  permEls.read.value = perms.read || 'ask';
  permEls.write.value = perms.write || 'ask';
  permEls.delete.value = perms.delete || 'ask';
  permEls.exec.value = perms.exec || 'ask';
  permEls.network.value = perms.network || 'ask';
  permEls.open.value = perms.open || 'allow';
  permEls.mcp.value = perms.mcp || 'ask';
  permEls.screen.value = perms.screen || 'ask';
  permEls.control.value = perms.control || 'ask';
  // deriva o preset de STT a partir da config salva
  sttPresetEl.value =
    (c.sttProvider || 'off') === 'off'
      ? 'Desligado'
      : /groq/i.test(c.sttBaseUrl || '')
        ? 'Groq (grátis) 🆓'
        : /api\.openai\.com/i.test(c.sttBaseUrl || '')
          ? 'OpenAI'
          : 'Personalizado';
  sttApiKeyEl.value = c.sttApiKey || '';
  sttBaseUrlEl.value = c.sttBaseUrl || '';
  sttModelEl.value = c.sttModel || '';
  presetSel.value = presetForBaseUrl(c.baseUrl); // mostra o provedor em uso (em vez de sempre "Personalizado")
  modelsStatus.textContent = '';
  // sempre abre na primeira aba (I.A.)
  document.querySelectorAll('#settings .tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  document.querySelectorAll('#settings .panel').forEach((p, i) => p.classList.toggle('active', i === 0));
  settings.style.display = 'flex';
  loadAudioDevices(c.audioInput || '', c.audioOutput || ''); // lista mics/saidas
  refreshProfiles(); // atualiza a lista de perfis salvos
  profileMsgEl.textContent = '';
}
gear.addEventListener('click', () => window.api.openSettingsWindow()); // janela dedicada (redimensionável)

presetSel.addEventListener('change', () => {
  const p = PRESETS[presetSel.value];
  if (p) {
    providerSel.value = p.provider;
    baseUrlEl.value = p.baseUrl;
    modelEl.value = p.model;
  }
});
tempEl.addEventListener('input', () => (tempValEl.textContent = tempEl.value));

// tamanho da avatar: slider (live) + atualizacao quando o scroll muda a escala
avatarScaleEl.addEventListener('input', () => {
  avatarScaleValEl.textContent = avatarScaleEl.value;
  window.api.setAvatarScale(parseInt(avatarScaleEl.value, 10) / 100);
});
window.api.onAvatarScale((s) => {
  const pct = Math.round(s * 100);
  avatarScaleEl.value = pct;
  avatarScaleValEl.textContent = pct;
});
// scroll do mouse sobre o corpo -> aumenta/diminui a avatar
window.addEventListener(
  'wheel',
  (e) => {
    if (!hoveringBody) return; // so quando o cursor esta sobre ela
    e.preventDefault();
    window.api.scaleAvatarBy(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false }
);

// ---- editor de tema (cores da UI) ----
const THEME_DEFAULTS = {
  bg: '#16161e', surface: '#24242f', 'surface-2': '#0f0f16',
  accent: '#7aa2ff', 'accent-text': '#ffffff', text: '#eeeeee', border: '#2a2a38',
};
const THEME_INPUTS = {
  bg: document.getElementById('thBg'),
  surface: document.getElementById('thSurface'),
  'surface-2': document.getElementById('thSurface2'),
  accent: document.getElementById('thAccent'),
  'accent-text': document.getElementById('thAccentText'),
  text: document.getElementById('thText'),
  border: document.getElementById('thBorder'),
};
const THEME_PRESETS = {
  Padrão: {},
  AMOLED: { bg: '#000000', surface: '#101016', 'surface-2': '#000000', accent: '#7aa2ff', 'accent-text': '#ffffff', text: '#e8e8ee', border: '#1c1c26' },
  'Meia-noite': { bg: '#0e0e1a', surface: '#1b1b2e', 'surface-2': '#0a0a14', accent: '#8b7aff', 'accent-text': '#ffffff', text: '#e8e8f4', border: '#2a2a44' },
  Claro: { bg: '#f4f5f9', surface: '#ffffff', 'surface-2': '#e8eaf1', accent: '#5b7cfa', 'accent-text': '#ffffff', text: '#23263a', border: '#d4d8e4' },
  Pastel: { bg: '#f7f3fb', surface: '#ffffff', 'surface-2': '#efe8f6', accent: '#b58aed', 'accent-text': '#ffffff', text: '#3a3344', border: '#e2d8ee' },
  Sakura: { bg: '#fdf2f6', surface: '#ffffff', 'surface-2': '#f8e4ec', accent: '#e96ba8', 'accent-text': '#ffffff', text: '#45323c', border: '#f0d4e0' },
  Rosé: { bg: '#1a1418', surface: '#2a1f27', 'surface-2': '#140f13', accent: '#ff7aa2', 'accent-text': '#ffffff', text: '#f0e6ec', border: '#3a2a34' },
  Floresta: { bg: '#0f1714', surface: '#16241e', 'surface-2': '#0a110d', accent: '#5fd08a', 'accent-text': '#0a1a10', text: '#e6f0ea', border: '#20342a' },
  Âmbar: { bg: '#1a160e', surface: '#2a2418', 'surface-2': '#14110a', accent: '#ffb347', 'accent-text': '#1a1206', text: '#f0e9dc', border: '#3a3220' },
};
function currentThemeFromInputs() {
  const t = {};
  for (const k in THEME_INPUTS) t[k] = THEME_INPUTS[k].value;
  return t;
}
function fillThemeInputs(theme) {
  const t = Object.assign({}, THEME_DEFAULTS, theme || {});
  for (const k in THEME_INPUTS) THEME_INPUTS[k].value = t[k];
}
function previewTheme() {
  if (window.__lumiApplyTheme) window.__lumiApplyTheme(currentThemeFromInputs());
}
Object.values(THEME_INPUTS).forEach((el) => {
  el.addEventListener('input', previewTheme); // ao vivo (local, sem salvar)
  el.addEventListener('change', () => window.api.setTheme(currentThemeFromInputs())); // persiste + outras janelas
});
const themePresetRow = document.getElementById('themePresets');
Object.keys(THEME_PRESETS).forEach((name) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = name;
  b.addEventListener('click', () => {
    fillThemeInputs(THEME_PRESETS[name]);
    previewTheme();
    window.api.setTheme(name === 'Padrão' ? {} : currentThemeFromInputs());
  });
  themePresetRow.appendChild(b);
});
document.getElementById('themeReset').addEventListener('click', () => {
  fillThemeInputs({});
  previewTheme();
  window.api.setTheme({}); // volta ao padrão
});

function readForm() {
  return {
    provider: providerSel.value,
    baseUrl: baseUrlEl.value.trim(),
    model: modelEl.value.trim(),
    apiKey: apiKeyEl.value.trim(),
    temperature: parseFloat(tempEl.value) || 0.8,
    systemPrompt: sysPromptEl.value,
    ttsProvider: ttsProviderEl.value,
    ttsApiKey: ttsApiKeyEl.value.trim(),
    ttsVoice: ttsVoiceEl.value.trim(),
    ttsModel: ttsModelEl.value.trim(),
    ttsBaseUrl: ttsBaseUrlEl.value.trim(),
    gfxQuality: gfxQualityEl.value,
    toolsEnabled: toolsEnabledEl.checked,
    memoryEnabled: memoryEnabledEl.checked,
    searchProvider: searchProviderEl.value,
    searchApiKey: searchApiKeyEl.value.trim(),
    searxUrl: searxUrlEl.value.trim(),
    fallbackModel: fallbackModelEl.value.trim(),
    proactivity: proactivityEl.value,
    reactApps: reactAppsEl.checked,
    watchServer: watchServerEl.checked,
    maxSteps: Math.min(200, Math.max(4, parseInt(maxStepsEl.value, 10) || 48)),
    contextWindow: Math.min(2000000, Math.max(8192, parseInt(contextWindowEl.value, 10) || 128000)),
    compactAtPct: Math.min(95, Math.max(50, parseInt(compactAtPctEl.value, 10) || 80)),
    responseReserveTokens: Math.min(200000, Math.max(1024, parseInt(responseReserveTokensEl.value, 10) || 8192)),
    recentLiteralTokens: Math.min(500000, Math.max(4000, parseInt(recentLiteralTokensEl.value, 10) || 24000)),
    codeBudgetPct: Math.min(70, Math.max(5, parseInt(codeBudgetPctEl.value, 10) || 35)),
    perms: {
      read: permEls.read.value,
      write: permEls.write.value,
      delete: permEls.delete.value,
      exec: permEls.exec.value,
      network: permEls.network.value,
      open: permEls.open.value,
      mcp: permEls.mcp.value,
      screen: permEls.screen.value,
      control: permEls.control.value,
    },
    sttProvider: sttPresetEl.value === 'Desligado' ? 'off' : 'openai',
    sttApiKey: sttApiKeyEl.value.trim(),
    sttBaseUrl: sttBaseUrlEl.value.trim(),
    sttModel: sttModelEl.value.trim(),
    audioInput: audioInputEl.value,
    audioOutput: audioOutputEl.value,
  };
}

saveBtn.addEventListener('click', async () => {
  const form = readForm();
  await window.api.setConfig(form);
  applyGraphics(form.gfxQuality); // aplica a qualidade na hora
  ttsProvider = form.ttsProvider; // atualiza o modo de fala (edge x chave)
  audioOutputId = form.audioOutput; // aplica o alto-falante escolhido
  applySink();
  if (SETTINGS_ONLY) settingsToast('✓ Configurações salvas');
  else settings.style.display = 'none';
  showBubble('Pronto! Pode falar comigo ✨', 4000);
});

// ---- dropdown de modelos: lista COMPLETA com scroll e filtro ao digitar ----
// (o datalist nativo só mostrava sugestões do que você já tinha digitado)
const modelPick = document.getElementById('modelPick');
const mpkList = document.getElementById('mpkList');
let mpkModels = []; // última lista buscada do provedor
let mpkKey = ''; // assinatura provedor|url|chave da lista (trocou → rebusca)
let mpkTarget = null; // qual campo está usando o dropdown (modelo ou reserva)
let mpkIdx = -1; // item destacado pelas setinhas

function mpkSrcKey() {
  return providerSel.value + '|' + baseUrlEl.value.trim() + '|' + apiKeyEl.value.trim();
}
async function mpkFetch() {
  modelsStatus.textContent = 'Buscando modelos…';
  try {
    const ids = await window.api.listModels({
      provider: providerSel.value,
      baseUrl: baseUrlEl.value.trim(),
      apiKey: apiKeyEl.value.trim(),
    });
    mpkModels = ids || [];
    mpkKey = mpkSrcKey();
    modelsStatus.textContent = mpkModels.length + ' modelos — escolha na lista ou digite pra filtrar.';
    return true;
  } catch (e) {
    mpkModels = [];
    mpkKey = '';
    modelsStatus.textContent = '⚠ ' + (e.message || e);
    return false;
  }
}
function mpkRender() {
  if (!mpkTarget) return;
  const q = mpkTarget.value.trim().toLowerCase();
  const list = q ? mpkModels.filter((m) => m.toLowerCase().includes(q)) : mpkModels;
  mpkIdx = -1;
  mpkList.innerHTML = '';
  if (!mpkModels.length) {
    mpkList.innerHTML = '<div class="mpkmsg">nenhum modelo carregado — confira a URL/chave e clique no 🔄</div>';
    return;
  }
  if (!list.length) {
    mpkList.innerHTML = '<div class="mpkmsg">nada bate com "' + q.replace(/[<>&]/g, '') + '" — apague pra ver todos</div>';
    return;
  }
  list.slice(0, 500).forEach((m) => {
    const d = document.createElement('div');
    d.className = 'mpkrow' + (m === mpkTarget.value ? ' cur' : '');
    d.textContent = m;
    d.title = m;
    // mousedown (não click): escolhe ANTES do blur do campo fechar o painel
    d.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mpkTarget.value = m;
      mpkClose();
    });
    mpkList.appendChild(d);
  });
}
function mpkOpen(target) {
  mpkTarget = target;
  const r = target.getBoundingClientRect();
  modelPick.style.left = r.left + 'px';
  modelPick.style.top = r.bottom + 4 + 'px';
  modelPick.style.width = r.width + 'px';
  modelPick.hidden = false;
  if (!mpkModels.length || mpkKey !== mpkSrcKey()) {
    // primeira abertura (ou trocou o provedor): busca sozinho — o usuário nem precisa saber do 🔄
    mpkList.innerHTML = '<div class="mpkmsg">⏳ buscando os modelos do provedor…</div>';
    mpkFetch().then(() => {
      if (!modelPick.hidden && mpkTarget === target) mpkRender();
    });
  } else mpkRender();
}
function mpkClose() {
  modelPick.hidden = true;
  mpkTarget = null;
}
[modelEl, fallbackModelEl].forEach((el) => {
  el.addEventListener('focus', () => mpkOpen(el));
  el.addEventListener('click', () => {
    if (modelPick.hidden) mpkOpen(el);
  });
  el.addEventListener('input', () => {
    if (!modelPick.hidden && mpkTarget === el) mpkRender();
    else mpkOpen(el);
  });
  el.addEventListener('keydown', (e) => {
    if (modelPick.hidden) return;
    const rows = [...mpkList.querySelectorAll('.mpkrow')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      mpkIdx = e.key === 'ArrowDown' ? Math.min(mpkIdx + 1, rows.length - 1) : Math.max(mpkIdx - 1, 0);
      rows.forEach((x, i) => x.classList.toggle('sel', i === mpkIdx));
      rows[mpkIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && mpkIdx >= 0 && rows[mpkIdx]) {
      e.preventDefault();
      el.value = rows[mpkIdx].textContent;
      mpkClose();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      mpkClose();
    }
  });
});
document.addEventListener('mousedown', (e) => {
  if (!modelPick.hidden && !modelPick.contains(e.target) && e.target !== mpkTarget) mpkClose();
});
// rolar a página de configurações fecha o painel (a lista interna pode rolar à vontade)
document.addEventListener(
  'scroll',
  (e) => {
    if (!modelPick.hidden && e.target !== mpkList && !mpkList.contains(e.target)) mpkClose();
  },
  true
);
// 🔄 = força rebuscar a lista e já abre no campo de modelo
fetchModelsBtn.addEventListener('click', async () => {
  mpkModels = [];
  mpkKey = '';
  const ok = await mpkFetch();
  if (ok) mpkOpen(modelEl);
});

// testar a voz com os valores atuais do formulario (sem precisar salvar)
testVoiceBtn.addEventListener('click', () => {
  if (ttsProviderEl.value === 'off') {
    modelsStatus.textContent = '⚠ Selecione um provedor de voz primeiro.';
    return;
  }
  const testPhrase =
    ttsProviderEl.value === 'gemini'
      ? 'Oi! Essa é a minha voz. [laughs] Tá curtindo?'
      : 'Oi! Essa é a minha voz. Tá gostando?';
  speakOnce(testPhrase, {
    ttsProvider: ttsProviderEl.value,
    ttsApiKey: ttsApiKeyEl.value.trim(),
    ttsVoice: ttsVoiceEl.value.trim(),
    ttsModel: ttsModelEl.value.trim(),
    ttsBaseUrl: ttsBaseUrlEl.value.trim(),
    baseUrl: baseUrlEl.value.trim(),
    apiKey: apiKeyEl.value.trim(),
  });
});
closeBtn.addEventListener('click', () => (SETTINGS_ONLY ? window.close() : (settings.style.display = 'none')));

// mini-confirmação na janela dedicada de configurações (não tem bolha do avatar lá)
function settingsToast(t) {
  let el = document.getElementById('sav-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sav-toast';
    el.style.cssText =
      'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);' +
      'border-radius:16px;padding:7px 16px;font-size:12px;color:var(--text);z-index:99;box-shadow:0 6px 20px rgba(0,0,0,.4);transition:opacity .25s;';
    document.body.appendChild(el);
  }
  el.textContent = t;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.style.opacity = '0'), 1800);
}

// troca de abas das configuracoes
document.querySelectorAll('#settings .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('#settings .tab').forEach((t) => t.classList.toggle('active', t === tab));
    document
      .querySelectorAll('#settings .panel')
      .forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  });
});

// Esc fecha as configuracoes (na janela dedicada, fecha a janela)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settings.style.display === 'flex') {
    if (SETTINGS_ONLY) window.close();
    else settings.style.display = 'none';
  }
});
resetBtn.addEventListener('click', () => {
  window.api.resetChat();
  showBubble('Memória da conversa limpa 🧹', 3000);
});
clearFactsBtn.addEventListener('click', async () => {
  await window.api.clearFacts();
  showBubble('Esqueci tudo sobre você 🫥', 3500);
});
document.getElementById('viewFacts').addEventListener('click', () => window.api.openMemoryPage());

// ---- perfis de configuracao ----
async function refreshProfiles() {
  const names = await window.api.listPresets();
  profileSelectEl.innerHTML = '<option value="">— Perfis salvos —</option>';
  names.forEach((n) => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    profileSelectEl.appendChild(o);
  });
}
profileSaveBtn.addEventListener('click', async () => {
  const name = profileNameEl.value.trim();
  if (!name) {
    profileMsgEl.textContent = 'Digite um nome para o perfil.';
    return;
  }
  await window.api.savePreset(name, readForm());
  profileNameEl.value = '';
  await refreshProfiles();
  profileSelectEl.value = name;
  profileMsgEl.textContent = `Perfil "${name}" salvo. ✨`;
});
profileLoadBtn.addEventListener('click', async () => {
  const name = profileSelectEl.value;
  if (!name) {
    profileMsgEl.textContent = 'Escolha um perfil para carregar.';
    return;
  }
  const cfg = await window.api.loadPreset(name);
  if (!cfg) return;
  await window.api.setConfig(cfg);
  applyGraphics(cfg.gfxQuality || 'balanced');
  ttsProvider = cfg.ttsProvider || 'off';
  audioOutputId = cfg.audioOutput || '';
  applySink();
  await openSettings(); // repopula o formulario com o perfil carregado
  profileSelectEl.value = name;
  profileMsgEl.textContent = `Perfil "${name}" carregado. ✅`;
});
profileDelBtn.addEventListener('click', async () => {
  const name = profileSelectEl.value;
  if (!name) return;
  await window.api.deletePreset(name);
  await refreshProfiles();
  profileMsgEl.textContent = `Perfil "${name}" excluído. 🗑`;
});

// ---- botao de pular a voz ----
skipVoiceBtn.addEventListener('click', () => stopSpeaking());

// ---- microfone (STT): gravar -> transcrever -> enviar ----
function toBase64(u8) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function toggleMic() {
  if (recording) {
    if (mediaRecorder) mediaRecorder.stop();
    return;
  }
  const c = await window.api.getConfig();
  if ((c.sttProvider || 'off') === 'off') {
    showBubble('Ative a transcrição (STT) nas configurações ⚙', 4500);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: c.audioInput ? { deviceId: { exact: c.audioInput } } : true,
    });
  } catch (e) {
    showBubble('⚠ Microfone: ' + (e.message || e), 5000);
    return;
  }
  const chunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recording = false;
    micBtn.classList.remove('rec');
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (!blob.size) return;
    showBubble('Transcrevendo… 🎤');
    try {
      const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
      const text = await window.api.transcribe(b64, blob.type);
      if (text && text.trim()) {
        input.value = text.trim();
        send();
      } else {
        showBubble('Não entendi 🤔', 3000);
      }
    } catch (e) {
      showBubble('⚠ STT: ' + (e.message || e), 6000);
    }
  };
  mediaRecorder.start();
  recording = true;
  micBtn.classList.add('rec');
  showBubble('Gravando… clique no 🎤 de novo para parar');
}
micBtn.addEventListener('click', toggleMic);

// lista os dispositivos de audio (mic / alto-falante) nas configuracoes
function fillDevices(sel, devs, kind, selected) {
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Padrão do sistema';
  sel.appendChild(def);
  devs
    .filter((d) => d.kind === kind)
    .forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || (kind === 'audioinput' ? 'Microfone ' + (i + 1) : 'Saída ' + (i + 1));
      sel.appendChild(o);
    });
  sel.value = selected || '';
}

async function loadAudioDevices(inId, outId) {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop()); // so para liberar os nomes dos dispositivos
  } catch (e) {
    /* sem permissao -> nomes vem vazios */
  }
  let devs = [];
  try {
    devs = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    /* ok */
  }
  fillDevices(audioInputEl, devs, 'audioinput', inId);
  fillDevices(audioOutputEl, devs, 'audiooutput', outId);
}

// ---- click-through inteligente: avisa o main quando o mouse esta sobre o corpo dela ou a UI ----
let lastInteractive = null;
function reportHover(x, y) {
  if (SETTINGS_ONLY) return; // janela de settings NÃO mexe no click-through do avatar
  let overUI = false;
  let overBody = false;
  if (settings.style.display === 'flex') {
    overUI = true; // painel de config aberto -> tudo clicavel
  } else {
    const el = document.elementFromPoint(x, y);
    if (el && el !== canvas) {
      overUI = true; // sobre a barra / botoes / balao
    } else {
      // sobre o canvas: acertou o corpo da avatar? (teste O(1) na capsula)
      overBody = hitsAvatar((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    }
  }
  hoveringBody = overBody;
  if (overBody) touchInteraction();

  // CAPTURA: sobre a UI OU sobre o corpo. Capturar sobre o corpo faz o clique NAO
  // vazar pros apps atras. Agora e barato (cápsula O(1)) e o lag do raycast acabou.
  const want = overUI || overBody;
  const tnow = performance.now();
  if (want) lastWantTrue = tnow;
  const capture = want || tnow - lastWantTrue < 250; // histerese anti-flicker
  if (capture !== lastInteractive) {
    lastInteractive = capture;
    window.api.setHoverInteractive(capture);
  }
}
// posicao do cursor vem do polling do main (~30x/seg), relativa a janela.
// Funciona mesmo com a janela em click-through e mesmo com o cursor fora dela.
window.api.onCursor((p) => {
  mouseX = p.x;
  mouseY = p.y;
  lastCursorMove = performance.now(); // o main so emite quando o cursor mexe
});
// FALLBACK (Linux/Wayland): se o polling global do cursor não funcionar, os mousemove
// locais alimentam o look-at e o hover — funciona porque lá a janela começa capturada.
// No Windows é redundante e inofensivo (mesmas coordenadas).
window.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  lastCursorMove = performance.now();
});

// ---- acoes vindas do menu de contexto (clique direito) ----
window.api.onOpenSettings(() => openSettings());
window.api.onChatReset(() => showBubble('Memória da conversa limpa 🧹', 3000));

// ---- testador de animacoes (janela separada) ----
window.api.onPreviewAnim((name) => previewAnim(name));
window.api.onStopPreview(() => stopPreview());

// ---- diagnostico de memoria ----
function gatherMem() {
  const info = renderer.info.memory;
  let texBytes = 0;
  const texList = [];
  const seen = new Set();
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    mats.forEach((m) => {
      collectTextures(m).forEach(([k, v]) => {
        if (seen.has(v)) return;
        seen.add(v);
        const w = v.image.width || 0;
        const h = v.image.height || 0;
        texBytes += w * h * 4 * 1.33; // RGBA + mips
        texList.push(`${k} ${w}x${h}`);
      });
    });
  });
  return {
    geometries: info.geometries,
    textures: info.textures,
    texMB: Math.round(texBytes / 1048576),
    texList: texList.sort(),
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 'n/d',
  };
}
window.api.onMemReport(() => window.api.sendMemReport(gatherMem()));

// ---- hook global de mouse (arrasto/sentar controlados pelo main) ----
window.api.getHookStatus().then((ok) => (useHook = ok));
window.api.onDragStart(() => {
  touchInteraction();
  stopSitting();
  reactionT = REACTION_DUR; // reacao de "agarrada"
  playGesture();
});
window.api.onSitStart(() => startSitting());

// a I.A. pediu uma emocao/animacao via ferramenta (play_animation)
window.api.onToolAnimation((name) => triggerEmotion(name));

// ---- primeira execucao: aplica qualidade salva + avisa para configurar ----
window.api.getConfig().then((c) => {
  if (SETTINGS_ONLY) {
    maxFps = 5; // sem avatar, o loop praticamente dorme
    // faixa de arrasto no topo (só no Windows — Linux/mac mantêm a barra nativa)
    if (window.api.platform === 'win32') {
      const drag = document.createElement('div');
      drag.style.cssText = 'position:fixed;top:0;left:0;right:142px;height:34px;-webkit-app-region:drag;z-index:50;';
      document.body.appendChild(drag);
    }
    openSettings(); // abre o formulário direto (a janela É as configurações)
    return;
  }
  applyGraphics(c.gfxQuality || 'balanced');
  ttsProvider = c.ttsProvider || 'off';
  audioOutputId = c.audioOutput || '';
  // so mostra em instalacao nova (provedor padrao e sem chave); proxy local nao dispara
  if (!c.apiKey && (!c.baseUrl || c.baseUrl === 'https://api.openai.com/v1')) {
    showBubble('Clique na engrenagem ⚙ para configurar sua I.A.');
  }
});

// config salva em OUTRA janela (a de configurações) → o avatar re-aplica o que importa
if (!SETTINGS_ONLY && window.api.onConfigChanged)
  window.api.onConfigChanged(async () => {
    const c = await window.api.getConfig();
    applyGraphics(c.gfxQuality || 'balanced');
    ttsProvider = c.ttsProvider || 'off';
    audioOutputId = c.audioOutput || '';
    applySink();
  });

// posicao inicial da janela (para o arrasto comecar do lugar certo)
window.api.getWindowPos().then((p) => {
  winX = p[0];
  winY = p[1];
});

// topo da taskbar (para sentar nela)
window.api.getWorkArea().then((w) => {
  if (w) {
    taskbarTop = w.taskbarTop;
    hasBottomBar = w.hasBottomBar !== false;
  }
});

uiReady = true; // libera o hover no loop (UI ja montada)
