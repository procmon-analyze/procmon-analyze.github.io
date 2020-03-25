const VERTEX_NUM_COMPONENTS = 4; // x, y, z, fill
const VERTICES_PER_RECT = 6; // two triangles - probably the least efficient thing we could do
const DEFAULT_VERTEX_BUFFER_NUM_VERTICES = 25000;
const DEFAULT_VERTEX_BUFFER_SIZE = DEFAULT_VERTEX_BUFFER_NUM_VERTICES * VERTEX_NUM_COMPONENTS;
const VERTEX_CHUNK_SIZE = 250000;

let gl = null;
let glCanvas = null;
let shaderProgram = null;
let aspectRatio;
let defaultTranslation = [0.0, 0.0];
let defaultScale = [1.0, 1.0];
let userScale = [1.0, 1.0];
let userTranslation = [0.0, 0.0];
let uTranslation;
let uScalingFactor;
let uGlobalColor;
let aVertexData;

let rectsByColor = {};

window.addEventListener("load", startup, false);

function compileShader(id, type) {
  let code = document.getElementById(id).firstChild.nodeValue;
  let shader = gl.createShader(type);

  gl.shaderSource(shader, code);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.log(`Error compiling ${type === gl.VERTEX_SHADER ? "vertex" : "fragment"} shader:`);
    console.log(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function buildShaderProgram(shaderInfo) {
  let program = gl.createProgram();

  shaderInfo.forEach(desc => {
    let shader = compileShader(desc.id, desc.type);

    if (shader) {
      gl.attachShader(program, shader);
    }
  });

  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.log("Error linking shader program:");
    console.log(gl.getProgramInfoLog(program));
  }

  return program;
}

function hexToColorArray(color) {
  let match = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(color);
  function parseAndNormalize(hexVal) {
    return parseInt(hexVal, 16) / 255;
  }
  return [
    parseAndNormalize(match[1]),
    parseAndNormalize(match[2]),
    parseAndNormalize(match[3]),
    1.0
  ];
}

function makeRectsObj() {
  let result = {};
  result.vertexArray = new Float32Array(DEFAULT_VERTEX_BUFFER_SIZE);
  result.vertexBuffer = gl.createBuffer();
  result.vertexCount = 0;
  result.hasAlpha = false;
  gl.bindBuffer(gl.ARRAY_BUFFER, result.vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, result.vertexArray, gl.STATIC_DRAW);
  return result;
}

function pushVertex(rectsObj, x, y, z, fill) {
  let startIndex = rectsObj.vertexCount++;
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 0] = x;
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 1] = y;
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 2] = z;
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 3] = fill;
}

function pushRect(cssColor, x, y, width, height, depth, fill = 1.0) {
  if (!rectsByColor[cssColor]) {
    rectsByColor[cssColor] = makeRectsObj();
  }
  let rectsObj = rectsByColor[cssColor];
  if (rectsObj.vertexCount + VERTICES_PER_RECT >=
      rectsObj.vertexArray.length / VERTEX_NUM_COMPONENTS) {
    let oldArray = rectsObj.vertexArray;
    rectsObj.vertexArray = new Float32Array(oldArray.length * 2);
    rectsObj.vertexArray.set(oldArray);
  }

  if (fill != 1.0) {
    rectsObj.hasAlpha = true;
  }

  pushVertex(rectsObj, x, y, depth, fill);
  pushVertex(rectsObj, x, y + height, depth, fill);
  pushVertex(rectsObj, x + width, y + height, depth, fill);
  pushVertex(rectsObj, x, y, depth, fill);
  pushVertex(rectsObj, x + width, y + height, depth, fill);
  pushVertex(rectsObj, x + width, y, depth, fill);
}

function clearAll() {
  for (let [cssColor, rectsObj] of Object.entries(rectsByColor)) {
    rectsObj.vertexCount = 0;
    rectsObj.hasAlpha = false;
  }
}

function scale(scaleX, scaleY) {
  userScale = [scaleX, scaleY];
}

window.translate = translate;
window.draw = draw;

function translate(translateX, translateY) {
  userTranslation = [translateX, translateY];
}

function draw() {
  gl.viewport(0, 0, glCanvas.width, glCanvas.height);
  gl.clearColor(1.0, 1.0, 1.0, 1.0);
  gl.clearDepth(1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(shaderProgram);

  uScalingFactor =
      gl.getUniformLocation(shaderProgram, "uScalingFactor");
  uTranslation =
      gl.getUniformLocation(shaderProgram, "uTranslation");
  uGlobalColor =
      gl.getUniformLocation(shaderProgram, "uGlobalColor");
  aVertexData =
      gl.getAttribLocation(shaderProgram, "aVertexData");

  let scale = defaultScale.map((s, i) => s * userScale[i]);
  gl.uniform2fv(uScalingFactor, scale);
  gl.uniform2fv(uTranslation,
                defaultTranslation.map((t, i) => t + userTranslation[i]));

  for (let alphaPass of [false, true]) {
    if (alphaPass) {
      gl.enable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
    }

    for (let [cssColor, rectsObj] of Object.entries(rectsByColor)) {
      if (rectsObj.hasAlpha != alphaPass) {
        continue;
      }
      gl.uniform4fv(uGlobalColor, hexToColorArray(cssColor));

      gl.bindBuffer(gl.ARRAY_BUFFER, rectsObj.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,
                    rectsObj.vertexArray,
                    gl.STATIC_DRAW);

      gl.enableVertexAttribArray(aVertexData);
      gl.vertexAttribPointer(aVertexData, VERTEX_NUM_COMPONENTS,
            gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, rectsObj.vertexCount);
    }
  }
}

function startup() {
  glCanvas = document.getElementById("canvas");
  gl = glCanvas.getContext("webgl", { alpha: false });

  const shaderSet = [
    {
      type: gl.VERTEX_SHADER,
      id: "vertex-shader"
    },
    {
      type: gl.FRAGMENT_SHADER,
      id: "fragment-shader"
    }
  ];

  shaderProgram = buildShaderProgram(shaderSet);

  defaultTranslation = [-glCanvas.width / 2.0, -glCanvas.height / 2.0];
  defaultScale = [2.0 / glCanvas.width, -2.0 / glCanvas.height];
}

export default {
  startup,
  pushRect,
  draw,
  scale,
  translate,
  clearAll,
};