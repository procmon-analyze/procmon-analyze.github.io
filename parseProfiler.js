export function parseProfiler(text, data) {
  const obj = JSON.parse(text);
  var processStartTime;
  for (let row of data) {
    if (row.operation == "Process Start") {
      processStartTime = row.start
      break;
    }
  }

  for (let thread of obj.threads) {
    // Loop through all the threads we have profiler info on
    for (let i = 0; i < thread.markers.length; i++) {
      let markers = thread.markers;
      let profileTime = markers.time[i] / 1000;
      var duration;
      if (!markers.data[i]) {
        duration = 0.01;
      } else {
        duration = (markers.data[i].endTime - markers.data[i].startTime)/1000;
      }

      var testObject = {
        operation: "profiler - " + thread.stringArray[markers.name[i]],
        path: "",
        pid: thread.pid,
        tid: thread.tid,
        detail: markers.category[i] + "\n",
        processName: "firefox.exe",
        start: profileTime + processStartTime,
        duration: duration
      };
      data.push(testObject);
    }
  }
  return data;
};