export function parseDiskify(text) {
  let map = {};
  let lines = text.replace(/\r/g, "").split("\n").filter(l => l != "");
  let pathReg = /^[^\s]/;
  let pathStatusReg = /^  (?:OK|BAD [0-9]+)/;
  let mappingEntryReg = /^    ([0-9-]+),([0-9]+)/;
  let currentPath = null;
  let currentMappings = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let mappingEntryMatch = null;
    if (pathReg.test(line)) {
      if (currentPath) {
        map[currentPath] = currentMappings;
        currentMappings = [];
      }
      currentPath = line;
    } else if (mappingEntryMatch = mappingEntryReg.exec(line)) {
      let start = parseInt(mappingEntryMatch[1]);
      let length = parseInt(mappingEntryMatch[2]);
      if (isNaN(start) || isNaN(length)) {
        console.error(`Unsupported diskify file. Line ${i}: ${line}`);
        return null;
      }
      currentMappings.push([start, length]);
    } else if (!pathStatusReg.test(line)) {
      console.error(`Unsupported diskify file. Line ${i}: ${line}`);
      return null;
    }
  }
  if (currentPath && currentMappings.length > 0) {
    map[currentPath] = currentMappings;
  }
  return map;
};