// The pond's water: a real-time water surface for the arena (units: mm).
//
// Each frame, before the main render:
// - Reflection: the scene above the water is rendered from a camera mirrored in the water
//   plane (only what is marked reflectable: sky, banks, stones, plants, frogs, the fly,
//   nearby grass), at reduced resolution.
// - Refraction: what is under the water (the pond bed, weed, submerged legs: marked
//   underwater) is rendered from the main camera, clipped at the surface, with its depth.
// The surface shader then bends both by the ripples (drifting wind ripples and rings
// spreading from wherever the fly walks, raindrops land or frogs splash), mixes them by
// the Fresnel term, darkens and tints the view through the water by how much water it
// passes through (from the refraction depth), fades to the bank at the shoreline and adds
// glints of the sun.
import * as THREE from "three";

export const LAYER_REFLECT = 3;
export const LAYER_UNDER = 4;
const MAX_RIPPLES = 24;

/** Mark objects (and their children) as seen in the water's reflection. */
export function reflectable(obj) {
  obj.traverse((o) => o.layers.enable(LAYER_REFLECT));
}
/** Mark objects as seen through the water (under the surface). */
export function underwater(obj) {
  obj.traverse((o) => o.layers.enable(LAYER_UNDER));
}

// Ripples shared by the water surface and anything that lights the bed (caustics).
export const RIPPLE_GLSL = `
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), u.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), u.x), u.y);
}
// Height of the wind ripples (mm) at p (mm), time t (s).
float windRipples(vec2 p, float t) {
  float h = 0.0;
  h += 0.030 * sin(dot(p, vec2(0.21, 0.07)) - t * 1.9);
  h += 0.022 * sin(dot(p, vec2(-0.09, 0.26)) - t * 2.3);
  h += 0.015 * sin(dot(p, vec2(0.37, -0.29)) - t * 3.1);
  h += 0.040 * (wNoise(p * 0.08 + vec2(t * 0.11, t * 0.07)) - 0.5);
  h += 0.020 * (wNoise(p * 0.23 - vec2(t * 0.21, -t * 0.17)) - 0.5);
  h += 0.005 * (wNoise(p * 0.6 + vec2(t * 0.5, t * 0.3)) - 0.5);
  return h;
}
`;

export class PondWater {
  /**
   * geometry: the water surface (flat, any shape), already placed in world space at height z.
   * opts.scale: resolution of the reflection/refraction passes relative to the screen.
   */
  constructor(renderer, geometry, z, opts = {}) {
    this.z = z;
    this.scale = opts.scale ?? 0.5;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.round(size.x * this.scale)), h = Math.max(64, Math.round(size.y * this.scale));
    this.rtReflect = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    this.rtRefract = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    this.rtRefract.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    this.mirror = new THREE.PerspectiveCamera();
    this.under = new THREE.PerspectiveCamera();
    this.texMatrix = new THREE.Matrix4();
    this.ripples = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0));
    this.next = 0;
    this.time = 0;
    this.clip = [new THREE.Plane(new THREE.Vector3(0, 0, -1), z + 0.3)]; // keep what is below the surface
    this.uniforms = {
      tReflect: { value: this.rtReflect.texture },
      tRefract: { value: this.rtRefract.texture },
      tDepth: { value: this.rtRefract.depthTexture },
      uTexMatrix: { value: this.texMatrix },
      uResolution: { value: new THREE.Vector2(w, h) },
      uNearFar: { value: new THREE.Vector2(0.05, 2000) },
      uTime: { value: 0 },
      uRipples: { value: this.ripples },
      uSunDir: { value: new THREE.Vector3(0.3, -0.4, 0.86).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSkyColor: { value: new THREE.Color(0.55, 0.65, 0.72) },
      uCamPos: { value: new THREE.Vector3() },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
        uniform mat4 uTexMatrix;
        varying vec4 vReflCoord;
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vReflCoord = uTexMatrix * wp;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform sampler2D tReflect, tRefract, tDepth;
        uniform vec2 uResolution, uNearFar;
        uniform float uTime;
        uniform vec4 uRipples[${MAX_RIPPLES}];
        uniform vec3 uSunDir, uSunColor, uSkyColor, uCamPos;
        varying vec4 vReflCoord;
        varying vec3 vWorld;
        ${RIPPLE_GLSL}
        // Rings spreading from where something touched the water: a train of capillary
        // waves whose front moves out at ~120 mm/s and fades as it spreads.
        float rings(vec2 p) {
          float h = 0.0;
          for (int i = 0; i < ${MAX_RIPPLES}; i++) {
            vec4 r = uRipples[i];
            float age = uTime - r.z;
            if (age < 0.0 || age > 3.0 || r.w <= 0.0) continue;
            float d = length(p - r.xy), front = 4.0 + 120.0 * age;
            float env = exp(-pow((d - front) / (6.0 + 10.0 * age), 2.0));
            h += r.w * 0.35 * env * sin(1.1 * (d - front)) * exp(-1.4 * age) / (1.0 + 0.03 * front);
          }
          return h;
        }
        float heightAt(vec2 p) { return windRipples(p, uTime) + rings(p); }
        float linearDepth(float d) { float n = uNearFar.x, f = uNearFar.y; return n * f / (f - d * (f - n)); }
        void main() {
          vec2 p = vWorld.xy;
          float e = 0.35;
          float h0 = heightAt(p);
          vec3 n = normalize(vec3(-(heightAt(p + vec2(e, 0.0)) - h0) / e, -(heightAt(p + vec2(0.0, e)) - h0) / e, 1.0));
          vec3 V = normalize(uCamPos - vWorld);
          vec2 suv = gl_FragCoord.xy * ${this.scale.toFixed(3)} / vec2(textureSize(tRefract, 0)); // screen uv
          // How much water the view passes through, from the refraction pass's depth.
          float sceneD = linearDepth(texture2D(tDepth, suv).r), waterD = linearDepth(gl_FragCoord.z);
          float thick = max(0.0, sceneD - waterD);
          // Refraction: bent by the ripples, less so in the shallows.
          vec2 rUV = suv + n.xy * 0.06 * clamp(thick / 25.0, 0.15, 1.0);
          if (linearDepth(texture2D(tDepth, rUV).r) < waterD) rUV = suv; // don't pull in what's above the water
          vec3 refr = texture2D(tRefract, rUV).rgb;
          // Light lost and scattered in the water: clear in the shallows, peaty green-brown deeper.
          float path = linearDepth(texture2D(tDepth, rUV).r) - waterD;
          vec3 absorb = exp(-max(path, 0.0) * vec3(0.038, 0.019, 0.028));
          vec3 scatter = vec3(0.045, 0.07, 0.05);
          refr = refr * absorb + scatter * (1.0 - absorb.g);
          // Reflection: the mirrored scene, wobbled by the same ripples.
          vec4 rc = vReflCoord; rc.xy += n.xy * 0.045 * rc.w;
          vec3 refl = texture2DProj(tReflect, rc).rgb;
          float cosT = clamp(dot(n, V), 0.0, 1.0);
          float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
          vec3 col = mix(refr, refl, F);
          // Glints of the sun on the ripples.
          vec3 R = reflect(-V, n);
          col += uSunColor * pow(max(dot(R, uSunDir), 0.0), 600.0) * 6.0;
          col += uSunColor * pow(max(dot(R, uSunDir), 0.0), 60.0) * 0.08;
          // The shoreline: thin water fades into the wet bank.
          float a = smoothstep(0.0, 1.6, thick);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.resizeTo = new THREE.Vector2();
  }

  /** Something touched the water at (x, y): a ring of ripples of this strength (~0.2 .. 2). */
  addRipple(x, y, strength = 1) {
    this.ripples[this.next].set(x, y, this.time, strength);
    this.next = (this.next + 1) % MAX_RIPPLES;
  }

  /** Is (x, y) open water (inside the surface's outline)? Set by the caller. */
  contains(x, y) {
    return this.isWater ? this.isWater(x, y) : false;
  }

  /** Render the reflection and refraction for this frame. */
  prerender(renderer, scene, camera, timeS, sun) {
    if (!this.mesh.visible || !this.mesh.parent?.visible) return;
    this.time = timeS;
    const u = this.uniforms;
    u.uTime.value = timeS;
    u.uCamPos.value.copy(camera.position);
    u.uNearFar.value.set(camera.near, camera.far);
    if (sun) u.uSunDir.value.copy(sun.position).sub(sun.target.position).normalize();
    // Keep the passes at the screen's aspect and resolution.
    const size = renderer.getDrawingBufferSize(this.resizeTo);
    const w = Math.max(64, Math.round(size.x * this.scale)), h = Math.max(64, Math.round(size.y * this.scale));
    if (w !== this.rtReflect.width || h !== this.rtReflect.height) {
      this.rtReflect.setSize(w, h);
      this.rtRefract.setSize(w, h);
      u.uResolution.value.set(w, h);
    }
    // Camera below the water? (can't happen in the arena) Nothing to reflect then.
    const camZ = camera.position.z;
    const prevTarget = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes, prevLocal = renderer.localClippingEnabled;
    this.mesh.visible = false;
    if (camZ > this.z + 0.01) {
      // ---------- reflection: a camera mirrored in the plane z = this.z ----------
      const m = this.mirror;
      m.copy(camera, false);
      m.position.set(camera.position.x, camera.position.y, 2 * this.z - camZ);
      const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      look.z = -look.z;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      up.z = -up.z;
      m.up.copy(up);
      m.lookAt(m.position.clone().add(look));
      m.updateMatrixWorld(true);
      m.projectionMatrix.copy(camera.projectionMatrix);
      // Oblique near plane at the water, so nothing below it shows in the reflection.
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.z).applyMatrix4(m.matrixWorldInverse);
      const c = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const pm = m.projectionMatrix.elements;
      const q = new THREE.Vector4((Math.sign(c.x) + pm[8]) / pm[0], (Math.sign(c.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
      c.multiplyScalar(2 / c.dot(q));
      pm[2] = c.x; pm[6] = c.y; pm[10] = c.z + 1 - 0.003; pm[14] = c.w;
      m.projectionMatrixInverse.copy(m.projectionMatrix).invert();
      this.texMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
        .multiply(m.projectionMatrix).multiply(m.matrixWorldInverse);
      m.layers.set(LAYER_REFLECT);
      renderer.setRenderTarget(this.rtReflect);
      renderer.clear();
      renderer.render(scene, m);
    }
    // ---------- refraction: what is under the surface, from the main camera ----------
    const un = this.under;
    un.copy(camera, false);
    un.layers.set(LAYER_UNDER);
    renderer.clippingPlanes = this.clip;
    renderer.setRenderTarget(this.rtRefract);
    renderer.clear();
    renderer.render(scene, un);
    renderer.clippingPlanes = prevClip;
    renderer.localClippingEnabled = prevLocal;
    renderer.setRenderTarget(prevTarget);
    this.mesh.visible = true;
  }
}
