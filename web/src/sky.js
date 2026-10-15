// Outdoor sky for the grass arena: atmospheric scattering, a cloud layer that follows the
// weather, and a rainbow placed by the optics of raindrops.
//
// The sky is the Preetham analytic daylight model (three.js Sky), turned to this scene's
// z-up axes. Clouds are a noise layer on the dome, lit from the sun's side. A rainbow is
// sunlight refracted and reflected inside raindrops: it is a circle around the antisolar
// point (directly opposite the sun), the primary bow at 40.5-42.3 degrees with red outside,
// the fainter secondary at 50-53.5 degrees with the colors reversed, brighter sky inside the
// primary and Alexander's dark band between the two. It only shows when it is raining with
// the sun behind the viewer, and only above the horizon, so the sun must be below 42 degrees.
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

const R = 800; // dome radius (mm); the camera's far plane is 1000

const CLOUD_FRAG = `
varying vec3 vDir;
uniform vec3 uSun;
uniform float uTime, uCover, uDark, uBow, uSnow;
uniform vec3 uGround, uHorizon;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
// Rainbow colors along the band (0 = red edge, 1 = violet edge).
vec3 spectrum(float t) {
  vec3 c = vec3(1.0 - smoothstep(0.15, 0.45, t), smoothstep(0.1, 0.4, t) * (1.0 - smoothstep(0.55, 0.85, t)), smoothstep(0.5, 0.85, t));
  c.r += 0.45 * smoothstep(0.75, 1.0, t); // violet
  return c;
}
// Same output transform as three.js materials (tone mapping, sRGB).
void finish() {
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
void main() {
  vec3 d = normalize(vDir);
  // Distant meadow fading into haze, in output colors: three.js fogs after tone mapping, so
  // this matches the fog the arena floor fades into.
  if (d.z < 0.0) { gl_FragColor = vec4(mix(uGround, uHorizon, exp(d.z * 14.0)), 1.0); return; }
  // Clouds on a flat layer overhead, drifting with the wind.
  vec2 p = d.xy / (d.z + 0.08) * 0.9 + uTime * vec2(0.012, 0.005);
  float n = fbm(p * 1.4);
  float edge = 1.0 - uCover;
  float c = smoothstep(edge - 0.08, edge + 0.22, n) * smoothstep(0.0, 0.1, d.z);
  float sunward = pow(max(dot(d, uSun), 0.0), 6.0);
  float thick = smoothstep(edge, edge + 0.5, n);
  vec3 lit = mix(vec3(0.97, 0.98, 1.0), vec3(1.0, 0.94, 0.82), sunward);   // silver lining
  vec3 base = mix(lit, mix(vec3(0.5, 0.54, 0.6), vec3(0.88, 0.9, 0.93), uSnow), thick * (0.35 + 0.65 * uDark));
  base *= mix(1.0, 0.42 + 0.4 * uSnow, uDark * (0.4 + 0.6 * thick));      // dark rain-cloud bases
  base *= 0.85 + 0.3 * fbm(p * 5.0);
  // Rainbow, centred on the antisolar point.
  float a = degrees(acos(clamp(dot(d, -uSun), -1.0, 1.0)));
  float t1 = (42.3 - a) / 1.8, t2 = (a - 50.2) / 3.3;
  float band1 = smoothstep(-0.05, 0.12, t1) * (1.0 - smoothstep(0.88, 1.05, t1));
  float band2 = smoothstep(-0.05, 0.15, t2) * (1.0 - smoothstep(0.85, 1.05, t2));
  vec3 bow = spectrum(clamp(t1, 0.0, 1.0)) * band1 + 0.43 * spectrum(clamp(t2, 0.0, 1.0)) * band2;
  bow += vec3(0.1) * (1.0 - smoothstep(30.0, 40.5, a)) * step(a, 40.5);   // brighter inside the primary
  float dark = step(42.3, a) * step(a, 50.2) * 0.12;                        // Alexander's band
  float rise = smoothstep(0.0, 0.06, d.z);
  bow *= uBow * rise;
  gl_FragColor = vec4(pow(base, vec3(2.2)) * c + bow * 0.75, max(c, dark * uBow * rise));
  finish();
}`;

export class SkyDome {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.renderOrder = -10;
    scene.add(this.group);
    // Scattering sky, turned to z-up.
    const sky = new Sky();
    const mat = sky.material;
    mat.vertexShader = mat.vertexShader.replace("sunPosition.y / 450000.0", "sunPosition.z / 450000.0");
    mat.fragmentShader = mat.fragmentShader.replace("acos( direction.y )", "acos( direction.z )");
    mat.uniforms.up.value.set(0, 0, 1);
    // The model's radiance is scaled for exposure ~0.5; this renderer runs at 1.
    mat.fragmentShader = mat.fragmentShader.replace("gl_FragColor = vec4( retColor, 1.0 );", "gl_FragColor = vec4( retColor * 0.38, 1.0 );");
    mat.fog = false;
    sky.scale.setScalar(1000); // a box: corners stay inside the far plane
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.sky = sky;
    this.group.add(sky);
    // Clouds and the rainbow on a slightly smaller dome.
    this.uniforms = {
      uSun: { value: new THREE.Vector3() }, uTime: { value: 0 }, uCover: { value: 0.35 },
      uDark: { value: 0 }, uBow: { value: 0 }, uSnow: { value: 0 }, uGround: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    };
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 32), new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      vertexShader: "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: CLOUD_FRAG,
    }));
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -9;
    this.group.add(this.clouds);
    // Afternoon sun at 32 deg: low enough for a rainbow (top 10 deg above the horizon).
    this.sunDir = new THREE.Vector3();
    this.setSun(32, 215);
    this.set("off", 2);
  }

  setSun(elevationDeg, azimuthDeg) {
    const e = THREE.MathUtils.degToRad(elevationDeg), a = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.set(Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e));
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir).multiplyScalar(450000);
    this.uniforms.uSun.value.copy(this.sunDir);
  }

  // Weather: "off" (fair-weather cumulus), "rain" or "snow", intensity level 0-4.
  set(mode, level) {
    const u = this.uniforms, s = this.sky.material.uniforms;
    const wet = mode !== "off";
    u.uCover.value = wet ? Math.min(0.93, 0.62 + 0.07 * level) : 0.38;
    u.uDark.value = mode === "rain" ? 0.55 + 0.1 * level : mode === "snow" ? 0.45 : 0;
    u.uSnow.value = mode === "snow" ? 1 : 0;
    // Showers with the sun out make rainbows; a downpour's clouds hide the sun.
    u.uBow.value = mode === "rain" ? [0.85, 1, 0.8, 0.45, 0.15][level] : 0;
    s.turbidity.value = wet ? 10 : 3.2;
    s.rayleigh.value = wet ? 1.2 : 1.6;
    s.mieCoefficient.value = wet ? 0.02 : 0.004;
    s.mieDirectionalG.value = 0.82;
    this.mode = mode;
    u.uHorizon.value.setHex(this.horizon, THREE.LinearSRGBColorSpace);
    u.uGround.value.setHex(mode === "snow" ? 0xb8bfc4 : 0x6f8a5a, THREE.LinearSRGBColorSpace).multiplyScalar(wet ? 0.75 : 1);
  }

  // Horizon color for the fog, so the ground fades into the sky. Fog is mixed into the final
  // (sRGB) color, so set it with fog.color.setHex(horizon, THREE.LinearSRGBColorSpace).
  get horizon() {
    return this.mode === "rain" ? 0x8c97a1 : this.mode === "snow" ? 0xc7ced5 : 0xa9c3dc;
  }

  set visible(v) { this.group.visible = v; }
  get visible() { return this.group.visible; }

  update(camera, timeS) {
    this.group.position.copy(camera.position); // always at infinity
    this.uniforms.uTime.value = timeS;
  }
}
