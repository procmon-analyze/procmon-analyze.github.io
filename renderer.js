const VERTEX_NUM_COMPONENTS = 4; // x, y, z, fill
const VERTICES_PER_RECT = 6; // two triangles - probably the least efficient thing we could do
const DEFAULT_VERTEX_BUFFER_NUM_VERTICES = 25000;
const DEFAULT_VERTEX_BUFFER_SIZE = DEFAULT_VERTEX_BUFFER_NUM_VERTICES * VERTEX_NUM_COMPONENTS;
const VERTEX_CHUNK_SIZE = 250000;

function printMatrix(mat) {
  let strs = mat.map(x => x.toString());
  let maxLen = 0;
  for (let s of strs) {
    if (s.length > maxLen) {
      maxLen = s.length;
    }
  }

  function padRight(str, length) {
    while (str.length < length) {
      str += " ";
    }
    return str;
  }

  let m = strs.map(s => padRight(s, maxLen));
  console.log(`|${m[0]} ${m[3]} ${m[6]}|\n|${m[0 + 1]} ${m[3 + 1]} ${m[6 + 1]}|\n|${m[0 + 2]} ${m[3 + 2]} ${m[6 + 2]}|`);
}

function vecTimesScalar(vec, scalar) {
  let result = new Float32Array(vec);
  result[0] *= scalar;
  result[1] *= scalar;
  result[2] *= scalar;
  return result;
}

function vecPlusVec(vec, otherVec) {
  let result = new Float32Array(vec);
  result[0] += otherVec[0];
  result[1] += otherVec[1];
  result[2] += otherVec[2];
  return result;
}

function matTimesVec(matrix, vec) {
  let result = vecTimesScalar(matrix.slice(0, 3), vec[0]);
  result = vecPlusVec(result, vecTimesScalar(matrix.slice(3, 6), vec[1]));
  result = vecPlusVec(result, vecTimesScalar(matrix.slice(6, 9), vec[2]));
  return result;
}

function matTimesMat(matrix, otherMatrix) {
  let result = new Float32Array(9);
  result.set(matTimesVec(matrix, otherMatrix.slice(0, 3)), 0);
  result.set(matTimesVec(matrix, otherMatrix.slice(3, 6)), 3);
  result.set(matTimesVec(matrix, otherMatrix.slice(6, 9)), 6);
  return result;
}

class Matrix3x3 {
  constructor(vals) {
    this.vals = vals;
  }

  timesVec(vec) {
    let result = 0;
    result += this.vals[0]
  }
}

function Renderer(canvas) {
  let gl = null;
  let glCanvas = canvas;
  let shaderProgram = null;
  let aspectRatio;
  let viewTranslation = [0.0, 0.0];
  let viewScale = [1.0, 1.0];
  let worldScale = [1.0, 1.0];
  let worldTranslation = [0.0, 0.0];
  let uTransform;
  let uGlobalColor;
  let aVertexData;

  let rectsByColor = {};
  let generationId = 1;

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
    let match = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
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
    worldScale = [scaleX, scaleY];
  }

  window.translate = translate;
  window.draw = draw;

  function translate(translateX, translateY) {
    worldTranslation = [translateX, translateY];
  }

  function getIdentityMatrix() {
    return new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
  }

  function getScaleMatrix(scale) {
    return new Float32Array([
      scale[0], 0, 0,
      0, scale[1], 0,
      0, 0, 1,
    ]);
  }

  function getTranslationMatrix(translation) {
    return new Float32Array([
      1, 0, 0,
      0, 1, 0,
      translation[0], translation[1], 1,
    ]);
  }

  function draw() {
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(shaderProgram);

    uTransform =
        gl.getUniformLocation(shaderProgram, "uTransform");
    uGlobalColor =
        gl.getUniformLocation(shaderProgram, "uGlobalColor");
    aVertexData =
        gl.getAttribLocation(shaderProgram, "aVertexData");

    let transform = getTranslationMatrix(worldTranslation);
    transform = matTimesMat(getScaleMatrix(worldScale), transform);
    transform = matTimesMat(getTranslationMatrix(viewTranslation), transform);
    transform = matTimesMat(getScaleMatrix(viewScale), transform);

    gl.uniformMatrix3fv(uTransform, false, transform);

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

    viewTranslation = [-glCanvas.width / 2.0, -glCanvas.height / 2.0];
    viewScale = [2.0 / glCanvas.width, -2.0 / glCanvas.height];
  }

  return {
    startup,
    pushRect,
    maybeMutateRect,
    draw,
    scale,
    translate,
    clearAll,
  };
}

export default Renderer;
