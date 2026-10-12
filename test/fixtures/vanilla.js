import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;

const light = new THREE.DirectionalLight();
light.shadow.mapSize.width = 4096;
light.shadow.mapSize.height = 4096;

const geometry = new THREE.TorusKnotGeometry(1, 0.3, 256, 32);
const material = new THREE.MeshPhysicalMaterial({ clearcoat: 1 });

function animate() {
  const tmp = new THREE.Matrix4();
  const mat = new THREE.MeshBasicMaterial();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
