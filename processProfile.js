export function extractProfileMarkers(obj, processStartTime) {
  let result = [];
  let tracingMarkers = {};

  for (let thread of obj.threads) {
    // Loop through all the threads we have profiler info on
    for (let i = 0; i < thread.markers.length; i++) {
      let markers = thread.markers;
      let profileTime = markers.time[i] / 1000;

      let duration = 0.01;
      let data = markers.data[i];
      if (data) {
        let candidateDuration = data.endTime - data.startTime;
        if (candidateDuration > 0 && !isNaN(candidateDuration)) {
          duration = candidateDuration / 1000;
        }
      }

      let name = thread.stringArray[markers.name[i]];

      if (data && data.type == "tracing") {
        if (data.interval == "start") {
          let tracingMarkersForName = tracingMarkers[name];
          if (!tracingMarkersForName) {
            tracingMarkersForName = [];
            tracingMarkers[name] = tracingMarkersForName;
          }
          tracingMarkersForName.push(i);
        } else if (data.interval == "end") {
          let tracingMarkersForName = tracingMarkers[name];
          if (tracingMarkersForName) {
            let startMarkerIndex = tracingMarkersForName.pop();
            let startTime = markers.time[startMarkerIndex] / 1000;
            duration = profileTime - startTime;
            let marker = {
              operation: `ProfilerMarker - ${obj.meta.categories[markers.category[i]].name}`,
              path: "",
              pid: thread.pid,
              tid: thread.tid,
              detail: name,
              processName: "firefox.exe",
              start: profileTime + processStartTime,
              duration: duration
            };

            result.push(marker);
          }
        } else {
          console.warn("Bad interval on tracing marker: " + data.interval);
        }
      } else {
        let path = "";
        if (name == "FileIO" && data) {
          path = data.filename;
        }

        let marker = {
          operation: `ProfilerMarker - ${obj.meta.categories[markers.category[i]].name}`,
          path,
          pid: thread.pid,
          tid: thread.tid,
          detail: name,
          processName: "firefox.exe",
          start: profileTime + processStartTime,
          duration: duration
        };
        result.push(marker);
      }
    }
  }
  return result;
};

export async function symbolicateStacks(profileObj, dataTable) {
  // The format we need to get our stacks into to send to https://symbols.mozilla.org
  // is this:
  // {
  //   memoryMap: [
  //     ["xul.dll", "<breakpad_id>"],
  //     ["other_lib.dll", "<other_breakpad_id>"],
  //     ...
  //   ],
  //   stacks: [
  //     [
  //       [<index_into_memoryMap>, <address>],
  //       [<index_into_memoryMap>, <address>],
  //       ...,
  //     },
  //   ],
  // }
  // 
  // address will be the address member of the stack obj in dataTable.
  // "xul.dll" will come from the last part of the "path" member. breakpad_id
  // will have to come from the module list from the profile, and is the main
  // reason we need it. index_into_memoryMap will just be computed as we
  // construct the memoryMap.
  let memoryMap = [];
  let memoryMapIndexMap = {};
  let frames = [];
  let frameIndexMap = {};

  for (let thread of profileObj.threads) {
    for (let lib of thread.libs) {
      let pathLower = lib.path.toLowerCase();
      let splitPath = pathLower.split("\\");
      let pathLeaf = splitPath[splitPath.length - 1];
      if (!(pathLeaf in memoryMapIndexMap)) {
        memoryMapIndexMap[pathLeaf] = memoryMap.length;
        memoryMap.push([pathLeaf.replace(".dll", ".pdb").replace(".exe", ".pdb"), lib.breakpadId]);
      }
    }
  }

  for (let i = 0; i < dataTable.length; i++) {
    let entry = dataTable[i];
    for (let frame of entry.stack || []) {
      let pathLower = frame.path.toLowerCase();
      let splitPath = pathLower.split("\\");
      let pathLeaf = splitPath[splitPath.length - 1];
      if (pathLeaf in memoryMapIndexMap) {
        let frameKey = `${memoryMapIndexMap[pathLeaf]}:${frame.address}`;
        if (!(frameKey in frameIndexMap)) {
          frameIndexMap[frameKey] = frames.length;
          frames.push([memoryMapIndexMap[pathLeaf], Number(frame.address)]);
        }
        frame.frameIndex = frameIndexMap[frameKey];
      }
    }
  }
  async function postData(url = '', data = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    return await response.json(); // parses JSON response into native JavaScript objects
  }

  let stacks = [];
  for (let i = 0; i < Math.ceil(frames.length / 64); i++) {
    stacks.push(frames.slice(i * 64, (i + 1) * 64));
  }
  let payload = {
    memoryMap,
    stacks,
  };
  let data = await postData("https://symbols.mozilla.org/symbolicate/v5", {jobs: [payload]});
  let resultFrames = data.results[0].stacks.flat();

  for (let i = 0; i < dataTable.length; i++) {
    let entry = dataTable[i];
    for (let frame of entry.stack || []) {
      if ("frameIndex" in frame) {
        let resultFrame = resultFrames[frame.frameIndex];
        frame.location = resultFrame.function;
      }
      let splitPath = frame.path.toLowerCase().split("\\");
      frame.path = splitPath[splitPath.length - 1];
    }
  }
} 

export function nameThreadsAndProcesses(profileObj, dataTable) {
  let pidsToNames = {};
  let tidsToNames = {};
  for (let thread of profileObj.threads) {
    pidsToNames[thread.pid] = thread.processName;
    tidsToNames[thread.tid] = thread.name;
  }

  for (let entry of dataTable) {
    if (entry.pid in pidsToNames) {
      entry.pName = pidsToNames[entry.pid];
    }
    if (entry.tid in tidsToNames) {
      entry.tName = tidsToNames[entry.tid];
    }
  }
}
