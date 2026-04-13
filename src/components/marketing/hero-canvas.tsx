/**
 * WebGL hero background shader.
 * Based on "Bass Ripple" by Paul Bakaus (Radiant Shaders, MIT license).
 * https://radiant-shaders.com/shader/bass-ripple
 * https://github.com/pbakaus/radiant
 */

import { useEffect, useRef } from 'react';

const VERT_SRC =
  'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0,1);}';

const FRAG_SRC = /* glsl */ `
precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_bassFreq;
uniform float u_bassIntensity;
uniform vec2 u_mouse;

#define PI 3.14159265359
#define TAU 6.28318530718

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float hash3(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
mat2 rot2(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}

float displacement(vec2 p,float t,float bassFreq,float intensity){
  float period=1.0/max(bassFreq,0.01);
  float phase=t/period;
  float beatFrac=fract(phase);
  float envelope=exp(-beatFrac*3.5);
  float prevEnv=exp(-(beatFrac+1.0)*3.5);
  float prevEnv2=exp(-(beatFrac+2.0)*3.5);
  float dist=length(p);
  float angle=atan(p.y,p.x);

  float wave1=sin(dist*14.0-beatFrac*22.0)*envelope;
  float wave2=sin(dist*9.0-(beatFrac+1.0)*16.0)*prevEnv*0.6;
  float wave3=sin(dist*6.0-(beatFrac+2.0)*12.0)*prevEnv2*0.3;
  float standing=(sin(p.x*18.0)*sin(p.y*18.0))*envelope*0.3;
  float radialMode=sin(dist*22.0)*cos(angle*3.0)*envelope*0.2;
  radialMode+=sin(dist*16.0)*cos(angle*5.0+1.0)*prevEnv*0.1;

  vec2 offCenter=vec2(0.3*sin(t*0.2),0.25*cos(t*0.25));
  float dist2=length(p-offCenter);
  float wave6=sin(dist2*12.0-beatFrac*18.0)*envelope*0.35;

  float mouseWave=0.0;
  if(u_mouse.x>0.0){
    vec2 mouseNorm=(u_mouse/u_res-0.5)*vec2(u_res.x/u_res.y,1.0);
    float mouseDist=length(p-mouseNorm);
    mouseWave=sin(mouseDist*16.0-beatFrac*20.0)*envelope*0.7;
    mouseWave+=sin(mouseDist*10.0-(beatFrac+1.0)*14.0)*prevEnv*0.4;
    mouseWave*=1.0/(1.0+mouseDist*3.0);
  }

  float dome=(1.0-smoothstep(0.0,1.0,dist))*envelope*0.8;
  float h=(wave1+wave2+wave3+standing+radialMode+wave6+mouseWave+dome)*intensity;

  float idle=sin(dist*8.0+t*3.0)*0.03*(1.0-envelope);
  idle+=sin(dist*5.0-t*1.5)*0.015*(1.0-envelope);
  h+=idle*intensity;
  return h;
}

vec3 calcNormal(vec2 p,float t,float bassFreq,float intensity,float hc){
  float eps=0.002;
  float hx=displacement(p+vec2(eps,0.0),t,bassFreq,intensity);
  float hy=displacement(p+vec2(0.0,eps),t,bassFreq,intensity);
  return normalize(vec3(-(hx-hc)/eps*0.35,-(hy-hc)/eps*0.35,1.0));
}

vec3 hexGrid(vec2 p,float scale){
  p*=scale;
  vec2 r=vec2(1.0,1.732);
  vec2 h=r*0.5;
  vec2 a=mod(p,r)-h;
  vec2 b=mod(p-h,r)-h;
  vec2 g=dot(a,a)<dot(b,b)?a:b;
  float edgeDist=0.5-max(abs(g.x)*1.0+abs(g.y)*0.577,abs(g.y)*1.155);
  vec2 cellId=p-g;
  return vec3(edgeDist,cellId);
}

float fresnel(float cosTheta,float f0){
  return f0+(1.0-f0)*pow(1.0-cosTheta,5.0);
}

void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  float aspect=u_res.x/u_res.y;
  float t=u_time;
  vec2 cuv=vec2((uv.x-0.5)*aspect,uv.y-0.5);

  float camDriftX=sin(t*0.15)*0.03;
  float camDriftY=cos(t*0.12)*0.02;
  float foreshorten=0.7+camDriftY*0.5;

  vec2 meshUV=cuv;
  meshUV.x+=camDriftX;
  meshUV.y=meshUV.y/foreshorten;
  meshUV.y+=0.08;
  meshUV=rot2(0.06+sin(t*0.08)*0.02)*meshUV;

  float h=displacement(meshUV,t,u_bassFreq,u_bassIntensity);
  vec3 N=calcNormal(meshUV,t,u_bassFreq,u_bassIntensity,h);

  float meshScale=45.0;
  vec3 hex=hexGrid(meshUV+N.xy*0.003,meshScale);
  float hexEdge=hex.x;
  float wireWidth=0.06;
  float wire=1.0-smoothstep(0.0,wireWidth,hexEdge);
  float hole=smoothstep(wireWidth,wireWidth+0.02,hexEdge);

  vec2 microGrid=fract(meshUV*meshScale*3.0+N.xy*0.01);
  float microWire=smoothstep(0.04,0.0,min(microGrid.x,microGrid.y));
  microWire+=smoothstep(0.04,0.0,min(1.0-microGrid.x,1.0-microGrid.y));
  microWire*=0.15;

  vec3 V=normalize(vec3(-cuv.x*0.3,-cuv.y*0.3+0.2,1.0));

  float period=1.0/max(u_bassFreq,0.01);
  float bFrac=fract(t/period);
  float bEnv=exp(-bFrac*3.5);

  vec3 L1=normalize(vec3(0.4+sin(t*0.25)*0.4,0.6+cos(t*0.18)*0.3,1.0));
  float NdL1=max(dot(N,L1),0.0);
  vec3 H1=normalize(L1+V);
  float NdH1=max(dot(N,H1),0.0);
  float spec1=pow(NdH1,180.0);
  float spec1med=pow(NdH1,50.0);
  float spec1soft=pow(NdH1,12.0);
  vec3 lightCol1=vec3(1.0,0.4,0.55);

  vec3 L2=normalize(vec3(-0.8+sin(t*0.15)*0.2,0.4,0.8));
  float NdL2=max(dot(N,L2),0.0);
  vec3 H2=normalize(L2+V);
  float NdH2=max(dot(N,H2),0.0);
  float spec2=pow(NdH2,120.0);
  float spec2soft=pow(NdH2,25.0);
  vec3 lightCol2=vec3(0.9,0.2,0.45);

  vec3 L3=normalize(vec3(0.3+bEnv*0.3,-0.6,0.6));
  float NdL3=max(dot(N,L3),0.0);
  vec3 H3=normalize(L3+V);
  float NdH3=max(dot(N,H3),0.0);
  float spec3=pow(NdH3,90.0);
  float spec3soft=pow(NdH3,18.0);
  vec3 lightCol3=vec3(1.0,0.35,0.5);

  vec3 L4=normalize(vec3(0.0,0.1,1.0));
  float NdL4=max(dot(N,L4),0.0);
  float NdV=max(dot(N,V),0.0);
  float rim=pow(1.0-NdV,4.0);
  vec3 rimCol=vec3(0.95,0.3,0.5);

  vec3 baseColor=vec3(0.32,0.26,0.28);
  baseColor+=vec3(0.025,0.018,0.025)*noise(meshUV*30.0);
  baseColor+=vec3(0.015,0.01,0.015)*noise(meshUV*80.0+5.0);
  float f0=0.75;
  float fres=fresnel(NdV,f0);

  vec3 diffuse=baseColor*(NdL1*lightCol1*1.0+NdL2*lightCol2*0.5+NdL3*lightCol3*0.25+NdL4*0.4);
  diffuse+=baseColor*0.18;
  vec3 hemiAmb=mix(vec3(0.03,0.025,0.03),vec3(0.06,0.04,0.05),N.y*0.5+0.5);
  diffuse+=hemiAmb;

  vec3 specular=vec3(0.0);
  specular+=spec1*lightCol1*2.8;
  specular+=spec1med*lightCol1*1.0;
  specular+=spec1soft*lightCol1*0.2;
  specular+=spec2*lightCol2*2.0;
  specular+=spec2soft*lightCol2*0.4;
  specular+=spec3*lightCol3*2.5;
  specular+=spec3soft*lightCol3*0.35;
  specular*=fres;
  specular*=1.0+bEnv*1.0*u_bassIntensity;

  float wireCenter=abs(hexEdge-wireWidth*0.5)/max(wireWidth,0.001);
  float aniso=pow(max(1.0-wireCenter,0.0),3.0);
  specular+=aniso*wire*vec3(0.45,0.35,0.4)*fres*0.4;

  vec3 wireCol=diffuse+specular;
  wireCol+=rim*rimCol*0.5;
  wireCol+=microWire*vec3(0.12,0.08,0.1)*fres;

  vec3 holeCol=vec3(0.012,0.008,0.012);
  float coneRefl=max(dot(N,vec3(0.0,0.0,1.0)),0.0);
  holeCol+=vec3(0.02,0.015,0.02)*coneRefl;
  float conePush=max(h*0.4,0.0);
  holeCol+=vec3(0.04,0.025,0.04)*conePush;
  holeCol+=vec3(0.2,0.05,0.12)*bEnv*0.25*u_bassIntensity;
  holeCol+=vec3(0.12,0.03,0.08)*bEnv*0.1*u_bassIntensity;

  vec3 col=mix(holeCol,wireCol,wire);
  col+=microWire*vec3(0.02,0.015,0.022)*(1.0-hole*0.7);

  vec3 beatColor=mix(vec3(0.5,0.1,0.3),vec3(0.4,0.08,0.25),sin(t*0.4)*0.5+0.5);
  col+=beatColor*bEnv*0.02*u_bassIntensity;

  vec3 refl=reflect(-V,N);
  vec3 envCol=vec3(0.03,0.02,0.04);
  envCol+=vec3(0.08,0.05,0.08)*pow(max(refl.y,0.0),2.0);
  envCol+=vec3(0.1,0.05,0.08)*pow(max(-refl.x,0.0),2.0);
  envCol+=vec3(0.12,0.06,0.1)*pow(max(-refl.y,0.0),3.0);
  float softbox=pow(max(dot(refl,normalize(vec3(0.2,0.8,0.5))),0.0),8.0);
  envCol+=vec3(0.2,0.18,0.22)*softbox;
  envCol*=1.0+bEnv*0.5*u_bassIntensity;
  col+=envCol*fres*wire*0.5;

  vec2 vc=uv-0.5;
  float vig=1.0-dot(vc,vc)*2.5;
  vig=smoothstep(0.0,1.0,vig);
  col*=vig;

  float dofDist=length(cuv);
  float dof=smoothstep(0.3,0.8,dofDist);
  col=mix(col,col*vec3(0.7,0.65,0.75),dof*0.3);

  float grain=hash(gl_FragCoord.xy+fract(t*7.3)*100.0);
  col+=(grain-0.5)*0.018;

  float ca=dofDist*0.003;
  col.r+=(hash(gl_FragCoord.xy*0.5+1.0)-0.5)*ca;
  col.b+=(hash(gl_FragCoord.xy*0.5+2.0)-0.5)*ca;

  col*=0.25;
  col=col/(col+vec3(1.5));
  col=pow(max(col,vec3(0.0)),vec3(0.75));

  gl_FragColor=vec4(col,1.0);
}
`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  src: string
): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(s));
  }
  return s;
}

function setF(
  gl: WebGLRenderingContext,
  loc: WebGLUniformLocation | null,
  v: number
) {
  if (loc) gl.uniform1f(loc, v);
}

function set2F(
  gl: WebGLRenderingContext,
  loc: WebGLUniformLocation | null,
  x: number,
  y: number
) {
  if (loc) gl.uniform2f(loc, x, y);
}

export function HeroCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;

    const maybeGl = cvs.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!maybeGl) return;

    const gl: WebGLRenderingContext = maybeGl;
    const canvas: HTMLCanvasElement = cvs;
    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    const BASS_FREQ = 0.0;
    const BASS_INTENSITY = 0.5;
    let running = true;
    let mouseX = -1.0;
    let mouseY = -1.0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let needsResize = true;

    // Build program
    const prog = gl.createProgram();
    if (!prog) return;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return;

    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    // Full-screen triangle
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Uniform locations
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uBassFreq = gl.getUniformLocation(prog, 'u_bassFreq');
    const uBassIntensity = gl.getUniformLocation(prog, 'u_bassIntensity');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');

    function resize() {
      needsResize = false;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        set2F(gl, uRes, w, h);
      }
    }

    function render(now: number) {
      if (!running) return;
      if (needsResize) resize();
      setF(gl, uTime, prefersReduced ? 0.0 : now * 0.0015);
      setF(gl, uBassFreq, BASS_FREQ);
      setF(gl, uBassIntensity, BASS_INTENSITY);
      set2F(gl, uMouse, mouseX, mouseY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      requestAnimationFrame(render);
    }

    // Events
    function onResize() {
      needsResize = true;
    }
    function onMouseMove(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        mouseX = (e.clientX - rect.left) * dpr;
        mouseY = (rect.bottom - e.clientY) * dpr;
      }
    }
    function onPointerLeave() {
      mouseX = -1.0;
      mouseY = -1.0;
    }
    function onTouchMove(e: TouchEvent) {
      const touch = e.touches[0];
      if (!touch) return;
      const rect = canvas.getBoundingClientRect();
      mouseX = (touch.clientX - rect.left) * dpr;
      mouseY = (rect.bottom - touch.clientY) * dpr;
    }
    function onVisibility() {
      if (document.hidden) {
        running = false;
      } else {
        running = true;
        requestAnimationFrame(render);
      }
    }

    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onPointerLeave);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibility);

    resize();
    requestAnimationFrame(render);

    return () => {
      running = false;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onPointerLeave);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 size-full"
      aria-hidden="true"
    />
  );
}
