import { useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';

function Robot() {
  const { scene } = useGLTF('/models/robot.glb');
  return <primitive object={scene} />;
}

function Spinner({ items }) {
  const [angle, setAngle] = useState(0);
  useFrame((state, delta) => {
    const target = new THREE.Vector3(0, 1, 0);
    setAngle((a) => a + delta);
  });
  return (
    <group rotation-y={angle}>
      {items.map((p, i) => (
        <mesh key={i} position={p}>
          <boxGeometry />
          <meshStandardMaterial />
        </mesh>
      ))}
    </group>
  );
}

export default function App() {
  return (
    <Canvas shadows camera={{ position: [0, 2, 5] }}>
      <directionalLight castShadow shadow-mapSize={[4096, 4096]} />
      <mesh castShadow>
        <sphereGeometry args={[1, 128, 64]} />
        <meshPhysicalMaterial transmission={1} roughness={0} />
      </mesh>
      <Robot />
      <Spinner items={[[0, 0, 0]]} />
      <OrbitControls />
      <EffectComposer>
        <Bloom />
      </EffectComposer>
    </Canvas>
  );
}
