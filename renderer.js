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
let generationId = 1;

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

function setVertex(rectsObj, startIndex, x, y, z, fill) {
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 0] = x;
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 1] = y;
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 2] = z;
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 3] = fill;
}

function setVertexFill(rectsObj, startIndex, fill) {
  rectsObj.vertexArray[startIndex * VERTEX_NUM_COMPONENTS + 3] = fill;
}

function maybeMutateRect(handle, fill) {
  if (handle && handle.generationId == generationId) {
    let rectsObj = rectsByColor[handle.cssColor];
    if (fill != 1.0) {
      rectsObj.hasAlpha = true;
    }
    setVertexFill(rectsObj, handle.startIndex + 0, fill);
    setVertexFill(rectsObj, handle.startIndex + 1, fill);
    setVertexFill(rectsObj, handle.startIndex + 2, fill);
    setVertexFill(rectsObj, handle.startIndex + 3, fill);
    setVertexFill(rectsObj, handle.startIndex + 4, fill);
    setVertexFill(rectsObj, handle.startIndex + 5, fill);
    return true;
  } else {
    return false;
  }
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

    gl.bindBuffer(gl.ARRAY_BUFFER, rectsObj.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
                  rectsObj.vertexArray,
                  gl.STATIC_DRAW);
  }

  if (fill != 1.0) {
    rectsObj.hasAlpha = true;
  }

  let startIndex = rectsObj.vertexCount;
  rectsObj.vertexCount += VERTICES_PER_RECT;
  setVertex(rectsObj, startIndex + 0, x, y, depth, fill);
  setVertex(rectsObj, startIndex + 1, x, y + height, depth, fill);
  setVertex(rectsObj, startIndex + 2, x + width, y + height, depth, fill);
  setVertex(rectsObj, startIndex + 3, x, y, depth, fill);
  setVertex(rectsObj, startIndex + 4, x + width, y + height, depth, fill);
  setVertex(rectsObj, startIndex + 5, x + width, y, depth, fill);

  return {cssColor, startIndex, generationId};
}

function clearAll() {
  generationId++;
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
  gl.clearColor(0.5, 0.5, 0.5, 1.0);
  gl.clearDepth(1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.disable(gl.CULL_FACE);

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
      gl.depthFunc(gl.LESS);
      gl.disable(gl.BLEND);
    }

    for (let [cssColor, rectsObj] of Object.entries(rectsByColor)) {
      if (rectsObj.hasAlpha != alphaPass) {
        continue;
      }
      gl.uniform4fv(uGlobalColor, hexToColorArray(cssColor));
      gl.bindBuffer(gl.ARRAY_BUFFER, rectsObj.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, rectsObj.vertexArray, gl.STATIC_DRAW);

      gl.enableVertexAttribArray(aVertexData);
      gl.vertexAttribPointer(aVertexData, VERTEX_NUM_COMPONENTS,
            gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, rectsObj.vertexCount);
    }
  }
}

function startup() {
  glCanvas = document.getElementById("canvas");
  gl = glCanvas.getContext("webgl");

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
  maybeMutateRect,
  draw,
  scale,
  translate,
  clearAll,
};