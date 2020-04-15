export function parseProfiler(text, processStartTime) {
  const obj = JSON.parse(text);
  let result = [];

  for (let thread of obj.threads) {
    // Loop through all the threads we have profiler info on
    for (let i = 0; i < thread.markers.length; i++) {
      let markers = thread.markers;
      let profileTime = markers.time[i] / 1000;
      let duration;
      if (!markers.data[i]) {
        duration = 0.01;
      } else {
        duration = (markers.data[i].endTime - markers.data[i].startTime)/1000;
      }

      let testObject = {
        operation: "profiler - " + thread.stringArray[markers.name[i]],
        path: "",
        pid: thread.pid,
        tid: thread.tid,
        detail: thread.stringArray[markers.category[i]],
        processName: "firefox.exe",
        start: profileTime + processStartTime,
        duration: duration
      };
      result.push(testObject);
    }
  }
  return result;
};
