export function parseProfiler(text, processStartTime) {
  const obj = JSON.parse(text);
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
    }
  }
  return result;
};
