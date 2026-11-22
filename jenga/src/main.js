// 우리 가족 젠가 — 소스 파일
// 빌드: npx esbuild src/main.js --bundle --minify --format=esm --outfile=game.js
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as CANNON from 'cannon-es';

// ---------- 설정 ----------
const L = 3, H = 0.6, W = 1, GAP = 0.03, LAYERS = 12;
const PULL_SPEED = 2;          // 블록 빼는 속도
const PULL_FRICTION = 0.004;   // 빼는 블록 마찰 (클수록 탑이 더 흔들림)
const SLOT_ORDER = [1, 0, 2];  // 위에 올릴 때 채우는 순서 (가운데 먼저)

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const stage = $('stage'), msgEl = $('msg');
const nameOf = p => ($(p === 0 ? 'name0' : 'name1').value.trim() || (p === 0 ? '1번' : '2번'));

// ---------- 3D ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xfff3dc);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
camera.position.set(9, 9, 11);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableDamping = true;
controls.minDistance = 7;
controls.maxDistance = 30;
controls.maxPolarAngle = Math.PI * 0.48;
controls.target.set(0, LAYERS * H / 2, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8b98a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(8, 18, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 16, bottom: -4, near: 1, far: 50 });
scene.add(sun);

const table = new THREE.Mesh(
  new THREE.CylinderGeometry(9, 9, 0.4, 48),
  new THREE.MeshStandardMaterial({ color: 0x8fd18f, roughness: 0.9 })
);
table.position.y = -0.2;
table.receiveShadow = true;
scene.add(table);

function woodTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#e7c48d'; g.fillRect(0, 0, 256, 64);
  for (let i = 0; i < 26; i++) {
    g.strokeStyle = `rgba(150,100,50,${0.08 + Math.random() * 0.15})`;
    g.lineWidth = 1 + Math.random() * 2;
    const y = Math.random() * 64;
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= 256; x += 32) g.lineTo(x, y + Math.sin(x / 40 + i) * 3);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const woodTex = woodTexture();
const blockGeo = new THREE.BoxGeometry(L, H, W);
const edgeGeo = new THREE.EdgesGeometry(blockGeo);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x8a5a2b });

// ---------- 물리 ----------
let world, wood, slick, blocks, state, turn, moves, pulling, placing, settleT, selected, wakeT;

function makeWorld() {
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.allowSleep = true;
  world.solver.iterations = 30;
  world.solver.tolerance = 1e-4;
  wood = new CANNON.Material('wood');
  slick = new CANNON.Material('slick');
  world.addContactMaterial(new CANNON.ContactMaterial(wood, wood, {
    friction: 0.5, restitution: 0, contactEquationStiffness: 1e8, contactEquationRelaxation: 3
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(slick, wood, { friction: PULL_FRICTION, restitution: 0 }));
  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: wood });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(ground);
}

function slotPos(layer, slot) {
  const alongX = layer % 2 === 0, off = (slot - 1) * (W + GAP);
  return { x: alongX ? 0 : off, y: H / 2 + layer * H, z: alongX ? off : 0, alongX };
}

function addBlock(layer, slot, pos, dynamic = true) {
  const p = slotPos(layer, slot);
  const body = new CANNON.Body({
    mass: dynamic ? 1 : 0, type: dynamic ? CANNON.Body.DYNAMIC : CANNON.Body.KINEMATIC,
    material: wood, shape: new CANNON.Box(new CANNON.Vec3(L / 2, H / 2, W / 2)),
    position: new CANNON.Vec3(pos ? pos.x : p.x, pos ? pos.y : p.y, pos ? pos.z : p.z),
    sleepSpeedLimit: 0.15, sleepTimeLimit: 0.4, linearDamping: 0.05, angularDamping: 0.1
  });
  if (!p.alongX) body.quaternion.setFromEuler(0, Math.PI / 2, 0);
  world.addBody(body);

  const shade = 0.88 + Math.random() * 0.12;
  const mesh = new THREE.Mesh(blockGeo, new THREE.MeshStandardMaterial({
    map: woodTex, roughness: 0.75, color: new THREE.Color(shade, shade * 0.97, shade * 0.92)
  }));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.add(new THREE.LineSegments(edgeGeo, edgeMat));
  scene.add(mesh);
  const b = { body, mesh, layer, slot, baseColor: mesh.material.color.clone() };
  mesh.userData.block = b;
  blocks.push(b);
  return b;
}

function wakeAll(sec = 3) {
  world.bodies.forEach(x => x.wakeUp());
  wakeT = Math.max(wakeT, sec);
}

// ---------- 게임 ----------
function newGame() {
  if (blocks) blocks.forEach(b => { scene.remove(b.mesh); b.mesh.material.dispose(); });
  makeWorld();
  blocks = [];
  for (let l = 0; l < LAYERS; l++) for (let s = 0; s < 3; s++) addBlock(l, s);
  state = 'idle'; turn = 0; moves = 0; pulling = null; placing = null; selected = null; settleT = 0; wakeT = 0;
  $('over').classList.remove('show');
  updateUI();
  say(`${nameOf(turn)} 차례예요! 뺄 블록을 눌러 보세요`);
}

function topLayer() { return Math.max(...blocks.map(b => b.layer)); }
function countIn(layer) { return blocks.filter(b => b.layer === layer).length; }

function canTake(b) {
  const T = topLayer();
  if (b.layer === T) return '맨 위 층은 뺄 수 없어요';
  if (countIn(T) < 3 && b.layer === T - 1) return '맨 위 층이 다 차기 전엔 바로 아래 층도 뺄 수 없어요';
  return null;
}

function select(b) {
  if (selected) selected.mesh.material.color.copy(selected.baseColor);
  selected = b;
  if (b) b.mesh.material.color.set(0xffd34d);
}

function onTap(b) {
  if (state !== 'idle') return;
  if (!b) { select(null); return; }
  const why = canTake(b);
  if (why) { select(null); say(why + ' 🙅'); return; }
  if (selected !== b) { select(b); say('한 번 더 누르면 블록이 빠져요 👆'); return; }
  startPull(b);
}

function startPull(b) {
  select(null);
  state = 'pulling';
  wakeAll();
  const p = slotPos(b.layer, 0);
  const axis = p.alongX ? new CANNON.Vec3(1, 0, 0) : new CANNON.Vec3(0, 0, 1);
  const toCam = p.alongX ? camera.position.x - b.body.position.x : camera.position.z - b.body.position.z;
  const dir = axis.scale(toCam >= 0 ? 1 : -1);
  b.body.material = slick;
  b.body.type = CANNON.Body.KINEMATIC;
  b.body.mass = 0; b.body.updateMassProperties();
  b.body.velocity.copy(dir.scale(PULL_SPEED));
  b.body.angularVelocity.set(0, 0, 0);
  pulling = { b, t: (L + 0.6) / PULL_SPEED };
  say('살~살~ 빼는 중... 🤞');
}

function finishPull() {
  const b = pulling.b;
  pulling = null;
  world.removeBody(b.body);
  scene.remove(b.mesh);
  b.mesh.material.dispose();
  blocks.splice(blocks.indexOf(b), 1);
  wakeAll();
  startPlace();
}

function startPlace() {
  state = 'placing';
  let T = topLayer();
  let layer = T, used = blocks.filter(x => x.layer === T).map(x => x.slot);
  if (used.length >= 3) { layer = T + 1; used = []; }
  const slot = SLOT_ORDER.find(s => !used.includes(s));

  // 탑이 기울어진 만큼 따라가기
  const top = blocks.filter(x => x.layer === T);
  const cx = top.reduce((a, x) => a + x.body.position.x, 0) / top.length;
  const cz = top.reduce((a, x) => a + x.body.position.z, 0) / top.length;
  const maxY = Math.max(...blocks.map(x => x.body.position.y));
  const p = slotPos(layer, slot);
  const target = { x: 0, y: 0, z: 0 };
  // 같은 층이면 이미 놓인 블록 기준으로 정렬, 새 층이면 아래층 중심 기준
  if (layer === T) {
    const ref = top[0];
    if (p.alongX) { target.x = ref.body.position.x; target.z = ref.body.position.z + (slot - ref.slot) * (W + GAP); }
    else { target.z = ref.body.position.z; target.x = ref.body.position.x + (slot - ref.slot) * (W + GAP); }
    target.y = ref.body.position.y + 0.01;
  } else {
    if (p.alongX) { target.x = cx; target.z = cz + p.z; } else { target.x = cx + p.x; target.z = cz; }
    target.y = maxY + H + 0.01;
  }
  const b = addBlock(layer, slot, { x: target.x, y: target.y + 3, z: target.z }, false);
  placing = { b, from: target.y + 3, to: target.y, t: 0, dur: 0.7 };
  say('맨 위에 올리는 중... 🧱');
}

function finishPlace() {
  const b = placing.b;
  placing = null;
  b.body.type = CANNON.Body.DYNAMIC;
  b.body.mass = 1; b.body.updateMassProperties();
  b.body.velocity.set(0, 0, 0);
  wakeAll();
  state = 'settling';
  settleT = 1.6;
  say('버텨라 버텨라... 😬');
}

function collapsed() {
  const up = new CANNON.Vec3();
  for (const b of blocks) {
    if (pulling && b === pulling.b) continue;
    if (placing && b === placing.b) continue;
    const nominal = H / 2 + b.layer * H;
    if (b.body.position.y < nominal - H * 0.7) return true;
    b.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0), up);
    if (Math.abs(up.y) < 0.75) return true;
  }
  return false;
}

function lose() {
  state = 'over';
  const loser = turn, winner = 1 - turn;
  say('와르르! 💥');
  wakeAll(10);
  setTimeout(() => {
    $('oTitle').textContent = `${nameOf(winner)} 승리! 🏆`;
    $('oText').textContent = `무너뜨린 사람: ${nameOf(loser)} · 모두 ${moves}개를 뺐어요!`;
    $('over').classList.add('show');
  }, 1500);
}

function nextTurn() {
  moves++;
  turn = 1 - turn;
  state = 'idle';
  updateUI();
  say(`${nameOf(turn)} 차례예요! 🙌`);
}

function updateUI() {
  $('p0').classList.toggle('active', turn === 0);
  $('p1').classList.toggle('active', turn === 1);
  $('count').textContent = moves;
}

let sayTimer;
function say(t) {
  msgEl.textContent = t;
  clearTimeout(sayTimer);
}

// ---------- 입력 (짧게 누르면 선택, 끌면 회전) ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const long = performance.now() - down.t > 500;
  down = null;
  if (moved > 10 || long) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(blocks.map(b => b.mesh), false)[0];
  onTap(hit ? hit.object.userData.block : null);
});

// ---------- 루프 ----------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

let last = performance.now(), acc = 0;
const STEP = 1 / 120;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (pulling) { pulling.t -= dt; if (pulling.t <= 0) finishPull(); }
  if (placing) {
    placing.t += dt;
    const k = Math.min(placing.t / placing.dur, 1), e = 1 - Math.pow(1 - k, 3);
    placing.b.body.position.y = placing.from + (placing.to - placing.from) * e;
    if (k >= 1) finishPlace();
  }
  if (wakeT > 0) { wakeT -= dt; world.bodies.forEach(x => x.wakeUp()); }

  acc += dt;
  let n = 0;
  while (acc >= STEP && n < 10) { world.step(STEP); acc -= STEP; n++; }
  if (n >= 10) acc = 0;

  for (const b of blocks) { b.mesh.position.copy(b.body.position); b.mesh.quaternion.copy(b.body.quaternion); }

  if (state === 'pulling' || state === 'placing' || state === 'settling') {
    if (collapsed()) lose();
    else if (state === 'settling') { settleT -= dt; if (settleT <= 0) nextTurn(); }
  }

  // 탑 높이에 맞춰 카메라 중심 이동
  const h = (topLayer() + 1) * H;
  controls.target.y += (h / 2 - controls.target.y) * 0.05;
  controls.update();
  renderer.render(scene, camera);
}

$('reset').onclick = newGame;
$('again').onclick = newGame;
$('turnCam').onclick = () => {
  const a = Math.atan2(camera.position.z - controls.target.z, camera.position.x - controls.target.x) + Math.PI / 2;
  const r = Math.hypot(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  camera.position.x = controls.target.x + Math.cos(a) * r;
  camera.position.z = controls.target.z + Math.sin(a) * r;
};
['name0', 'name1'].forEach(id => $(id).addEventListener('input', () => { if (state === 'idle') say(`${nameOf(turn)} 차례예요!`); }));

window.__jenga = { get blocks() { return blocks; }, get state() { return state; }, onTap, get turn() { return turn; } };

newGame();
resize();
requestAnimationFrame(loop);
