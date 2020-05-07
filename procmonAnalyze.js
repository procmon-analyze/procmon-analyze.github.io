import {parseCSV} from "./parseCSV.js"
import {parseProcmonXML} from "./parseProcmonXML.js"
import {parseDiskify} from "./parseDiskify.js"
import {
  extractProfileMarkers,
  symbolicateStacks,
  nameThreadsAndProcesses
} from "./processProfile.js"
import Renderer from "./renderer.js"

const BACKGROUND_DEPTH = 0.9;
const TRACK_GUTTER_DEPTH = 0.8;
const FOREGROUND_DEPTH = 0.7;
const HOVERED_ENTRY_FILL = 0.9;
const FILTERED_OUT_ENTRY_FILL = 0.7;
const MAX_DETAIL_LINES = 24;
const ASSUMED_CLUSTER_SIZE = 4096;

const csvInput = document.getElementById("csvfile");
const diskifyInput = document.getElementById("diskifyfile");
const profilerInput = document.getElementById("profilerfile");
const tooltip = document.getElementById("tooltip");
const searchbar = document.getElementById("searchbar-input");
const colorBySelect = document.getElementById("color-by-select");
const timeline = document.getElementById("timeline");
const canvas = document.getElementById("canvas");
const fsmapCanvas = document.getElementById("fsmap-canvas");
const diskmapCanvas = document.getElementById("diskmap-canvas");
const readInfo = document.getElementById("read-info");
const tools = document.getElementById("tools");

const renderer = new Renderer(canvas);
const fsmapRenderer = new Renderer(fsmapCanvas);
const diskmapRenderer = new Renderer(diskmapCanvas);

canvas.width = window.innerWidth * 0.5;
canvas.height = window.innerHeight - 16;

fsmapCanvas.width = window.innerWidth * 0.025;
fsmapCanvas.height = window.innerHeight - 16;

diskmapCanvas.width = window.innerWidth * 0.025;
diskmapCanvas.height = window.innerHeight - 16;

const VIEWPORT_BUFFER = canvas.height;

let headerMap = {
  "Time of Day": "time",
  "Process Name": "processName",
  "PID": "pid",
  "TID": "tid",
  "Detail": "detail",
  "Operation": "operation",
  "Path": "path",
  "Duration": "duration",
};

function parseTimeString(str) {
  let match = /([0-9]+):([0-9]+):([0-9.]+)/.exec(str);
  if (!match) {
    throw new Error("Failed to parse time: " + str);
  }

  let hours = parseInt(match[1]);
  let minutes = parseInt(match[2]);
  let seconds = parseFloat(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

let colors = [
  "#4736fc",
  "#e4ba6e",
  "#623b1a",
  "#8fb0e9",
  "#857ebb",
  "#7fcbd7",
  "#427975",
  "#72b37e",
];

let lastColorIndex = -1;
let entryColors = {};

const COLOR_BY_OPERATION = 1;
const COLOR_BY_PID = 2;
const COLOR_BY_TID = 3;
let colorBy = getColorByKey();

let gState = null;

function colorArrayToHex(colorArray) {
  function denormalizeAndStringify(c) {
    let x = Math.min(255, Math.floor(c * 255)).toString(16);
    if (x.length < 2) {
      x = "0" + x;
    }
    return x;
  }
  return "#" +
    denormalizeAndStringify(colorArray[0]) +
    denormalizeAndStringify(colorArray[1]) +
    denormalizeAndStringify(colorArray[2]);
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

const red = [.9,.2,.1];
const blue = [.2,.1,.9];
const green = [.2,.9,.2];
function redBlueLerp(x) {
  let result = new Array(red.length);
  for (let i = 0; i < red.length; i++) {
    result[i] = red[i] * x + blue[i] * (1 - x);
  }
  return result;
}

function blueGreenLerp(x) {
  let result = new Array(blue.length);
  for (let i = 0; i < blue.length; i++) {
    result[i] = blue[i] * x + green[i] * (1 - x);
  }
  return result;
}

function gbrLerp(x) {
  return x < 0.5 ? blueGreenLerp(x * 2) : redBlueLerp(x * 2 - 1);
}

function darkenColor(color, amount) {
  var colorArray = hexToColorArray(color);
  var darkenFactor = 1 - amount;
  colorArray[0] *= darkenFactor;
  colorArray[1] *= darkenFactor;
  colorArray[2] *= darkenFactor;
  let result = colorArrayToHex(colorArray);
  return result;
}

function getColor(entry) {
  let {operation, tid, pid} = entry;

  let colorKey = null;
  switch (colorBy) {
    case COLOR_BY_OPERATION: colorKey = operation; break;
    case COLOR_BY_PID: colorKey = pid; break;
    case COLOR_BY_TID: colorKey = tid; break;
    default: throw new Error("Unsupported color by setting.");
  }

  if (!entryColors[colorKey]) {
    let index = ++lastColorIndex;
    let color = colors[index % colors.length];
    if (index > colors.length) {
      color = darkenColor(color, Math.min(0.9, Math.floor(index / colors.length) * 0.05));
    }
    entryColors[colorKey] = color;
  }
  return entryColors[colorKey];
}

function parseReadDetail(detail) {
  let pattern = /Offset: ([0-9,]+) Length: ([0-9,]+)/;
  let match = pattern.exec(detail);
  if (match) {
    return {
      offset: parseInt(match[1].replace(/,/g, "")),
      length: parseInt(match[2].replace(/,/g, "")),
    };
  } else {
    console.error("Couldn't parse detail: " + detail);
    return null;
  }
}

async function drawData(data, diskify) {
  document.getElementById("chooserWrapper").style.display = "none";
  tools.style.display = "block";

  let tracks = [];
  let minTime = Number.MAX_VALUE;
  let maxTime = -1;

  let totalTimeByOperation = {};
  let readsByPath = {};

  for (let row of data) {
    let {
      operation,
      path,
      pid,
      tid,
      pName,
      tName,
      start,
      duration,
      detail,
      processName,
      stack,
    } = row;
    let end = start + duration;

    if (start < minTime) {
      if (minTime != Number.MAX_VALUE) {
        throw new Error("Data should be ordered by start time.");
      }
      minTime = start;
    }
    if (end > maxTime) {
      maxTime = end;
    }

    let track = null;
    let entry = null;

    if (!totalTimeByOperation[operation]) {
      totalTimeByOperation[operation] = 0;
    }

    totalTimeByOperation[operation] += duration;
    let fromProfiler = operation.startsWith("ProfilerMarker");
    for (let candidate of tracks) {
      if (operation == candidate.operation) {
        let lastEntry = candidate.entries[candidate.entries.length - 1];
        if (start > lastEntry.end) {
          track = candidate;
          break;
        } else if (path == lastEntry.path &&
                   pid == lastEntry.pid &&
                   tid == lastEntry.tid &&
                   (!fromProfiler ||
                     lastEntry.detail == detail)) {

          lastEntry.end = end;
          if (!fromProfiler) {
            lastEntry.detail += "\n" + detail;
          }
          track = candidate;
          entry = lastEntry;
          break;
        }
      }
    }

    if (!entry) {
      if (!track) {
        track = {operation, entries: [], fromProfiler};
        tracks.push(track);
      }
      entry = {
        start,
        end,
        path,
        pid,
        tid,
        pName,
        tName,
        detail,
        processName,
        operation,
        track,
        stack,
        hiddenBySearch: false,
        rectHandle: null,
      };

      track.entries.push(entry);
    }

    if (operation == "ReadFile" && detail) {
      let readDetail = parseReadDetail(detail);
      let readStart = readDetail.offset;
      let readEnd = readDetail.offset + readDetail.length;
      if (readDetail.length != 524288) {
        if (!readsByPath[path]) {
          readsByPath[path] = {
            reads:[],
            minAddress: readStart,
            maxAddress: readEnd,
            totalRead: 0,
          };
        }

        readsByPath[path].reads.push({readDetail, entry, start, end});
        if (readStart < readsByPath[path].minAddress) {
          readsByPath[path].minAddress = readStart;
        }
        if (readEnd > readsByPath[path].maxAddress) {
          readsByPath[path].maxAddress = readEnd;
        }
        readsByPath[path].totalRead += readDetail.length;
      }
    }
  }

  tracks.sort((lhs, rhs) => {
    // Ensure profiler tracks always show up at the end
    if (lhs.fromProfiler && !rhs.fromProfiler) {
      return 1;
    }
    if (rhs.fromProfiler && !lhs.fromProfiler) {
      return -1;
    }
    return totalTimeByOperation[rhs.operation] - totalTimeByOperation[lhs.operation];
  });

  for (let i = 0; i < tracks.length; i++) {
    tracks[i].index = i;
  }

  let maxLcn = 0;
  if (diskify) {
    for (let [path, entries] of Object.entries(diskify)) {
      for (let [start, length] of entries) {
        if (start + length > maxLcn) {
          maxLcn = start + length;
        }
      }
    }
  }
  let diskmapScale = diskmapCanvas.height / maxLcn;

  let totalTime = maxTime - minTime;
  let trackWidth = canvas.width / tracks.length;
  let rendererScale = canvas.height / totalTime;
  gState = {
    minTime,
    maxTime,
    tracks,
    totalTime,
    trackWidth,
    rendererScale,
    targetRendererScale: rendererScale,
    diskmapScale,
    targetDiskmapScale: diskmapScale,
    readsByPath,
    diskify,
    maxLcn,
    diskmapTranslate: 0,
    targetDiskmapTranslate: 0,
    rendererTranslate: 0,
    targetRendererTranslate: 0,
    mouseX: 0,
    mouseY: 0,
    timelineIndicators: [],
    lcnReads: [],
    lastHoveredRect: null,
    selectedEntry: null,
    activePath: null,
  };

  renderer.scale(trackWidth, rendererScale);
  renderer.translate(0, 0);

  renderer.clearAll();
  drawBackground();
  drawForeground();
  renderer.draw();

  drawTopPathsInfo();
  scheduleRedrawDiskmap();
}

function drawBackground() {
  let {
    trackWidth,
    minTime,
    maxTime,
    tracks,
    totalTime,
    rendererTranslate,
    rendererScale
  } = gState;

  let timelineScale =
    rendererScale < 1000 ? 1 :
    rendererScale < 10000 ? 0.1 :
    rendererScale < 100000 ? 0.01 : 0.001;

  for (let i = 0; i < Math.ceil(totalTime / timelineScale); i++) {
    let color = (i & 1) ? "#ffffff" : "#efefef";
    renderer.pushRect(color,
                      0,
                      timelineScale * i,
                      tracks.length,
                      timelineScale,
                      BACKGROUND_DEPTH - 0.05);
  }

  let lastOperation = null;
  for (let i = 0; i < tracks.length; i++) {
    let track = tracks[i];
    if (track.operation != lastOperation) {
      let color = "#fafafa";
      renderer.pushRect(color,
                        i, 0,
                        0.1, maxTime - minTime,
                        TRACK_GUTTER_DEPTH);
      lastOperation = track.operation;
    }
  }

  gState.timelineIndicators = [];
  timeline.textContent = "";
  let printSeconds = timelineScale == 1;
  for (let i = 0; i < Math.floor(totalTime / timelineScale); i++) {
    let offset = i * timelineScale;
    let offsetPx = (offset + rendererTranslate) * rendererScale;
    if (offsetPx < -VIEWPORT_BUFFER || offsetPx > canvas.height + VIEWPORT_BUFFER) {
      continue;
    }

    let div = document.createElement("div");
    div.style.position = "fixed";
    div.style.left = `${canvas.width - 64}px`;
    div.style.top = `${offsetPx}px`;
    div.textContent = timelineScale == 1 ? `${i}s` : `${Math.round(i * timelineScale * 1000)}ms`;

    timeline.appendChild(div);
    gState.timelineIndicators.push({div, offset});
  }
}

// From MDN (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions)
function escapeRegExp(string) {
  return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');
}

function drawForeground() {
  let {
    trackWidth,
    minTime,
    maxTime,
    tracks,
    totalTime,
    rendererScale,
    rendererTranslate,
    selectedEntry,
  } = gState;

  let searchText = selectedEntry ? selectedEntry.path : searchbar.value;
  let searchRegex = new RegExp(escapeRegExp(searchText), "i");

  for (let i = 0; i < tracks.length; i++) {
    let track = tracks[i];
    for (let entry of track.entries) {
      let matchesSearch = false;
      if (searchRegex.test(entry.path)) {
        matchesSearch = true;
      } else if (searchRegex.test(entry.pid.toString())) {
        matchesSearch = true;
      } else if (searchRegex.test(entry.processName)) {
        matchesSearch = true;
      } else if (entry.pName && searchRegex.test(entry.pName)) {
        matchesSearch = true;
      } else if (entry.tName && searchRegex.test(entry.tName)) {
        matchesSearch = true;
      } else if (entry.detail && searchRegex.test(entry.detail)) {
        matchesSearch = true;
      }

      entry.hiddenBySearch = !matchesSearch;

      let startRelative = entry.start - minTime;
      let endRelative = entry.end - minTime;
      let startPixels = (startRelative + rendererTranslate) * rendererScale;
      let endPixels = (endRelative + rendererTranslate) * rendererScale;

      if (endPixels < -VIEWPORT_BUFFER || startPixels > canvas.height + VIEWPORT_BUFFER) {
        continue;
      }

      entry.rectHandle = renderer.pushRect(getColor(entry),
                                           i, startRelative,
                                           1, endRelative - startRelative,
                                           FOREGROUND_DEPTH,
                                           matchesSearch ? 1.0 : FILTERED_OUT_ENTRY_FILL);
    }
  }
}

async function readFileContents() {
  let file = csvInput.files[0];
  if (file) {
    let reader = new FileReader();
    let text = await getFileText(reader, file);

    let diskifyData = null;
    if (diskifyInput.files[0]) {
      let diskifyText = await getFileText(reader, diskifyInput.files[0]);

      diskifyData = parseDiskify(diskifyText);
    }

    let data;

    let filename = file.name.toLowerCase();
    if (filename.endsWith(".csv")) {
      data = parseCSV(text).map(row => Object.entries(row).reduce((acc,[key,val]) => {
        key = headerMap[key] || key;
        acc[key] = val;
        return acc;
      }, {}));
    } else if (filename.endsWith('.xml')) {
      data = parseProcmonXML(text).map(row => Object.entries(row).reduce((acc,[key,val]) => {
        key = headerMap[key] || key;
        acc[key] = val;
        return acc;
      }, {}));
    } else {
      console.error("Unsupported extension for file " + filename);
    }

    data = data.map(row => {
      let operation = row.operation;
      let path = row.path;
      let pid = row.pid;
      let tid = row.tid;
      let stack = row.stack;
      let detail = row.detail;
      let processName = row.processName;
      let start = parseTimeString(row.time);
      let duration = parseFloat(row.duration);
      if (isNaN(duration)) {
        duration = 0.01;
      }
      return {
        operation, path, pid, tid, start, duration, detail, processName, stack,
      };
    }).filter(row => row.duration > 0 || row.operation == "Process Start");

    let profilerData = null;
    if (profilerInput.files[0]) {
      let profilerText = await getFileText(reader, profilerInput.files[0]);
      let profileObj = JSON.parse(profilerText);

      let processStartTimes = data.filter(row => row.operation == "Process Start");
      if (!processStartTimes.length) {
        processStartTimes = data;
      }
      let firstContentIndex = processStartTimes.findIndex(row => row.detail.includes("-contentproc"));
      let mainProcessIndex = firstContentIndex > 0 ? firstContentIndex - 1 : 0;
      let processStartTime = processStartTimes[mainProcessIndex].start;

      data.push(...extractProfileMarkers(profileObj, processStartTime));
      await symbolicateStacks(profileObj, data);
      nameThreadsAndProcesses(profileObj, data);
    }

    data.sort((lhs, rhs) => lhs.start - rhs.start);

    await drawData(data, diskifyData);
  }
};

async function getFileText(reader, file) {
  reader.readAsText(file, "UTF-8");
  return new Promise((resolve, reject) => {
    reader.onload = e => {
      resolve(e.target.result);
    };
    reader.onerror = e => {
      reject("error reading file");
    };
  });
}

// TODO: remove duplication between these and their diskmap equivalents
function smoothScroll(targetTranslate) {
  smoothValueChange("translate",
                    gState.rendererTranslate,
                    targetTranslate,
                    5000 / gState.rendererScale,
                    (translate) => {
    gState.rendererTranslate = translate;
    renderer.translate(0, gState.rendererTranslate);
    renderer.draw();
    scheduleTranslateTimeline();
  });
}

function smoothScale(targetScale) {
  gState.targetRendererScale = targetScale;
  smoothValueChange("scale",
                    gState.rendererScale,
                    targetScale,
                    100 * gState.rendererScale,
                    (scale) => {
    let {
      trackWidth,
      minTime,
      maxTime,
      rendererScale,
      rendererTranslate,
      mouseY
    } = gState;

    let scaleFactor = scale / rendererScale;
    let windowTopInPixels = -rendererTranslate * rendererScale;
    let mousePositionAbsolute = windowTopInPixels + mouseY;
    let newMousePositionAbsolute = scaleFactor * mousePositionAbsolute;
    let newWindowTopInPixels = newMousePositionAbsolute - mouseY;

    let totalTime = maxTime - minTime;
    let windowHeightInSeconds = canvas.height / scale;
    let newTranslate = Math.min(0, Math.max(-(totalTime - windowHeightInSeconds),
                                            -newWindowTopInPixels / scale));
    gState.rendererScale = scale;
    renderer.scale(gState.trackWidth, gState.rendererScale);
    gState.rendererTranslate = newTranslate;

    gState.targetRendererTranslate = newTranslate;
    renderer.translate(0, gState.rendererTranslate);
    renderer.draw();
  });
}

function doScroll(dy) {
  let {
    trackWidth,
    minTime,
    maxTime,
    rendererScale,
    rendererTranslate,
    targetRendererTranslate,
    mouseY,
  } = gState;

  let totalTime = maxTime - minTime;
  let windowHeightInSeconds = canvas.height / rendererScale;
  let newTranslate = targetRendererTranslate - dy / rendererScale;
  newTranslate = Math.min(0, Math.max(-(totalTime - windowHeightInSeconds), newTranslate));

  gState.targetRendererTranslate = newTranslate;
  smoothScroll(newTranslate);
  scheduleRedraw();
}

function smoothDiskmapScroll(targetTranslate) {
  smoothValueChange("diskmapTranslate",
                    gState.diskmapTranslate,
                    targetTranslate,
                    5000 / gState.diskmapScale,
                    (translate) => {
    gState.diskmapTranslate = translate;
    diskmapRenderer.translate(0, gState.diskmapTranslate);
    diskmapRenderer.draw();
  });
}

function doDiskmapScroll(dy) {
  let {
    maxLcn,
    diskmapScale,
    targetDiskmapTranslate,
    mouseY,
  } = gState;

  let windowHeightInLcns = diskmapCanvas.height / diskmapScale;
  let newTranslate = targetDiskmapTranslate - dy / diskmapScale;
  gState.targetDiskmapTranslate = Math.min(0, Math.max(-(maxLcn - windowHeightInLcns), newTranslate));
  smoothDiskmapScroll(gState.targetDiskmapTranslate);
}

function doZoom(scaleFactor) {
  let {
    trackWidth,
    minTime,
    maxTime,
    targetRendererScale,
    rendererTranslate,
    mouseY
  } = gState;

  let windowTopInPixels = -rendererTranslate * targetRendererScale;
  let mousePositionAbsolute = windowTopInPixels + mouseY;
  let newMousePositionAbsolute = scaleFactor * mousePositionAbsolute;
  let newWindowTopInPixels = newMousePositionAbsolute - mouseY;

  let minScale = canvas.height / (maxTime - minTime);
  let newScale = Math.max(minScale, gState.targetRendererScale * scaleFactor);

  smoothScale(newScale);
  scheduleRedraw();
}

function smoothDiskmapScale(targetScale) {
  gState.targetDiskmapScale = targetScale;
  smoothValueChange("diskmapScale",
                    gState.diskmapScale,
                    targetScale,
                    100 * gState.diskmapScale,
                    (scale) => {
    let {
      maxLcn,
      diskmapScale,
      diskmapTranslate,
      mouseY
    } = gState;

    let scaleFactor = scale / diskmapScale;

    let windowTopInPixels = -diskmapTranslate * diskmapScale;
    let windowCenterInPixels = windowTopInPixels + diskmapCanvas.height / 2;
    let mousePositionAbsolute = windowTopInPixels + mouseY;
    let newMousePositionAbsolute = scaleFactor * mousePositionAbsolute;
    let newWindowTopInPixels = newMousePositionAbsolute - mouseY;

    let windowHeightInLcns = diskmapCanvas.height / scale;
    let newTranslate = Math.min(0, Math.max(-(maxLcn - windowHeightInLcns),
                                            -newWindowTopInPixels / scale));

    gState.diskmapScale = scale;
    gState.diskmapTranslate = newTranslate;
    gState.targetDiskmapTranslate = newTranslate;

    diskmapRenderer.translate(0, gState.diskmapTranslate);
    diskmapRenderer.scale(diskmapCanvas.width, gState.diskmapScale);
    diskmapRenderer.draw();
  });
}

function doDiskmapZoom(scaleFactor) {
  let {
    maxLcn,
    targetDiskmapScale,
    diskmapTranslate,
    mouseY
  } = gState;

  let windowTopInPixels = -diskmapTranslate * targetDiskmapScale;
  let windowCenterInPixels = windowTopInPixels + diskmapCanvas.height / 2;
  let mousePositionAbsolute = windowTopInPixels + mouseY;
  let newMousePositionAbsolute = scaleFactor * mousePositionAbsolute;
  let newWindowTopInPixels = newMousePositionAbsolute - mouseY;

  let minScale = diskmapCanvas.height / maxLcn;
  let newScale = Math.max(minScale, gState.targetDiskmapScale * scaleFactor);

  smoothDiskmapScale(newScale);
  scheduleRedrawDiskmap();
}

function getHoveredEntry() {
  let {
    trackWidth,
    minTime,
    maxTime,
    tracks,
    rendererTranslate,
    rendererScale,
    lastHoveredRect,
    mouseX,
    mouseY,
  } = gState;

  let track = null;
  let hoveredEntry = null;
  let trackIndex = Math.floor(mouseX / trackWidth);
  if (trackIndex < tracks.length) {
    track = tracks[trackIndex];

    let time = minTime + mouseY / rendererScale - rendererTranslate;

    let minDistance = 0.001; // 1 millisecond minimum distance
    for (let entry of track.entries) {
      let distance;
      if (entry.start < time && entry.end > time) {
        minDistance = 0;
        hoveredEntry = entry;
        break;
      } else if (entry.start > time) {
        distance = entry.start - time;
      } else if (entry.end < time) {
        distance = time - entry.end;
      }

      if (distance < minDistance) {
        minDistance = distance;
        hoveredEntry = entry;
      }
    }
  }

  return hoveredEntry;
}

function highlightEntry(entry) {
  if ((entry && entry.rectHandle) != gState.lastHoveredRect) {
    renderer.maybeMutateRect(gState.lastHoveredRect, 1.0);
  }
  if (entry && !entry.hiddenBySearch) {
    renderer.maybeMutateRect(entry.rectHandle, HOVERED_ENTRY_FILL);
    gState.lastHoveredRect = entry.rectHandle;
  } else {
    gState.lastHoveredRect = null;
  }
  renderer.draw();
}

function showEntryTooltip(entry, position, header = null) {
  let {
    trackWidth,
    minTime,
    maxTime,
    tracks,
    rendererTranslate,
    rendererScale,
    lastHoveredRect,
  } = gState;

  let x = 0;
  let y = 0;
  if (position) {
    x = position.x + 8;
    y = position.y + 8;
  } else if (entry) {
    x = (entry.track.index + 1) * trackWidth + 4;
    y = (entry.start - minTime + rendererTranslate) * rendererScale;
  }

  if (entry) {
    let track = entry.track;
    tooltip.style.display = "block";
    tooltip.textContent = "";

    let text = header ? `${header}\n` : "";
    text += `Op: ${entry ? entry.operation : track.operation}\n`;
    text += `Path: ${entry.path}\n`;
    if (entry.pName) {
      text += `Process: ${entry.pName} (${entry.pid})\n`;
    } else {
      text += `Process ID: ${entry.pid}\n`;
    }
    if (entry.tName) {
      text += `Thread: ${entry.tName} (${entry.tid})\n`;
    } else {
      text += `Thread ID: ${entry.tid}\n`;
    }
    if (entry.detail) {
      let detailLines = entry.detail.split("\n");
      text += `Detail: ${detailLines.slice(0, MAX_DETAIL_LINES).join("\n        ")}\n`;
      if (detailLines.length > MAX_DETAIL_LINES) {
        text += `       (${detailLines.length - MAX_DETAIL_LINES} more entries...)\n`;
      }
    }
    text += `Process Name: ${entry.processName}\n`;
    text += `Duration: ${((entry.end - entry.start) * 1000).toFixed(3)}ms\n`;

    if (entry.stack) {
      text += "\nCall stack:\n"
      for (let {path, location} of entry.stack) {
        text += `  ${location} (${path})\n`;
      }
    }

    let lines = text.split("\n");
    for (let line of lines) {
      let div = document.createElement("div");
      div.textContent = line;
      tooltip.appendChild(div);
    }

    let left = x;
    let top = y;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;

    let tooltipRect = tooltip.getBoundingClientRect();
    if (tooltipRect.bottom > window.innerHeight - 4) {
      top -= tooltipRect.bottom - window.innerHeight + 4;
      top = Math.max(0, top);
      tooltip.style.top = `${top}px`;
    }
    if (tooltipRect.right > window.innerWidth - 4) {
      left -= tooltipRect.right - window.innerWidth + 4;
      left = Math.max(0, left);
      tooltip.style.left = `${left}px`;
    }

    highlightEntry(entry);
  } else {
    tooltip.style.display = "none";
    highlightEntry(null);
  }
}

function handleMouseMove(e) {
  if (!gState) {
    return;
  }

  let x = e.pageX;
  let y = e.pageY;
  gState.mouseX = x;
  gState.mouseY = y;

  if (gState.middleMouseDownFor) {
    let dy = e.movementY;
    let isForMainCanvas = gState.middleMouseDownFor == "main";
    let isForDiskmap = gState.middleMouseDownFor == "diskmap";
    if (isForMainCanvas) {
      doScroll(-dy);
    } else if (isForDiskmap) {
      doDiskmapScroll(-dy);
    }
  } else if (x < canvas.width) {
    let entry = getHoveredEntry();
    showEntryTooltip(entry, {x, y});
  } else if (x - canvas.width < fsmapCanvas.width && gState.selectedEntry) {
    let entry = getHoveredReadEntry();
    highlightEntry(entry);
    showEntryTooltip(entry); //, "Map of File reads (top is beginning of file, bottom is end, green are early reads, red are late)");
  } else if (x - canvas.width - fsmapCanvas.width < diskmapCanvas.width) {
    let entry = getHoveredDiskmapEntry();
    highlightEntry(entry);
    showEntryTooltip(entry); //, "Map of File reads by physical location on disk (green are early reads, red are late)");
  } else {
    tooltip.style.display = "none";
  }
}

function drawTopPathsInfo() {
  if (gState) {
    let {
      totalTime,
      readsByPath,
    } = gState;

    let totalRead = Object.entries(readsByPath).map(r => ([r[0], r[1].totalRead]));
    totalRead.sort((lhs, rhs) => rhs[1] - lhs[1]);

    function padRight(str, length) {
      while (str.length < length) {
        str += " ";
      }
      return str;
    }

    let maxStrLen = 0;
    totalRead = totalRead.map(([path, amount]) => {
      let result = [path, amount.toLocaleString()];
      if (result[1].length > maxStrLen) {
        maxStrLen = result[1].length;
      }
      return result;
    });
    let text = "";
    readInfo.textContent = "";
    for (let [path, amount] of totalRead) {
      text += `${padRight(amount, maxStrLen)}  ${path}\n`;
    }
    readInfo.textContent = text;

    fsmapRenderer.clearAll();
    fsmapRenderer.draw();
  }
}

function getHoveredReadEntry() {
  let hoveredEntry = null;
  if (gState) {
    let {
      activePath,
      readsByPath,
      mouseY,
    } = gState;

    if (readsByPath[activePath]) {
      let {
        reads,
        minAddress,
        maxAddress,
      } = readsByPath[activePath];

      let pixelsPerByte = fsmapCanvas.height / maxAddress;
      let minHoveredTime = Number.MAX_VALUE;

      for (let i = 0; i < reads.length; i++) {
        let {readDetail, entry} = reads[i];
        let {offset, length} = readDetail;
        let startPixels = offset * pixelsPerByte;
        let endPixels = (offset + length) * pixelsPerByte;
        if (startPixels < mouseY && endPixels > mouseY) {
          hoveredEntry = entry;
          break;
        }
      }
    }
  }

  return hoveredEntry;
}

function drawPathInfo() {
  if (gState) {
    let {
      activePath,
      totalTime,
      readsByPath,
      totalReadByPath,
      diskify,
      maxLcn,
      selectedEntry,
    } = gState;

    fsmapRenderer.clearAll();

    if (readsByPath[activePath]) {
      let {
        reads,
        minAddress,
        maxAddress,
        totalRead,
      } = readsByPath[activePath];

      for (let i = 0; i < reads.length; i++) {
        let {readDetail} = reads[i];
        let {offset, length} = readDetail;
        let endAddress = offset + length;

        let rgb = gbrLerp(i / reads.length);
        fsmapRenderer.pushRect(colorArrayToHex(rgb), 0, offset, 1, length, (i / reads.length) / 2 + 0.2);
      }

      fsmapRenderer.scale(fsmapCanvas.width, fsmapCanvas.height / maxAddress);
      fsmapRenderer.draw();

      readInfo.textContent = "";
      let text = "";
      text += `Read info for ${activePath}:\n`;
      text += `Read ${(totalRead / 1000000).toLocaleString()} MB from a range of ${((maxAddress - minAddress) / 1000000).toLocaleString()} MB\n`;

      if (diskify && diskify[activePath]) {
        text += `Physical locations on disk:\n`;
        for (let [start, length] of diskify[activePath]) {
          text += `  clusters ${start.toLocaleString()} through ${(start + length).toLocaleString()} (length: ${(length * 4096 / 1000000).toLocaleString()} MB)\n`;
        }
      }

      if (selectedEntry && selectedEntry.stack) {
        text += "\nCall stack:\n"
        for (let {path, location} of selectedEntry.stack) {
          text += `  ${location} (${path})\n`;
        }
      }

      readInfo.textContent = text;
    } else if (selectedEntry && selectedEntry.stack) {
      let text = "";
      if (selectedEntry && selectedEntry.stack) {
        text += "\nCall stack:\n"
        for (let {path, location} of selectedEntry.stack) {
          text += `  ${location} (${path})\n`;
        }
      }

      readInfo.textContent = text;
    } else {
      readInfo.textContent = "";
    }
  }
}

function vcnRangeToLcnRanges(diskifyEntries, startVcn, vcnLength) {
  let curVcn = 0;
  let lcnRanges = [];
  for (let i = 0; i < diskifyEntries.length; i++) {
    if (vcnLength <= 0) {
      break;
    }
    let [startLcn, lcnLength] = diskifyEntries[i];
    if (startVcn >= curVcn && startVcn < curVcn + lcnLength) {
      let offset = startVcn - curVcn;
      let readStartLcn = offset + startLcn;
      let readLength = lcnLength - offset;

      if (vcnLength < readLength) {
        readLength = vcnLength;
      }
      vcnLength -= readLength;
      startVcn += readLength;
      lcnRanges.push([readStartLcn, readLength]);
    }
    curVcn += lcnLength;
  }

  return lcnRanges;
}

function drawDiskmap() {
  let {
    activePath,
    diskify,
    diskmapScale,
    diskmapTranslate,
    readsByPath,
  } = gState;
  if (!diskify) {
    return;
  }
  let lcnsPerPixel = 1 / diskmapScale;

  diskmapRenderer.clearAll();
  let drawLcns = (start, length, color, z) => {
    // -1 indicates something that is virtually stored in some way - an example is
    // transparent filesystem compression. We don't currently have a good way of
    // visualizing this, so I just leave it off.
    if (start != -1) {
      diskmapRenderer.pushRect(color, 0, start, 1, Math.max(lcnsPerPixel, length), z);
    }
  };


  let lcnReads = [];
  if (activePath) {
    if (readsByPath[activePath]) {
      let { reads } = readsByPath[activePath];
      let diskifyForPath = diskify[activePath];
      for (let i = 0; i < reads.length; i++) {
        let {readDetail, entry} = reads[i];
        let {offset, length} = readDetail;
        let startVcn = Math.floor(offset / ASSUMED_CLUSTER_SIZE);
        let vcnLength = Math.ceil(length / ASSUMED_CLUSTER_SIZE);
        lcnReads.push({
          entry,
          lcnRanges: vcnRangeToLcnRanges(diskifyForPath, startVcn, vcnLength),
        });
      }
    }
  } else {
    for (let [path, {reads}] of Object.entries(readsByPath)) {
      let diskifyForPath = diskify[path];
      for (let i = 0; i < reads.length; i++) {
        let {readDetail, entry} = reads[i];
        let {offset, length} = readDetail;
        let startVcn = Math.floor(offset / ASSUMED_CLUSTER_SIZE);
        let vcnLength = Math.ceil(length / ASSUMED_CLUSTER_SIZE);
        lcnReads.push({
          entry,
          lcnRanges: vcnRangeToLcnRanges(diskifyForPath, startVcn, vcnLength),
        });
      }
    }
  }

  let totalLength = 0;
  for (let {lcnRanges} of lcnReads) {
    for (let [start, length] of lcnRanges) {
      totalLength += length;
    }
  }

  let currentTotalLength = 0;
  let i = 0;
  for (let {lcnRanges} of lcnReads) {
    for (let [start, length] of lcnRanges) {
      currentTotalLength += length;
      let rgb = gbrLerp(currentTotalLength / totalLength);
      drawLcns(start, length, colorArrayToHex(rgb), (i / lcnReads.length) / 2 + 0.2);
      i++;
    }
  }

  gState.lcnReads = lcnReads;
  diskmapRenderer.translate(0, diskmapTranslate);
  diskmapRenderer.scale(diskmapCanvas.width, diskmapScale);
  diskmapRenderer.draw();
}

function getHoveredDiskmapEntry() {
  let {
    mouseY,
    lcnReads,
    diskmapScale,
    diskmapTranslate,
    diskify,
  } = gState;
  if (!diskify) {
    return null;
  }

  let lcnsPerPixel = 1 / diskmapScale;
  let mouseLcn = mouseY * lcnsPerPixel - diskmapTranslate;
  let minDistance = lcnsPerPixel;
  let foundExact = false;
  let hoveredEntry = null;
  for (let {lcnRanges, entry} of lcnReads) {
    if (foundExact) {
      break;
    }
    for (let [start, length] of lcnRanges) {
      let end = start + length;
      let distance = 0;
      if (start < mouseLcn && end > mouseLcn) {
        hoveredEntry = entry;
        foundExact = true;
        break;
      } else if (start > mouseLcn) {
        distance = start - mouseLcn;
      } else if (end < mouseLcn) {
        distance = mouseLcn - end;
      }

      if (distance < minDistance) {
        minDistance = distance;
        hoveredEntry = entry;
      }
    }
  }

  return hoveredEntry;
}

let frameRequested = false;
let smoothValueStates = {};
let lastFrame = null;

function smoothValueChangeCb() {
  frameRequested = false;
  let dt = Math.min(performance.now() - lastFrame, 1 / 30);
  lastFrame = performance.now();

  let allTargetsMet = true;
  for (let [key, state] of Object.entries(smoothValueStates)) {
    let {
      currentValue,
      target,
      acceleration,
      callback,
      dp,
    } = state;

    let delta = target - currentValue;
    if (Math.sign(dp) != Math.sign(delta)) {
      dp = 0;
    }

    let deltaAbs = Math.abs(delta);
    let speed = Math.abs(dp);
    let slowDownThreshold = speed * speed * 0.5 / acceleration;

    let ddp = acceleration * Math.sign(delta);
    if (deltaAbs <= slowDownThreshold) {
      ddp = acceleration * -Math.sign(delta);
    }
    dp += ddp * dt;
    let nextValue = currentValue + dp * dt;

    let targetMet = false;
    if (currentValue <= target && nextValue >= target ||
        currentValue >= target && nextValue <= target) {
      nextValue = target;
      dp = 0;
      targetMet = true;
    } else {
      allTargetsMet = false;
    }
    state.currentValue = nextValue;
    state.dp = dp;

    callback(state.currentValue);

    if (targetMet) {
      delete smoothValueStates[key];
    }
  }

  if (!allTargetsMet) {
    requestAnimationFrame(smoothValueChangeCb);
    frameRequested = true;
  }
}

function smoothValueChange(key, currentValue, target, acceleration, callback) {
  if (!smoothValueStates[key]) {
    smoothValueStates[key] = {dp: 0};
  }
  smoothValueStates[key].currentValue = currentValue;
  smoothValueStates[key].target = target;
  smoothValueStates[key].acceleration = acceleration;
  smoothValueStates[key].callback = callback;

  if (!frameRequested) {
    requestAnimationFrame(smoothValueChangeCb);
    frameRequested = true;
    lastFrame = performance.now();
  }
}

let drawForegroundTimeout = null;
function doRedraw() {
  renderer.clearAll();
  drawBackground();
  drawForeground();
  renderer.draw();
  drawForegroundTimeout = null;
}

function scheduleRedraw() {
  if (drawForegroundTimeout) {
    return;
  }
  drawForegroundTimeout = setTimeout(doRedraw, 250);
}

let drawDiskmapTimeout = null;
function doRedrawDiskmap() {
  drawDiskmap();
  drawDiskmapTimeout = null;
}

function scheduleRedrawDiskmap() {
  if (!gState.diskify) {
    return;
  }

  if (drawDiskmapTimeout) {
    return;
  }

  drawDiskmapTimeout = setTimeout(doRedrawDiskmap, 250);
}

let translateTimelineTimeout = null;
function scheduleTranslateTimeline() {
  if (translateTimelineTimeout) {
    return;
  }
  translateTimelineTimeout = setTimeout(() => {
    let {timelineIndicators, rendererTranslate, rendererScale} = gState;
    for (let indicator of timelineIndicators) {
      indicator.div.style.top = `${(indicator.offset + rendererTranslate) * rendererScale}px`;
    }
    translateTimelineTimeout = null;
  }, 10);
}

function normalizeMouseWheelDelta(deltaY) {
  if (deltaY > 0) {
    return 1;
  } else if (deltaY < 0) {
    return -1;
  } else {
    return 0;
  }
}

let isTrackpadScroll = false;
function handleMouseWheel(event) {
  if (gState) {
    let isForMainCanvas = gState.mouseX < canvas.width;
    let diskmapOffset = canvas.width + fsmapCanvas.width;
    let isForDiskmap = gState.mouseX > diskmapOffset &&
        gState.mouseX < diskmapOffset + diskmapCanvas.width;
    if (isForMainCanvas || isForDiskmap) {
      event.preventDefault();
    }
    let zoom = isForMainCanvas ? doZoom : isForDiskmap ? doDiskmapZoom : () => {};
    let scroll = isForMainCanvas ? doScroll : isForDiskmap ? doDiskmapScroll : () => {};
    if (event.ctrlKey) {
      let scaleFactor = 1 + normalizeMouseWheelDelta(event.deltaY) * -0.5;
      zoom(scaleFactor);
    } else {
      // This is an attempt at detecting trackpads. Mouse wheel scrolling
      // usually has detents set up which cause scrolls larger than 1.
      // This seems to be the best I can do for the time being - I'm open
      // to better solutions.
      if (event.deltaY == 1 || event.deltaY == -1) {
        isTrackpadScroll = true;
      }
      let dy;
      if (isTrackpadScroll) {
        dy = event.deltaY;
      } else {
        dy = normalizeMouseWheelDelta(event.deltaY) * 100;
      }
      scroll(dy);
    }
  }
}

function handleMouseDown(event) {
  if (gState) {
    if (event.which == 2 || event.button == 4 ) {
      let isForMainCanvas = gState.mouseX < canvas.width;
      let diskmapOffset = canvas.width + fsmapCanvas.width;
      let isForDiskmap = gState.mouseX > diskmapOffset &&
          gState.mouseX < diskmapOffset + diskmapCanvas.width;
      if (isForMainCanvas || isForDiskmap) {
        event.preventDefault();
      }
      gState.middleMouseDownFor = isForMainCanvas ? "main" : isForDiskmap ? "diskmap" : null;
    } else if (gState.mouseX < canvas.width) {
      let entry = getHoveredEntry();
      if (entry) {
        gState.selectedEntry = entry;
        searchbar.value = "";
        gState.activePath = entry.path;
        doRedraw();
        drawPathInfo();
        scheduleRedrawDiskmap();
      } else if (gState.selectedEntry) {
        gState.selectedEntry = null;
        gState.activePath = null;
        drawTopPathsInfo();
        scheduleRedrawDiskmap();
        doRedraw();
      }
    }
  }
}

function handleMouseUp(event) {
  if (gState) {
    if (event.which == 2 || event.button == 4 ) {
      event.preventDefault();
      gState.middleMouseDownFor = null;
    } else {

    }
  }
}

function handleSearchChange(event) {
  if (gState) {
    scheduleRedraw();
  }
}

function getColorByKey() {
  switch (colorBySelect.value) {
    case "operation": return COLOR_BY_OPERATION;
    case "pid": return COLOR_BY_PID;
    case "tid": return COLOR_BY_TID;
    default: throw new Error("Bad colorby option.");
  }
}

function handleColorByChange(event) {
  colorBy = getColorByKey();
  entryColors = {};
  lastColorIndex = -1;

  if (gState) {
    doRedraw();
  }
}

csvInput.addEventListener("change", readFileContents);
document.addEventListener("mousemove", handleMouseMove);
document.addEventListener("wheel", handleMouseWheel, {passive: false});
document.addEventListener("mousedown", handleMouseDown);
document.addEventListener("mouseup", handleMouseUp);
searchbar.addEventListener("keydown", handleSearchChange);
colorBySelect.addEventListener("change", handleColorByChange);

renderer.startup();
fsmapRenderer.startup();
diskmapRenderer.startup();

if (false && window.location.href.indexOf("localhost") != -1) {
  readFileContents();
}
