import {parseCSV} from "./parseCSV.js"
import renderer from "./renderer.js"

const BACKGROUND_DEPTH = 0.9;
const TRACK_GUTTER_DEPTH = 0.8;
const FOREGROUND_DEPTH = 0.7;
const HOVERED_ENTRY_FILL = 0.9;
const FILTERED_OUT_ENTRY_FILL = 0.7;
const MAX_DETAIL_LINES = 20;

const csvInput = document.getElementById("csvfile");
const tooltip = document.getElementById("tooltip");
const searchbar = document.getElementById("searchbar-input");
const colorBySelect = document.getElementById("color-by-select");
const timeline = document.getElementById("timeline");
const canvas = document.getElementById("canvas");

canvas.width = window.innerWidth * 0.5;
canvas.height = window.innerHeight - 16;

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

async function drawData(data) {
  document.getElementById("chooserWrapper").style.display = "none";

  let tracks = [];
  let minTime = Number.MAX_VALUE;
  let maxTime = -1;

  data = data.map(row => {
    let operation = row.operation;
    let path = row.path;
    let pid = row.pid;
    let tid = row.tid;
    let detail = row.detail;
    let processName = row.processName;
    let start = parseTimeString(row.time);
    let duration = parseFloat(row.duration);
    return {
      operation, path, pid, tid, start, duration, detail, processName
    };
  }).filter(row => row.duration > 0 || row.operation == "Process Start");
  data.sort((lhs, rhs) => lhs.start - rhs.start);

  let totalTimeByOperation = {};

  for (let row of data) {
    let { operation, path, pid, tid, start, duration, detail, processName } = row;
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
    let mergedEntry = false;

    if (!totalTimeByOperation[operation]) {
      totalTimeByOperation[operation] = 0;
    }

    totalTimeByOperation[operation] += duration;

    for (let candidate of tracks) {
      if (operation == candidate.operation) {
        let lastEntry = candidate.entries[candidate.entries.length - 1];
        if (start > lastEntry.end) {
          track = candidate;
          break;
        } else if (path == lastEntry.path && pid == lastEntry.pid && tid == lastEntry.tid) {
          lastEntry.end = end;
          lastEntry.detail += "\n" + detail;
          track = candidate;
          mergedEntry = true;
          break;
        }
      }
    }

    if (mergedEntry) {
      continue;
    }

    if (!track) {
      track = {operation, entries: []};
      tracks.push(track);
    }
    let entry = {
      start,
      end,
      path,
      pid,
      tid,
      detail,
      processName,
      operation,
      hiddenBySearch: false,
      rectHandle: null
    };
    track.entries.push(entry);
  }

  tracks.sort((lhs, rhs) => totalTimeByOperation[rhs.operation] - totalTimeByOperation[lhs.operation]);

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
    rendererTranslate: 0,
    mouseX: 0,
    mouseY: 0,
    timelineIndicators: [],
    lastHoveredRect: null,
    selectedEntry: null,
  };

  renderer.scale(trackWidth, rendererScale);
  renderer.translate(0, 0);

  renderer.clearAll();
  drawBackground();
  drawForeground();
  renderer.draw();
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
    div.style.left = `${canvas.width}px`;
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
      } else if (entry.detail && searchRegex.test(entry.detail)) {
        matchesSearch = true;
      }

      if (!matchesSearch) {
        entry.hiddenBySearch = true;
      }

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
    reader.readAsText(file, "UTF-8");
    let text = await new Promise((resolve, reject) => {
      reader.onload = e => {
        resolve(e.target.result);
      };
      reader.onerror = e => {
        reject("error reading file");
      };
    });

    let data = parseCSV(text).map(row => Object.entries(row).reduce((acc,[key,val]) => {
      acc[headerMap[key]] = val;
      return acc;
    }, {}));

    await drawData(data);
  }
};

function doScroll(dy) {
  let {
    trackWidth,
    minTime,
    maxTime,
    rendererScale,
    rendererTranslate,
    tracks,
    mouseX,
    mouseY,
  } = gState;

  let totalTime = maxTime - minTime;
  let windowHeightInSeconds = canvas.height / rendererScale;
  let newTranslate = rendererTranslate - dy / rendererScale;
  gState.rendererTranslate = Math.min(0, Math.max(-(totalTime - windowHeightInSeconds), newTranslate));

  renderer.translate(0, gState.rendererTranslate);
  renderer.draw();
  scheduleTranslateTimeline();
  scheduleRedraw();
}

function doZoom(scaleFactor) {
  let {
    trackWidth,
    minTime,
    maxTime,
    rendererScale,
    rendererTranslate,
    tracks,
    mouseX,
    mouseY
  } = gState;

  let windowTopInPixels = -rendererTranslate * rendererScale;
  let windowCenterInPixels = windowTopInPixels + canvas.height / 2;
  let mousePositionAbsolute = windowTopInPixels + mouseY;
  let newMousePositionAbsolute = scaleFactor * mousePositionAbsolute;
  let newWindowTopInPixels = newMousePositionAbsolute - mouseY;

  let minScale = canvas.height / (maxTime - minTime);
  gState.rendererScale = Math.max(minScale, gState.rendererScale * scaleFactor);
  let totalTime = maxTime - minTime;
  let windowHeightInSeconds = canvas.height / rendererScale;
  gState.rendererTranslate = Math.min(0, Math.max(-(totalTime - windowHeightInSeconds),
                                                  -newWindowTopInPixels / (rendererScale * scaleFactor)));

  renderer.scale(trackWidth, gState.rendererScale);
  renderer.translate(0, gState.rendererTranslate);
  renderer.draw();
  scheduleTranslateTimeline();
  scheduleRedraw();
}

function getTrackAndEntryByMousePosition(x, y) {
  let {
    trackWidth,
    minTime,
    maxTime,
    tracks,
    rendererTranslate,
    rendererScale,
    lastHoveredRect,
  } = gState;

  let track = null;
  let hoveredEntry = null;
  let trackIndex = Math.floor(x / trackWidth);
  if (trackIndex < tracks.length) {
    track = tracks[trackIndex];

    let time = minTime + y / rendererScale - rendererTranslate;

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

  return {track, entry: hoveredEntry};
}

function handleMouseMove(e) {
  if (!gState) {
    return;
  }

  let x = e.pageX;
  let y = e.pageY;
  gState.mouseX = x;
  gState.mouseY = y;

  if (gState.middleMouseDown) {
    let dy = e.movementY;
    doScroll(-dy);
  } else if (x < canvas.width) {
    tooltip.style.display = "block";
    tooltip.textContent = "";
    tooltip.style.left = `${x + 8}px`;
    tooltip.style.top = `${y + 8}px`;

    let {
      trackWidth,
      minTime,
      maxTime,
      tracks,
      rendererTranslate,
      rendererScale,
      lastHoveredRect,
    } = gState;

    let {track, entry} = getTrackAndEntryByMousePosition(x, y);

    let text = "";
    text += `Op: ${track.operation}\n`;
    if (entry) {
      text += `Path: ${entry.path}\n`;
      text += `Process ID: ${entry.pid}\n`;
      text += `Thread ID: ${entry.tid}\n`;
      if (entry.detail) {
        let detailLines = entry.detail.split("\n");
        text += `Detail: ${detailLines.slice(0, MAX_DETAIL_LINES).join("\n        ")}\n`;
        if (detailLines.length > MAX_DETAIL_LINES) {
          text += `       (${detailLines.length - MAX_DETAIL_LINES} more entries...)\n`;
        }
      }
      text += `Process Name: ${entry.processName}\n`;
      text += `Duration: ${((entry.end - entry.start) * 1000).toFixed(3)}ms\n`;

      renderer.maybeMutateRect(lastHoveredRect, 1.0);
      if (!entry.hiddenBySearch) {
        renderer.maybeMutateRect(entry.rectHandle, HOVERED_ENTRY_FILL);
        gState.lastHoveredRect = entry.rectHandle;
      }
      renderer.draw();
    } else if (lastHoveredRect) {
      renderer.maybeMutateRect(lastHoveredRect,
                               1.0);
      lastHoveredRect = null;
      renderer.draw();
    }

    let lines = text.split("\n");
    for (let line of lines) {
      let div = document.createElement("div");
      div.textContent = line;
      tooltip.appendChild(div);
    }
  } else {
    tooltip.style.display = "none";
  }
};

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

let isTrackpadScroll = false;
function handleMouseWheel(event) {
  if (gState) {
    event.preventDefault();
    if (event.ctrlKey) {
      let scaleFactor = 1 + event.deltaY * -0.05;
      doZoom(scaleFactor);
    } else {
      // This is an attempt at detecting trackpads. Mouse wheel scrolling
      // usually has detents set up which cause scrolls larger than 1.
      // This seems to be the best I can do for the time being - I'm open
      // to better solutions.
      if (event.deltaY == 1 || event.deltaY == -1) {
        isTrackpadScroll = true;
      }
      let dy = event.deltaY;
      if (!isTrackpadScroll) {
        dy *= 10;
      }
      doScroll(dy);
    }
  }
}

function handleMouseDown(event) {
  if (gState) {
    if (event.which == 2 || event.button == 4 ) {
      event.preventDefault();
      gState.middleMouseDown = true;
    } else {
      let {track, entry} = getTrackAndEntryByMousePosition(gState.mouseX, gState.mouseY);
      if (entry) {
        gState.selectedEntry = entry;
        searchbar.value = "";
        doRedraw();
      } else if (gState.selectedEntry) {
        gState.selectedEntry = null;
        doRedraw();
      }
    }
  }
}

function handleMouseUp(event) {
  if (gState) {
    if (event.which == 2 || event.button == 4 ) {
      event.preventDefault();
      gState.middleMouseDown = false;
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

if (window.location.href.indexOf("localhost") != -1) {
  readFileContents();
}

