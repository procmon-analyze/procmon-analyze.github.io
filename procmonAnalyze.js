import {parseCSV} from "./parseCSV.js"
import renderer from "./renderer.js"

const BACKGROUND_DEPTH = 0.9;
const TRACK_GUTTER_DEPTH = 0.8;
const FOREGROUND_DEPTH = 0.7;
const HOVERED_ENTRY_FILL = 0.9;

const csvInput = document.getElementById("csvfile");
const tooltip = document.getElementById("tooltip");
const searchbar = document.getElementById("searchbar-input");
const timeline = document.getElementById("timeline");
const canvas = document.getElementById("canvas");
// const ctx = canvas.getContext("2d");

canvas.width = window.innerWidth * 0.5;
canvas.height = window.innerHeight - 16;

const VIEWPORT_BUFFER = canvas.height;

let headerMap = {
  "Time of Day": "time",
  "Process Name": "processName",
  "PID": "pid",
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
  "#4736fc",
  "#e4ba6e",
  "#623b1a",
  "#8fb0e9",
  "#857ebb",
  "#7fcbd7",
  "#427975",
  "#72b37e",
  "#4736fc",
  "#e4ba6e",
  "#623b1a",
  "#8fb0e9",
  "#857ebb",
  "#7fcbd7",
  "#427975",
  "#72b37e",
  "#6f6add",
  "#584081",
  "#cb6b6f",
  "#6f6add",
  "#4736fc",
  "#e4ba6e",
  "#623b1a",
  "#8fb0e9",
  "#857ebb",
  "#7fcbd7",
  "#427975",
  "#72b37e",
  "#6f6add",
  "#584081",
  "#cb6b6f",
  "#6f6add",
  "#4736fc",
  "#e4ba6e",
  "#623b1a",
  "#8fb0e9",
  "#857ebb",
  "#7fcbd7",
  "#427975",
  "#72b37e",
  "#6f6add",
  "#584081",
  "#cb6b6f",
  "#6f6add",
];

let opColors = {};
let gState = null;

async function drawData(data) {
  document.getElementById("chooserWrapper").style.display = "none";

  let tracks = [];
  let minTime = Number.MAX_VALUE;
  let maxTime = -1;

  data = data.map(row => {
    let operation = row.operation;
    let path = row.path;
    let pid = row.pid;
    let detail = row.detail;
    let processName = row.processName;
    let start = parseTimeString(row.time);
    let duration = parseFloat(row.duration);
    return {
      operation, path, pid, start, duration, detail, processName
    };
  }).filter(row => row.duration > 0 || row.operation == "Process Start");
  data.sort((lhs, rhs) => lhs.start - rhs.start);

  let totalTimeByOperation = {};

  for (let row of data) {
    let { operation, path, pid, start, duration, detail, processName } = row;
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
        let lastTimeSlice = candidate.entries[candidate.entries.length - 1];
        if (start > lastTimeSlice.end) {
          track = candidate;
          break;
        } else if (path == lastTimeSlice.path) {
          lastTimeSlice.end = end;
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

    if (!opColors[operation]) {
      if (!colors.length) {
        throw new Error("Not enough colors in array.");
      }
      opColors[operation] = colors.pop();
    }
    let entry = {start, end, path, pid, detail, processName, rectHandle: null, color: opColors[operation]};
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
  } = gState;

  let searchText = searchbar.value;
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

      entry.hiddenBySearch = !matchesSearch;
      if (!matchesSearch) {
        continue;
      }

      let startRelative = entry.start - minTime;
      let endRelative = entry.end - minTime;
      let startPixels = (startRelative + rendererTranslate) * rendererScale;
      let endPixels = (endRelative + rendererTranslate) * rendererScale;

      if (endPixels < -VIEWPORT_BUFFER || startPixels > canvas.height + VIEWPORT_BUFFER) {
        continue;
      }

      entry.rectHandle = renderer.pushRect(entry.color,
                                           i, startRelative,
                                           1, endRelative - startRelative,
                                           FOREGROUND_DEPTH);
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
  let newTranslate = -Math.max(0, newWindowTopInPixels / (rendererScale * scaleFactor));

  let minScale = canvas.height / (maxTime - minTime);
  gState.rendererScale = Math.max(minScale, gState.rendererScale * scaleFactor);
  gState.rendererTranslate = newTranslate;

  renderer.scale(trackWidth, gState.rendererScale);
  renderer.translate(0, gState.rendererTranslate);
  renderer.draw();
  scheduleTranslateTimeline();
  scheduleRedraw();
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
  } else {
    tooltip.textContent = "";

    let {
      trackWidth,
      minTime,
      maxTime,
      tracks,
      rendererTranslate,
      rendererScale,
      lastHoveredRect,
    } = gState;

    let trackIndex = Math.floor(x / trackWidth);
    if (trackIndex < tracks.length) {
      let track = tracks[trackIndex];
      tooltip.style.left = `${x + 8}px`;
      tooltip.style.top = `${y + 8}px`;

      let time = minTime + y / rendererScale - rendererTranslate;
      let hoveredEntry = null;

      let minDistance = 0.001; // 1 millisecond minimum distance
      for (let entry of track.entries) {
        if (entry.hiddenBySearch) {
          continue;
        }

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

      let text = "";
      text += `Op: ${track.operation}\n`;
      if (hoveredEntry) {
        text += `Path: ${hoveredEntry.path}\n`;
        text += `PID: ${hoveredEntry.pid}\n`;
        if (hoveredEntry.detail) {
          text += `Detail: ${hoveredEntry.detail}\n`;
        }
        text += `Process Name: ${hoveredEntry.processName}\n`;
        text += `Duration: ${((hoveredEntry.end - hoveredEntry.start) * 1000).toFixed(3)}ms\n`;

        renderer.maybeMutateRect(lastHoveredRect, 1.0);
        renderer.maybeMutateRect(hoveredEntry.rectHandle, HOVERED_ENTRY_FILL);
        gState.lastHoveredRect = hoveredEntry.rectHandle; 
        renderer.draw();
      } else if (lastHoveredRect) {
        renderer.maybeMutateRect(lastHoveredRect, 1.0);
        lastHoveredRect = null;
        renderer.draw();
      }

      let lines = text.split("\n");
      for (let line of lines) {
        let div = document.createElement("div");
        div.textContent = line;
        tooltip.appendChild(div);
      }
    }
  }
};

let drawForegroundTimeout = null;
function scheduleRedraw() {
  if (drawForegroundTimeout) {
    return;
  }
  drawForegroundTimeout = setTimeout(() => {
    renderer.clearAll();
    drawBackground();
    drawForeground();
    renderer.draw();
    drawForegroundTimeout = null;
  }, 250);
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
  if (gState && event && (event.which == 2 || event.button == 4 )) {
    event.preventDefault();
    gState.middleMouseDown = true;
  }
}

function handleMouseUp(event) {
  if (gState && event && (event.which == 2 || event.button == 4 )) {
    event.preventDefault();
    gState.middleMouseDown = false;
  }
}

function handleSearchChange(event) {
  if (gState) {
    scheduleRedraw();
  }
}

csvInput.addEventListener("change", readFileContents);
canvas.addEventListener("mousemove", handleMouseMove);
document.addEventListener("wheel", handleMouseWheel, {passive: false});
document.addEventListener("mousedown", handleMouseDown);
document.addEventListener("mouseup", handleMouseUp);
searchbar.addEventListener("keydown", handleSearchChange);

renderer.startup();

readFileContents();

